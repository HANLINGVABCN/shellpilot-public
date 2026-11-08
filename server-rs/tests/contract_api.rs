// 对齐 tests/api.test.js：起一个 mock SSH 服务器 + 被测后端二进制，全链路验证 API 契约
use base64::Engine;
use russh::server::{Auth, Msg, Session};
use russh::{ChannelId, CryptoVec};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tokio::io::AsyncReadExt;

const SAMPLE: &str = "===CPU===\ncpu 1 2 3 4 5\n===MEM===\nMemTotal: 1024 kB\nMemAvailable: 512 kB\n===LOAD===\n0.1 0.1 0.1\n===NET===\nlo: 0 0 0 0 0 0 0 0 0\n===DISK===\n/dev/mock 1024 512 512 50% /\n===UP===\n100 100\n";

#[derive(Clone)]
struct Reply {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    code: u32,
    capture_stdin: bool,
}

impl Reply {
    fn code(code: u32) -> Self {
        Self { stdout: vec![], stderr: vec![], code, capture_stdin: false }
    }
    fn out(s: &str) -> Self {
        Self { stdout: s.as_bytes().to_vec(), stderr: vec![], code: 0, capture_stdin: false }
    }
}

type ReplyFn = Arc<dyn Fn(&str) -> Reply + Send + Sync>;

static REPLY: LazyLock<Mutex<ReplyFn>> = LazyLock::new(|| {
    Mutex::new(Arc::new(|_: &str| Reply::code(0)) as ReplyFn)
});
static COMMANDS: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static CAPTURED_STDIN: LazyLock<Mutex<Vec<Vec<u8>>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static CONN_RECORDS: LazyLock<Mutex<Vec<Vec<String>>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn set_reply(f: impl Fn(&str) -> Reply + Send + Sync + 'static) {
    *REPLY.lock().unwrap() = Arc::new(f);
}

fn fs_commands() -> Vec<String> {
    COMMANDS
        .lock()
        .unwrap()
        .iter()
        .filter(|c| !c.starts_with("echo ===CPU==="))
        .cloned()
        .collect()
}

struct MockHandler {
    conn_id: usize,
}

#[async_trait::async_trait]
impl russh::server::Handler for MockHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let cmd = String::from_utf8_lossy(data).to_string();
        COMMANDS.lock().unwrap().push(cmd.clone());
        CONN_RECORDS.lock().unwrap()[self.conn_id].push(cmd.clone());
        let reply = (REPLY.lock().unwrap().clone())(&cmd);
        if reply.capture_stdin {
            return Ok(());
        }
        finish_reply(session, channel, reply);
        Ok(())
    }

    async fn data(&mut self, _channel: ChannelId, data: &[u8], _session: &mut Session) -> Result<(), Self::Error> {
        CAPTURED_STDIN.lock().unwrap().push(data.to_vec());
        Ok(())
    }

    async fn channel_eof(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        // stdin 采集型命令：客户端 EOF 即结束，回 0
        {
            let mut guard = CAPTURED_STDIN.lock().unwrap();
            let all: Vec<u8> = guard.drain(..).flatten().collect();
            if !all.is_empty() {
                guard.push(all);
            }
        }
        session.exit_status_request(channel, 0);
        session.eof(channel);
        session.close(channel);
        Ok(())
    }
}

fn finish_reply(session: &mut Session, channel: ChannelId, reply: Reply) {
    if !reply.stderr.is_empty() {
        session.extended_data(channel, 1, CryptoVec::from(reply.stderr));
    }
    if !reply.stdout.is_empty() {
        session.data(channel, CryptoVec::from(reply.stdout));
    }
    session.exit_status_request(channel, reply.code);
    session.eof(channel);
    session.close(channel);
}

async fn start_mock_ssh() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let config = Arc::new(russh::server::Config {
            keys: vec![russh::keys::key::KeyPair::generate_ed25519()],
            ..Default::default()
        });
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => break,
            };
            let conn_id = CONN_RECORDS.lock().unwrap().len();
            CONN_RECORDS.lock().unwrap().push(Vec::new());
            let config = config.clone();
            tokio::spawn(async move {
                let _ = russh::server::run_stream(config, stream, MockHandler { conn_id }).await;
            });
        }
    });
    port
}

async fn wait_for_url(child: &mut tokio::process::Child, stdout: &mut tokio::process::ChildStdout) -> String {
    let mut buf = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if tokio::time::Instant::now() > deadline {
            panic!("backend did not start: {}", String::from_utf8_lossy(&buf));
        }
        let mut chunk = [0u8; 512];
        match tokio::time::timeout(std::time::Duration::from_millis(300), stdout.read(&mut chunk)).await {
            Ok(Ok(0)) | Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Ok(Ok(n)) => buf.extend_from_slice(&chunk[..n]),
            Ok(Err(e)) => panic!("read stdout: {e}"),
        }
        let text = String::from_utf8_lossy(&buf);
        if let Some(idx) = text.find("http://127.0.0.1:") {
            let rest = &text[idx + "http://127.0.0.1:".len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() {
                return format!("http://127.0.0.1:{}", digits);
            }
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("backend exited ({status}): {}", String::from_utf8_lossy(&buf));
        }
    }
}

async fn request(base: &str, endpoint: &str, body: Option<Value>) -> (u16, Value) {
    let client = reqwest::Client::new();
    let mut req = match body {
        Some(b) => client.post(format!("{base}/api{endpoint}")).json(&b),
        None => client.get(format!("{base}/api{endpoint}")),
    };
    let resp = req.timeout(std::time::Duration::from_secs(8)).send().await.unwrap();
    let status = resp.status().as_u16();
    let data: Value = resp.json().await.unwrap_or(Value::Null);
    (status, data)
}

fn tmp_data_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("shellpilot-rs-test-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn saved(data_dir: &std::path::Path, name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(data_dir.join(name)).unwrap()).unwrap()
}

fn encrypt_b64(value: &Value, password: &str) -> String {
    let payload = serde_json::to_vec(value).unwrap();
    let enc = shellpilot_server::crypt::encrypt_data(&payload, password);
    base64::engine::general_purpose::STANDARD.encode(enc)
}

#[tokio::test(flavor = "multi_thread")]
async fn api_contract_end_to_end() {
    let password = "test-only-password";
    let ssh_port = start_mock_ssh().await;
    let data_dir = tmp_data_dir("api");

    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_shellpilot-server"))
        .env("SHELLPILOT_DATA", &data_dir)
        .env("SHELLPILOT_PORT", "0")
        .env("SHELLPILOT_OPEN", "0")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let base = wait_for_url(&mut child, &mut stdout).await;

    // 创建主机
    let (status, created) = request(&base, "/hosts", Some(json!({
        "name": "mock-localhost", "host": "127.0.0.1", "port": ssh_port, "username": "test", "password": "test"
    }))).await;
    assert_eq!(status, 200);
    let host_id = created["id"].as_str().unwrap().to_string();
    // First use automatically saves the mock server key before authentication.
    let mut trusted=Value::Null;
    for _ in 0..50 {
        trusted=std::fs::read_to_string(data_dir.join("trusted-host-keys.json")).ok().and_then(|text|serde_json::from_str(&text).ok()).unwrap_or(Value::Null);
        if trusted[format!("127.0.0.1:{ssh_port}")].is_string() { break; }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(trusted[format!("127.0.0.1:{ssh_port}")].is_string(),"mock host key was not pinned automatically");
    let (_,keys)=request(&base,"/ssh/host-keys",None).await;
    assert!(keys.as_array().unwrap().is_empty(),"First use must not ask for confirmation");

    // 1. 导出 → 预览（脱敏）→ 导入回环
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/export"))
        .json(&json!({ "password": password }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let blob = resp.bytes().await.unwrap();
    let data = base64::engine::general_purpose::STANDARD.encode(&blob);
    let (status, preview) = request(&base, "/import/preview", Some(json!({ "password": password, "data": data }))).await;
    assert_eq!(status, 200);
    assert_eq!(preview["hosts"][0]["id"], json!(host_id));
    assert!(preview["hosts"][0].get("password").is_none());
    let (status, _) = request(&base, "/import", Some(json!({ "password": password, "data": data }))).await;
    assert_eq!(status, 200);

    // 2. overwrite 保留全局历史与模型，并重载聊天缓存
    let payload = json!({
        "version": 1,
        "hosts": saved(&data_dir, "hosts.json"),
        "settings": {
            "providers": [{ "id": "p_test", "name": "test", "baseURL": "https://unused.example/v1", "apiKey": "test-secret" }],
            "models": [{ "id": "m_test", "providerId": "p_test", "name": "test-model" }],
            "defaultModelId": "m_test"
        },
        "chats": { "__global__": [{ "id": "c_test", "title": "restored", "messages": [{ "role": "user", "content": "restored" }] }] }
    });
    let (status, _) = request(&base, "/import", Some(json!({
        "password": password, "data": encrypt_b64(&payload, password),
        "mode": "overwrite", "hostIds": [host_id], "providerIds": ["p_test"]
    }))).await;
    assert_eq!(status, 200);
    let (status, chats) = request(&base, "/chats/__global__", None).await;
    assert_eq!(status, 200);
    assert_eq!(chats[0]["id"], json!("c_test"));
    let (status, settings) = request(&base, "/settings", None).await;
    assert_eq!(status, 200);
    assert_eq!(settings["defaultModelId"], json!("m_test"));

    // 3. 非法备份：400 且文件原样
    let names = ["hosts.json", "settings.json", "chats.json"];
    let before: Vec<String> = names
        .iter()
        .map(|n| std::fs::read_to_string(data_dir.join(n)).unwrap())
        .collect();
    for payload in [json!(null), json!({ "hosts": {} }), json!({ "settings": { "models": "invalid" } })] {
        let data = encrypt_b64(&payload, password);
        for endpoint in ["/import/preview", "/import"] {
            let (status, result) = request(&base, endpoint, Some(json!({ "password": password, "data": data }))).await;
            assert_eq!(status, 400, "{endpoint}: {result}");
            assert!(result["error"].is_string());
        }
    }
    let after: Vec<String> = names
        .iter()
        .map(|n| std::fs::read_to_string(data_dir.join(n)).unwrap())
        .collect();
    assert_eq!(before, after);

    // 4. 文件操作透传远端失败
    set_reply(|_| Reply { stdout: vec![], stderr: b"Permission denied".to_vec(), code: 1, capture_stdin: false });
    for (endpoint, body) in [
        ("/fs/mkdir", json!({ "host": host_id, "path": "/test/new" })),
        ("/fs/newfile", json!({ "host": host_id, "path": "/test/file" })),
        ("/fs/rename", json!({ "host": host_id, "from": "/test/old", "to": "/test/new" })),
    ] {
        let (status, result) = request(&base, endpoint, Some(body)).await;
        assert_eq!(status, 400, "{endpoint}");
        assert!(result["error"].as_str().unwrap().contains("Permission denied"), "{endpoint}: {result}");
    }
    for endpoint in [format!("/fs/list?host={host_id}&path=/test/missing"), format!("/fs/read?host={host_id}&path=/test/missing")] {
        let (status, result) = request(&base, &endpoint, None).await;
        assert_eq!(status, 400, "{endpoint}");
        assert!(result["error"].as_str().unwrap().contains("Permission denied"), "{endpoint}");
    }

    // 5. 部分回收站移动保留元数据
    set_reply(|cmd| {
        if cmd.starts_with("mkdir -p \"$HOME/.shellpilot-trash\"") {
            Reply::out("/home/test/.shellpilot-trash\n")
        } else if cmd.starts_with("mv --") {
            let mut count = TRASH_MOVES.lock().unwrap();
            *count += 1;
            if *count == 1 {
                Reply::code(0)
            } else {
                Reply { stdout: vec![], stderr: b"second move denied".to_vec(), code: 1, capture_stdin: false }
            }
        } else {
            Reply::code(0)
        }
    });
    let (status, result) = request(&base, "/fs/delete", Some(json!({
        "host": host_id, "paths": ["/test/first", "/test/second"]
    }))).await;
    assert_eq!(status, 400);
    assert!(result["error"].as_str().unwrap().contains("second move denied"));
    let meta = saved(&data_dir, &format!("trash-{host_id}.json"));
    assert_eq!(meta.as_array().unwrap().len(), 1);
    assert_eq!(meta[0]["origPath"], json!("/test/first"));

    // 6. 上传保真 + 非法文件名不触达 SSH
    let bytes: Vec<u8> = vec![0, 255, 128, 1, 2, 3];
    set_reply(|_| Reply { stdout: vec![], stderr: vec![], code: 0, capture_stdin: true });
    CAPTURED_STDIN.lock().unwrap().clear();
    let (status, _) = request(&base, "/fs/upload-chunk", Some(json!({
        "host": host_id, "dir": "/test", "name": "valid.bin",
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes)
    }))).await;
    assert_eq!(status, 200);
    let captured = CAPTURED_STDIN.lock().unwrap().concat();
    assert_eq!(captured, bytes);
    let cmd_count = fs_commands().len();
    for name in [".", "..", "bad/name", "bad\0name"] {
        let (status, _) = request(&base, "/fs/upload-chunk", Some(json!({
            "host": host_id, "dir": "/test", "name": name, "data": ""
        }))).await;
        assert_eq!(status, 400, "{name}");
    }
    assert_eq!(fs_commands().len(), cmd_count);

    // 7. 压缩：以 - 开头的名字按文件名处理
    set_reply(|_| Reply::code(0));
    let (status, _) = request(&base, "/fs/compress", Some(json!({
        "host": host_id, "paths": ["/test/--checkpoint=1"], "destFile": "/test/archive.tar.gz"
    }))).await;
    assert_eq!(status, 200);
    let last = fs_commands().last().unwrap().clone();
    assert!(last.contains("-C '/test' -- '--checkpoint=1'"), "{last}");

    // 8. paste 拒绝越界名
    let count = fs_commands().len();
    for as_name in ["../outside", "..", "bad\0name"] {
        let (status, _) = request(&base, "/fs/paste", Some(json!({
            "host": host_id, "destDir": "/test",
            "items": [{ "host": host_id, "path": "/source/file", "kind": "copy", "asName": as_name }]
        }))).await;
        assert_eq!(status, 400, "{as_name}");
    }
    assert_eq!(fs_commands().len(), count);

    // 9. 下载：远端读失败返回 400
    set_reply(|cmd| {
        if cmd.starts_with("[ -d ") {
            Reply::out("F\n")
        } else {
            Reply { stdout: vec![], stderr: b"Permission denied".to_vec(), code: 1, capture_stdin: false }
        }
    });
    let resp = reqwest::Client::new()
        .get(format!("{base}/api/fs/download?host={host_id}&path=/test/missing"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
    assert!(resp.text().await.unwrap().contains("Permission denied"));

    // 10. 下载保真（二进制 + 空文件）
    let big: Vec<u8> = (0..600000u32).map(|i| (i % 256) as u8).collect();
    for content in [big.clone(), vec![]] {
        let content_clone = content.clone();
        set_reply(move |cmd| {
            if cmd.starts_with("[ -d ") {
                Reply::out("F\n")
            } else {
                Reply { stdout: content_clone.clone(), stderr: vec![], code: 0, capture_stdin: false }
            }
        });
        let resp = reqwest::Client::new()
            .get(format!("{base}/api/fs/download?host={host_id}&path=/test/file.bin"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers().get("content-type").unwrap(), "application/octet-stream");
        let body = resp.bytes().await.unwrap();
        assert_eq!(&body[..], &content[..]);
    }

    // 11. 部分下载失败：响应中断但后端存活
    set_reply(|cmd| {
        if cmd.starts_with("[ -d ") {
            Reply::out("F\n")
        } else {
            Reply { stdout: vec![0xa5; 600000], stderr: b"remote read failed".to_vec(), code: 1, capture_stdin: false }
        }
    });
    let resp = reqwest::Client::new()
        .get(format!("{base}/api/fs/download?host={host_id}&path=/test/partial.bin"))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .unwrap();
    let result = resp.bytes().await;
    assert!(result.is_err(), "partial download should abort");
    let (status, _) = request(&base, "/hosts", None).await;
    assert_eq!(status, 200);

    // 12. 并发文件请求共享单条 SSH 连接
    set_reply(|_| Reply::code(0));
    let (status, created) = request(&base, "/hosts", Some(json!({
        "name": "mock-parallel", "host": "127.0.0.1", "port": ssh_port, "username": "parallel", "password": "test"
    }))).await;
    assert_eq!(status, 200);
    let id2 = created["id"].as_str().unwrap().to_string();
    let mut set = Vec::new();
    for _ in 0..6 {
        let body = json!({ "host": id2, "path": "/test/parallel" });
        set.push(request(&base, "/fs/mkdir", Some(body)));
    }
    let results = futures_util::future::join_all(set).await;
    assert!(results.iter().all(|(s, _)| *s == 200));
    let used = CONN_RECORDS
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.iter().any(|c| c.starts_with("mkdir -p -- '/test/parallel'")))
        .count();
    assert_eq!(used, 1, "expected one shared connection");

    child.kill().await.ok();
    let _ = std::fs::remove_dir_all(&data_dir);
}

static TRASH_MOVES: LazyLock<Mutex<i32>> = LazyLock::new(|| Mutex::new(0));

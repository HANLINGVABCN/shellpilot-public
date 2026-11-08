use serde_json::{json,Value};
use tokio::io::{AsyncBufReadExt,AsyncWriteExt,BufReader};

#[tokio::test]
async fn mcp_protocol_permissions_and_scope() {
    let dir=std::env::temp_dir().join(format!("sp-mcp-{}",uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("hosts.json"),json!([
        {"id":"a","name":"web","host":"127.0.0.1","port":1,"password":"never-output"},
        {"id":"b","name":"web","host":"127.0.0.1","port":2}
    ]).to_string()).unwrap();
    std::fs::write(dir.join("settings.json"),json!({"mcpEnabled":true,"mcpReadOnly":true,"mcpHostIds":["a"]}).to_string()).unwrap();
    let mut child=tokio::process::Command::new(env!("CARGO_BIN_EXE_shellpilot-server")).arg("--mcp")
        .env("SHELLPILOT_DATA",&dir).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).kill_on_drop(true).spawn().unwrap();
    let mut input=child.stdin.take().unwrap();
    let mut lines=BufReader::new(child.stdout.take().unwrap()).lines();
    input.write_all(b"bad-json\n").await.unwrap();
    let invalid:Value=serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(invalid["error"]["code"],-32700);
    input.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}\n").await.unwrap();
    let init:Value=serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(init["result"]["protocolVersion"],"2025-06-18");
    input.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n").await.unwrap();
    for (id,name,args) in [(2,"vps_list",json!({})),(3,"vps_exec",json!({"host":"a","command":"touch /tmp/must-not-execute"})),(4,"vps_exec",json!({"host":"b","command":"ls"}))] {
        input.write_all(format!("{}\n",json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":args}})).as_bytes()).await.unwrap();
        let response:Value=serde_json::from_str(&tokio::time::timeout(std::time::Duration::from_secs(5),lines.next_line()).await.unwrap().unwrap().unwrap()).unwrap();
        assert_eq!(response["id"],id);
        if id==2 {
            let result=&response["result"]["structuredContent"]["result"];
            assert_eq!(result.as_array().unwrap().len(),1);
            assert_eq!(result[0]["id"],"a");
            assert!(!response.to_string().contains("never-output"));
        } else { assert_eq!(response["result"]["isError"],true); }
    }
    child.kill().await.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

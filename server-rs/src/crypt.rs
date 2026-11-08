// 导入/导出加密：与 Node 版 (server/crypt.js) 完全同格式
// 文件格式：magic "SPEXPT01"(8) + salt(16) + nonce(12) + AES-256-GCM 密文(含 16B tag)
use serde_json::Value;
// 密钥派生：sha256(password+salt) 起步，迭代 out=sha256(out + i_le32 + salt)，取第 2500 轮结果
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use sha2::{Digest, Sha256};

pub const MAGIC: &[u8; 8] = b"SPEXPT01";

/// Node: deriveKey —— 2500 轮迭代后返回前 32 字节
fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hasher.update(salt);
    out.copy_from_slice(&hasher.finalize());
    for i in 0..10000u32 {
        let mut h = Sha256::new();
        h.update(out);
        h.update(i.to_le_bytes());
        h.update(salt);
        out.copy_from_slice(&h.finalize());
        if i % 2500 == 2499 {
            break;
        }
    }
    out
}

pub fn encrypt_data(plaintext: &[u8], password: &str) -> Vec<u8> {
    let salt: [u8; 16] = rand::random();
    let nonce_bytes: [u8; 12] = rand::random();
    let key = derive_key(password, &salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload { msg: plaintext, aad: b"" },
        )
        .expect("aes-gcm encrypt");
    let mut out = Vec::with_capacity(36 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    out
}

pub fn decrypt_data(data: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if data.len() < 36 || &data[..8] != MAGIC {
        return Err("文件格式不正确或不是 ShellPilot 导出文件".into());
    }
    let salt = &data[8..24];
    let nonce_bytes = &data[24..36];
    let ct = &data[36..];
    if ct.len() < 16 {
        return Err("密码错误或文件已损坏".into());
    }
    let key = derive_key(password, salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher
        .decrypt(
            Nonce::from_slice(nonce_bytes),
            Payload { msg: ct, aad: b"" },
        )
        .map_err(|_| "密码错误或文件已损坏".into())
}

/// Node: exportAll —— 直接读磁盘上的三份配置
pub fn export_all() -> Value {
    serde_json::json!({
        "version": 1,
        "exportedAt": crate::now_ms(),
        "hosts": crate::load_json_or("hosts.json", serde_json::json!([])),
        "settings": crate::load_json_or("settings.json", serde_json::json!({})),
        "chats": crate::load_json_or("chats.json", serde_json::json!({})),
        "memories": crate::memories::list()
    })
}

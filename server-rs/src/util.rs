// 通用小工具：随机 ID、时间戳、远端 shell 引号、路径校验
use rand::Rng;
use serde_json::Value;

const B36: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// Node: p + '_' + Math.random().toString(36).slice(2, 10)
pub fn rand_id(prefix: &str) -> String {
    let mut rng = rand::thread_rng();
    let s: String = (0..8).map(|_| B36[rng.gen_range(0..36)] as char).collect();
    format!("{prefix}_{s}")
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Node: shq —— 远端 shell 的单引号包裹
pub fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Node: validPath
pub fn valid_path(p: &str) -> bool {
    p.starts_with('/') && !p.contains('\0') && p.chars().count() < 2000
}

/// Node: validFileName
pub fn valid_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\0')
        && name.len() <= 255
}

/// Node: baseName —— 去掉尾部斜杠后取最后一段；空则视为 '/'
pub fn base_name(p: &str) -> String {
    let trimmed = p.trim_end_matches('/');
    match trimmed.rsplit('/').next() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => "/".to_string(),
    }
}

/// JS Number(value) 的常用子集（端口等字段的宽松数值化）
pub fn js_number(v: &Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else if t.starts_with("0x") || t.starts_with("0X") {
                i64::from_str_radix(&t[2..], 16).ok().map(|x| x as f64)
            } else {
                t.parse::<f64>().ok()
            }
        }
        serde_json::Value::Null => Some(0.0),
        _ => None,
    }
}

/// Node: Number(port) || 22
pub fn port_or_default(v: &Value) -> i64 {
    js_number(v).filter(|p| *p != 0.0).map(|p| p as i64).unwrap_or(22)
}

/// path.posix.dirname 的等价实现（Node 在 restore / compress 里使用）
pub fn posix_dirname(p: &str) -> String {
    let trimmed = p.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => trimmed[..i].to_string(),
        None => ".".to_string(),
    }
}

/// Node: path.posix.normalize(list[0]) 只用于 dirname 前的规范化（去尾部斜杠即可满足压缩场景）
pub fn posix_normalize_strip(p: &str) -> String {
    p.trim_end_matches('/').to_string()
}

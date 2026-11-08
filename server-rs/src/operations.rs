//! Shared, bounded operations for the built-in assistant and MCP clients.
use crate::{pool, util::shq, AppState};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub const OUTPUT_LIMIT: usize = 64 * 1024;

pub fn normalize_scope(hosts:&[Value],ids:&[String])->Vec<String> {
    let valid:std::collections::HashSet<&str>=hosts.iter().filter_map(|host|host["id"].as_str()).collect();
    let mut seen=std::collections::HashSet::new();
    ids.iter().filter(|id|valid.contains(id.as_str()) && seen.insert(id.as_str())).cloned().collect()
}

pub fn text_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("缺少或无效的 {key} 参数"))
}

pub fn resolve_host(hosts: &[Value], scope: &[String], query: &str) -> Result<Value, String> {
    let permitted: Vec<&Value> = hosts.iter().filter(|h| {
        scope.iter().any(|id| h["id"].as_str() == Some(id.as_str()))
    }).collect();
    if permitted.is_empty() { return Err("没有已授权的服务器，请先选择机器范围".into()); }
    let q = query.trim();
    let matches: Vec<&Value> = if q.is_empty() {
        permitted
    } else {
        // Stable IDs take precedence; names and addresses must be unambiguous.
        if let Some(h) = permitted.iter().find(|h| h["id"].as_str() == Some(q)) { return Ok((*h).clone()); }
        permitted.into_iter().filter(|h| ["name", "host"].iter().any(|k| {
            h[*k].as_str().map(|s| s.eq_ignore_ascii_case(q)).unwrap_or(false)
        })).collect()
    };
    match matches.as_slice() {
        [h] => Ok((*h).clone()),
        [] => Err(format!("目标「{q}」不存在或不在授权范围，请使用主机 ID")),
        _ => Err(format!("目标「{q}」匹配多台机器，请使用唯一主机 ID")),
    }
}

pub fn hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

pub fn safe_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.contains('\0') || path.contains(['\n', '\r']) {
        return Err("请提供有效的远程绝对路径".into());
    }
    Ok(())
}

pub fn diagnose_command(args: &Value) -> Result<String, String> {
    let area = args.get("area").and_then(Value::as_str).unwrap_or("overview");
    let command = match area {
        "overview" => "printf '\\n=== SYSTEM ===\\n'; uname -a; uptime; printf '\\n=== MEMORY ===\\n'; free -m; printf '\\n=== DISK ===\\n'; df -h; printf '\\n=== FAILED SERVICES ===\\n'; systemctl --failed --no-pager 2>/dev/null; printf '\\n=== TOP PROCESSES ===\\n'; ps -eo pid,ppid,user,%cpu,%mem,stat,comm --sort=-%cpu | head -21",
        "cpu" => "uptime; getconf _NPROCESSORS_ONLN; ps -eo pid,ppid,user,%cpu,%mem,stat,comm --sort=-%cpu | head -31; vmstat 1 3",
        "memory" => "free -m; cat /proc/meminfo; ps -eo pid,user,rss,%mem,comm --sort=-rss | head -31; vmstat 1 3",
        "disk" => "df -h; df -i; lsblk; cat /proc/diskstats",
        "network" => "ip -brief address; ip route show; ss -s; ss -tuln; cat /proc/net/dev",
        "service" => {
            let unit = unit_arg(args)?;
            return Ok(format!("systemctl status --no-pager -- {}; journalctl --no-pager -n 60 -u {}", shq(unit), shq(unit)));
        }
        _ => return Err("area 应为 overview、cpu、memory、disk、network 或 service".into()),
    };
    Ok(command.into())
}

fn unit_arg(args: &Value) -> Result<&str, String> {
    let unit = text_arg(args, "unit")?;
    if unit.starts_with('-') || !unit.chars().all(|c| c.is_ascii_alphanumeric() || "._@:-".contains(c)) {
        return Err("无效的服务名称".into());
    }
    Ok(unit)
}

pub fn logs_command(args: &Value) -> Result<String, String> {
    let unit = unit_arg(args)?;
    let lines = args.get("lines").and_then(Value::as_u64).unwrap_or(100).clamp(1, 500);
    let since = args.get("since").and_then(Value::as_str).unwrap_or("1 hour ago");
    if since.len() > 80 || since.contains(['\0', '\r', '\n']) { return Err("无效的 since 参数".into()); }
    Ok(format!("journalctl --no-pager -n {lines} -u {} --since {}", shq(unit), shq(since)))
}

pub async fn read_file(st: &Arc<AppState>, host_id: &str, args: &Value) -> Result<Value, String> {
    let path = text_arg(args, "path")?;
    safe_path(path)?;
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(16 * 1024).clamp(1, OUTPUT_LIMIT as u64);
    let cmd = format!("test -f {p} && test -r {p} && dd if={p} bs=1 skip={offset} count={} 2>/dev/null", limit + 1, p = shq(path));
    let output = pool::exec_result(st, host_id, &cmd, 30000, (limit as usize + 4).min(OUTPUT_LIMIT)).await?;
    if output.exit_code != 0 { return Err(format!("读取失败（退出码 {}）：{}",output.exit_code,output.stderr)); }
    let truncated = output.truncated || output.stdout.len() > limit as usize;
    let mut content = output.stdout;
    let mut end = (limit as usize).min(content.len());
    while !content.is_char_boundary(end) { end -= 1; }
    content.truncate(end);
    Ok(json!({ "path": path, "offset": offset, "content": content, "truncated": truncated,
        "nextOffset": offset + content.len() as u64, "sha256": if offset == 0 && !truncated { Some(hash(&content)) } else { None } }))
}

pub async fn file_preview(st: &Arc<AppState>, host_id: &str, args: &Value) -> Result<Value, String> {
    let path = text_arg(args, "path")?;
    safe_path(path)?;
    let content = args.get("content").and_then(Value::as_str).ok_or("缺少 content 参数")?;
    if content.len() > OUTPUT_LIMIT { return Err("单次写入最多 64 KiB，请缩小文件".into()); }
    let exists = pool::exec_on_host(st, host_id, &format!("if test -e {p}; then test -f {p} && test ! -L {p} && printf exists; else printf missing; fi", p = shq(path)), 10000).await? == "exists";
    let before = if exists {
        let value = read_file(st, host_id, &json!({ "path": path, "limit": OUTPUT_LIMIT })).await?;
        if value["truncated"] == true { return Err("原文件超过 64 KiB，无法安全预览".into()); }
        value["content"].as_str().unwrap_or("").to_string()
    } else { String::new() };
    Ok(json!({ "path": path, "exists": exists, "before": before, "after": content,
        "expectedHash": if exists { hash(&before) } else { "missing".into() }, "newHash": hash(content),
        "changed": !exists || before != content, "preview": true }))
}

/// Checked, atomic replacement. An unchanged preview never rewrites the file.
pub async fn write_file(st: &Arc<AppState>, host_id: &str, args: &Value) -> Result<Value, String> {
    let preview = file_preview(st, host_id, args).await?;
    if args.get("preview").and_then(Value::as_bool).unwrap_or(true) { return Ok(preview); }
    let expected = text_arg(args, "expectedHash")?;
    if preview["expectedHash"].as_str() != Some(expected) { return Err("文件已变化，请重新预览后再修改".into()); }
    if preview["changed"] == false { return Ok(json!({ "path": preview["path"], "changed": false })); }
    let path = text_arg(args, "path")?;
    let content = args["content"].as_str().unwrap();
    let token = crate::rand_id("sp");
    let temporary = format!("{path}.{token}.tmp");
    let backup = format!("{path}.{token}.bak");
    let p = shq(path);
    let t = shq(&temporary);
    let b = shq(&backup);
    let cleanup = shq(&format!("rm -f -- {t}"));
    let check = if expected == "missing" {
        format!("test ! -e {p}")
    } else {
        format!("test -f {p} && test ! -L {p} && test \"$(sha256sum -- {p} | cut -d ' ' -f 1)\" = {}", shq(expected))
    };
    let cmd = format!("set -eu; {check}; umask 077; trap {cleanup} EXIT; cat > {t}; if test -e {p}; then cp -p -- {p} {b}; chmod --reference={p} -- {t}; chown --reference={p} -- {t}; fi; {check}; mv -- {t} {p}; sha256sum -- {p}");
    let output = pool::exec_stdin_on_host(st, host_id, &cmd, content.as_bytes().to_vec(), 60000).await.map_err(|e| e.message)?;
    if !output.starts_with(&hash(content)) { return Err("写入后的校验失败，请检查备份".into()); }
    Ok(json!({ "path": path, "changed": true, "sha256": hash(content),
        "backup": if preview["exists"] == true { Some(backup) } else { None }, "verified": true }))
}

pub fn schemas() -> Vec<Value> {
    let host = json!({"type":"string","description":"授权范围内的主机 ID 或唯一名称"});
    let mut tools = Vec::new();
    let mut add = |name: &str, description: &str, properties: Value, required: Vec<&str>| {
        tools.push(json!({ "name": name, "description": description, "inputSchema": {
            "type": "object", "properties": properties, "required": required, "additionalProperties": false } }));
    };
    add("vps_list", "列出已授权主机，不包含凭据；优先使用返回的 ID", json!({}), vec![]);
    add("vps_exec", "执行命令，返回退出码、stdout、stderr和截断状态。修改操作受权限策略控制", json!({"host":host,"command":{"type":"string"},"timeout":{"type":"integer","minimum":1,"maximum":600},"maxOutput":{"type":"integer","minimum":1024,"maximum":65536}}), vec!["host","command"]);
    add("vps_exec_batch", "并行执行独立的只读命令，最多16条、4个并发，减少往返；写操作必须单独执行", json!({"commands":{"type":"array","maxItems":16,"minItems":1,"items":{"type":"object","properties":{"host":host,"command":{"type":"string"},"timeout":{"type":"integer"}},"required":["host","command"],"additionalProperties":false}}}), vec!["commands"]);
    add("vps_read_file", "分页读取文本文件，返回内容、偏移、截断标记及完整文件哈希；不要读取凭据", json!({"host":host,"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":65536}}), vec!["host","path"]);
    add("vps_write_file", "先预览 before/after 和 expectedHash；确认后传 preview=false、expectedHash。自动备份、原子替换并校验", json!({"host":host,"path":{"type":"string"},"content":{"type":"string","maxLength":65536},"preview":{"type":"boolean","default":true},"expectedHash":{"type":"string"}}), vec!["host","path","content"]);
    add("vps_metrics", "获取指定主机的实时性能指标", json!({"host":host}), vec!["host"]);
    add("vps_metrics_batch", "一次并行获取多台主机指标；省略 hosts 则查询本次授权范围", json!({"hosts":{"type":"array","maxItems":16,"items":{"type":"string"}}}), vec![]);
    add("vps_diagnose", "一次收集完整诊断证据；CPU/内存/磁盘/网络/服务故障优先使用此工具，减少逐条执行命令", json!({"host":host,"area":{"type":"string","enum":["overview","cpu","memory","disk","network","service"]},"unit":{"type":"string"}}), vec!["host"]);
    add("vps_logs", "按服务和时间窗口查询日志，最多500行", json!({"host":host,"unit":{"type":"string"},"since":{"type":"string"},"lines":{"type":"integer","minimum":1,"maximum":500}}), vec!["host","unit"]);
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_resolution_never_guesses() {
        let hosts = vec![json!({"id":"a","name":"web","host":"one"}), json!({"id":"b","name":"web","host":"two"})];
        let scope = vec!["a".into(), "b".into()];
        assert!(resolve_host(&hosts, &scope, "web").is_err());
        assert!(resolve_host(&hosts, &scope, "we").is_err());
        assert_eq!(resolve_host(&hosts, &scope, "b").unwrap()["id"], "b");
        assert!(resolve_host(&hosts, &["a".into()], "b").is_err());
    }
    #[test]
    fn scopes_remove_deleted_and_duplicate_host_ids() {
        let hosts=vec![json!({"id":"a"}),json!({"id":"b"}),json!({"id":"c"})];
        assert_eq!(normalize_scope(&hosts,&["a".into(),"b".into(),"c".into(),"deleted".into(),"a".into()]),vec!["a","b","c"]);
        assert!(normalize_scope(&hosts,&[]).is_empty());
    }
    #[test]
    fn diagnostic_arguments_cannot_inject_commands() {
        assert!(diagnose_command(&json!({"area":"service","unit":"nginx; reboot"})).is_err());
        assert!(logs_command(&json!({"unit":"--rotate"})).is_err());
        assert!(safe_path("relative").is_err());
        assert!(safe_path("/etc/a\nrm").is_err());
        assert!(logs_command(&json!({"unit":"nginx","since":"';touch /tmp/a;#"})).unwrap().contains("'\\''"));
    }
}

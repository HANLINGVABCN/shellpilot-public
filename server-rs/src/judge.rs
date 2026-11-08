// AI 审批官：用一个小模型自动审查主 AI 想执行的危险命令（对应 server/judge.js）
use crate::ai::{chat_completion_stream, StreamOpts};
use crate::safety::safety_check;
use serde_json::{json, Value};
use std::pin::Pin;
use std::sync::Arc;

const JUDGE_SYSTEM: &str = r#"你是 Linux 服务器的 AI 安全审批官。主 AI 助手想在服务器上执行一条命令，由你来判断放行还是拒绝。

判断标准：
- 只读、诊断类命令（查看文件、服务状态、日志、指标、端口）→ allow
- 与用户当前任务直接相关、是完成用户明确要求的必要步骤的写操作 → allow
- 删库、格式化、改关键系统配置、下载并执行来路不明的脚本、明显超出任务范围的破坏性操作 → deny
- 信息不足时，先调用 get_context 工具跑只读命令收集证据（最多 2 次），再决定
- 你只做审批，不要在理由里建议执行其他命令

最终回复必须是纯 JSON，不要包 markdown 代码块：
{"decision":"allow","reason":"一句话中文理由"}
或 {"decision":"deny","reason":"一句话中文理由"}"#;

const JUDGE_TOOLS: &str = r#"[{
    "type": "function",
    "function": {
        "name": "get_context",
        "description": "执行一条只读命令来收集审批所需的上下文信息",
        "parameters": {
            "type": "object",
            "properties": { "command": { "type": "string", "description": "只读 shell 命令" } },
            "required": ["command"]
        }
    }
}]"#;

pub type ExecFuture = Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>>;

pub struct JudgeInput {
    pub cmd: String,
    pub host_id: String,
    pub host_name: String,
    pub os_info: String,
    pub metrics: String,
    pub agent_messages: Vec<Value>,
    pub exec_on: Arc<dyn Fn(String, u64) -> ExecFuture + Send + Sync>,
}

/// Node: aiJudge —— 最多 3 轮；三轮无效 → None（转人工）
pub async fn ai_judge(input: JudgeInput) -> Result<Option<(String, String)>, String> {
    let settings = crate::get_settings();
    let judge_model = settings
        .get("models")
        .and_then(|m| m.as_array())
        .and_then(|models| {
            models
                .iter()
                .find(|m| m.get("id").and_then(|v| v.as_str()) == settings.get("approverModelId").and_then(|v| v.as_str()))
        })
        .cloned();
    let Some(judge_model) = judge_model else { return Ok(None) };
    let provider = settings
        .get("providers")
        .and_then(|p| p.as_array())
        .and_then(|providers| {
            providers
                .iter()
                .find(|p| p.get("id").and_then(|v| v.as_str()) == judge_model.get("providerId").and_then(|v| v.as_str()))
        })
        .cloned();
    let Some(provider) = provider else { return Ok(None) };

    let base_url = provider.get("baseURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let api_key = provider.get("apiKey").and_then(|v| v.as_str()).map(String::from);
    let model_name = judge_model.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Node: 最近 6 条消息，content 截 400 字
    let recent: Vec<Value> = input
        .agent_messages
        .iter()
        .rev()
        .take(6)
        .rev()
        .filter_map(|m| {
            let content = match m.get("content") {
                Some(Value::String(s)) => {
                    let cut: String = s.chars().take(400).collect();
                    if cut.is_empty() {
                        return None;
                    }
                    cut
                }
                _ => return None,
            };
            Some(json!({
                "role": m.get("role").cloned().unwrap_or(Value::Null),
                "content": content
            }))
        })
        .collect();

    let payload = json!({
        "待审批命令": input.cmd,
        "目标机器": input.host_name,
        "服务器信息": if input.os_info.is_empty() { "未知" } else { &input.os_info },
        "实时性能": if input.metrics.is_empty() { "暂无" } else { &input.metrics },
        "最近对话": recent
    });
    // Node: JSON.stringify(payload, null, 1)
    let payload_str = indent_json(&payload, 1);

    let mut messages: Vec<Value> = vec![
        json!({ "role": "system", "content": JUDGE_SYSTEM }),
        json!({ "role": "user", "content": payload_str }),
    ];
    let tools: Value = serde_json::from_str(JUDGE_TOOLS).unwrap();

    for _round in 0..3 {
        let result = chat_completion_stream(StreamOpts {
            base_url: base_url.clone(),
            api_key: api_key.clone(),
            model: model_name.clone(),
            messages: json!(messages),
            tools: Some(tools.clone()),
            temperature: Some(0.0),
            max_tokens: Some(400),
            reasoning_effort: None,
            on_reasoning: None,
            on_delta: None,
        })
        .await?;

        if !result.tool_calls.is_empty() {
            messages.push(json!({
                "role": "assistant",
                "content": if result.content.is_empty() { Value::Null } else { json!(result.content) },
                "tool_calls": result.tool_calls
            }));
            for tc in &result.tool_calls {
                let args: Value =
                    serde_json::from_str(tc.pointer("/function/arguments").and_then(|v| v.as_str()).unwrap_or("{}"))
                        .unwrap_or(json!({}));
                let c = args.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let check = safety_check(&c);
                let out = if check.mode != "auto" {
                    "（不允许：审批官自身只能运行只读白名单命令）".to_string()
                } else {
                    match (input.exec_on)(c, 10000).await {
                        Ok(s) => {
                            let s = if s.is_empty() { "(无输出)".to_string() } else { s };
                            let cut: String = s.chars().take(1500).collect();
                            cut
                        }
                        Err(e) => format!("执行失败: {e}"),
                    }
                };
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tc.get("id").cloned().unwrap_or(Value::Null),
                    "content": out
                }));
            }
            continue;
        }

        // Node: (content).match(/\{[\s\S]*\}/) —— 贪婪：从第一个 { 到最后一个 }
        let content = result.content;
        if let (Some(start), Some(end)) = (content.find('{'), content.rfind('}')) {
            if end > start {
                if let Ok(j) = serde_json::from_str::<Value>(&content[start..=end]) {
                    let decision = j.get("decision").and_then(|v| v.as_str()).unwrap_or("");
                    if decision == "allow" || decision == "deny" {
                        let reason = j
                            .get("reason")
                            .and_then(|v| v.as_str())
                            .map(|s| {
                                let cut: String = s.chars().take(200).collect();
                                cut
                            })
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| "（未给出理由）".into());
                        return Ok(Some((decision.to_string(), reason)));
                    }
                }
            }
        }
    }
    Ok(None)
}

/// JSON.stringify(value, null, indent) 的等价实现
fn indent_json(v: &Value, indent: usize) -> String {
    fn write(v: &Value, indent: usize, depth: usize, out: &mut String) {
        let pad = " ".repeat(indent * depth);
        let pad_child = " ".repeat(indent * (depth + 1));
        match v {
            Value::Object(map) => {
                if map.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push_str("{\n");
                for (i, (k, val)) in map.iter().enumerate() {
                    out.push_str(&pad_child);
                    out.push_str(&serde_json::to_string(k).unwrap());
                    out.push_str(": ");
                    write(val, indent, depth + 1, out);
                    if i + 1 < map.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&pad);
                out.push('}');
            }
            Value::Array(arr) => {
                if arr.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push_str("[\n");
                for (i, val) in arr.iter().enumerate() {
                    out.push_str(&pad_child);
                    write(val, indent, depth + 1, out);
                    if i + 1 < arr.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&pad);
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut s = String::new();
    write(v, indent, 0, &mut s);
    s
}

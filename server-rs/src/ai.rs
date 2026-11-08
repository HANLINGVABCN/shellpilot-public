// 调用 OpenAI 兼容接口（/chat/completions 与 /models），兼容 GLM、DeepSeek、OpenAI 等（对应 server/ai.js）

use serde_json::{json, Value};
use std::collections::HashSet;

use std::sync::{LazyLock, Mutex};

/// Node: friendlyFetchError —— 把底层报错翻译成能看懂的人话
pub fn friendly_fetch_error(e: &reqwest::Error) -> String {
    let mut chain = String::new();
    let mut src: Option<&dyn std::error::Error> = Some(e);
    while let Some(s) = src {
        chain.push_str(&s.to_string());
        chain.push(' ');
        src = s.source();
    }
    let msg = chain.to_lowercase();
    if msg.contains("lookup") || msg.contains("resolve") || msg.contains("temporary failure") || msg.contains("name or service") {
        return "域名解析失败：检查 Base URL 拼写，或本机网络/DNS 是否正常".into();
    }
    if msg.contains("refused") {
        return "连接被拒绝：服务没开或地址/端口不对".into();
    }
    if msg.contains("reset") || msg.contains("broken pipe") || msg.contains("connection closed before message completed") {
        return "连接被中断：网络不稳或对方服务异常".into();
    }
    if msg.contains("timed out") || msg.contains("timeout") || msg.contains("deadline") {
        return "连接超时：网络不通、代理干扰，或地址写错".into();
    }
    if msg.contains("certificate") || msg.contains("ssl") || msg.contains("tls") || msg.contains("invalid peer certificate") {
        return "HTTPS 证书异常：检查系统时间或代理".into();
    }
    let display = e.to_string();
    if display == "fetch failed" {
        "网络请求失败：检查网络和 Base URL".into()
    } else {
        display
    }
}

// ---------- 思考深度：各模型接口的参数方言自动翻译 ----------
static UNSUPPORTED_THINKING: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Node: buildThinkingParams
pub fn build_thinking_params(model: &str, effort: &str) -> Value {
    if effort.is_empty() || effort == "off" {
        return json!({});
    }
    let m = model.to_lowercase();
    let level = if ["minimal", "low", "medium", "high"].contains(&effort) {
        effort
    } else {
        "medium"
    };
    let budget = match level {
        "minimal" => 1024,
        "low" => 2048,
        "medium" => 8192,
        _ => 16384,
    };
    let re_glm = regex::Regex::new(r"glm|chatglm|zhipu").unwrap();
    let re_qwen = regex::Regex::new(r"qwen|qwq").unwrap();
    let re_claude = regex::Regex::new(r"claude").unwrap();
    if re_glm.is_match(&m) {
        json!({ "thinking": { "type": "enabled" } })
    } else if re_qwen.is_match(&m) {
        json!({ "enable_thinking": true, "thinking_budget": budget })
    } else if re_claude.is_match(&m) {
        json!({ "thinking": { "type": "enabled", "budget_tokens": budget } })
    } else {
        json!({ "reasoning_effort": level })
    }
}

fn is_generic_unknown_param_error(text: &str) -> bool {
    let re = regex::Regex::new(
        r#"(?i)(unknown|unrecognized|unexpected|unsupported|invalid)[^\n]{0,40}(parameter|argument|field|key)|not\s+support|不支持的参数|无效的参数"#,
    )
    .unwrap();
    re.is_match(text)
}

fn mentions_any_param(text: &str, keys: &[String]) -> bool {
    let t = text.to_lowercase();
    keys.iter().any(|k| t.contains(&k.to_lowercase()))
}

fn http_client() -> reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .expect("reqwest client"));
    CLIENT.clone()
}

pub struct StreamOpts {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub messages: Value,
    pub tools: Option<Value>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub reasoning_effort: Option<String>,
    pub on_reasoning: Option<Box<dyn Fn(&str) + Send>>,
    pub on_delta: Option<Box<dyn Fn(&str) + Send>>,
}

#[derive(Default)]
pub struct StreamResult {
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<Value>,
    pub usage: Option<Value>,
    pub finish_reason: Option<String>,
    pub done: bool,
    pub generation_ms:u64,
}

/// Node: chatCompletionStream —— SSE 流式解析 + 思考参数黑名单重试
pub async fn chat_completion_stream(opts: StreamOpts) -> Result<StreamResult, String> {
    let url = format!("{}/chat/completions", opts.base_url.trim_end_matches('/'));
    let client = http_client();
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Content-Type", "application/json".parse().unwrap());
    if let Some(k) = &opts.api_key {
        if !k.is_empty() {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("Bearer {k}")) {
                headers.insert("Authorization", v);
            }
        }
    }

    let mut base_body = serde_json::Map::new();
    base_body.insert("model".into(), json!(opts.model));
    base_body.insert("messages".into(), opts.messages.clone());
    if let Some(tools) = &opts.tools {
        base_body.insert("tools".into(), tools.clone());
        base_body.insert("tool_choice".into(), json!("auto"));
    }
    let native_reasoning = ["o1", "o3", "o4", "gpt-5"].iter().any(|prefix| opts.model.to_lowercase().starts_with(prefix));
    if let Some(t) = opts.temperature.filter(|_| !native_reasoning) {
        base_body.insert("temperature".into(), json!(t));
    }
    if let Some(m) = opts.max_tokens {
        base_body.insert(if native_reasoning { "max_completion_tokens" } else { "max_tokens" }.into(), json!(m));
    }
    let base_body = Value::Object(base_body);

    let think_params = match &opts.reasoning_effort {
        Some(e) if e != "off" => build_thinking_params(&opts.model, e),
        _ => json!({}),
    };
    let cache_key = format!("{}|{}", url, opts.model);
    let all_keys: Vec<String> = think_params
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let active_keys: Vec<String> = {
        let bl = UNSUPPORTED_THINKING.lock().unwrap();
        all_keys
            .iter()
            .filter(|k| !bl.contains(&format!("{}|{}", cache_key, k)))
            .cloned()
            .collect()
    };

    let do_fetch = |extra: &Value| {
        let mut body = base_body.clone();
        if let (Some(dst), Some(src)) = (body.as_object_mut(), extra.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
        body["stream"] = json!(true);
        let url = url.clone();
        let headers = headers.clone();
        let client = client.clone();
        async move {
            client
                .post(&url)
                .headers(headers)
                .body(body.to_string())
                .send()
                .await
                .map_err(|e| friendly_fetch_error(&e))
        }
    };

    let mut extra = serde_json::Map::new();
    for k in &active_keys {
        extra.insert(k.clone(), think_params[k].clone());
    }
    let mut res: Option<reqwest::Response> = Some(do_fetch(&Value::Object(extra)).await?);

    if !res.as_ref().unwrap().status().is_success() && !active_keys.is_empty() {
        let r = res.take().unwrap();
        let status = r.status();
        let err_text = r.text().await.unwrap_or_default();
        if mentions_any_param(&err_text, &active_keys) {
            // 接口明确不认识这个思考参数：记入黑名单，之后该模型不再携带
            {
                let mut bl = UNSUPPORTED_THINKING.lock().unwrap();
                for k in &active_keys {
                    bl.insert(format!("{}|{}", cache_key, k));
                }
            }
            res = Some(do_fetch(&json!({})).await?);
        } else if is_generic_unknown_param_error(&err_text) {
            // 泛化的"未知参数"错误：本次去掉思考参数重试，但不拉黑
            res = Some(do_fetch(&json!({})).await?);
        } else {
            return Err(format!(
                "模型接口返回 {}: {}",
                status.as_u16(),
                truncate(&err_text, 300)
            ));
        }
    }

    if !res.as_ref().unwrap().status().is_success() {
        let r = res.take().unwrap();
        let status = r.status().as_u16();
        let t = r.text().await.unwrap_or_default();
        return Err(format!("模型接口返回 {}: {}", status, truncate(&t, 300)));
    }
    let mut res = res.unwrap();

    // SSE 解析
    let stream_started=std::time::Instant::now();
    let mut first_output=None;
    let mut out = StreamResult::default();
    let mut tool_slots: Vec<Option<Value>> = Vec::new();
    use futures_util::StreamExt;
    let mut stream = res.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let chunk = match stream.next().await {
            Some(Ok(b)) => b,
            Some(Err(e)) => return Err(friendly_fetch_error(&e)),
            None => break,
        };
        pending.extend_from_slice(&chunk);
        if pending.len()>2*1024*1024 || out.content.len()+out.reasoning.len()>2*1024*1024 {
            return Err("模型响应超过大小上限，本轮工具未执行".into());
        }
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = pending.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
            process_line(&line, &mut out, &mut tool_slots, &opts)?;
            if first_output.is_none()&&(!out.content.is_empty()||!out.reasoning.is_empty()||!tool_slots.is_empty()){first_output=Some(std::time::Instant::now());}
        }
    }
    // 处理最后未换行的残余
    if !pending.is_empty() {
        let line = String::from_utf8_lossy(&pending).trim().to_string();
        process_line(&line, &mut out, &mut tool_slots, &opts)?;
    }
    out.tool_calls = tool_slots.into_iter().flatten().collect();
    if matches!(out.finish_reason.as_deref(), Some("length" | "content_filter")) {
        return Err("模型回复被截断或过滤，本轮工具未执行；请增加输出预算或缩小任务".into());
    }
    if !out.done && out.finish_reason.is_none() { return Err("模型响应流未完整结束，本轮工具未执行，请重试".into()); }
    for call in &out.tool_calls {
        if call["id"].as_str().unwrap_or("").is_empty() || call["function"]["name"].as_str().unwrap_or("").is_empty()
            || serde_json::from_str::<Value>(call["function"]["arguments"].as_str().unwrap_or("")).map(|v|!v.is_object()).unwrap_or(true) {
            return Err("模型返回不完整或无效的工具调用，本轮工具未执行".into());
        }
    }
    if out.content.is_empty() && out.tool_calls.is_empty() { return Err("模型没有返回正文或工具调用，请检查模型是否支持当前请求".into()); }
    out.generation_ms=first_output.unwrap_or(stream_started).elapsed().as_millis().max(1) as u64;
    Ok(out)
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn process_line(
    line: &str,
    out: &mut StreamResult,
    tool_slots: &mut Vec<Option<Value>>,
    opts: &StreamOpts,
) -> Result<(), String> {
    let Some(payload) = line.strip_prefix("data:") else { return Ok(()) };
    let payload = payload.trim();
    if payload.is_empty() { return Ok(()); }
    if payload == "[DONE]" {
        out.done = true;
        return Ok(());
    }
    let j = serde_json::from_str::<Value>(payload).map_err(|_| "模型返回无效的 SSE JSON".to_string())?;
    if let Some(error)=j.get("error") { return Err(format!("模型流返回错误：{}",truncate(&error.to_string(),300))); }
    if let Some(usage)=j.get("usage").filter(|v|!v.is_null()) { out.usage=Some(usage.clone()); }
    let Some(choice) = j.get("choices").and_then(|c| c.get(0)) else { return Ok(()) };
    if let Some(reason)=choice.get("finish_reason").and_then(Value::as_str) { out.finish_reason=Some(reason.into()); }
    let Some(d) = choice.get("delta") else { return Ok(()) };
    let reasoning_delta = d
        .get("reasoning_content")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| d.get("thought").and_then(|v| v.as_str()).filter(|s| !s.is_empty()));
    if let Some(t) = reasoning_delta {
        out.reasoning.push_str(t);
        if let Some(cb) = &opts.on_reasoning {
            cb(t);
        }
    }
    if let Some(t) = d.get("content").and_then(|v| v.as_str()) {
        if !t.is_empty() {
            out.content.push_str(t);
            if let Some(cb) = &opts.on_delta {
                cb(t);
            }
        }
    }
    if let Some(tcs) = d.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in tcs {
            let i = tc.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if i >= 16 { return Err("模型单轮工具调用超过16个".into()); }
            while tool_slots.len() <= i {
                tool_slots.push(None);
            }
            let slot = tool_slots[i]
                .get_or_insert_with(|| json!({ "id": "", "type": "function", "function": { "name": "", "arguments": "" } }));
            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                if !id.is_empty() {
                    slot["id"] = json!(id);
                }
            }
            if let Some(fname) = tc.pointer("/function/name").and_then(|v| v.as_str()) {
                if !fname.is_empty() {
                    slot["function"]["name"] =
                        json!(format!("{}{}", slot["function"]["name"].as_str().unwrap_or(""), fname));
                }
            }
            if let Some(fargs) = tc.pointer("/function/arguments").and_then(|v| v.as_str()) {
                if !fargs.is_empty() {
                    slot["function"]["arguments"] = json!(format!(
                        "{}{}",
                        slot["function"]["arguments"].as_str().unwrap_or(""),
                        fargs
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Node: fetchModelList
pub async fn fetch_model_list(base_url: &str, api_key: Option<&str>) -> Result<Vec<String>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut req = http_client().get(&url);
    if let Some(k) = api_key {
        if !k.is_empty() {
            req = req.header("Authorization", format!("Bearer {k}"));
        }
    }
    let res = req.send().await.map_err(|e| friendly_fetch_error(&e))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}（检查 Base URL 和 API Key 是否正确）", res.status().as_u16()));
    }
    let j: Value = res.json().await.map_err(|e| friendly_fetch_error(&e))?;
    let mut list: Vec<String> = j
        .get("data")
        .or_else(|| j.get("models"))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    m.get("id")
                        .and_then(|v| v.as_str())
                        .or_else(|| m.get("name").and_then(|v| v.as_str()))
                        .map(String::from)
                })
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    list.sort();
    Ok(list)
}

/// index.js: /api/ai/chat-test —— 用某个模型真实发一条消息验证全链路
pub async fn chat_test(base_url: &str, api_key: Option<&str>, model: &str) -> Result<(String, i64), String> {
    let t0 = crate::now_ms();
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut req = http_client().post(&url);
    if let Some(k) = api_key {
        if !k.is_empty() {
            req = req.header("Authorization", format!("Bearer {k}"));
        }
    }
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "请只回复两个字：成功" }],
        "max_tokens": 20,
        "temperature": 0
    });
    let res = req.json(&body).send().await.map_err(|e| friendly_fetch_error(&e))?;
    let status = res.status();
    let j: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let msg = j
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(msg);
    }
    let reply = j
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("(空回复)")
        .trim()
        .chars()
        .take(60)
        .collect::<String>();
    Ok((reply, crate::now_ms() - t0))
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn mock_stream(payload:&str)->Result<StreamResult,String> {
        use tokio::io::{AsyncReadExt,AsyncWriteExt};
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address=listener.local_addr().unwrap();
        let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",payload.len(),payload);
        tokio::spawn(async move {
            let (mut socket,_)=listener.accept().await.unwrap();
            let mut request=[0u8;8192];
            let _=socket.read(&mut request).await;
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        chat_completion_stream(StreamOpts {base_url:format!("http://{address}"),api_key:None,model:"test".into(),messages:json!([]),tools:None,
            temperature:None,max_tokens:None,reasoning_effort:None,on_reasoning:None,on_delta:None}).await
    }
    #[tokio::test]
    async fn incomplete_or_error_streams_cannot_execute_tools() {
        assert!(mock_stream("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n").await.is_err());
        assert!(mock_stream("data: {\"error\":{\"message\":\"upstream failed\"}}\n\ndata: [DONE]\n\n").await.is_err());
        assert!(mock_stream("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n").await.is_err());
        assert!(mock_stream("data: not-json\n\ndata: [DONE]\n\n").await.is_err());
    }
    #[tokio::test]
    async fn fragmented_tool_arguments_and_usage_are_preserved() {
        let payload=[
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"vps_exec","arguments":"{\"host\":\"a\","}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"command\":\"ls\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":42}}),
        ].into_iter().map(|value|format!("data: {value}\n\n")).collect::<String>()+"data: [DONE]\n\n";
        let result=mock_stream(&payload).await.unwrap();
        assert_eq!(result.tool_calls.len(),1);
        assert_eq!(serde_json::from_str::<Value>(result.tool_calls[0]["function"]["arguments"].as_str().unwrap()).unwrap()["command"],"ls");
        assert_eq!(result.usage.unwrap()["total_tokens"],42);
    }
}

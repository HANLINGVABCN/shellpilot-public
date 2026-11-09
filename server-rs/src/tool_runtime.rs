use crate::{operations as op, AppState};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone)]
pub struct ToolContext {
    pub st: Arc<AppState>,
    pub scope: Vec<String>,
    pub mode: String,
    pub source: String,
}

impl ToolContext {
    pub async fn host(&self, query: &str) -> Result<Value, String> {
        op::resolve_host(&self.st.hosts.read().await, &self.scope, query)
    }

    async fn authorize(&self, host: &Value, command: &str, preview: Option<Value>) -> Result<Value, String> {
        let check = crate::safety::safety_check(command);
        let hid = host["id"].as_str().unwrap_or("");
        let name = host["name"].as_str().unwrap_or(hid);
        let audit = |action: &str, reason: &str| crate::append_audit(json!({
            "ts": crate::now_ms(), "source": self.source, "hostId": hid, "host": name,
            "command": command, "action": action, "reason": reason }));
        if check.mode == "block" && self.mode != "full" {
            audit("blocked", &check.reason);
            return Err(format!("命令被本地策略拦截：{}", check.reason));
        }
        let key = format!("{hid}\n{command}");
        if self.mode == "readonly" && check.mode != "auto" { audit("blocked", "只读模式"); return Err("只读模式禁止修改操作".into()); }
        let remembered = self.st.agent.lock().await.allowed.contains(&key);
        if check.mode == "auto" || remembered || self.mode == "auto" || self.mode == "full" {
            audit("allowed", &self.mode);
            return Ok(json!({"decision":"allow","by":"policy"}));
        }
        if self.mode == "ai" && preview.is_none() {
            let st = self.st.clone();
            let id = hid.to_string();
            let exec_on: Arc<dyn Fn(String, u64) -> crate::judge::ExecFuture + Send + Sync> = Arc::new(move |command, timeout| {
                let st = st.clone(); let id = id.clone();
                Box::pin(async move { crate::pool::exec_on_host(&st, &id, &command, timeout).await })
            });
            self.st.broadcast_all(&json!({"type":"chat-ai-judging","command":command,"host":name}));
            let verdict = crate::judge::ai_judge(crate::judge::JudgeInput {
                cmd: command.into(), host_id: hid.into(), host_name: name.into(),
                os_info: crate::sessions::os_of_host(&self.st, hid).await,
                metrics: crate::agent::metrics_summary(self.st.probes.last(hid).await.as_ref()),
                agent_messages: self.st.agent.lock().await.messages.clone(), exec_on,
            }).await.ok().flatten();
            if let Some((decision, reason)) = verdict {
                audit(if decision == "allow" { "ai-allowed" } else { "ai-denied" }, &reason);
                self.st.broadcast_all(&json!({"type":"chat-ai-verdict","command":command,"host":name,"decision":decision,"reason":reason}));
                if decision == "deny" { return Err(format!("AI 审批拒绝：{reason}")); }
                return Ok(json!({"decision":decision,"reason":reason,"by":"ai"}));
            }
        }
        audit("asked", "人工确认");
        let allowed = crate::approvals::request_approval_details(
            &|event| self.st.broadcast_all(event), command, name, hid, preview, &self.source,if self.source=="ai"{Some(self.st.clone())}else{None},
        ).await.unwrap_or(false);
        if !allowed { audit("denied", "拒绝或审批超时"); return Err("用户拒绝执行或审批已超时".into()); }
        if self.source=="ai"{crate::jobs::checkpoint_with(&self.st,1).await?;}
        Ok(json!({"decision":"allow","by":"user"}))
    }

    pub async fn call(&self, name: &str, args: &Value) -> Result<Value, String> {
        if name.starts_with("workspace_"){
            if self.source!="ai"{return Err("工作区目前只供本机应用协作，未授权给外部MCP".into());}
            if ["workspace_upload_to_server","workspace_download_from_server"].contains(&name){
                let host=self.host(op::text_arg(args,"host")?).await?;
                if name=="workspace_upload_to_server"{let command=format!("从本机工作区上传文件到 {}",op::text_arg(args,"remotePath")?);self.authorize(&host,&command,None).await?;}
                return crate::workspace::transfer::transfer(&self.st,name,host["id"].as_str().unwrap_or(""),args).await;
            }
            return crate::workspace::call(&self.st,name,args).await;
        }
        match name {
            "vps_list" => {
                let hosts = self.st.hosts.read().await;
                return Ok(json!(hosts.iter().filter(|h| self.scope.iter().any(|id| h["id"].as_str() == Some(id))).map(|h| {
                    let mut out = json!({});
                    for key in ["id","name","host","port","username","group","tags"] {
                        if let Some(value) = h.get(key) { out[key] = value.clone(); }
                    }
                    out
                }).collect::<Vec<_>>()));
            }
            "vps_exec_batch" => {
                let commands = args.get("commands").and_then(Value::as_array).ok_or("缺少 commands 数组")?;
                if commands.is_empty() || commands.len() > 16 { return Err("批量命令数量应为 1–16".into()); }
                // Validate the entire batch before starting any operation.
                for command in commands {
                    let cmd = op::text_arg(command, "command")?;
                    if crate::safety::safety_check(cmd).mode != "auto" { return Err("批量执行仅支持只读白名单命令；修改命令请单独执行".into()); }
                    self.host(op::text_arg(command, "host")?).await?;
                }
                let mut results = stream::iter(commands.clone().into_iter().enumerate().map(|(index, args)| async move {
                    let result = Box::pin(self.call("vps_exec", &args)).await;
                    (index, match result { Ok(value) => value, Err(error) => json!({"error":error}) })
                })).buffer_unordered(4).collect::<Vec<_>>().await;
                results.sort_by_key(|(i, _)| *i);
                return Ok(json!({"results":results.into_iter().map(|(_,v)|v).collect::<Vec<_>>()}));
            }
            "vps_metrics_batch" => {
                let queries: Vec<String> = match args.get("hosts") {
                    Some(value) => value.as_array().ok_or("hosts 应为数组")?.iter().map(|v| v.as_str().map(String::from).ok_or("hosts 必须包含字符串")).collect::<Result<_,_>>()?,
                    None => self.scope.clone(),
                };
                if queries.is_empty() || queries.len() > 16 { return Err("批量指标查询应选择 1–16 台机器".into()); }
                for query in &queries { self.host(query).await?; }
                let values = stream::iter(queries.into_iter().map(|host| async move {
                    match Box::pin(self.call("vps_metrics", &json!({"host":host}))).await {
                        Ok(value) => value, Err(error) => json!({"host":host,"error":error}),
                    }
                })).buffer_unordered(4).collect::<Vec<_>>().await;
                return Ok(json!({"results":values}));
            }
            _ => {}
        }
        let host = self.host(args.get("host").and_then(Value::as_str).unwrap_or("")).await?;
        let hid = host["id"].as_str().unwrap_or("");
        let mut value = match name {
            "vps_exec" | "exec_command" => {
                let command = op::text_arg(args, "command")?;
                let approval = self.authorize(&host, command, None).await?;
                let timeout = args.get("timeout").and_then(Value::as_u64).unwrap_or(60).clamp(1, 600);
                let limit = args.get("maxOutput").and_then(Value::as_u64).unwrap_or(16*1024) as usize;
                let mut result = serde_json::to_value(crate::pool::exec_result(&self.st, hid, command, timeout * 1000, limit).await?).map_err(|e|e.to_string())?;
                result["approval"] = approval;
                result
            }
            "vps_read_file" => op::read_file(&self.st, hid, args).await?,
            "vps_write_file" => {
                if args.get("preview").and_then(Value::as_bool).unwrap_or(true) {
                    op::file_preview(&self.st, hid, args).await?
                } else {
                    if self.mode == "readonly" { return Err("只读模式禁止写入文件".into()); }
                    let preview = op::file_preview(&self.st, hid, args).await?;
                    let expected = op::text_arg(args, "expectedHash")?;
                    if preview["expectedHash"].as_str() != Some(expected) { return Err("文件已变化，请重新预览".into()); }
                    let command = format!("写入文件 {}（SHA256 {}）", op::text_arg(args, "path")?, preview["newHash"].as_str().unwrap_or(""));
                    let approval = self.authorize(&host, &command, Some(preview)).await?;
                    let mut result = op::write_file(&self.st, hid, args).await?;
                    result["approval"] = approval;
                    result
                }
            }
            "vps_diagnose" | "vps_logs" => {
                let command = if name == "vps_logs" { op::logs_command(args)? } else { op::diagnose_command(args)? };
                serde_json::to_value(crate::pool::exec_result(&self.st, hid, &command, 30000, 24*1024).await?).map_err(|e|e.to_string())?
            }
            "vps_metrics" | "get_metrics" => {
                let cached = self.st.probes.last(hid).await;
                if let Some(cached) = cached {
                    if cached.get("t").and_then(Value::as_i64).map(|ts| crate::now_ms() - ts < 10000).unwrap_or(false) { return Ok(json!({"hostId":hid,"metrics":cached,"cached":true})); }
                }
                let command=format!("{}; printf '\\n===SECOND_SAMPLE===\\n'; sleep 0.25; {}",crate::metrics::COLLECT,crate::metrics::COLLECT);
                let output = crate::pool::exec_result(&self.st, hid, &command, 15000, op::OUTPUT_LIMIT).await?;
                if output.exit_code != 0 || !output.stdout.contains("===SECOND_SAMPLE===") {
                    let output=crate::pool::exec_result(&self.st,hid,&crate::metrics::powershell_command(crate::metrics::WINDOWS_SCRIPT),15000,op::OUTPUT_LIMIT).await?;
                    if output.exit_code!=0 {return Err(output.stderr);}
                    let sample=crate::metrics::parse_windows_sample(&output.stdout,None).ok_or("Windows 指标解析失败")?;
                    let mut metrics=sample.to_json();metrics["platform"]=json!("windows");
                    if let Ok(value)=serde_json::from_str::<Value>(&output.stdout) {metrics["os"]=value["os"].clone();}
                    return Ok(json!({"hostId":hid,"host":host["name"],"metrics":metrics,"cached":false}));
                }
                let (first,second)=output.stdout.split_once("===SECOND_SAMPLE===").ok_or("指标采样不完整")?;
                let sample=crate::metrics::parse_sample(first,None).ok_or("指标解析失败")?;
                let previous=crate::metrics::PrevSample { t:sample.t-250,cpu:sample.cpu,cpu_total:sample.cpu_total,cpu_idle:sample.cpu_idle,rx_sum:sample.rx_sum,tx_sum:sample.tx_sum };
                let sample = crate::metrics::parse_sample(second, Some(&previous)).ok_or("指标解析失败")?;
                json!({"metrics":sample.to_json(),"cached":false})
            }
            _ => return Err(format!("未知工具 {name}")),
        };
        value["hostId"] = json!(hid);
        value["host"] = host["name"].clone();
        crate::append_audit(json!({"ts":crate::now_ms(),"source":self.source,"hostId":hid,"host":host["name"],
            "tool":name,"action":"exec","exitCode":value["exitCode"],"durationMs":value["durationMs"],
            "path":args["path"],"command":args["command"]}));
        Ok(value)
    }
}

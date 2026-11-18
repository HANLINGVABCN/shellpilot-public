//! Streamable HTTP and legacy HTTP+SSE use the same tools and permissions as STDIO.
use axum::{body::Bytes,extract::{Query,State},http::{HeaderMap,StatusCode},response::{IntoResponse,Response,Sse,sse::{Event,KeepAlive}},Json};
use serde_json::{json,Value};
use std::{collections::HashMap,convert::Infallible,sync::{Arc,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
use tokio::sync::{mpsc,oneshot,watch,Mutex,Semaphore};

type App=Arc<crate::AppState>;
pub struct Hub { sessions:Mutex<HashMap<String,Arc<Session>>>, token:Mutex<Option<String>>, permits:Arc<Semaphore>,background:AtomicBool }
impl Hub { pub fn new()->Self {Self{sessions:Mutex::new(HashMap::new()),token:Mutex::new(None),permits:Arc::new(Semaphore::new(4)),background:AtomicBool::new(false)}} }
struct Session {
    id:String,legacy:bool,hello:AtomicBool,initialized:AtomicBool,closed:AtomicBool,
    version:std::sync::Mutex<String>,touched:std::sync::Mutex<Instant>,
    output:Option<mpsc::Sender<Value>>,tasks:Mutex<HashMap<String,watch::Sender<bool>>>,
}
fn rpc_error(id:Value,code:i64,message:&str)->Value{json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})}
fn http_error(status:StatusCode,message:&str)->Response{(status,Json(rpc_error(Value::Null,-32600,message))).into_response()}
pub async fn token(st:&App)->Result<String,String>{
    let mut cached=st.mcp_http.token.lock().await;
    if let Some(value)=cached.as_ref(){return Ok(value.clone());}
    let stored=crate::load_json("mcp-http-auth.json");
    let value=stored.as_ref().and_then(|v|v["token"].as_str()).filter(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit())).map(str::to_string)
        .unwrap_or_else(||format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple()));
    crate::save_json("mcp-http-auth.json",&json!({"token":value}));
    if let Some(error)=crate::storage_fault(){return Err(error);}
    *cached=Some(value.clone());Ok(value)
}
fn loopback_host(text:&str)->bool{reqwest::Url::parse(text).ok().is_some_and(|u|matches!(u.host_str(),Some("127.0.0.1"|"localhost"|"[::1]"))&&u.scheme()=="http")}
async fn access(st:&App,headers:&HeaderMap)->Result<(),Response>{
    if !headers.get("host").and_then(|v|v.to_str().ok()).is_some_and(|v|loopback_host(&format!("http://{v}"))){return Err(http_error(StatusCode::FORBIDDEN,"MCP 仅允许本机连接"));}
    if headers.get("origin").is_some_and(|v|!v.to_str().ok().is_some_and(loopback_host)){return Err(http_error(StatusCode::FORBIDDEN,"不允许此来源访问 MCP"));}
    if let Some(error)=crate::storage_fault(){return Err(http_error(StatusCode::SERVICE_UNAVAILABLE,&error));}
    if crate::get_settings()["mcpEnabled"]!=true{return Err(http_error(StatusCode::FORBIDDEN,"请先开启 MCP"));}
    let expected=token(st).await.map_err(|e|http_error(StatusCode::SERVICE_UNAVAILABLE,&e))?;
    if headers.get("authorization").and_then(|v|v.to_str().ok())!=Some(format!("Bearer {expected}").as_str()) {return Err(http_error(StatusCode::UNAUTHORIZED,"MCP 连接密钥无效"));}
    if let Some(version)=headers.get("mcp-protocol-version"){
        if !version.to_str().ok().is_some_and(|v|["2024-11-05","2025-03-26","2025-06-18"].contains(&v)){return Err(http_error(StatusCode::BAD_REQUEST,"MCP 协议版本不支持"));}
    }Ok(())
}
fn accepts(headers:&HeaderMap,kind:&str)->bool{headers.get("accept").and_then(|v|v.to_str().ok()).is_some_and(|v|v.split(',').any(|part|part.trim().split(';').next()==Some(kind)))}
fn parse(bytes:&Bytes)->Result<Value,Response>{
    let value:Value=serde_json::from_slice(bytes).map_err(|_|(StatusCode::BAD_REQUEST,Json(rpc_error(Value::Null,-32700,"JSON parse error"))).into_response())?;
    let response=value.get("id").is_some()&&(value.get("result").is_some()^value.get("error").is_some());
    if !value.is_object()||value["jsonrpc"]!="2.0"||(!value["method"].is_string()&&!response){return Err((StatusCode::BAD_REQUEST,Json(rpc_error(Value::Null,-32600,"Invalid JSON-RPC request"))).into_response());}
    if value.get("id").is_some_and(|v|!v.is_string()&&!v.is_number()&&!v.is_null()){return Err(http_error(StatusCode::BAD_REQUEST,"Invalid request ID"));}
    if value.get("params").is_some_and(|v|!v.is_object()){return Err(http_error(StatusCode::BAD_REQUEST,"params must be an object"));}Ok(value)
}
async fn create(st:&App,legacy:bool,output:Option<mpsc::Sender<Value>>)->Result<Arc<Session>,Response>{
    let mut sessions=st.mcp_http.sessions.lock().await;
    sessions.retain(|_,s|!s.closed.load(Ordering::SeqCst)&&s.output.as_ref().is_none_or(|tx|!tx.is_closed())&&s.touched.lock().unwrap().elapsed()<Duration::from_secs(1800));
    if sessions.len()>=32{return Err(http_error(StatusCode::TOO_MANY_REQUESTS,"MCP 连接数已满"));}
    let s=Arc::new(Session{id:uuid::Uuid::new_v4().to_string(),legacy,hello:AtomicBool::new(false),initialized:AtomicBool::new(false),closed:AtomicBool::new(false),version:std::sync::Mutex::new("2024-11-05".into()),touched:std::sync::Mutex::new(Instant::now()),output,tasks:Mutex::new(HashMap::new())});
    sessions.insert(s.id.clone(),s.clone());Ok(s)
}
async fn find(st:&App,id:Option<&str>,legacy:bool,headers:&HeaderMap)->Result<Arc<Session>,Response>{
    let id=id.ok_or_else(||http_error(StatusCode::BAD_REQUEST,"缺少 MCP 会话 ID"))?;
    let session=st.mcp_http.sessions.lock().await.get(id).cloned().filter(|s|s.legacy==legacy&&!s.closed.load(Ordering::SeqCst)&&s.touched.lock().unwrap().elapsed()<Duration::from_secs(1800))
        .ok_or_else(||http_error(StatusCode::NOT_FOUND,"MCP 会话已结束，请重新连接"))?;
    if let Some(version)=headers.get("mcp-protocol-version").and_then(|v|v.to_str().ok()){
        if session.hello.load(Ordering::SeqCst)&&version!=session.version.lock().unwrap().as_str(){return Err(http_error(StatusCode::BAD_REQUEST,"协议版本与会话不一致"));}
    }*session.touched.lock().unwrap()=Instant::now();Ok(session)
}
async fn dispatch(st:App,session:Arc<Session>,request:Value)->Option<Value>{
    if !request["method"].is_string(){return None;}
    let method=request["method"].as_str().unwrap_or("");let params=request.get("params").cloned().unwrap_or(json!({}));
    if method=="notifications/initialized" {if session.hello.load(Ordering::SeqCst){session.initialized.store(true,Ordering::SeqCst);}return None;}
    if method=="notifications/cancelled" {if let Some(id)=params.get("requestId"){if let Some(cancel)=session.tasks.lock().await.get(&id.to_string()){cancel.send_replace(true);}}return None;}
    let id=request.get("id")?.clone();
    let result=match method{
        "initialize"=>{
            if session.hello.swap(true,Ordering::SeqCst){return Some(rpc_error(id,-32600,"Already initialized"));}
            let result=crate::mcp::initialize_result(&params);*session.version.lock().unwrap()=result["protocolVersion"].as_str().unwrap().into();result
        },
        "ping"=>json!({}),
        _ if !session.initialized.load(Ordering::SeqCst)=>return Some(rpc_error(id,-32600,"Client must initialize first")),
        "tools/list"=>crate::mcp::listed_tools(),
        "tools/call"=>{
            let Some(name)=params["name"].as_str().map(str::to_string)else{return Some(rpc_error(id,-32602,"Missing tool name"));};
            let args=params.get("arguments").cloned().unwrap_or(json!({}));if !args.is_object(){return Some(rpc_error(id,-32602,"arguments must be an object"));}
            if !crate::operations::schemas().iter().any(|t|t["name"]==name){return Some(crate::mcp::tool_response(id,Err(format!("未知 MCP 工具 {name}"))));}
            let key=id.to_string();let(mut tasks,(cancel,mut stopped))=(session.tasks.lock().await,watch::channel(false));
            if tasks.contains_key(&key){return Some(rpc_error(id,-32600,"Duplicate active request ID"));}
            if tasks.len()>=32{return Some(rpc_error(id,-32000,"Too many pending calls"));}
            tasks.insert(key.clone(),cancel);drop(tasks);
            let(sender,receiver)=oneshot::channel();let own=session.clone();let response_id=id.clone();
            tokio::spawn(async move{
                let operation=async{let _permit=st.mcp_http.permits.clone().acquire_owned().await.map_err(|_|"MCP 已关闭")?;crate::mcp::context(st)?.call(&name,&args).await};
                let response=tokio::select!{result=operation=>crate::mcp::tool_response(id.clone(),result),_=stopped.changed()=>rpc_error(id.clone(),-32800,"Request cancelled")};
                own.tasks.lock().await.remove(&key);let _=sender.send(response);
            });
            return Some(receiver.await.unwrap_or_else(|_|rpc_error(response_id,-32603,"MCP task stopped")));
        },
        _=>return Some(rpc_error(id,-32601,&format!("Method not found: {method}")))
    };Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}
pub async fn post(State(st):State<App>,headers:HeaderMap,bytes:Bytes)->Response{
    if let Err(response)=access(&st,&headers).await{return response;}
    if headers.get("content-type").and_then(|v|v.to_str().ok()).and_then(|v|v.split(';').next())!=Some("application/json"){return http_error(StatusCode::UNSUPPORTED_MEDIA_TYPE,"请发送 application/json");}
    if !accepts(&headers,"application/json")||!accepts(&headers,"text/event-stream"){return http_error(StatusCode::NOT_ACCEPTABLE,"Accept 必须包含 application/json 和 text/event-stream");}
    let request=match parse(&bytes){Ok(v)=>v,Err(r)=>return r};
    let initialize=request["method"]=="initialize"&&request.get("id").is_some();
    let session=if initialize&&headers.get("mcp-session-id").is_none(){create(&st,false,None).await}else{find(&st,headers.get("mcp-session-id").and_then(|v|v.to_str().ok()),false,&headers).await};
    let session=match session{Ok(s)=>s,Err(r)=>return r};let id=session.id.clone();
    let value=dispatch(st,session,request).await;
    match value{Some(value)=>([("mcp-session-id",id)],Json(value)).into_response(),None=>StatusCode::ACCEPTED.into_response()}
}
pub async fn get(State(st):State<App>,headers:HeaderMap)->Response{
    if let Err(r)=access(&st,&headers).await{return r;}(StatusCode::METHOD_NOT_ALLOWED,[("allow","POST, DELETE")]).into_response()
}
pub async fn delete(State(st):State<App>,headers:HeaderMap)->Response{
    if let Err(r)=access(&st,&headers).await{return r;}
    let session=match find(&st,headers.get("mcp-session-id").and_then(|v|v.to_str().ok()),false,&headers).await{Ok(s)=>s,Err(r)=>return r};
    session.closed.store(true,Ordering::SeqCst);for cancel in session.tasks.lock().await.values(){cancel.send_replace(true);}st.mcp_http.sessions.lock().await.remove(&session.id);StatusCode::NO_CONTENT.into_response()
}
pub async fn sse(State(st):State<App>,headers:HeaderMap)->Response{
    if let Err(r)=access(&st,&headers).await{return r;}
    if !accepts(&headers,"text/event-stream"){return http_error(StatusCode::NOT_ACCEPTABLE,"Accept 必须包含 text/event-stream");}
    let(tx,rx)=mpsc::channel(64);let session=match create(&st,true,Some(tx)).await{Ok(s)=>s,Err(r)=>return r};
    let endpoint=format!("/mcp/messages?sessionId={}",session.id);
    let stream=futures_util::stream::unfold((Some(endpoint),rx,session,st),|(mut first,mut rx,session,st)|async move{
        if let Some(endpoint)=first.take(){return Some((Ok::<Event,Infallible>(Event::default().event("endpoint").data(endpoint)),(first,rx,session,st)));}
        loop{
            if session.closed.load(Ordering::SeqCst)||crate::get_settings()["mcpEnabled"]!=true {return None;}
            tokio::select!{value=rx.recv()=>{let value=value?;return Some((Ok(Event::default().event("message").data(value.to_string())),(first,rx,session,st)));},_=tokio::time::sleep(Duration::from_secs(10))=>{*session.touched.lock().unwrap()=Instant::now();}}
        }
    });Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(5))).into_response()
}
pub async fn messages(State(st):State<App>,Query(query):Query<HashMap<String,String>>,headers:HeaderMap,bytes:Bytes)->Response{
    if let Err(r)=access(&st,&headers).await{return r;}
    if headers.get("content-type").and_then(|v|v.to_str().ok()).and_then(|v|v.split(';').next())!=Some("application/json"){return http_error(StatusCode::UNSUPPORTED_MEDIA_TYPE,"请发送 application/json");}
    let session=match find(&st,query.get("sessionId").map(String::as_str),true,&headers).await{Ok(s)=>s,Err(r)=>return r};
    let request=match parse(&bytes){Ok(r)=>r,Err(r)=>return r};
    let id=request.get("id").cloned();let key=id.as_ref().map(Value::to_string);
    if let Some(key)=key {if session.tasks.lock().await.contains_key(&key){return (StatusCode::BAD_REQUEST,Json(rpc_error(id.unwrap(),-32600,"Duplicate active request ID"))).into_response();}}
    tokio::spawn(async move{if let Some(value)=dispatch(st,session.clone(),request).await{if let Some(output)=&session.output{let _=output.send(value).await;}}});
    StatusCode::ACCEPTED.into_response()
}
pub async fn configuration(st:&App,transport:&str)->Result<Value,String>{
    let port=crate::load_json("runtime.json").and_then(|v|v["port"].as_u64()).filter(|p|*p>0&&*p<=65535).ok_or("MCP 服务地址尚未就绪")?;
    let token=token(st).await?;let headers=json!({"Authorization":format!("Bearer {token}")});
    let http=json!({"type":"http","url":format!("http://127.0.0.1:{port}/mcp"),"headers":headers});
    let sse=json!({"type":"sse","url":format!("http://127.0.0.1:{port}/mcp/sse"),"headers":headers});
    match transport{
        "http"=>Ok(http),"sse"=>Ok(sse),"all"=>{
            let mut value=json!({"enabled":crate::get_settings()["mcpEnabled"]==true,"backgroundActive":st.mcp_http.background.load(Ordering::SeqCst),"supported":if cfg!(target_os="android"){vec!["http","sse"]}else{vec!["stdio","http","sse"]},"http":http,"sse":sse});
            if !cfg!(target_os="android"){value["stdio"]=crate::mcp_runtime::configuration()?;}Ok(value)
        },_=>Err("请选择 STDIO、HTTP 或 SSE".into())
    }
}
pub async fn sync_background(st:&App)->Result<(),String>{
    let enabled=crate::get_settings()["mcpEnabled"]==true;
    #[cfg(target_os="android")]
    if enabled!=st.mcp_http.background.load(Ordering::SeqCst){crate::workspace::android::request(json!({"op":"mcp-service","enabled":enabled})).await?;st.mcp_http.background.store(enabled,Ordering::SeqCst);}
    if !enabled{let mut sessions=st.mcp_http.sessions.lock().await;for session in sessions.values(){session.closed.store(true,Ordering::SeqCst);for cancel in session.tasks.lock().await.values(){cancel.send_replace(true);}}sessions.clear();}Ok(())
}

async fn next_event(response:&mut reqwest::Response,buffer:&mut String)->Result<(String,String),String>{
    loop{
        if let Some(end)=buffer.find("\n\n"){
            let block=buffer[..end].to_string();buffer.drain(..end+2);
            let event=block.lines().find_map(|line|line.strip_prefix("event:")).unwrap_or("message").trim().to_string();
            let data=block.lines().filter_map(|line|line.strip_prefix("data:")).map(str::trim_start).collect::<Vec<_>>().join("\n");
            if !data.is_empty(){return Ok((event,data));}continue;
        }
        let bytes=response.chunk().await.map_err(|e|e.to_string())?.ok_or("SSE 连接已关闭")?;buffer.push_str(&String::from_utf8_lossy(&bytes).replace('\r',""));
    }
}
pub async fn test(st:&App,transport:&str)->Result<Value,String>{
    let config=configuration(st,transport).await?;let url=config["url"].as_str().ok_or("MCP URL 不可用")?;
    let auth=config["headers"]["Authorization"].as_str().ok_or("缺少连接密钥")?;
    let client=reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(2)).build().map_err(|e|e.to_string())?;
    let initialize=json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"shellpilot-connection-test","version":"1"}}});
    let notify=json!({"jsonrpc":"2.0","method":"notifications/initialized"});
    let list=json!({"jsonrpc":"2.0","id":2,"method":"tools/list"});
    let request=|url:&str,body:&Value|client.post(url).header("Authorization",auth).header("Accept","application/json, text/event-stream").json(body);
    let(init,tools)=if transport=="http"{
        let response=request(url,&initialize).send().await.map_err(|e|e.to_string())?;
        if !response.status().is_success(){return Err(format!("HTTP MCP 初始化失败：{}",response.status()));}
        let session=response.headers().get("mcp-session-id").and_then(|v|v.to_str().ok()).ok_or("未返回 MCP 会话")?.to_string();
        let init:Value=response.json().await.map_err(|e|e.to_string())?;
        let notify_response=request(url,&notify).header("mcp-session-id",&session).send().await.map_err(|e|e.to_string())?;
        if notify_response.status()!=reqwest::StatusCode::ACCEPTED{return Err("MCP 初始化通知未接受".into());}
        let tools:Value=request(url,&list).header("mcp-session-id",&session).send().await.map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
        let _=client.delete(url).header("Authorization",auth).header("mcp-session-id",session).send().await;(init,tools)
    }else if transport=="sse"{
        let mut stream=client.get(url).header("Authorization",auth).header("Accept","text/event-stream").send().await.map_err(|e|e.to_string())?;
        if !stream.status().is_success(){return Err(format!("SSE MCP 连接失败：{}",stream.status()));}
        let mut buffer=String::new();let(event,endpoint)=next_event(&mut stream,&mut buffer).await?;if event!="endpoint"{return Err("SSE 未返回消息地址".into());}
        let endpoint=reqwest::Url::parse(url).map_err(|e|e.to_string())?.join(&endpoint).map_err(|e|e.to_string())?.to_string();
        if request(&endpoint,&initialize).send().await.map_err(|e|e.to_string())?.status()!=reqwest::StatusCode::ACCEPTED{return Err("SSE 初始化未接受".into());}
        let(_,value)=next_event(&mut stream,&mut buffer).await?;let init:Value=serde_json::from_str(&value).map_err(|e|e.to_string())?;
        request(&endpoint,&notify).send().await.map_err(|e|e.to_string())?;
        request(&endpoint,&list).send().await.map_err(|e|e.to_string())?;
        let(_,value)=next_event(&mut stream,&mut buffer).await?;let tools:Value=serde_json::from_str(&value).map_err(|e|e.to_string())?;(init,tools)
    }else{return Err("不支持的网络传输类型".into());};
    if init.get("error").is_some()||tools.get("error").is_some(){return Err("MCP 初始化或工具发现失败".into());}
    let count=tools["result"]["tools"].as_array().ok_or("MCP 未返回工具列表")?.len();
    Ok(json!({"tools":count,"protocolVersion":init["result"]["protocolVersion"],"transport":transport}))
}

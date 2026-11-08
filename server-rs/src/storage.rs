use std::sync::Arc;
use axum::{Json,extract::State,http::StatusCode,response::{Response,IntoResponse}};
use serde_json::{Value,json};
static RELOAD:tokio::sync::Mutex<()>=tokio::sync::Mutex::const_new(());
fn unavailable()->Response{
    (StatusCode::SERVICE_UNAVAILABLE,Json(json!({"storageError":true,"error":crate::storage_fault().unwrap_or("读取本机数据失败".into())}))).into_response()
}
pub async fn status()->Json<Value>{
    Json(json!({"error":crate::storage_fault(),"directory":crate::data_dir().to_string_lossy()}))
}
pub async fn retry(State(st):State<Arc<crate::AppState>>)->Response{
    let _lock=RELOAD.lock().await;
    if crate::storage_fault().is_none(){return Json(json!({"ok":true})).into_response();}
    if st.agent.lock().await.busy{return (StatusCode::CONFLICT,Json(json!({"error":"任务执行中，暂不能重新读取数据"}))).into_response();}
    crate::clear_storage_fault();
    if let Err(error)=crate::validate_storage(){crate::store::report_storage_error(error);return unavailable();}
    crate::chats::reload_chats();
    crate::bootstrap(&st).await;
    if crate::storage_fault().is_some(){return unavailable();}
    st.broadcast_all(&json!({"type":"hosts-changed"}));
    st.broadcast_all(&json!({"type":"chat-list-changed"}));
    Json(json!({"ok":true})).into_response()
}
pub async fn guard(request:axum::extract::Request,next:axum::middleware::Next)->Response{
    let path=request.uri().path().to_string();
    if path.starts_with("/api/workspace"){
        if let Some(origin)=request.headers().get("origin"){
            let same=origin.to_str().ok().and_then(|s|reqwest::Url::parse(s).ok()).is_some_and(|url|
                url.scheme()=="http"&&url.host_str()==Some("127.0.0.1")&&url.port_or_known_default()==request.headers().get("host").and_then(|v|v.to_str().ok()).and_then(|s|s.rsplit(':').next()).and_then(|s|s.parse::<u16>().ok()));
            if !same{return (StatusCode::FORBIDDEN,Json(json!({"error":"工作区只允许本机应用页面访问"}))).into_response();}
        }
    }
    let persistent=(path.starts_with("/api/")||path=="/ws")&&!matches!(path.as_str(),"/api/storage/status"|"/api/storage/retry"|"/api/mcp/config"|"/api/open-external-url");
    if persistent&&crate::storage_fault().is_some(){return unavailable();}
    let result=next.run(request).await;
    if persistent&&crate::storage_fault().is_some(){unavailable()}else{result}
}

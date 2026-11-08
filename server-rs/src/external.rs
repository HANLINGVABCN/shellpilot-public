//! Open web links using the operating system, without navigating the application.
pub fn web_url(input:&str)->Result<String,String>{
    let url=reqwest::Url::parse(input).map_err(|_|"链接格式不正确".to_string())?;
    if !["http","https"].contains(&url.scheme()) || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some(){
        return Err("仅支持打开 HTTP 或 HTTPS 网页链接".into());
    }
    Ok(url.to_string())
}
pub fn open_default(input:&str)->Result<(),String>{
    let url=web_url(input)?;
    #[cfg(target_os="windows")]
    let mut command={
        use std::os::windows::process::CommandExt;
        let mut command=std::process::Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler",&url]).creation_flags(0x08000000);command
    };
    #[cfg(target_os="macos")]
    let mut command={let mut command=std::process::Command::new("open");command.arg(&url);command};
    #[cfg(not(any(target_os="windows",target_os="macos")))]
    let mut command={let mut command=std::process::Command::new("xdg-open");command.arg(&url);command};
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().map(|_|()).map_err(|error|format!("无法打开系统浏览器：{error}"))
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn only_web_links_are_sent_to_browser(){
        assert_eq!(web_url("https://example.com/docs?q=1&other=2").unwrap(),"https://example.com/docs?q=1&other=2");
        for url in ["javascript:alert(1)","file:///secret","data:text/html,test","https://user:secret@example.com","not-url"]{assert!(web_url(url).is_err());}
    }
    #[tokio::test]
    async fn endpoint_uses_native_opener_without_navigating_webview(){
        let calls=std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let st=crate::AppState::new();let received=calls.clone();
        *st.external_opener.write().unwrap()=Some(std::sync::Arc::new(move|url|{received.lock().unwrap().push(url.to_string());Ok(())}));
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move{axum::serve(listener,crate::router(st)).await.unwrap();});
        let client=reqwest::Client::new();
        let response=client.post(format!("http://{address}/api/open-external-url")).json(&serde_json::json!({"url":"https://example.com/docs"})).send().await.unwrap();
        assert!(response.status().is_success());assert_eq!(&*calls.lock().unwrap(),&["https://example.com/docs"]);
        let response=client.post(format!("http://{address}/api/open-external-url")).json(&serde_json::json!({"url":"file:///private"})).send().await.unwrap();
        assert_eq!(response.status().as_u16(),400);assert_eq!(calls.lock().unwrap().len(),1);server.abort();
    }
}

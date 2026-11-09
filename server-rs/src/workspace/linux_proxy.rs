//! Explicit Internet proxy for the guest: direct guest networking stays disabled.
use tokio::{net::{TcpListener,TcpStream},io::{AsyncReadExt,AsyncWriteExt}};
use std::{net::{IpAddr,Ipv4Addr,Ipv6Addr},time::Duration};
pub struct InternetProxy{pub port:u16,task:tokio::task::JoinHandle<()>}
impl Drop for InternetProxy{fn drop(&mut self){self.task.abort();}}
pub async fn start()->Result<InternetProxy,String>{
 let listener=TcpListener::bind(("127.0.0.1",0)).await.map_err(|e|e.to_string())?;let port=listener.local_addr().map_err(|e|e.to_string())?.port();
 let task=tokio::spawn(async move{let permits=std::sync::Arc::new(tokio::sync::Semaphore::new(8));while let Ok((stream,_))=listener.accept().await{let Ok(permit)=permits.clone().try_acquire_owned()else{continue;};tokio::spawn(async move{let _permit=permit;let _=tokio::time::timeout(Duration::from_secs(600),forward(stream)).await;});}});
 Ok(InternetProxy{port,task})
}
fn public(ip:IpAddr)->bool{match ip{
 IpAddr::V4(v)=>!(v.is_private()||v.is_loopback()||v.is_link_local()||v.is_multicast()||v.is_broadcast()||v.is_unspecified()||v.octets()[0]==0||v.octets()[0]>=240||v.octets()[0]==127||(v.octets()[0]==100&&(64..=127).contains(&v.octets()[1]))||v.is_documentation()),
 IpAddr::V6(v)=>v.to_ipv4_mapped().map(|v|public(IpAddr::V4(v))).unwrap_or(!v.is_loopback()&&!v.is_unspecified()&&!v.is_multicast()&&(v.segments()[0]&0xfe00!=0xfc00)&&(v.segments()[0]&0xffc0!=0xfe80)&&(v.segments()[0]&0xe000==0x2000)),
}}
async fn forward(mut client:TcpStream)->Result<(),String>{
 let mut head=Vec::new();let mut byte=[0u8;1];while !head.ends_with(b"\r\n\r\n"){if head.len()>=16384{return Err("Proxy header too large".into());}if client.read(&mut byte).await.map_err(|e|e.to_string())?==0{return Ok(());}head.push(byte[0]);}
 let text=std::str::from_utf8(&head).map_err(|_|"Invalid proxy header")?;let mut lines=text.split("\r\n");let first=lines.next().ok_or("Missing proxy request")?;let mut parts=first.split_whitespace();let method=parts.next().ok_or("Missing method")?;let target=parts.next().ok_or("Missing target")?;
 let tunnel=method=="CONNECT";let url=reqwest::Url::parse(&if tunnel{format!("https://{target}")}else{target.into()}).map_err(|_|"Invalid proxy target")?;
 if !["http","https"].contains(&url.scheme())||!url.username().is_empty()||url.password().is_some(){return Err("Unsupported proxy target".into());}
 let host=url.host_str().ok_or("Missing host")?;let port=url.port_or_known_default().ok_or("Missing port")?;
 if port!=80&&port!=443{return Err("Internet proxy allows HTTP/HTTPS only".into());}
 let addresses=tokio::net::lookup_host((host,port)).await.map_err(|e|e.to_string())?.collect::<Vec<_>>();
 if addresses.is_empty()||addresses.iter().any(|address|!public(address.ip())){client.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.map_err(|e|e.to_string())?;return Err("Private network target denied".into());}
 let mut remote=tokio::time::timeout(Duration::from_secs(15),TcpStream::connect(addresses.as_slice())).await.map_err(|_|"Internet connect timeout")?.map_err(|e|e.to_string())?;
 if tunnel{client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.map_err(|e|e.to_string())?;}else{
  let path=if let Some(query)=url.query(){format!("{}?{query}",url.path())}else{url.path().into()};let mut request=format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
  for line in lines.filter(|line|!line.is_empty()){let Some((name,_))=line.split_once(':')else{return Err("Malformed proxy header".into());};if !["host","connection","proxy-connection","proxy-authorization"].contains(&name.to_ascii_lowercase().as_str()){request.push_str(line);request.push_str("\r\n");}}
  request.push_str("\r\n");remote.write_all(request.as_bytes()).await.map_err(|e|e.to_string())?;
 }
 tokio::io::copy_bidirectional(&mut client,&mut remote).await.map_err(|e|e.to_string())?;Ok(())
}
#[cfg(test)]mod tests{use super::*;#[test]fn private_destinations_denied(){for ip in ["127.0.0.1","10.0.2.2","192.168.1.1","169.254.1.2","::1","::ffff:127.0.0.1","fd00::1"]{assert!(!public(ip.parse().unwrap()));}assert!(public(IpAddr::V4(Ipv4Addr::new(1,1,1,1))));assert!(public(IpAddr::V6("2606:4700:4700::1111".parse::<Ipv6Addr>().unwrap())));}}

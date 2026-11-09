use serde_json::{Value,json};
pub async fn request(body:Value)->Result<Value,String>{
 #[cfg(target_os="android")]{
  tokio::task::spawn_blocking(move||{
   let context=ndk_context::android_context();
   let vm=unsafe{jni::JavaVM::from_raw(context.vm().cast())}.map_err(|e|e.to_string())?;
   let mut env=vm.attach_current_thread().map_err(|e|e.to_string())?;
   let activity=unsafe{jni::objects::JObject::from_raw(context.context().cast())};
   let input=env.new_string(body.to_string()).map_err(|e|e.to_string())?;let object=jni::objects::JObject::from(input);
   let result=env.call_method(&activity,"workspaceRuntime","(Ljava/lang/String;)Ljava/lang/String;",&[jni::objects::JValue::Object(&object)]).map_err(|e|format!("安卓工作区接口不可用：{e}"))?.l().map_err(|e|e.to_string())?;
   let text:String=env.get_string(&jni::objects::JString::from(result)).map_err(|e|e.to_string())?.into();let value:Value=serde_json::from_str(&text).map_err(|e|e.to_string())?;
   if let Some(error)=value["error"].as_str(){Err(error.into())}else{Ok(value)}
  }).await.map_err(|e|e.to_string())?
 }
 #[cfg(not(target_os="android"))]{let _=body;Err("此平台没有安卓运行组件".into())}
}
pub async fn ready()->Result<bool,String>{Ok(request(json!({"op":"status"})).await?["installed"].as_bool().unwrap_or(false))}
pub async fn action(name:&str,args:&Value,network:bool)->Result<Value,String>{request(json!({"op":"action","name":name,"arguments":args,"network":network})).await}

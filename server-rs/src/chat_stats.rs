use serde_json::{Value,json};
use std::sync::{Arc,Mutex};
#[derive(Default)]
pub struct ChatStats{
    pub input:Option<u64>,pub output:Option<u64>,pub cached:Option<u64>,
    pub provider:String,pub model:String,pub started_ms:i64,
    pub generation_ms:u64,
}
impl ChatStats{
    pub fn new()->Arc<Mutex<Self>>{Arc::new(Mutex::new(Self{started_ms:crate::now_ms(),..Self::default()}))}
    pub fn usage(&mut self,usage:&Value,generation_ms:u64){
        fn add(target:&mut Option<u64>,value:Option<u64>){if let Some(n)=value{*target=Some(target.unwrap_or(0).saturating_add(n));}}
        add(&mut self.input,usage["prompt_tokens"].as_u64().or_else(||usage["input_tokens"].as_u64()));
        let output=usage["completion_tokens"].as_u64().or_else(||usage["output_tokens"].as_u64());
        add(&mut self.output,output);
        add(&mut self.cached,usage.pointer("/prompt_tokens_details/cached_tokens").and_then(Value::as_u64)
            .or_else(||usage.pointer("/input_tokens_details/cached_tokens").and_then(Value::as_u64))
            .or_else(||usage["prompt_cache_hit_tokens"].as_u64()));
        if output.is_some(){self.generation_ms=self.generation_ms.saturating_add(generation_ms);}
    }
    pub fn value(&self)->Value{
        let elapsed=(crate::now_ms()-self.started_ms).max(0) as u64;
        json!({"inputTokens":self.input,"outputTokens":self.output,"cachedTokens":self.cached,
            "startedAt":self.started_ms,
            "durationMs":elapsed,"tokensPerSecond":self.output.filter(|_|self.generation_ms>0).map(|n|n as f64*1000.0/self.generation_ms as f64),
            "provider":self.provider,"model":self.model})
    }
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn usage_is_reported_without_estimated_counts(){
  let mut stats=ChatStats::default();
  stats.usage(&json!({"prompt_tokens":1200,"completion_tokens":300,"prompt_tokens_details":{"cached_tokens":800}}),12000);
  assert_eq!(stats.input,Some(1200));assert_eq!(stats.cached,Some(800));assert_eq!(stats.value()["tokensPerSecond"],25.0);
  stats.usage(&json!({}),10);assert_eq!(stats.output,Some(300));
 }
}

// 指标采集脚本与解析（probe 与 AI 共用，对应 server/metrics.js）

/// 一段只读的采集脚本，全部读 /proc，服务器上不需要安装任何东西
pub const COLLECT: &str = "echo ===CPU===; head -1 /proc/stat; \
echo ===MEM===; head -5 /proc/meminfo; \
echo ===LOAD===; cat /proc/loadavg; \
echo ===NET===; cat /proc/net/dev; \
echo ===DISK===; df -kP / | tail -1; \
echo ===UP===; cat /proc/uptime";

// Windows OpenSSH may use cmd.exe or PowerShell as the default shell.
// EncodedCommand avoids expanding PowerShell variables in either shell.
pub const WINDOWS_SCRIPT:&str=r#"
$ErrorActionPreference='Stop'
$os=Get-CimInstance Win32_OperatingSystem
$processors=@(Get-CimInstance Win32_Processor)
$cpu=[double](($processors | Measure-Object LoadPercentage -Average).Average)
$drive=Get-CimInstance Win32_LogicalDisk -Filter ('DeviceID='''+$os.SystemDrive+'''')
$net=@(Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface)
$rx=[double](($net | Measure-Object BytesReceivedPersec -Sum).Sum)
$tx=[double](($net | Measure-Object BytesSentPersec -Sum).Sum)
$total=[double]$os.TotalVisibleMemorySize
$used=$total-[double]$os.FreePhysicalMemory
$diskTotal=[double]$drive.Size/1024
$diskUsed=([double]$drive.Size-[double]$drive.FreeSpace)/1024
$uptime=((Get-Date)-$os.LastBootUpTime).TotalSeconds
@{cpu=$cpu;memTotal=$total;memUsed=$used;memPct=100*$used/$total;diskTotalKB=$diskTotal;diskUsedKB=$diskUsed;diskPct=$(if($diskTotal -gt 0){100*$diskUsed/$diskTotal}else{0});rxSum=$rx;txSum=$tx;uptime=$uptime;platform='windows';os=$os.Caption} | ConvertTo-Json -Compress
"#;

pub fn powershell_command(script:&str)->String {
    use base64::Engine;
    let bytes:Vec<u8>=script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub fn parse_windows_sample(text:&str,prev:Option<&PrevSample>)->Option<Sample> {
    let value:serde_json::Value=serde_json::from_str(text.trim().trim_start_matches('\u{feff}')).ok()?;
    if value["platform"]!="windows" { return None; }
    let number=|key:&str|value[key].as_f64().filter(|n|n.is_finite());
    let mem_total=number("memTotal")?;
    if mem_total<=0.0 {return None;}
    let t=crate::now_ms();
    let rx_sum=number("rxSum")?;let tx_sum=number("txSum")?;
    let elapsed=prev.map(|p|(t-p.t).max(1) as f64/1000.0).unwrap_or(0.0);
    let rx_s=if elapsed>0.0 {(rx_sum-prev?.rx_sum).max(0.0)/elapsed}else{0.0};
    let tx_s=if elapsed>0.0 {(tx_sum-prev?.tx_sum).max(0.0)/elapsed}else{0.0};
    Some(Sample{t,cpu:number("cpu")?.clamp(0.0,100.0),mem_total,mem_used:number("memUsed")?,mem_pct:number("memPct")?,
        disk_total_kb:number("diskTotalKB")?,disk_used_kb:number("diskUsedKB")?,disk_pct:number("diskPct")?,
        rx_sum,tx_sum,rx:rx_sum,tx:tx_sum,rx_s,tx_s,uptime:number("uptime")?,..Sample::default()})
}

#[cfg(test)]
mod windows_tests {
    use super::*;
    #[test]
    fn windows_metrics_have_real_percentages_and_network_rates() {
        let text=r#"{"platform":"windows","cpu":35,"memTotal":8192000,"memUsed":4096000,"memPct":50,"diskTotalKB":104857600,"diskUsedKB":52428800,"diskPct":50,"rxSum":10000,"txSum":6000,"uptime":7200}"#;
        let previous=PrevSample{t:crate::now_ms()-1000,rx_sum:8000.0,tx_sum:5000.0,..PrevSample::default()};
        let sample=parse_windows_sample(text,Some(&previous)).unwrap();
        assert_eq!(sample.cpu,35.0);assert_eq!(sample.mem_pct,50.0);assert_eq!(sample.disk_pct,50.0);
        assert!(sample.rx_s>1000.0);assert!(sample.tx_s>500.0);
        assert_eq!(sample.to_json()["memTotal"],8192000);
        assert!(parse_windows_sample("not-json",None).is_none());
    }
}

/// 上一帧采样（Node: prev 对象），用于 CPU 差值与网速计算
#[derive(Clone, Debug, Default)]
pub struct PrevSample {
    pub t: i64,
    pub cpu: f64,
    pub cpu_total: f64,
    pub cpu_idle: f64,
    pub rx_sum: f64,
    pub tx_sum: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub t: i64,
    pub cpu: f64,
    pub cpu_total: f64,
    pub cpu_idle: f64,
    pub mem_total: f64,
    pub mem_used: f64,
    pub mem_pct: f64,
    pub load1: f64,
    pub rx: f64,
    pub tx: f64,
    pub rx_sum: f64,
    pub tx_sum: f64,
    pub rx_s: f64,
    pub tx_s: f64,
    pub disk_pct: f64,
    pub disk_total_kb: f64,
    pub disk_used_kb: f64,
    pub uptime: f64,
}

impl Sample {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "t": self.t, "cpu": js_num(self.cpu), "cpuTotal": js_num(self.cpu_total),
            "cpuIdle": js_num(self.cpu_idle),
            "memTotal": js_num(self.mem_total), "memUsed": js_num(self.mem_used),
            "memPct": js_num(self.mem_pct),
            "load1": js_num(self.load1),
            "rx": js_num(self.rx), "tx": js_num(self.tx),
            "rxSum": js_num(self.rx_sum), "txSum": js_num(self.tx_sum),
            "rxS": js_num(self.rx_s), "txS": js_num(self.tx_s),
            "diskPct": self.disk_pct as i64, "diskTotalKB": self.disk_total_kb as i64,
            "diskUsedKB": self.disk_used_kb as i64, "uptime": js_num(self.uptime),
        })
    }
}

/// JS Number 的有限化：NaN/inf 归零，整数则输出整数
fn js_num(v: f64) -> serde_json::Value {
    let v = if v.is_finite() { v } else { 0.0 };
    if v.fract() == 0.0 && v.abs() < 9e15 {
        serde_json::json!(v as i64)
    } else {
        serde_json::json!(v)
    }
}

fn split_sections(text: &str) -> Vec<(String, String)> {
    // 复刻 JS: /===(\w+)===(?:\r?\n)([\s\S]*?)(?=\n?===\w+===|$)/g
    let mut out = Vec::new();
    let bytes = text;
    let mut i = 0;
    while let Some(start) = bytes[i..].find("===") {
        let s = i + start;
        let after = &bytes[s + 3..];
        let end_marker = match after.find("===") {
            Some(e) => s + 3 + e,
            None => break,
        };
        let name = &bytes[s + 3..end_marker];
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            i = s + 3;
            continue;
        }
        // 跳过 name 后的 ===，再跳过 \r?\n
        let content_start = end_marker + 3;
        let content_start = if bytes[content_start..].starts_with("\r\n") {
            content_start + 2
        } else if bytes[content_start..].starts_with('\n') {
            content_start + 1
        } else {
            content_start
        };
        // 找下一个 \n?===\w+=== 或结尾
        let content_end;
        let next_i;
        match bytes[content_start..].find("===") {
            Some(p) => {
                let abs = content_start + p;
                // 允许 === 前有一个 \n
                let ce = if abs > content_start && bytes.as_bytes()[abs - 1] == b'\n' {
                    abs - 1
                } else {
                    abs
                };
                content_end = ce;
                next_i = abs;
            }
            None => {
                content_end = bytes.len();
                next_i = bytes.len();
            }
        }
        out.push((name.to_string(), bytes[content_start..content_end].to_string()));
        i = next_i;
        if next_i >= bytes.len() {
            break;
        }
    }
    out
}

/// Node: parseSample
pub fn parse_sample(text: &str, prev: Option<&PrevSample>) -> Option<Sample> {
    let sections = split_sections(text);
    let get = |k: &str| -> String {
        sections
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let now = crate::now_ms() / 1000;

    // CPU：两次采样之间算差值
    let cpu_line = get("CPU")
        .lines()
        .find(|l| l.starts_with("cpu "))
        .unwrap_or("")
        .trim()
        .to_string();
    let cv: Vec<f64> = cpu_line
        .split_whitespace()
        .skip(1)
        .map(|x| x.parse::<f64>().unwrap_or(0.0))
        .collect();
    let mut cpu = prev.map(|p| p.cpu).unwrap_or(0.0);
    let mut cpu_total = prev.map(|p| p.cpu_total).unwrap_or(0.0);
    let mut cpu_idle = prev.map(|p| p.cpu_idle).unwrap_or(0.0);
    if cv.len() >= 5 {
        let total: f64 = cv.iter().filter(|x| x.is_finite()).sum();
        let idle = cv[3] + cv.get(4).copied().unwrap_or(0.0);
        if let Some(p) = prev {
            if p.cpu_total != 0.0 && total > p.cpu_total {
                let d_total = total - p.cpu_total;
                let d_idle = idle - p.cpu_idle;
                if d_total > 0.0 {
                    cpu = ((1.0 - d_idle / d_total) * 100.0).clamp(0.0, 100.0);
                }
            }
        }
        cpu_total = total;
        cpu_idle = idle;
    }

    // 内存
    let mut mem = std::collections::HashMap::new();
    for l in get("MEM").lines() {
        let mut it = l.splitn(2, ':');
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
            let v = v.trim();
            if let Ok(num) = v.split_whitespace().next().unwrap_or("").parse::<f64>() {
                mem.insert(k.trim().to_string(), num);
            }
        }
    }
    let mem_total = *mem.get("MemTotal").unwrap_or(&0.0);
    let mem_avail = mem
        .get("MemAvailable")
        .or_else(|| mem.get("MemFree"))
        .copied()
        .unwrap_or(0.0);
    let mem_used = (mem_total - mem_avail).max(0.0);
    let mem_pct = if mem_total != 0.0 { mem_used / mem_total * 100.0 } else { 0.0 };

    let load1 = get("LOAD")
        .trim()
        .split_whitespace()
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    // 网络：所有非 lo 网卡的字节总和，算速率
    let mut rx: f64 = 0.0;
    let mut tx: f64 = 0.0;
    for l in get("NET").lines() {
        let f: Vec<&str> = l.trim().split_whitespace().collect();
        if f.is_empty() || !f[0].ends_with(':') || f[0] == "lo:" {
            continue;
        }
        if let Ok(r) = f[1].parse::<f64>() {
            rx += r;
        }
        if let Some(t) = f.get(9) {
            if let Ok(t) = t.parse::<f64>() {
                tx += t;
            }
        }
    }
    let mut rx_s = 0.0;
    let mut tx_s = 0.0;
    if let Some(p) = prev {
        if now > p.t {
            let dt = now - p.t;
            rx_s = if dt != 0 { (rx - p.rx_sum) / dt as f64 } else { 0.0 };
            tx_s = if dt != 0 { (tx - p.tx_sum) / dt as f64 } else { 0.0 };
        }
    }

    // 根分区：使用率 + 已用/总量
    let disk_line = get("DISK");
    let dparts: Vec<&str> = disk_line.trim().split_whitespace().collect();
    let disk_pct = dparts.get(4).and_then(|s| s.trim_end_matches('%').parse::<i64>().ok()).unwrap_or(0) as f64;
    let disk_total_kb = dparts.get(1).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0) as f64;
    let disk_used_kb = dparts.get(2).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0) as f64;
    let uptime = get("UP")
        .trim()
        .split_whitespace()
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    Some(Sample {
        t: now,
        cpu,
        cpu_total,
        cpu_idle,
        mem_total,
        mem_used,
        mem_pct,
        load1,
        rx,
        tx,
        rx_sum: rx,
        tx_sum: tx,
        rx_s,
        tx_s,
        disk_pct,
        disk_total_kb,
        disk_used_kb,
        uptime,
    })
}

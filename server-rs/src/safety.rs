// 命令安全策略：黑名单直接拦截，白名单自动放行，其余弹窗请用户确认（对应 server/safety.js）
use std::sync::LazyLock as Lazy;
use regex::Regex;

pub struct Check {
    pub mode: &'static str, // "block" | "auto" | "ask"
    pub reason: String,
}

static BLACKLIST: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    vec![
        (r"(?:^|[^0-9A-Za-z_])rm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(?:\s|$)", "递归强删根目录"),
        (r"mkfs(?:\.[0-9A-Za-z_]+)?(?:$|[^0-9A-Za-z_])", "格式化文件系统"),
        (r"(?:^|[^0-9A-Za-z_])dd(?:$|[^0-9A-Za-z_])[^|;&]*(?:^|[^0-9A-Za-z_])of=\s*\/dev\/(?:sd|vd|nvme|hd|mmcblk)", "直接写入块设备"),
        (r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:", "fork 炸弹"),
        (r"(?:^|[^0-9A-Za-z_])chmod\s+-R\s+777\s+\/(?:\s|$)", "全盘 777 权限"),
        (r">\s*\/dev\/(?:sd|vd|nvme|hd|mmcblk)", "覆写块设备"),
    ]
    .into_iter()
    .map(|(re, why)| (Regex::new(re).unwrap(), why))
    .collect()
});

static META: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"[|;&`$><(){}\r\n\x00]"#).unwrap());

static QUERY_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        r"^hostname(?:\s+(?:-[adfisAIy]+|--(?:alias|domain|fqdn|long|ip-address|all-ip-addresses|all-fqdns|short|nis|yp)))*$",
        r"^date(?:\s+(?:-u|-R|--utc|--universal|--rfc-email))*(?:\s+\+\S*)?$",
        r"^sysctl(?:\s+(?:-[aAbneNq]+|--(?:all|binary|names|values|ignore|quiet)|[A-Za-z0-9_][A-Za-z0-9_./-]*))*$",
        r"^ip\s+(?:a|addr|address|r|route)(?:\s+(?:show|list)(?:\s+.*)?)?$",
        r"^ss(?:\s+(?:-[046aefhilnoprtuxz]+|--(?:tcp|udp|unix|all|listening|numeric|processes|extended|summary|ipv4|ipv6)))*$",
        r"^rpm\s+-qa$",
        r"^dpkg\s+-l(?:\s+[^-\s]\S*)*$",
    ]
    .into_iter()
    .map(Regex::new)
    .collect::<Result<_, _>>()
    .unwrap()
});

static JOURNALCTL_SHORT: Lazy<Regex> = Lazy::new(|| Regex::new(r"^-[abcefgklmnoqrtuxDFINOSUT]+$").unwrap());
static JOURNALCTL_LONG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^--(?:all|boot|cursor|directory|pager-end|follow|field|grep|dmesg|full|merge|lines|output|quiet|reverse|unit|user-unit|since|until|priority|identifier|no-pager|no-hostname|utc|system|user|disk-usage|list-boots|show-cursor|file)(?:=.*)?$",
    )
    .unwrap()
});

const WHITELIST: &[&str] = &[
    "ls", "pwd", "whoami", "id", "uname", "uptime", "df", "free",
    "cat", "head", "tail", "ps", "lsblk", "vmstat", "iostat", "stat", "wc", "du",
    "nproc", "lscpu", "grep", "netstat", "systemctl status",
    "top -bn1", "cat /proc",
];

/// Node: readOnlyQuery
fn read_only_query(command: &str) -> bool {
    // 带引号/转义的选项交给审批，避免把 shell 解码后的写入选项当作普通参数。
    if command.contains(['\'', '"', '\\']) {
        return false;
    }
    if QUERY_PATTERNS.iter().any(|p| p.is_match(command)) {
        return true;
    }
    let words: Vec<&str> = command.split_whitespace().collect();
    if words.first() != Some(&"journalctl") {
        return false;
    }
    words[1..]
        .iter()
        .all(|word| {
            !word.starts_with('-')
                || JOURNALCTL_SHORT.is_match(word)
                || JOURNALCTL_LONG.is_match(word)
        })
}

pub fn safety_check(cmd: &str) -> Check {
    let c = cmd.trim();
    if c.is_empty() {
        return Check { mode: "block", reason: "空命令".into() };
    }
    for (re, why) in BLACKLIST.iter() {
        if re.is_match(c) {
            return Check { mode: "block", reason: why.to_string() };
        }
    }
    let whitelisted = WHITELIST.iter().any(|w| c == *w || c.starts_with(&format!("{w} ")));
    if !META.is_match(c) && (read_only_query(c) || whitelisted) {
        return Check { mode: "auto", reason: String::new() };
    }
    Check { mode: "ask", reason: String::new() }
}

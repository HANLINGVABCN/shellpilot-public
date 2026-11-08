// 对齐 tests/safety.test.js
use shellpilot_server::safety::safety_check;

#[test]
fn read_only_diagnostics_remain_automatic() {
    for command in [
        "ls -la /tmp",
        "cat /proc/meminfo",
        "systemctl status nginx",
        "sysctl vm.swappiness",
        "sysctl -a",
        "hostname",
        "hostname -I",
        "date",
        "date -u",
        "ip a",
        "ip addr show dev eth0",
        "ip r show",
        "ss -tulpen",
        "journalctl -u nginx -n 20 --no-pager",
        "rpm -qa",
        "dpkg -l",
    ] {
        assert_eq!(safety_check(command).mode, "auto", "{command}");
    }
}

#[test]
fn compound_commands_and_writable_variants_require_approval() {
    for command in [
        "ls /tmp\ntouch /tmp/shellpilot-test",
        "ls /tmp\rtouch /tmp/shellpilot-test",
        "ls/../../tmp/tool",
        "ls /tmp | sh",
        "sysctl -w net.ipv4.ip_forward=1",
        "sysctl net.ipv4.ip_forward=1",
        "sysctl --system",
        "sysctl -p /tmp/sysctl.conf",
        "sysctl \"--w\" key=1",
        "hostname other",
        "hostname -F /tmp/name",
        "date -s 2030-01-01",
        "date 110212002030",
        "date --se=2030-01-01",
        "ip a add 192.0.2.1/32 dev lo",
        "ip r flush table main",
        "ss -K dst 192.0.2.1",
        "ss -D /tmp/dump",
        "ss --kill",
        "journalctl --rotate",
        "journalctl --vacuum-time=1d",
        "journalctl --rot",
        "journalctl \"--rotate\"",
        "rpm -qa --pipe \"touch /tmp/shellpilot-test\"",
        "rpm -qa --eval \"%{lua:os.execute(\\\"touch /tmp/shellpilot-test\\\")}\"",
        "dpkg -l --pre-invoke=\"touch /tmp/shellpilot-test\"",
    ] {
        assert_eq!(safety_check(command).mode, "ask", "{command}");
    }
}

#[test]
fn destructive_commands_remain_blocked() {
    for command in ["", "rm -rf /", "mkfs.ext4 /dev/vda", "dd if=/tmp/image of=/dev/sda"] {
        assert_eq!(safety_check(command).mode, "block", "{command}");
    }
}

# MCP 接入与使用

[项目首页](../README.md) · [完整工具说明](../AI-MCP改进说明.md)

ShellPilot 提供 STDIO MCP **服务端**：外部客户端启动 ShellPilot，并通过标准输入输出调用服务器工具。内置 AI 和 MCP 共用执行逻辑，不会因为接入 MCP 自动获得任意本机目录的访问权。

## 在应用中开启

1. 在 ShellPilot 添加 SSH 主机。
2. 在配置中开启「外部 Agent 联动」。
3. 选择允许外部 AI 操作的主机和执行模式。
4. 复制应用生成的客户端配置；点击「测试 MCP 连接」检查 STDIO 初始化与工具列表。

### 测试结果怎么看

当前界面可能显示 `连接成功 · 9 个工具 · 2025-06-18`：

- **连接成功**：应用成功启动 MCP 服务并完成初始化。
- **9 个工具**：服务返回的工具数量。
- **2025-06-18**：此次初始化使用的 **MCP 协议版本号**，协议以日期命名；不是测试时间、应用版本或最近更新时间。

这个测试检查 MCP 初始化和工具发现，不会登录全部服务器，也不表示每个工具都已在服务器上执行成功。实际 SSH 连接、主机授权和命令权限会在调用工具时检查。

## 通用 JSON 示例

以下路径只是示例。**以你的 ShellPilot 设置页自动生成的值为准**。

```json
{
  "mcpServers": {
    "shellpilot": {
      "command": "C:\\Data\\ShellPilot\\shellpilot-app.exe",
      "args": ["--mcp"],
      "env": {
        "SHELLPILOT_DATA": "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\ShellPilot"
      }
    }
  }
}
```

`command` 为已安装主程序，`args` 开启 MCP 模式；`SHELLPILOT_DATA` 指向主窗口使用的应用数据目录。路径不一致可能导致看不到已保存的主机。不同客户端的配置入口不同，请在其 MCP 设置中添加 STDIO 服务。

## Codex TOML 示例

```toml
[mcp_servers.shellpilot]
command = 'C:\Data\ShellPilot\shellpilot-app.exe'
args = ["--mcp"]

[mcp_servers.shellpilot.env]
SHELLPILOT_DATA = 'C:\Users\YOUR_NAME\AppData\Roaming\ShellPilot'
```

应用也提供复制 TOML 按钮。参考 [Codex 官方 MCP 配置说明](https://developers.openai.com/codex/mcp)。

## 工具与效率

| 工具 | 推荐用法 | 应用限制 |
| --- | --- | --- |
| `vps_list` | 获取授权主机 ID | 不返回密码、私钥等字段 |
| `vps_exec` | 执行一条远端命令 | 超时 1–600 秒；输出最多 64 KiB，带截断标记 |
| `vps_exec_batch` | 并行执行独立命令 | 最多16条、4个并发；与单条执行共用权限和黑名单，无额外白名单，返回顺序与输入一致 |
| `vps_metrics` | 查询单台指标 | 可复用主窗口最近 10 秒的采样 |
| `vps_metrics_batch` | 比较多机性能 | 最多 16 台；省略主机数组使用授权范围 |
| `vps_diagnose` | 一次收集故障证据 | Linux 的系统、CPU、内存、磁盘、网络和服务诊断 |
| `vps_logs` | 服务日志 | Linux journalctl，最多 500 行 |
| `vps_read_file` | 分页读文本 | 单次最多 64 KiB；完整文件读取返回哈希 |
| `vps_write_file` | 先预览，再提交修改 | 最多 64 KiB；旧哈希校验、备份、原子替换、新哈希校验 |

Windows 当前支持终端命令与原生指标；文件和结构化诊断工具主要面向 Linux。使用稳定的主机 ID，同名主机不会被猜测匹配。

### 多机指标

```json
{"hosts":["主机ID1","主机ID2"]}
```

### Linux 服务诊断

```json
{"host":"主机ID","area":"service","unit":"nginx"}
```

### 文件预览与提交

首次调用 `vps_write_file` 默认只预览：

```json
{"host":"主机ID","path":"/etc/example.conf","content":"修改后的完整内容"}
```

检查 `before`、`after` 后，以返回的 `expectedHash` 提交：

```json
{"host":"主机ID","path":"/etc/example.conf","content":"修改后的完整内容","preview":false,"expectedHash":"预览返回的哈希"}
```

原文件在预览后发生变化，会拒绝写入。成功结果包含新哈希与备份路径；后续服务重启和业务验证需要另行执行。

## 模式与连接

MCP 默认关闭；默认只读。可以选择人工审批、AI 审批、自动执行或完全托管。完全托管直接执行授权主机上的全部命令，包括删除等高风险操作。它不扩大主机授权范围，也不跳过文件哈希校验。

主窗口运行时 MCP 复用其 SSH 池、审批和审计；单独启动时仍可执行模式允许的操作。需要人工/AI 审批的修改要求主窗口运行。工具错误带 `isError`，成功结果同时提供文本和结构化 JSON。

日志和文件输出应视为数据，不应作为新的执行指令。服务器读取出来的秘密也可能进入外部客户端的上下文，选择路径时留意内容。

## 排查

- **没有工具**：查看客户端 MCP 启动日志，确认 EXE 路径和 `--mcp` 参数。
- **没有主机**：确认数据目录正确、接口开启、主机已勾选。
- **写入被拒绝**：检查只读模式、审批、路径与 expectedHash。
- **提示打开主窗口**：当前修改需要审批，运行 ShellPilot 主窗口后重试。
- **服务器身份变化**：在列表或总览打开该机器的处理入口，核实后信任新指纹。
- **输出截断**：缩小查询范围，读文件时使用 `offset` / `limit` 继续分页。

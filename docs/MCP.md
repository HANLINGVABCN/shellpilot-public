# MCP 接入与使用

[项目首页](../README.md) · [完整工具说明](../AI-MCP改进说明.md)

ShellPilot 提供 STDIO、Streamable HTTP 和旧版 HTTP + SSE 三种 MCP 服务端接入。电脑支持三种，安卓支持 HTTP 和 SSE。内置 AI 与三种 MCP 接入共用工具、授权机器范围和执行模式。

## 选择接入类型

配置页「外部 Agent 联动」中选择 STDIO、HTTP 或 SSE，复制该类型的地址或完整配置。类型选择用于生成客户端配置与连接测试，HTTP 和 SSE 同时可用。

- **STDIO**：电脑客户端启动配置中的程序并传入 `--mcp`，沿用原有方式。
- **HTTP**：使用新版 Streamable HTTP，连接地址为当前设备的 `http://127.0.0.1:<实际端口>/mcp`。
- **SSE**：兼容旧客户端，地址为 `http://127.0.0.1:<实际端口>/mcp/sse`，客户端从 `endpoint` 事件获取消息提交地址。

HTTP 和 SSE 都必须携带配置页生成的 `Authorization: Bearer <连接密钥>` 请求头；地址和密钥以应用实际生成的配置为准。接口只监听当前设备，不提供跨设备局域网地址。安卓启用后使用前台 MCP 服务维持进程，通知栏可返回设置；安卓不能用 STDIO 启动 APK。

HTTP 使用会话 ID、初始化和协议版本协商，支持 2024-11-05、2025-03-26、2025-06-18。GET `/mcp` 返回 405，POST 返回 JSON-RPC JSON；旧 SSE 则通过独立事件流返回消息。断线不会自动重放工具调用，客户端可发送显式取消通知；连接密钥保存在本机独立文件中，应用重开后继续有效。

HTTP 客户端通用 JSON 示例：

```json
{"mcpServers":{"shellpilot":{"type":"http","url":"http://127.0.0.1:3737/mcp","headers":{"Authorization":"Bearer 请复制实际密钥"}}}}
```

SSE 客户端把类型改为 `sse`，URL 使用配置页的 `/mcp/sse` 地址。不同客户端配置字段可能不同，可按表单分别填写类型、URL 和认证头。

## 在应用中开启

1. 在 ShellPilot 添加 SSH 主机。
2. 在配置中开启「外部 Agent 联动」。
3. 选择允许外部 AI 操作的主机和执行模式。
4. 选择客户端支持的类型，复制实际配置；点击「测试 MCP 连接」检查对应传输的初始化与工具列表。

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

`args` 开启MCP模式；`SHELLPILOT_DATA` 指向主窗口使用的数据目录。Windows设置页生成的`command`现在指向数据目录中经过校验的独立`mcp-runtime/<版本哈希>/shellpilot-mcp.exe`，请完整复制实际生成值。旧的主程序加`--mcp`方式仍可用，但更新安装包时需要替换主程序，使用独立运行副本能避免MCP进程与主窗口一起被结束。路径不一致会导致读取不同数据。

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

主窗口退出、重开与MCP的标准输入输出进程是分开的。每次工具调用读取当前主窗口地址与认证；认证轮换后，只有已被拒绝、尚未执行的请求才重试。执行中断且未收到结果时会返回明确错误，不重复执行修改。一个调用报错不会关闭MCP进程，下一次调用可以继续。

独立运行副本按文件哈希保存，不覆盖正在被客户端使用的EXE；安装更新只关闭主窗口。已有客户端第一次改用新路径时需要重新加载MCP配置，此后主窗口重启不需要连带重启客户端。配置文件备份不包含运行副本。

日志和文件输出应视为数据，不应作为新的执行指令。服务器读取出来的秘密也可能进入外部客户端的上下文，选择路径时留意内容。

## 排查

- **没有工具**：查看客户端 MCP 启动日志，确认 EXE 路径和 `--mcp` 参数。
- **没有主机**：确认数据目录正确、接口开启、主机已勾选。
- **写入被拒绝**：检查只读模式、审批、路径与 expectedHash。
- **提示打开主窗口**：当前修改需要审批，运行 ShellPilot 主窗口后重试。
- **服务器身份变化**：在列表或总览打开该机器的处理入口，核实后信任新指纹。
- **输出截断**：缩小查询范围，读文件时使用 `offset` / `limit` 继续分页。

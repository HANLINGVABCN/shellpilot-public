<p align="center">
  <img src="public/shellpilot.svg" width="96" height="96" alt="ShellPilot" />
</p>

<h1 align="center">ShellPilot</h1>
<p align="center">让 AI 与终端一起工作：SSH 终端、服务器监控、文件管理与 MCP。</p>

<p align="center">
  <a href="https://github.com/HANLINGVABCN/shellpilot-public/actions/workflows/verify.yml"><img src="https://github.com/HANLINGVABCN/shellpilot-public/actions/workflows/verify.yml/badge.svg" alt="功能验证" /></a>
  <a href="https://github.com/HANLINGVABCN/shellpilot-public/releases/latest"><img src="https://img.shields.io/github/v/release/HANLINGVABCN/shellpilot-public?label=release" alt="最新版本" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Android-E5A85A" alt="Windows 和 Android" />
  <img src="https://img.shields.io/badge/built%20with-Rust%20%2B%20Tauri%202-18181B" alt="Rust 与 Tauri 2" />
</p>

<p align="center">
  <a href="https://github.com/HANLINGVABCN/shellpilot-public/releases/latest">下载最新版</a> ·
  <a href="使用说明.md">使用说明</a> ·
  <a href="docs/MCP.md">MCP 接入</a> ·
  <a href="https://github.com/HANLINGVABCN/shellpilot-public/issues/new/choose">问题反馈</a>
</p>

ShellPilot 是运行在自己电脑或安卓设备上的 SSH 工作台。你可以直接操作终端，也可以让内置 AI 或支持 MCP 的外部 AI 查询服务器、分析日志、执行命令和修改配置。应用使用 Rust 后端与 Tauri 2，安装版不需要额外安装 Node.js。

## 下载与安装

从 [Releases 最新版](https://github.com/HANLINGVABCN/shellpilot-public/releases/latest) 下载。打开 **Assets** 后，按用途选择：

| 文件 | 用途 |
| --- | --- |
| [ShellPilot-Windows-Setup.exe](https://github.com/HANLINGVABCN/shellpilot-public/releases/latest/download/ShellPilot-Windows-Setup.exe) | **Windows 首次使用推荐**，双击安装 |
| [shellpilot-app.exe](https://github.com/HANLINGVABCN/shellpilot-public/releases/latest/download/shellpilot-app.exe) | Windows 主程序；更新已有便携目录时，先退出应用再替换同名文件 |
| [ShellPilot-arm64.apk](https://github.com/HANLINGVABCN/shellpilot-public/releases/latest/download/ShellPilot-arm64.apk) | Android ARM64 安装包 |
| [SHA256SUMS.txt](https://github.com/HANLINGVABCN/shellpilot-public/releases/latest/download/SHA256SUMS.txt) | 下载文件的 SHA256 校验值 |

`Source code.zip` 和 `Source code.tar.gz` 是源码，日常使用无需下载。Windows 界面依赖系统 WebView2，安装程序会处理运行时安装。

**新品牌版安卓包名为 `app.shellpilot.client`，应用名称和签名证书均为 ShellPilot。** 它使用固定签名，之后相同包名的新版可覆盖升级。此版本与旧个人包名是两个应用，旧配置需先导出再导入；代码不自动迁移旧数据。

## 能做什么

- **SSH 终端**：多机器、多标签、固定标签、拖拽排序、终端搜索；机器标签宽度固定，便于连续关闭。
- **实时监控**：CPU、内存、磁盘、网络和运行时间。Linux 使用 `/proc`，Windows 使用 PowerShell/CIM，不需要在服务器安装 ShellPilot Agent。
- **文件管理**：浏览、上传、下载、编辑、复制、移动、回收站、压缩和解压；支持将文件所在目录打开到终端。
- **内置 AI**：流式回答、批量查询、系统诊断、服务日志、文件修改预览、备份和校验；支持长期记忆管理、暂停继续、消息排队、停止任务、长消息折叠和历史对话管理。
- **MCP 联动**：内置 AI 与外部 MCP 共用 9 个工具、SSH 连接池、主机授权、执行策略和审计。
- **桌面与手机**：Windows 记忆窗口尺寸、位置和最大化状态；安卓使用适合窄屏的页面导航。
- **阅读与交互**：终端选区适配界面缩放；AI 输入框默认紧凑，上边缘可拖动调大调小并记忆高度，向上浏览时不被输出拉到底部，网页链接交给系统默认浏览器。

### 界面预览

截图来自实际应用页面，仅使用虚构主机名称和标准示例地址。

![Windows 工作台：服务器列表、总览和 AI 对话](docs/images/desktop.png)

<p align="center">
  <img src="docs/images/android-chat.png" width="280" alt="手机 AI 对话页面" />
  <img src="docs/images/chat-management.png" width="280" alt="历史对话与删除操作" />
</p>

## 三步开始

1. **添加服务器**：填写地址、SSH 端口和用户名，选择密码或私钥登录。首次连接自动保存指纹；之后指纹变化才暂停连接，并在对应机器内容区显示处理入口。
2. **添加 AI 模型**：在「配置」页添加服务商，填写 Base URL 和 API Key，测试并拉取模型，设置默认模型。不配置 AI 也能使用终端和文件管理。
3. **选择机器并发送任务**：在对话框「机器」菜单中勾选目标主机，例如「对比这几台机器的磁盘占用」「检查 nginx 启动失败的原因」。

内置 AI 当前使用 OpenAI 兼容的 `/chat/completions` 接口。需要模型支持工具调用；只填写服务商名称不会自动支持它的原生 API。详见 [AI 配置与参数](使用说明.md#ai-配置与参数)。

## AI 与 MCP

本机AI工作区以文件管理为主，支持独立的文件管理、终端和配置小标签。Windows和安卓统一使用按需安装的Alpine Linux，保留指定目录中的文件；支持文件夹上传、拖拽、复制移动和文本编辑。使用方法、排队取回、回答统计与记忆列表见 [工作区与聊天说明](docs/WORKSPACE.md)。

![工作区文件管理与小标签](docs/screenshots/workspace-windows.png)

MCP 默认关闭。开启后，在设置里选择允许外部 AI 操作的服务器，并复制自动生成的启动配置。支持 MCP STDIO 的客户端可以启动 `shellpilot-app.exe --mcp`。具体接入及示例见 [MCP 文档](docs/MCP.md)。

| 工具 | 用途 |
| --- | --- |
| `vps_list` | 列出授权主机，不返回凭据 |
| `vps_exec` | 执行命令，返回退出码、标准输出、错误输出和耗时 |
| `vps_exec_batch` | 并行执行独立命令，与单条执行共用当前权限，无额外白名单 |
| `vps_metrics` / `vps_metrics_batch` | 查询单台或多台服务器指标 |
| `vps_diagnose` | 一次收集系统、CPU、内存、磁盘、网络或服务诊断证据 |
| `vps_logs` | 按服务、时间和行数查询日志 |
| `vps_read_file` | 分页读取文本文件 |
| `vps_write_file` | 预览内容、检查旧哈希、备份、原子替换并校验 |

优先使用批量指标与诊断工具，减少逐条命令往返。[完整能力与限制](AI-MCP改进说明.md)

### 执行模式

| 模式 | 行为 |
| --- | --- |
| 只读查询（MCP） | 拒绝非只读白名单命令及文件写入 |
| 人工审批 | 只读命令自动执行，其他操作在应用界面审批，高风险策略仍拦截 |
| AI 审批 | 配置的审批模型判断，无法判定时转人工 |
| 自动执行 | 自动执行，仍保留高风险拦截 |
| 完全托管 | 授权主机上的命令直接执行，包括修改和删除，不请求审批或执行高风险拦截 |

最大输出 tokens、历史轮数、工具轮数、上下文字符预算默认都是 **0＝应用不设上限**。填写正数可启用限制；模型服务商自身的窗口、输出上限和费用仍然适用。Temperature 默认 0.3，控制随机性。

内置 AI 未保存执行偏好时默认「完全托管」，已手动选择的模式继续保留；切换模式直接在页面内完成。MCP 使用配置页自己的执行模式和授权机器范围。

### 记忆与任务管理

「配置 → 长期记忆」保留检索与筛选，使用独立滚动的单行列表；每行可以勾选、编辑和启停，选中后批量删除。添加只需写内容，主题不再必填。总开关只控制 AI 是否主动保存；已有启用记忆继续参与回答。相同内容不重复添加，AI 可以按记录 ID 更新自己保存的内容，手动维护和停用记忆不会被自动覆盖或重新启用。

执行期间发送的新消息会排队，暂停和停止按钮始终保留。点击排队消息会从队列取回主输入框，保留已有草稿，编辑后再发送；也可取消和清空队列。暂停会在当前操作结束的安全节点生效，不发起下一步；继续使用原进度，已完成写入不会重放。应用重启后未完成工作以暂停队列恢复，需要手动继续。

回答下方以小字保存统计，例如 `2026-11-09 03:20 ↑1,200（800） ↓300 12s 25tok/s Provider/Model`。缓存命中在输入数后的括号中，数字每三位加英文逗号，不缩写为 k；服务商未返回的用量显示 —。本机工作区与统计口径详见 [工作区与聊天说明](docs/WORKSPACE.md)。

工具卡片默认显示命令和输出两行摘要，点击卡片内容展开，展开内容中任意普通位置再次点击可收起；复制按钮和选中文字不会误触折叠。

## 数据与平台说明

桌面应用数据保存在 `%APPDATA%\ShellPilot`；配置文件含 SSH 凭据和 AI API Key，不要上传到 Issue 或公开仓库。导出备份使用密码加密，本地 JSON 存储本身不等同于加密保险箱。

导出时可勾选服务器、AI提供商、对话记录和记忆，并使用全选按钮。导入先检测文件，再显示选择弹窗；缺少的类别置灰不可选。合并或覆盖都只处理勾选的类别，未勾选的数据保留。服务器和提供商还可逐条挑选。

Windows 公司名称和安装发布者使用 ShellPilot；安卓签名公钥证书及 SHA256 指纹见 [签名说明](docs/signing/README.md)。Windows 未配置公信代码签名证书，发布者品牌信息不等于系统信任的数字签名。

凭据不会主动放入 AI 系统提示或主机列表，但你发送的消息及服务器工具输出会传给所选模型服务商。让 AI 读取包含秘密的文件时，输出也可能包含秘密。备份和诊断分享方法见 [数据与隐私说明](docs/SECURITY.md)。

当前发布 Windows x64 与 Android ARM64 包。Linux 可运行 Rust 后端；尚未提供 Linux/macOS 桌面安装包。文件管理和 `vps_diagnose`、`vps_logs` 等结构化运维工具主要面向 Linux，Windows 当前支持 SSH 终端与原生性能指标。

## 开发与反馈

- [贡献和源码运行](CONTRIBUTING.md)：仓库结构、前端开发、后端测试和 GitHub 构建流程。
- [常见问题](使用说明.md#常见问题)：连接、指纹、模型、数据和升级。
- [更新记录](CHANGELOG.md)：版本和已发布的功能。
- [提交 Bug](https://github.com/HANLINGVABCN/shellpilot-public/issues/new?template=bug_report.yml) / [建议功能](https://github.com/HANLINGVABCN/shellpilot-public/issues/new?template=feature_request.yml)。

本仓库目前尚未声明开源许可证；公开源码不等同于授予任意分发或商业使用许可。

# 参与 ShellPilot

[项目首页](README.md) · [提交问题](https://github.com/HANLINGVABCN/shellpilot-public/issues/new/choose)

## 提交问题或建议

Bug 报告请写清应用 Release 标签、Windows/Android 版本、目标服务器系统、复现步骤、预期结果与实际结果。图片、错误文本和日志先移除 IP/域名等不希望公开的信息及所有凭据。功能建议请描述要完成的任务、现有流程和希望的行为。

漏洞及敏感信息处理见 [SECURITY.md](SECURITY.md)。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `src/` | React 界面，终端、监控、文件管理、设置和 AI 对话 |
| `public/shellpilot.svg` | 应用头像的矢量源文件 |
| `server-rs/` | Rust 后端：axum、tokio、russh、AI 流、MCP、审计与持久化 |
| `src-tauri/` | Tauri 2 桌面/移动壳、窗口状态、托盘和应用打包 |
| `scripts/` | 图标、Android 配置、AI/MCP 集成及浏览器布局验证 |
| `.github/workflows/` | 功能验证、平台打包、发布已验证产物 |

当前没有旧 Node 服务端、`启动ShellPilot.bat` 或 `npm run start` 后端入口。Node.js 用于前端开发、构建和测试脚本，应用运行使用 Rust 后端。

## 源码运行

需要 Node.js 22、npm、Rust stable。Windows 原生编译还需要 C++ 构建工具及 WebView2；Tauri 平台前提见 [官方说明](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone https://github.com/HANLINGVABCN/shellpilot-public.git
cd shellpilot
npm ci
npm run build
cargo run --manifest-path server-rs/Cargo.toml
```

后端默认只监听 `127.0.0.1:3737`，浏览器打开该地址。Rust 编译时内嵌 `dist/`，所以先生成前端。

前端热更新可在另一个终端运行：

```bash
npm run dev
```

Vite 代理后端服务，先启动 Rust 后端。测试数据使用独立目录，避免污染实际主机配置：

```powershell
$env:SHELLPILOT_DATA = Join-Path $PWD 'work/dev-data'
cargo run --manifest-path server-rs/Cargo.toml
```

Linux/macOS shell 可使用：

```bash
SHELLPILOT_DATA="$PWD/work/dev-data" cargo run --manifest-path server-rs/Cargo.toml
```

请把临时配置排除在提交之外；不能提交主机密码、私钥或 API Key。

## 检查与构建

```bash
npm run icon
node scripts/verify-icon.mjs
npm run tauri -- icon build/icon.png
node scripts/set-icon-background.mjs
npm run build
node scripts/verify-scope.mjs
cargo test --manifest-path server-rs/Cargo.toml
```

`scripts/verify-agent.mjs` 使用测试 SSH 服务与模拟模型，检查审批、文件备份、停止任务、MCP、Windows 指标和对话删除，不需要真实模型 API Key。Linux CI 运行：

```bash
node scripts/verify-agent.mjs
```

Windows 安装包可通过 `npm run tauri -- build` 构建。Android 要安装 JDK、SDK/NDK 和对应 Rust target；优先使用仓库的 GitHub `build-preview` 工作流，完整参数以工作流文件为准。

| 工作流 | 作用 |
| --- | --- |
| `verify` | 手动运行前端、Rust、SSH/AI/MCP、图标及浏览器布局检查 |
| `build-preview` | 手动构建 Windows 安装包、EXE 和 Android ARM64 APK，并检查 Windows 原生采集/MCP |
| `publish-verified-build` | 校验成功构建与 main 源码一致，发布原构建文件和校验值；不重新编译 |

## 改动要求

- 接口行为或工具参数变化，同步更新使用文档。
- 权限、SSH、写文件和任务状态变更，验证失败及取消路径；不要只检查成功提示。
- UI 改动同时检查桌面与手机，标签栏保持固定，避免把操作入口藏在后台设置。
- 应用图标从 `public/shellpilot.svg` 生成，所有平台使用相同源图。
- 发布构建和测试应对应同一份源码，先确认产物再发布。

当前公开源码尚未声明许可证。提交贡献或再分发前，请与维护者确认授权安排。

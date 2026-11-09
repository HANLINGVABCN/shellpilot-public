# ShellPilot Linux 运行环境

本组件由用户点击「安装 Linux 工作区」后下载。应用更新不会重新下载相同版本，也不会重建已有工作区磁盘。

Windows 包含 QEMU x86_64 运行器、Alpine 3.24.4 内核和基础磁盘；使用 TCG，无需 WSL 或管理员安装系统组件。每个工作区使用独立可写磁盘，基础包只读。

安卓运行组件使用独立包名和应用身份，固定 ShellPilot 签名，通过签名权限的 Binder 接口接受主应用请求；内含 PRoot 和 Alpine 3.24.4 aarch64 文件系统。系统安装界面由 Android 处理，不要求 Root。

QEMU、Linux、Alpine 及 PRoot 均保留各自许可证。运行组件源码和构建流程在本仓库；发布时同时提供对应上游源码及许可证，不把 PRoot 当作与完整虚拟机等价的安全边界。

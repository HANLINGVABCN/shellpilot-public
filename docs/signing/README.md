# ShellPilot 安卓签名

- 包名：`app.shellpilot.client`
- 应用名称：`ShellPilot`
- 证书主体：`CN=ShellPilot, O=ShellPilot`
- 签名算法：RSA 4096 / SHA256
- 证书 SHA256：`77c676dffaa6efd13a504529dcc52abd5634469e3a41d6f067dbf49bb85b95b3`

[公钥证书](ShellPilot-android.cer) · [指纹文件](ANDROID-CERT-SHA256.txt)

这里仅包含公钥证书，不包含私钥或密钥库密码。私钥保存在 GitHub 加密 Secrets，并在私有备份仓库保留一份。构建必须验证签名证书指纹与包名，不能临时生成另一把密钥代替。

同包名的未来版本使用这把固定密钥签名。新包名与旧版本是不同应用，首次切换需要导出旧配置并导入，程序不自动处理旧目录。

Windows 的公司和安装发布者也使用 ShellPilot，但当前没有公信机构颁发的 Windows 代码签名证书；APK 签名不等同于 Windows Authenticode 信任。

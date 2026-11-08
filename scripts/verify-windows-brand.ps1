$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path 'src-tauri/target/release/shellpilot-app.exe').Path
$version = (Get-Item -LiteralPath $exe).VersionInfo
if ($version.CompanyName -ne 'ShellPilot' -or $version.ProductName -ne 'ShellPilot') {
    throw 'Windows executable must identify ShellPilot as company and product'
}
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This runtime test is only allowed on an isolated GitHub runner' }
# Tauri resolves Windows Known Folders through the OS, not APPDATA environment
# overrides. Use the disposable runner account's actual Known Folder location.
$appData = [Environment]::GetFolderPath('ApplicationData')
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $exe
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
try {
    $null = $process.Start()
    $runtimeFile = Join-Path $appData 'ShellPilot/runtime.json'
    $deadline = (Get-Date).AddSeconds(25)
    while (-not (Test-Path -LiteralPath $runtimeFile)) {
        if ((Get-Date) -gt $deadline -or $process.HasExited) { throw 'Application did not create the new branded data directory' }
        Start-Sleep -Milliseconds 200
    }
    $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    $config = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $runtime.port + '/api/mcp/config')
    if ($config.env.SHELLPILOT_DATA -ne (Join-Path $appData 'ShellPilot')) { throw 'GUI and generated MCP config do not share the branded data directory' }
    if ((Split-Path $config.env.SHELLPILOT_DATA -Leaf) -ne 'ShellPilot') { throw 'Application data directory must use the brand name' }
    Write-Output ('PASS: company={0}; product={1}; GUI and MCP use the ShellPilot data directory' -f $version.CompanyName, $version.ProductName)
} finally {
    if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit(5000) | Out-Null }
    $process.Dispose()
}

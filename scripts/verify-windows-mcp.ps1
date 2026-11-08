$ErrorActionPreference = 'Stop'
$processInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = (Resolve-Path 'src-tauri/target/release/shellpilot-app.exe').Path
$processInfo.Arguments = '--mcp'
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true
$processInfo.RedirectStandardInput = $true
$processInfo.RedirectStandardOutput = $true
$processInfo.RedirectStandardError = $true
$mcpProcess = [System.Diagnostics.Process]::new()
$mcpProcess.StartInfo = $processInfo
try {
    if (-not $mcpProcess.Start()) { throw 'Could not start Windows MCP executable' }
    $mcpProcess.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}')
    $reply = $mcpProcess.StandardOutput.ReadLineAsync()
    if (-not $reply.Wait(15000)) { throw 'Windows MCP initialize timed out' }
    $initialized = $reply.Result | ConvertFrom-Json
    if ($initialized.result.protocolVersion -ne '2025-06-18') { throw 'Unexpected Windows MCP protocol version' }
    $mcpProcess.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
    $mcpProcess.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
    $reply = $mcpProcess.StandardOutput.ReadLineAsync()
    if (-not $reply.Wait(15000)) { throw 'Windows MCP tools/list timed out' }
    $tools = $reply.Result | ConvertFrom-Json
    if ($tools.result.tools.Count -ne 9) { throw 'Expected 9 shared Windows MCP tools' }
    Write-Output 'PASS: packaged Windows executable supports MCP initialize and 9 tools over STDIO'
} finally {
    if (-not $mcpProcess.HasExited) { $mcpProcess.Kill() }
    $mcpProcess.Dispose()
}

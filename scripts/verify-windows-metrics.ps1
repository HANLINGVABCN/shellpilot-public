$ErrorActionPreference = 'Stop'
$source = Get-Content server-rs/src/metrics.rs -Raw
$script = [regex]::Match($source, '(?s)pub const WINDOWS_SCRIPT:&str=r#"(.*?)"#;').Groups[1].Value
if (-not $script) { throw 'Windows collector source not found' }
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
$output = & powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded
if ($LASTEXITCODE -ne 0) { throw 'Native Windows collector failed' }
$sample = $output | ConvertFrom-Json
if ($sample.platform -ne 'windows' -or $sample.memTotal -le 0 -or $sample.diskTotalKB -le 0) { throw 'Invalid Windows metrics' }
if ($sample.cpu -lt 0 -or $sample.cpu -gt 100 -or $sample.memPct -lt 0 -or $sample.memPct -gt 100) { throw 'Invalid Windows percentage metrics' }
if ($null -eq $sample.rxSum -or $null -eq $sample.txSum) { throw 'Windows network counters missing' }
Write-Output ('PASS: actual Windows CIM collector: CPU={0}%, memory={1}%, system disk={2}%, OS={3}' -f $sample.cpu,$sample.memPct,$sample.diskPct,$sample.os)

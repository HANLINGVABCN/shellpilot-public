$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true'){throw 'Run only in an isolated GitHub runner'}
$taskInstaller=(Get-ChildItem src-tauri/target/release/bundle/nsis -Filter *.exe | Select-Object -First 1).FullName
$taskInstall=Join-Path $env:RUNNER_TEMP 'ShellPilotUpgrade'
$taskData=Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'ShellPilot'
New-Item -ItemType Directory -Force $taskData|Out-Null
$taskSeed=@{
 'hosts.json'=@(@{id='a';name='演示主机 A';host='127.0.0.1';port=1;username='demo';authType='password';password='fixture-only'},@{id='b';name='演示主机 B';host='127.0.0.1';port=1;username='demo'})
 'settings.json'=@{providers=@(@{id='p';name='演示服务商';baseURL='https://model.example.com/v1';apiKey='fixture-key'});models=@(@{id='m';providerId='p';name='demo'});defaultModelId='m';aiBudgetVersion=3}
 'chats.json'=@{__global__=@(@{id='chat';title='保留对话';createdAt=1;updatedAt=1;messages=@(@{role='user';content='保留消息'})})}
 'memories.json'=@(@{id='mem';topic='测试记忆';content='保留内容';enabled=$true;source='manual';createdAt=1;updatedAt=1})
}
foreach($taskEntry in $taskSeed.GetEnumerator()){
 [IO.File]::WriteAllText((Join-Path $taskData $taskEntry.Key),(ConvertTo-Json -InputObject $taskEntry.Value -Depth 12),[Text.UTF8Encoding]::new($false))
}
$taskHashes=@{};foreach($taskName in $taskSeed.Keys){$taskHashes[$taskName]=(Get-FileHash -LiteralPath (Join-Path $taskData $taskName)).Hash}
$taskHandler=[Net.Http.HttpClientHandler]::new();$taskHandler.UseProxy=$false
$taskClient=[Net.Http.HttpClient]::new($taskHandler);$taskClient.Timeout=[TimeSpan]::FromSeconds(5)
function Request-Api($route,$method='GET',$body=$null){
 $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($method),('http://127.0.0.1:3737/api/'+$route))
 if($null -ne $body){$request.Content=[Net.Http.StringContent]::new(($body|ConvertTo-Json -Depth 12),[Text.Encoding]::UTF8,'application/json')}
 $response=$taskClient.Send($request);$text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
 [pscustomobject]@{Status=[int]$response.StatusCode;Data=(ConvertFrom-Json -InputObject $text -AsHashtable -NoEnumerate)}
}
function Stop-InstalledApp{
 Get-Process -Name shellpilot-app -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq (Join-Path $taskInstall 'shellpilot-app.exe')}|ForEach-Object{$null=$_.CloseMainWindow()}
 Start-Sleep -Milliseconds 800
 Get-Process -Name shellpilot-app -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq (Join-Path $taskInstall 'shellpilot-app.exe')}|Stop-Process
 Start-Sleep -Milliseconds 250
}
try{
 for($taskRound=1;$taskRound -le 2;$taskRound++){
  Stop-InstalledApp
  $process=Start-Process -FilePath $taskInstaller -ArgumentList @('/S','/R',('/D='+$taskInstall)) -WindowStyle Hidden -PassThru
  if(!$process.WaitForExit(60000)){throw 'Installer timed out'}
  if($process.ExitCode -ne 0){throw 'Installer failed'}
  $deadline=(Get-Date).AddSeconds(30)
  do{try{$hosts=Request-Api 'hosts';if($hosts.Status -eq 200 -and $hosts.Data.Count -eq 2){break}}catch{};Start-Sleep -Milliseconds 250}while((Get-Date) -lt $deadline)
  if(!$hosts -or $hosts.Status -ne 200 -or $hosts.Data.Count -ne 2){throw 'Installer-launched app did not load retained hosts'}
  $settings=(Request-Api 'settings').Data;$chats=(Request-Api 'chats/__global__').Data;$memories=(Request-Api 'memories').Data
  if($settings.providers.Count -ne 1 -or $settings.models.Count -ne 1 -or $chats.Count -ne 1 -or $memories.memories.Count -ne 1){throw 'Upgrade lost retained configuration'}
  foreach($name in $taskSeed.Keys){if((Get-FileHash -LiteralPath (Join-Path $taskData $name)).Hash -ne $taskHashes[$name]){throw ('Upgrade unexpectedly rewrote '+$name)}}
  Write-Output ('PASS: installer launch and reinstall {0} retained hosts, model, chats and memories' -f $taskRound)
 }
 # A real locked file must produce a data error, never an empty successful list.
 $settingsFile=Join-Path $taskData 'settings.json'
 $locked=[IO.File]::Open($settingsFile,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{
  $failed=Request-Api 'settings'
  if($failed.Status -ne 503 -or !$failed.Data.storageError){throw 'Unreadable settings must report a storage failure'}
  $blocked=Request-Api 'settings' 'PUT' @{providers=@();models=@()}
  if($blocked.Status -ne 503){throw 'Storage error must block writes'}
 }finally{$locked.Dispose()}
 if((Get-FileHash -LiteralPath $settingsFile).Hash -ne $taskHashes['settings.json']){throw 'Unreadable data was overwritten with defaults'}
 $retry=Request-Api 'storage/retry' 'POST' @{}
 if($retry.Status -ne 200 -or (Request-Api 'hosts').Data.Count -ne 2){throw 'Re-reading data did not restore retained hosts'}
 Write-Output 'PASS: file-access failure preserved data, blocked default writes and recovered in the same app'
}finally{
 Stop-InstalledApp
 $taskClient.Dispose()
}

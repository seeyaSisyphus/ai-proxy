# install-boot-task.ps1 -- 注册 ai-proxy-watchdog 开机计划任务（需管理员运行一次）
# 作用：开机（登录前）以 SYSTEM 启动 proxy-watchdog.vbs；任务自身带崩溃自动重试。
# 用法：powershell -ExecutionPolicy Bypass -File install-boot-task.ps1
$ErrorActionPreference = 'Stop'
$out = 'D:\ai-servers\ai-proxy\logs\boot-task-install.log'

function Note([string]$m) {
  $m | Out-File -FilePath $out -Encoding utf8 -Append
  Write-Host $m
}

"==== install run $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') by $env:USERNAME ====" | Out-File $out -Encoding utf8 -Append

try {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' `
    -Argument '//B "d:\ai-servers\ai-proxy\proxy-watchdog.vbs"' `
    -WorkingDirectory 'd:\ai-servers\ai-proxy'
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
  $settings.RestartCount = 255
  $settings.RestartInterval = New-TimeSpan -Minutes 1

  Register-ScheduledTask -TaskName 'ai-proxy-watchdog' `
    -Description 'ai-proxy 三代理常驻守卫：开机自启，探活失败自动重启代理进程' `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Note "OK: task registered (AtStartup, SYSTEM, restart=255x1min)"
} catch {
  Note "ERROR: register failed: $($_.Exception.Message)"
  exit 1
}

# 停掉当前用户级守护实例，交由任务实例接管（互斥锁保证不会双跑）
$mine = Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" |
  Where-Object { $_.CommandLine -like '*proxy-watchdog.vbs*' }
foreach ($p in $mine) {
  Note "stopping previous daemon pid=$($p.ProcessId)"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

try {
  Start-ScheduledTask -TaskName 'ai-proxy-watchdog'
  Start-Sleep -Seconds 8
  $inst = Get-ScheduledTask -TaskName 'ai-proxy-watchdog'
  Note "task state: $($inst.State)"
  (Get-ScheduledTaskInfo -TaskName 'ai-proxy-watchdog' | Out-String).Trim() | Out-File $out -Encoding utf8 -Append

  $run = Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" |
    Where-Object { $_.CommandLine -like '*proxy-watchdog.vbs*' }
  if ($run) {
    foreach ($p in $run) {
      $owner = (Invoke-CimMethod -InputObject $p -MethodName GetOwner).User
      Note "daemon running pid=$($p.ProcessId) owner=$owner"
    }
  } else {
    Note "WARN: no wscript daemon found after Start-ScheduledTask; falling back to user-level daemon"
    # 兜底：任务实例未起来时，立刻拉起用户级守护，避免出现无人守护窗口
    Start-Process wscript.exe -ArgumentList '//B "d:\ai-servers\ai-proxy\proxy-watchdog.vbs"' -WindowStyle Hidden
    Start-Sleep -Seconds 5
    $run2 = Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" |
      Where-Object { $_.CommandLine -like '*proxy-watchdog.vbs*' }
    if ($run2) { Note "fallback daemon pid=$($run2[0].ProcessId)" }
    else { Note "ERROR: fallback daemon also failed;服务当前无守护，请手动运行 Startup 里的 codex-proxy-watchdog.vbs" }
  }

  Note "watchdog.log tail:"
  Get-Content 'D:\ai-servers\ai-proxy\logs\watchdog.log' -Tail 5 |
    Out-File $out -Encoding utf8 -Append
  Note "DONE"
} catch {
  Note "ERROR: run/verify failed: $($_.Exception.Message)"
}

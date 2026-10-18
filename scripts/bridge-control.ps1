# QQ 桥接的启动 / 停止 / 重启 / 状态（给 qq-wake-bot 和人工用）。
#
# 为什么要有这个脚本：QQ 唤醒器要在「机器人没开」的时候把它叫起来，而桥接的启动
# 必须脱离调用者的控制台（否则调用方一退出，子进程跟着死）。做法沿用线上验证过的那套：
#   1) 先干净地杀 3100 的监听进程
#   2) 清掉「PID 已经不在了」的过期锁（state\bridge.lock 会挡住新实例）
#   3) 用 schtasks 立刻跑一次 run-qqbridge.cmd（脱离控制台）
#   4) 12 秒还没监听，退回 Start-Process 直起
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Action
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$lockFile = Join-Path $root 'state\bridge.lock'
$logFile = Join-Path $root 'logs\qqbridge.service.log'
# [维护暂停] 停桥接时告诉看门狗「别拉我」：不然 30 秒后它又把桥接拉回来，
# 「机器人关着」这个状态根本维持不住（QQ 唤醒器的 /start /stop 全靠它）。
$holdFile = 'C:\Users\ASUS\.dsh\ungrouped\qq-dsh-bridge\state\watchdog-hold.json'

function Set-Hold {
  param([int]$Minutes = 30)
  $dir = Split-Path -Parent $holdFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $body = '{' + '"services":["qqbridge"],"until":' + [int64]((Get-Date).AddMinutes($Minutes).ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds + ',"reason":"bridge-control stop"}'
  Set-Content -Path $holdFile -Value $body -Encoding UTF8
  Write-Output ('watchdog hold 已写（' + $Minutes + ' 分钟）')
}

function Clear-Hold {
  if (Test-Path $holdFile) { Remove-Item $holdFile -Force; Write-Output 'watchdog hold 已清' }
}

function Get-BridgePid {
  $c = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return 0
}

function Clear-StaleLock {
  if (-not (Test-Path $lockFile)) { return }
  $pidIn = (Get-Content $lockFile -Raw).Trim()
  $alive = $false
  if ($pidIn) { $alive = [bool](Get-Process -Id ([int]$pidIn) -ErrorAction SilentlyContinue) }
  if (-not $alive) { Remove-Item $lockFile -Force; Write-Output ('stale lock removed (pid=' + $pidIn + ')') }
}

function Stop-Bridge {
  $pidNow = Get-BridgePid
  if ($pidNow -gt 0) {
    Write-Output ('killing pid ' + $pidNow)
    Stop-Process -Id $pidNow -Force
    Start-Sleep -Seconds 4
  } else {
    Write-Output 'no listener'
  }
  Clear-StaleLock
}

function Start-Bridge {
  $taskName = 'qq-bridge-service'
  schtasks /Create /TN $taskName /TR ('cmd.exe /c ' + (Join-Path $root 'run-qqbridge.cmd')) /SC ONCE /ST 23:59 /F | Out-Null
  schtasks /Run /TN $taskName | Out-Null
  Start-Sleep -Seconds 12
  schtasks /Delete /TN $taskName /F | Out-Null
  if ((Get-BridgePid) -eq 0) {
    Write-Output 'schtasks 没拉起来，退回 Start-Process'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', (Join-Path $root 'run-qqbridge.cmd') -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 12
  }
  $pidNow = Get-BridgePid
  if ($pidNow -gt 0) {
    $p = Get-Process -Id $pidNow -ErrorAction SilentlyContinue
    Write-Output ('new pid=' + $pidNow + ' start=' + $p.StartTime)
  } else {
    Write-Output 'STILL NO LISTENER'
  }
}

switch ($Action) {
  'status' {
    $pidNow = Get-BridgePid
    if ($pidNow -gt 0) {
      $p = Get-Process -Id $pidNow -ErrorAction SilentlyContinue
      Write-Output ('running pid=' + $pidNow + ' start=' + $p.StartTime)
    } else {
      Write-Output 'stopped'
    }
  }
  'start' {
    Clear-Hold
    if ((Get-BridgePid) -gt 0) { Write-Output ('already running pid=' + (Get-BridgePid)); break }
    Clear-StaleLock
    Start-Bridge
  }
  'stop' { Stop-Bridge; Set-Hold }
  'restart' {
    Stop-Bridge
    Clear-Hold
    Start-Bridge
  }
}

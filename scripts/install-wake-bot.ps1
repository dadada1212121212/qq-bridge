# 安装「QQ 唤醒器」为登录自启的常驻进程，并立刻启动。
#
# 为什么用「启动文件夹 + VBS 隐藏窗口」而不是计划任务：
#   · 实测这台机器上 schtasks /SC ONLOGON 报 Access is denied（建登录任务要提权）；
#   · 启动文件夹不需要管理员，且同样是登录后运行；
#   · 用 .vbs 包一层是为了不弹黑框（直接放 .cmd 会留一个控制台窗口）。
# 会先试计划任务，失败再退到启动文件夹 —— 两种都失败才算安装失败。
param([switch]$Uninstall)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $root 'run-qq-wake.cmd'
$startup = [Environment]::GetFolderPath('Startup')
$vbsPath = Join-Path $startup 'qq-wake-bot.vbs'
$taskName = 'qq-wake-bot'

function Get-WakePid {
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*qq-wake-bot.js*' } | Select-Object -First 1
  if ($p) { return [int]$p.ProcessId }
  return 0
}

function Start-WakeNow {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $runner -WorkingDirectory $root -WindowStyle Hidden | Out-Null
}

if ($Uninstall) {
  schtasks /Delete /TN $taskName /F | Out-Null
  if (Test-Path $vbsPath) { Remove-Item $vbsPath -Force }
  $wakePid = Get-WakePid
  if ($wakePid -gt 0) { Stop-Process -Id $wakePid -Force }
  Write-Output 'uninstalled'
  exit 0
}

$installed = $false
schtasks /Create /TN $taskName /TR ('cmd.exe /c "' + $runner + '"') /SC ONLOGON /RL LIMITED /F 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  schtasks /Run /TN $taskName | Out-Null
  $installed = $true
  Write-Output 'installed via schtasks (ONLOGON)'
}

if (-not $installed) {
  # VBScript 里双引号写成两个："cmd /c ""路径""" —— 之前写成 4 个（""""），wscript 会解析失败。
  $vbs = 'CreateObject("WScript.Shell").Run "cmd /c ""' + $runner + '""", 0, False'
  Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII
  Write-Output ('schtasks 不可用，已写启动项: ' + $vbsPath)
  Start-WakeNow
}

Start-Sleep -Seconds 4
if ((Get-WakePid) -eq 0) { Start-WakeNow; Start-Sleep -Seconds 4 }
$wakePid = Get-WakePid
if ($wakePid -gt 0) { Write-Output ('wake-bot pid=' + $wakePid) } else { Write-Output 'wake-bot 没起来，看 logs\wake-bot.log' }

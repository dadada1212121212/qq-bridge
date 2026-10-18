@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 关闭 QQ 桥接（蓝色大肥鱼）
echo ============================================
echo  关闭 QQ 桥接机器人
echo ============================================
echo.

rem 【为什么以前「关不掉」】
rem   QQ-DSH-Keepalive 计划任务每 3 分钟跑一次 start-services.ps1，
rem   发现 3100 端口没在听，就用 WMI 把 run-qqbridge.cmd 重新拉起来
rem   （所以进程的父进程是 WmiPrvSE.exe，不是你的终端）。
rem   只杀 node 而不停这个任务，3 分钟内必然复活。
rem   本脚本第一步就把它禁用掉；要恢复自启：Enable-ScheduledTask -TaskName QQ-DSH-Keepalive

echo [0/4] 禁用自动拉起任务 QQ-DSH-Keepalive...
powershell -NoProfile -Command "try { Disable-ScheduledTask -TaskName 'QQ-DSH-Keepalive' -ErrorAction Stop | Out-Null; Write-Host '  OK 已禁用（恢复自启用 Enable-ScheduledTask -TaskName QQ-DSH-Keepalive）' } catch { Write-Host ('  !! 禁用失败：' + $_.Exception.Message) }"

echo [1/4] 结束守护窗口 (start.bat / run-qqbridge.cmd)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { ($_.CommandLine -like '*start.bat*' -or $_.CommandLine -like '*run-qqbridge.cmd*') -and $_.CommandLine -notlike '*restart.bat*' -and $_.CommandLine -notlike '*stop.bat*' } | ForEach-Object { Write-Host ('  kill cmd PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo [2/4] 结束桥接进程 (node src\bridge.js)...
powershell -NoProfile -Command "$lock = Join-Path '%~dp0' 'state\bridge.lock'; $pids = @(); if (Test-Path $lock) { $raw = (Get-Content $lock -Raw).Trim(); if ($raw -match '^\d+$') { $pids += [int]$raw } }; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' } | ForEach-Object { $pids += $_.ProcessId }; $pids | Sort-Object -Unique | ForEach-Object { Write-Host ('  kill node PID ' + $_); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

timeout /t 3 /nobreak >nul

echo [3/4] 复查...
powershell -NoProfile -Command "$left = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' }; if ($left) { Write-Host '  !! 仍有桥接存活：'; $left | ForEach-Object { Write-Host ('     PID ' + $_.ProcessId) }; exit 1 } else { Write-Host '  OK 桥接已全部退出' }"
if errorlevel 1 (
    echo.
    echo 关闭未完成：请以管理员身份重跑本脚本。
    pause
    exit /b 1
)

echo [4/4] 清理锁文件与控制台端口...
del state\bridge.lock 2>nul
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue; if ($c) { Write-Host ('  !! 端口 3100 仍被 PID ' + $c.OwningProcess + ' 占用') } else { Write-Host '  OK 端口 3100 已释放' }"

echo.
echo 机器人已关闭，且不会被自动拉起。
echo 需要重新开机自启时执行：Enable-ScheduledTask -TaskName QQ-DSH-Keepalive
pause

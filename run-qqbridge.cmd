@echo off
chcp 65001 >nul
cd /d "%~dp0"
set DSH_TELEMETRY_DISABLED=1
if not exist "logs" mkdir "logs"
rem 2026-10-19：补上 fish 号 10-18 就有的 5 秒重启循环（它崩过一次 0xC0000374 堆损坏，
rem 而原启动器只跑一遍 node 就退出 ⇒ 「保活任务没在跑」时她整个消失）。
rem 主号这边同样的坑：进程一死要等 3 分钟一次的保活任务，空窗最长 ~4.5 分钟。
rem 两条特殊语义不能破：
rem   1) 退出码 2 = 已有实例在跑（控制台端口被占），不死循环；
rem   2) 维护 hold 生效中（bridge-control.ps1 的 /stop 写的）——问 scripts\hold-state.mjs，
rem      退出码 1 就退出循环，否则「用 QQ 发 /stop 停掉、/start 叫起来」会失效。
:loop
echo [%date% %time%] START >> "logs\qqbridge.service.log"
node src\bridge.js >> "logs\qqbridge.service.log" 2>&1
set code=%ERRORLEVEL%
echo [%date% %time%] EXIT code=%code% >> "logs\qqbridge.service.log"
if "%code%"=="2" (
  echo [%date% %time%] bridge already running in another window; exiting. >> "logs\qqbridge.service.log"
  exit /b 2
)
node "scripts\hold-state.mjs" >nul 2>&1
if "%ERRORLEVEL%"=="1" (
  echo [%date% %time%] watchdog hold active, not restarting. >> "logs\qqbridge.service.log"
  exit /b 0
)
timeout /t 5 /nobreak >nul
goto loop

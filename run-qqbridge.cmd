@echo off
chcp 65001 >nul
cd /d "%~dp0"
set DSH_TELEMETRY_DISABLED=1
if not exist "logs" mkdir "logs"
echo [%date% %time%] START >> "logs\qqbridge.service.log"
node src\bridge.js >> "logs\qqbridge.service.log" 2>&1
echo [%date% %time%] EXIT code=%ERRORLEVEL% >> "logs\qqbridge.service.log"

@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
echo [%date% %time%] START wake-bot >> "logs\wake-bot.service.log"
node src\qq-wake-bot.js >> "logs\wake-bot.service.log" 2>&1
echo [%date% %time%] EXIT code=%ERRORLEVEL% >> "logs\wake-bot.service.log"

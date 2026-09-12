@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-local.ps1"
if errorlevel 1 (
  echo.
  echo 关闭时遇到问题，请查看上方提示。
  pause
  exit /b 1
)

echo 排版台已关闭。
timeout /t 2 >nul

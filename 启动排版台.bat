@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" -ForceRestart %*
if errorlevel 1 (
  echo.
  echo 启动失败，请查看上方提示。
  pause
  exit /b 1
)

echo.
echo 排版台已在浏览器中打开。
echo 不使用时请双击“关闭排版台.bat”。
timeout /t 4 >nul 2>nul
exit /b 0

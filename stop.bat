@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "APP_ROOT=%CD%"
set "PID_FILE=%APP_ROOT%\data\app.pid"
set "SERVER_ENTRY=%APP_ROOT%\dist-server\server\src\server.js"
set "SERVICE_TAG=--app-id=dafan-xiaoguan"
if not exist "%PID_FILE%" (
  echo 搭饭小馆当前没有 PID 文件，未停止任何进程。
  exit /b 0
)
set /p APP_METADATA=<"%PID_FILE%"
for /f "tokens=1,2 delims=|" %%A in ("%APP_METADATA%") do (set "APP_PID=%%A"& set "APP_STARTED=%%B")
echo(%APP_PID%| findstr /R "^[0-9][0-9]*$" >nul
if !errorlevel! neq 0 (
  echo [ERROR] PID 文件内容无效，未停止任何进程。
  exit /b 1
)
if not defined APP_STARTED (
  echo [ERROR] PID 文件内容无效，未停止任何进程。
  exit /b 1
)
powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=%APP_PID%' -ErrorAction SilentlyContinue; if(-not $p){exit 2}; if($p.CommandLine -notlike '*%SERVICE_TAG%*' -or $p.CommandLine -notlike '*%SERVER_ENTRY:\=\\%*' -or $p.CreationDate.ToUniversalTime().ToString('o') -ne '%APP_STARTED%'){exit 3}; Stop-Process -Id %APP_PID% -Force; exit 0"
set "STOP_CODE=!errorlevel!"
if "%STOP_CODE%"=="2" (
  echo PID %APP_PID% 已不存在，清理旧 PID 文件。
  del /q "%PID_FILE%"
  exit /b 0
)
if "%STOP_CODE%"=="3" (
  echo [ERROR] PID %APP_PID% 不是搭饭小馆服务，出于安全考虑未停止。
  exit /b 1
)
if not "%STOP_CODE%"=="0" (
  echo [ERROR] 停止服务失败，未删除 PID 文件。
  exit /b 1
)
del /q "%PID_FILE%"
echo 搭饭小馆已停止，仅终止了 PID %APP_PID%。
endlocal

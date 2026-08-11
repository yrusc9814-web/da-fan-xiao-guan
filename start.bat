@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "APP_ROOT=%CD%"
set "APP_PORT=8787"
set "PID_FILE=%APP_ROOT%\data\app.pid"
set "LOG_FILE=%APP_ROOT%\logs\app.log"
set "SERVER_ENTRY=%APP_ROOT%\dist-server\server\src\server.js"
set "SERVICE_TAG=--app-id=dafan-xiaoguan"

if exist "%APP_ROOT%\runtime\node.exe" (set "NODE_EXE=%APP_ROOT%\runtime\node.exe") else (for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I")
if not defined NODE_EXE (
  echo [ERROR] Node.js runtime not found. Put node.exe in runtime\ or install Node.js 22+.
  pause
  exit /b 1
)
if not exist "%APP_ROOT%\data" mkdir "%APP_ROOT%\data"
if not exist "%APP_ROOT%\data\uploads" mkdir "%APP_ROOT%\data\uploads"
if not exist "%APP_ROOT%\data\backups" mkdir "%APP_ROOT%\data\backups"
if not exist "%APP_ROOT%\logs" mkdir "%APP_ROOT%\logs"

if exist "%PID_FILE%" (
  set /p OLD_METADATA=<"%PID_FILE%"
  for /f "tokens=1,2 delims=|" %%A in ("!OLD_METADATA!") do (set "OLD_PID=%%A"& set "OLD_STARTED=%%B")
  powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=!OLD_PID!' -ErrorAction SilentlyContinue; if($p -and $p.CommandLine -like '*%SERVICE_TAG%*' -and $p.CommandLine -like '*%SERVER_ENTRY:\=\\%*' -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '!OLD_STARTED!'){exit 0}else{exit 1}"
  if !errorlevel! equ 0 (
    echo 搭饭小馆已经在运行，PID !OLD_PID!。
    start "" "http://127.0.0.1:%APP_PORT%"
    exit /b 0
  )
  del /q "%PID_FILE%"
)

netstat -ano | findstr /R /C:":%APP_PORT% .*LISTENING" >nul
if !errorlevel! equ 0 (
  echo [ERROR] 端口 %APP_PORT% 已被其他程序占用，请先释放端口。
  pause
  exit /b 1
)

if not exist "%APP_ROOT%\dist-server\server\src\server.js" (
  echo [ERROR] 缺少生产构建，请先执行 npm run build。
  pause
  exit /b 1
)
call npm run prisma:migrate:deploy
if !errorlevel! neq 0 (
  echo [ERROR] 数据库迁移失败，服务未启动。
  pause
  exit /b 1
)

for /f "tokens=1,2 delims=|" %%P in ('powershell -NoProfile -Command "$p=Start-Process -FilePath '%NODE_EXE%' -ArgumentList ('^"%SERVER_ENTRY%^" %SERVICE_TAG%') -WorkingDirectory '%APP_ROOT%' -RedirectStandardOutput '%LOG_FILE%' -RedirectStandardError '%APP_ROOT%\logs\app-error.log' -PassThru; $c=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.Id); Write-Output ($p.Id.ToString() + '^|' + $c.CreationDate.ToUniversalTime().ToString('o'))"') do (set "APP_PID=%%P"& set "APP_STARTED=%%Q")
if not defined APP_PID (
  echo [ERROR] 服务进程启动失败，请查看 logs\app-error.log。
  pause
  exit /b 1
)
if not defined APP_STARTED (
  echo [ERROR] 服务进程启动失败，请查看 logs\app-error.log。
  pause
  exit /b 1
)
>"%PID_FILE%" echo %APP_PID%^|%APP_STARTED%
timeout /t 2 /nobreak >nul
curl.exe -fsS "http://127.0.0.1:%APP_PORT%/api/v1/health" >nul 2>nul
if !errorlevel! neq 0 (
  echo [ERROR] 服务健康检查失败，请查看日志。
  call "%APP_ROOT%\stop.bat"
  pause
  exit /b 1
)
for /f %%I in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object {$_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown'} ^| Select-Object -First 1 -ExpandProperty IPAddress)"') do set "LAN_IP=%%I"
echo 搭饭小馆已启动，PID %APP_PID%
echo 电脑访问：http://127.0.0.1:%APP_PORT%
if defined LAN_IP echo 手机访问：http://%LAN_IP%:%APP_PORT%
echo 手机需要与电脑连接同一 Wi-Fi，并允许 Windows 防火墙访问端口 %APP_PORT%。
start "" "http://127.0.0.1:%APP_PORT%"
endlocal

@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "APP_ROOT=%CD%"
set "PORT=8787"
set "APP_PORT=%PORT%"
set "NODE_ENV=production"
set "HOST=0.0.0.0"
set "DATABASE_URL=file:../../../data/app.db"
set "PID_FILE=%APP_ROOT%\data\app.pid"
set "LOG_FILE=%APP_ROOT%\logs\app.log"
set "ERROR_LOG=%APP_ROOT%\logs\app-error.log"
set "SERVER_ENTRY=%APP_ROOT%\dist-server\server\src\server.js"
set "SERVICE_TAG=--app-id=dafan-xiaoguan"

if not exist "%APP_ROOT%\runtime\node.exe" (
  echo [ERROR] 正式发行包不完整：缺少 runtime\node.exe。
  echo [ERROR] 为避免使用系统 Node.js 冒充正式包，启动已停止。
  pause
  exit /b 1
)
set "NODE_EXE=%APP_ROOT%\runtime\node.exe"
if not exist "%APP_ROOT%\data" mkdir "%APP_ROOT%\data"
if not exist "%APP_ROOT%\data\uploads" mkdir "%APP_ROOT%\data\uploads"
if not exist "%APP_ROOT%\data\backups" mkdir "%APP_ROOT%\data\backups"
if not exist "%APP_ROOT%\logs" mkdir "%APP_ROOT%\logs"

if exist "%PID_FILE%" (
  set /p OLD_METADATA=<"%PID_FILE%"
  for /f "tokens=1,2 delims=|" %%A in ("!OLD_METADATA!") do (set "OLD_PID=%%A"& set "OLD_STARTED=%%B")
  powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:OLD_PID) -ErrorAction SilentlyContinue; if($p -and $p.CommandLine -like ('*' + $env:SERVICE_TAG + '*') -and $p.CommandLine -like ('*' + $env:SERVER_ENTRY + '*') -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $env:OLD_STARTED){exit 0}else{exit 1}"
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
set "PRISMA_CLI_REL="
for /f "usebackq delims=" %%I in (`call "%NODE_EXE%" -e "const fs=require('node:fs');const m=JSON.parse(fs.readFileSync('release-manifest.json','utf8'));process.stdout.write(m.prisma.cli.path)"`) do set "PRISMA_CLI_REL=%%I"
if not defined PRISMA_CLI_REL (
  echo [ERROR] release-manifest.json 未声明 Prisma CLI，正式包不完整。
  pause
  exit /b 1
)
set "PRISMA_CLI=%APP_ROOT%\%PRISMA_CLI_REL:/=\%"
if not exist "%PRISMA_CLI%" (
  echo [ERROR] release-manifest.json 指向的 Prisma CLI 不存在，正式包不完整。
  pause
  exit /b 1
)
"%NODE_EXE%" "%APP_ROOT%\scripts\ensure-sqlite-file.mjs"
if !errorlevel! neq 0 (
  echo [ERROR] 数据库文件准备失败，服务未启动。
  pause
  exit /b 1
)
"%NODE_EXE%" "%PRISMA_CLI%" migrate deploy --schema "%APP_ROOT%\app\server\prisma\schema.prisma"
if !errorlevel! neq 0 (
  echo [ERROR] 数据库迁移失败，服务未启动。
  pause
  exit /b 1
)

"%NODE_EXE%" "%APP_ROOT%\scripts\launch-server.mjs"
if !errorlevel! neq 0 (
  echo [ERROR] 服务进程启动失败，请查看 logs\app-error.log。
  pause
  exit /b 1
)
if not exist "%PID_FILE%" (
  echo [ERROR] 服务进程启动失败，未生成 PID 文件。
  pause
  exit /b 1
)
set /p APP_METADATA=<"%PID_FILE%"
for /f "tokens=1,2 delims=|" %%A in ("%APP_METADATA%") do (set "APP_PID=%%A"& set "APP_STARTED=%%B")
if not defined APP_PID (
  echo [ERROR] 服务进程启动失败，PID 文件内容无效。
  pause
  exit /b 1
)
if not defined APP_STARTED (
  echo [ERROR] 服务进程启动失败，PID 文件内容无效。
  pause
  exit /b 1
)
"%NODE_EXE%" -e "const d=Date.now()+30000;(async()=>{while(Date.now()<d){try{const r=await fetch('http://127.0.0.1:'+process.env.APP_PORT+'/api/v1/health');if(r.status===200)process.exit(0)}catch(e){};await new Promise(s=>setTimeout(s,1000))}process.exit(1)})()"
if !errorlevel! neq 0 (
  echo [ERROR] 服务健康检查失败，请查看日志。
  call "%APP_ROOT%\stop.bat"
  pause
  exit /b 1
)
"%NODE_EXE%" -e "const d=Date.now()+15000;(async()=>{while(Date.now()<d){try{const r=await fetch('http://127.0.0.1:'+process.env.APP_PORT+'/');if(r.status===200){const c=r.headers.get('content-type')||'';const t=await r.text();if(c.includes('text/html')&&(t.includes('<!doctype html')||t.includes('<html')))process.exit(0)}}catch(e){};await new Promise(s=>setTimeout(s,1000))}process.exit(1)})()"
if !errorlevel! neq 0 (
  echo [ERROR] 前端页面检查失败，生产静态资源未正确挂载。
  call "%APP_ROOT%\stop.bat"
  pause
  exit /b 1
)
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown'} | Select-Object -First 1 -ExpandProperty IPAddress)"`) do set "LAN_IP=%%I"
echo 搭饭小馆已启动，PID %APP_PID%
echo 电脑访问：http://127.0.0.1:%APP_PORT%
if defined LAN_IP echo 手机访问：http://%LAN_IP%:%APP_PORT%
echo 手机需要与电脑连接同一 Wi-Fi，并允许 Windows 防火墙访问端口 %APP_PORT%。
start "" "http://127.0.0.1:%APP_PORT%"
endlocal

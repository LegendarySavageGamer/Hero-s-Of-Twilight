@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo ============================================================
echo  Global Twilight - Cloudflare Deploy
echo ============================================================
echo.
where npm >nul 2>nul || (
  echo ERROR: npm was not found. Install Node.js LTS first.
  pause
  exit /b 1
)
call npm install
if errorlevel 1 goto :fail
call npx wrangler whoami
if errorlevel 1 (
  echo.
  echo Wrangler is not logged in. Opening Cloudflare login...
  call npx wrangler login
  if errorlevel 1 goto :fail
)
call npx wrangler deploy
if errorlevel 1 goto :fail
echo.
echo SUCCESS.
echo Expected public Worker:
echo   https://crests-rooms.twilight-heroes.workers.dev
echo Global endpoint baked into the mod:
echo   wss://crests-rooms.twilight-heroes.workers.dev/global
echo.
pause
exit /b 0
:fail
echo.
echo DEPLOY FAILED. Send the bottom of this window to ChatGPT.
pause
exit /b 1

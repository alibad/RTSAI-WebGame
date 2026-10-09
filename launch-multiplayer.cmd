@echo off
setlocal
cd /d "%~dp0"
set RTSAI_WEBGAME_PORT=3491
set RTSAI_WEB_COMPANION_GRPC=9989
echo RTS AI local multiplayer
pwsh -NoProfile -Command "try { $status = Invoke-RestMethod 'http://127.0.0.1:3491/api/health' -TimeoutSec 2; if ($status.ok) { exit 0 } } catch {}; exit 1" >nul 2>nul
if not errorlevel 1 (
  echo The local server is already running.
  echo Open http://127.0.0.1:3491/?profile=public^&runtime=interp^&private=0
  exit /b 0
)
echo Keep this window open while playing.
echo Open http://127.0.0.1:3491/?profile=public^&runtime=interp^&private=0
node server/serve.mjs
if errorlevel 1 (
  echo Could not start the local server. Check the error above.
  pause
)

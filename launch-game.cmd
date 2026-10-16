@echo off
setlocal
cd /d "%~dp0"
node tools/local-game.mjs launch %*
if errorlevel 1 (
  echo The verified web game could not be opened. See the message above.
  pause
  exit /b 1
)

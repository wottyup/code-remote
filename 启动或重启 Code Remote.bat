@echo off
setlocal
cd /d "%~dp0"
title Code Remote - Start or Restart

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-windows-restart.ps1"
if errorlevel 1 (
  echo.
  echo Unable to prepare Code Remote. See the message above.
  pause
  exit /b 1
)

set "PNPM_CMD="
for /f "delims=" %%P in ('where pnpm.cmd 2^>nul') do if not defined PNPM_CMD set "PNPM_CMD=%%P"
if not defined PNPM_CMD if exist "%APPDATA%\npm\pnpm.cmd" set "PNPM_CMD=%APPDATA%\npm\pnpm.cmd"
if not defined PNPM_CMD (
  echo [ERROR] pnpm.cmd was not found.
  pause
  exit /b 1
)

if exist "%APPDATA%\npm\codex.cmd" set "CODEX_REMOTE_COMMAND=%APPDATA%\npm\codex.cmd"
echo Starting Code Remote. Keep this window open.
echo Web: http://localhost:4173
call "%PNPM_CMD%" start
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%

@echo off
setlocal

cd /d "%~dp0"
title Codex Remote - 4173

set "PNPM_CMD="
for /f "delims=" %%P in ('where pnpm.cmd 2^>nul') do if not defined PNPM_CMD set "PNPM_CMD=%%P"
if not defined PNPM_CMD if exist "%APPDATA%\npm\pnpm.cmd" set "PNPM_CMD=%APPDATA%\npm\pnpm.cmd"

if not defined PNPM_CMD (
  echo [ERROR] pnpm.cmd was not found.
  echo Install pnpm or add it to PATH, then run this file again.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo [ERROR] package.json was not found in:
  echo %CD%
  pause
  exit /b 1
)

echo Starting Codex Remote...
echo Web: http://localhost:4173
echo Close this window to stop the service.
echo.

if not defined CODEX_REMOTE_COMMAND for /d %%E in ("%USERPROFILE%\.vscode\extensions\openai.chatgpt-*") do if exist "%%~fE\bin\windows-x86_64\codex.exe" if not defined CODEX_REMOTE_COMMAND set "CODEX_REMOTE_COMMAND=%%~fE\bin\windows-x86_64\codex.exe"
if not defined CODEX_REMOTE_COMMAND for /d %%E in ("%LOCALAPPDATA%\OpenAI\Codex\bin\*") do if exist "%%~fE\codex.exe" if not defined CODEX_REMOTE_COMMAND set "CODEX_REMOTE_COMMAND=%%~fE\codex.exe"

call "%PNPM_CMD%" dev
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Codex Remote exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%

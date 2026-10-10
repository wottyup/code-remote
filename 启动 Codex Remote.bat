@echo off
setlocal

cd /d "%~dp0"
title Codex Remote - 6546

where pnpm.cmd >nul 2>&1
if errorlevel 1 (
  echo [错误] 找不到 pnpm，请先安装 pnpm 或将它加入 PATH。
  pause
  exit /b 1
)

if not exist "package.json" (
  echo [错误] 未找到项目 package.json，启动目录不正确：%CD%
  pause
  exit /b 1
)

echo 正在启动 Codex Remote...
echo 网页地址：http://localhost:6546
echo 关闭此窗口即可停止服务。
echo.

call pnpm.cmd dev
set "exit_code=%ERRORLEVEL%"

if not "%exit_code%"=="0" (
  echo.
  echo Codex Remote 已退出，错误码：%exit_code%
  pause
)

exit /b %exit_code%

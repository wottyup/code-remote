param()

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot '.codex-remote\logs'
$logPath = Join-Path $logDirectory 'windows-service.log'
$previousLogPath = Join-Path $logDirectory 'windows-service.previous.log'

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
    Move-Item -LiteralPath $logPath -Destination $previousLogPath -Force
}

$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($null -eq $pnpmCommand) {
    $fallback = Join-Path $env:APPDATA 'npm\pnpm.cmd'
    if (Test-Path -LiteralPath $fallback) {
        $pnpmPath = $fallback
    } else {
        Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format o)] pnpm.cmd was not found."
        exit 1
    }
} else {
    $pnpmPath = $pnpmCommand.Source
}

Set-Location -LiteralPath $projectRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::AppendAllText($logPath, "`r`n[$(Get-Date -Format o)] Starting Codex Remote background service.`r`n", $utf8)
$commandLine = "`"$pnpmPath`" start >> `"$logPath`" 2>&1"
& $env:COMSPEC /d /s /c $commandLine
$serviceExitCode = $LASTEXITCODE
[IO.File]::AppendAllText($logPath, "[$(Get-Date -Format o)] Codex Remote exited with code $serviceExitCode.`r`n", $utf8)
exit $serviceExitCode

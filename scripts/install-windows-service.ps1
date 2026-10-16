param(
    [switch]$Start
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This installer only supports Windows.'
}

$taskName = 'Wotty Codex Remote'
$runnerPath = Join-Path $PSScriptRoot 'run-windows-service.ps1'
$projectRoot = Split-Path -Parent $PSScriptRoot
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershellPath = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $powershellPath)) {
    $powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
}

$actionArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runnerPath`""
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $actionArguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Keeps Wotty Codex Remote running independently of Codex Desktop.' `
    -Force | Out-Null

if ($Start) {
    Start-ScheduledTask -TaskName $taskName
}

Write-Output "Registered scheduled task: $taskName"
Write-Output "Log: $(Join-Path $projectRoot '.codex-remote\logs\windows-service.log')"

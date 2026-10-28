$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$backendExe = Join-Path $projectRoot '.venv\Scripts\python.exe'
$viteEntrypoint = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
$runnerPath = Join-Path $PSScriptRoot 'run-windows-service.ps1'

# Only stop the scheduled task when it points to this project's runner.
$task = Get-ScheduledTask -TaskName 'Wotty Codex Remote' -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running' -and
    @($task.Actions | Where-Object { $_.Arguments -and $_.Arguments.Contains($runnerPath) }).Count -gt 0) {
    Stop-ScheduledTask -TaskName 'Wotty Codex Remote'
}

$processes = @(Get-CimInstance Win32_Process)
$backend = @($processes | Where-Object {
    $_.Name -eq 'python.exe' -and $_.ExecutablePath -and
    $_.ExecutablePath.Equals($backendExe, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -match '(^|\s)codex_remote\.main(\s|$)'
})
$vites = @($processes | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($viteEntrypoint, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine -match '(\s|")preview(\s|"|$)'
})

# The owning launcher is identified through this project's backend or Vite child.
$launchers = @($backend + $vites | ForEach-Object {
    $parentId = $_.ParentProcessId
    $processes | Where-Object { $_.ProcessId -eq $parentId -and $_.Name -eq 'node.exe' -and
        $_.CommandLine -match 'scripts[\\/]dev\.mjs' }
} | Sort-Object ProcessId -Unique)
foreach ($launcher in $launchers) {
    Write-Host "Stopping Code Remote launcher $($launcher.ProcessId)..."
    & taskkill.exe /PID $launcher.ProcessId /T /F
    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $launcher.ProcessId -ErrorAction SilentlyContinue)) {
        throw "Failed to stop Code Remote launcher $($launcher.ProcessId)."
    }
}

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $occupied = @(Get-NetTCPConnection -State Listen -LocalPort 18766,4173 -ErrorAction SilentlyContinue)
    if ($occupied.Count -eq 0) { exit 0 }
    Start-Sleep -Milliseconds 250
}
$occupied | Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table | Out-Host
throw 'Port 18766 or 4173 is still in use. Stop the listed service before starting Code Remote.'

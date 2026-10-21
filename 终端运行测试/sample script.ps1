Write-Output 'script_type=powershell'
Write-Output "script_path=$PSCommandPath"
Write-Output "working_directory=$(Get-Location)"
Write-Output 'status=ok'

export function terminalChangeDirectoryCommand(shellName: string, path: string) {
  const shell = shellName.trim().toLowerCase().split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '') ?? ''
  if (shell === 'pwsh' || shell === 'powershell') {
    return `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'`
  }
  if (shell === 'cmd') {
    return `cd /d "${path.replace(/"/g, '""')}"`
  }
  return `cd -- '${path.replace(/'/g, "'\\''")}'`
}

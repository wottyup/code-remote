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

const runnableScriptExtension = /\.(py|js|mjs|cjs|sh|ps1|bat|cmd)$/i

export function isRunnableScriptPath(path: string) {
  return runnableScriptExtension.test(path) && !/[\x00-\x1f\x7f]/.test(path)
}

export function terminalRunScriptCommand(shellName: string, path: string): string | null {
  if (!isRunnableScriptPath(path)) return null
  const extension = runnableScriptExtension.exec(path)?.[1].toLowerCase()
  const shell = shellName.trim().toLowerCase().split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '') ?? ''
  const powershell = shell === 'pwsh' || shell === 'powershell'
  const cmd = shell === 'cmd'
  if (cmd && /[%!"^]/.test(path)) return null

  const quotedPath = powershell
    ? `'${path.replace(/'/g, "''")}'`
    : cmd
      ? `"${path}"`
      : `'${path.replace(/'/g, "'\\''")}'`

  if (extension === 'py') return `${cmd || powershell ? 'python' : 'python3'} ${quotedPath}`
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs') return `node ${quotedPath}`
  if (extension === 'sh') return `bash ${quotedPath}`
  if (extension === 'ps1') return powershell ? `& ${quotedPath}` : `${cmd ? 'powershell' : 'pwsh'} -NoProfile -File ${quotedPath}`
  if (extension === 'bat' || extension === 'cmd') {
    if (cmd) return `call ${quotedPath}`
    if (powershell) return `& ${quotedPath}`
  }
  return null
}

const storageKey = 'code-remote:terminal-screens-v1'
const openPanelsStorageKey = 'code-remote:open-terminals-v1'
const maxAgeMs = 30 * 60 * 1_000
const maxEntries = 3
const maxTextLength = 500_000

interface ScreenSnapshot {
  threadId: string
  text: string
  updatedAt: number
}

function readSnapshots(): ScreenSnapshot[] {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(storageKey) ?? '[]')
    if (!Array.isArray(value)) return []
    const now = Date.now()
    return value.filter((entry): entry is ScreenSnapshot =>
      typeof entry?.threadId === 'string'
      && typeof entry?.text === 'string'
      && typeof entry?.updatedAt === 'number'
      && now - entry.updatedAt < maxAgeMs
      && entry.updatedAt <= now,
    ).slice(-maxEntries)
  } catch {
    return []
  }
}

function writeSnapshots(snapshots: ScreenSnapshot[]) {
  const entries = snapshots.slice(-maxEntries)
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(entries))
  } catch {
    // A full or unavailable sessionStorage must not interrupt the terminal.
  }
}

export function readTerminalScreen(threadId: string): string | null {
  return readSnapshots().find((entry) => entry.threadId === threadId)?.text ?? null
}

export function rememberTerminalScreen(threadId: string, text: string) {
  const entries = readSnapshots().filter((entry) => entry.threadId !== threadId)
  if (text) entries.push({ threadId, text: text.slice(-maxTextLength), updatedAt: Date.now() })
  writeSnapshots(entries)
}

export function forgetTerminalScreen(threadId: string) {
  writeSnapshots(readSnapshots().filter((entry) => entry.threadId !== threadId))
}

function readOpenPanels(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(openPanelsStorageKey) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string' && entry[1].length > 0 && entry[1].length <= 512,
    ))
  } catch {
    return {}
  }
}

function writeOpenPanels(panels: Record<string, string>) {
  try {
    window.sessionStorage.setItem(openPanelsStorageKey, JSON.stringify(panels))
  } catch {
    // Browsers may deny storage; the current terminal session still works.
  }
}

export function readOpenTerminalThread(paneIndex: number): string | null {
  return readOpenPanels()[String(paneIndex)] ?? null
}

export function rememberOpenTerminalThread(paneIndex: number, threadId: string) {
  writeOpenPanels({ ...readOpenPanels(), [String(paneIndex)]: threadId })
}

export function forgetOpenTerminalThread(paneIndex: number) {
  const panels = readOpenPanels()
  delete panels[String(paneIndex)]
  writeOpenPanels(panels)
}

const paneLayoutStorageKey = 'codex-remote.pane-layout'
const layoutStorageNames = ['sessionStorage', 'localStorage'] as const
export const maxConcurrentPaneCount = 5

export interface PersistedPaneLayout {
  openPaneIndexes: number[]
  selectedPaneIndex: number
  threadIdsByPane: Record<string, string>
  enginesByPane: Record<string, 'codex' | 'claude-code'>
}

function parsePaneLayout(value: string | null): PersistedPaneLayout | null {
  if (!value) return null
  const parsed = JSON.parse(value) as Record<string, unknown>
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  // Pane IDs are stable slots. A narrower viewport must not discard panes
  // opened on desktop, including layouts whose first pane is no longer 0.
  const openPaneIndexes = Array.isArray(parsed.openPaneIndexes)
    ? [...new Set(parsed.openPaneIndexes.filter((index): index is number => typeof index === 'number'
      && Number.isInteger(index) && index >= 0 && index < maxConcurrentPaneCount))]
    : []
  if (openPaneIndexes.length === 0) return null
  const requestedSelection = parsed.selectedPaneIndex
  const selectedPaneIndex = typeof requestedSelection === 'number' && openPaneIndexes.includes(requestedSelection)
    ? requestedSelection : openPaneIndexes[0]
  const savedThreads = parsed.threadIdsByPane && typeof parsed.threadIdsByPane === 'object' && !Array.isArray(parsed.threadIdsByPane)
    ? parsed.threadIdsByPane as Record<string, unknown> : {}
  const threadIdsByPane = Object.fromEntries(openPaneIndexes.flatMap((index) => {
    const threadId = savedThreads[String(index)]
    return typeof threadId === 'string' && threadId.trim().length > 0 && threadId.length <= 512
      ? [[String(index), threadId.trim()]] : []
  }))
  const savedEngines = parsed.enginesByPane && typeof parsed.enginesByPane === 'object' && !Array.isArray(parsed.enginesByPane)
    ? parsed.enginesByPane as Record<string, unknown> : {}
  const enginesByPane: PersistedPaneLayout['enginesByPane'] = {}
  for (const index of openPaneIndexes) {
    const engine = savedEngines[String(index)]
    if (engine === 'codex' || engine === 'claude-code') enginesByPane[String(index)] = engine
  }
  return { openPaneIndexes, selectedPaneIndex, threadIdsByPane, enginesByPane }
}

export function readPersistedPaneLayout(): PersistedPaneLayout | null {
  if (typeof window === 'undefined') return null
  for (const storageName of layoutStorageNames) {
    try {
      const layout = parsePaneLayout(window[storageName].getItem(paneLayoutStorageKey))
      if (layout) return layout
    } catch {
      // An unavailable store or invalid record must not hide the fallback.
    }
  }
  return null
}

export function savePersistedPaneLayout(layout: PersistedPaneLayout) {
  if (typeof window === 'undefined') return
  const value = JSON.stringify(layout)
  for (const storageName of layoutStorageNames) {
    try {
      // The tab snapshot survives reload without another tab overwriting it.
      // Keep the shared copy for reopening the site and for older builds.
      window[storageName].setItem(paneLayoutStorageKey, value)
    } catch {
      // A full localStorage must not prevent the session snapshot being saved.
    }
  }
}

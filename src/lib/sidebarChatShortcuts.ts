export interface SidebarChatShortcut {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export interface SidebarChatShortcuts {
  previous: SidebarChatShortcut
  next: SidebarChatShortcut
}

export type SidebarChatShortcutAction = keyof SidebarChatShortcuts

const storageKey = 'codex-remote.sidebar-chat-shortcuts'
const modifierKeys = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'OS', 'Shift'])

export const defaultSidebarChatShortcuts: SidebarChatShortcuts = {
  previous: { key: 'ArrowUp', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false },
  next: { key: 'ArrowDown', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false },
}

function normalizeKey(key: string) {
  return key.length === 1 ? key.toLowerCase() : key
}

function normalizeShortcut(value: unknown): SidebarChatShortcut | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<SidebarChatShortcut>
  if (typeof candidate.key !== 'string' || !candidate.key || modifierKeys.has(candidate.key)) return null
  if (candidate.key === 'Dead' || candidate.key === 'Unidentified') return null

  const shortcut = {
    key: normalizeKey(candidate.key),
    altKey: candidate.altKey === true,
    ctrlKey: candidate.ctrlKey === true,
    metaKey: candidate.metaKey === true,
    shiftKey: candidate.shiftKey === true,
  }
  return shortcut.altKey || shortcut.ctrlKey || shortcut.metaKey || shortcut.shiftKey ? shortcut : null
}

export function isSidebarChatShortcutModifierKey(key: string) {
  return modifierKeys.has(key)
}

export function sidebarChatShortcutFromEvent(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>) {
  return normalizeShortcut(event)
}

export function matchesSidebarChatShortcut(event: KeyboardEvent, shortcut: SidebarChatShortcut) {
  return normalizeKey(event.key) === shortcut.key
    && event.altKey === shortcut.altKey
    && event.ctrlKey === shortcut.ctrlKey
    && event.metaKey === shortcut.metaKey
    && event.shiftKey === shortcut.shiftKey
}

export function sameSidebarChatShortcut(left: SidebarChatShortcut, right: SidebarChatShortcut) {
  return left.key === right.key
    && left.altKey === right.altKey
    && left.ctrlKey === right.ctrlKey
    && left.metaKey === right.metaKey
    && left.shiftKey === right.shiftKey
}

export function isReservedSidebarChatShortcut(event: KeyboardEvent) {
  const key = normalizeKey(event.key).toLowerCase()
  const controlOrMeta = event.ctrlKey || event.metaKey
  if (event.key === 'Tab' || event.key === 'Escape' || ['F5', 'F11', 'F12'].includes(event.key)) return true
  if (controlOrMeta && (['w', 't', 'n', 'r', 'l', 'p', 'f', 'q', 's', 'o', 'u', 'd'].includes(key) || /^[0-9]$/.test(key))) return true
  if (controlOrMeta && event.shiftKey && ['i', 'j', 'c', 'delete'].includes(key)) return true
  if (event.altKey && ['ArrowLeft', 'ArrowRight', 'Home', 'F4'].includes(event.key)) return true
  return false
}

export function formatSidebarChatShortcut(shortcut: SidebarChatShortcut) {
  const modifiers = [
    shortcut.ctrlKey ? 'Ctrl' : '',
    shortcut.altKey ? 'Alt' : '',
    shortcut.shiftKey ? 'Shift' : '',
    shortcut.metaKey ? '⌘' : '',
  ].filter(Boolean)
  const keyLabels: Record<string, string> = {
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Enter: 'Enter',
    Escape: 'Esc',
    PageDown: 'PageDown',
    PageUp: 'PageUp',
    ' ': 'Space',
    'Tab': 'Tab',
  }
  const label = keyLabels[shortcut.key] ?? (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key)
  return [...modifiers, label].join('+')
}

export function readSidebarChatShortcuts(): SidebarChatShortcuts {
  if (typeof window === 'undefined') return defaultSidebarChatShortcuts
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) return defaultSidebarChatShortcuts
    const parsed = JSON.parse(stored) as Record<string, unknown>
    const previous = normalizeShortcut(parsed.previous)
    const next = normalizeShortcut(parsed.next)
    if (!previous || !next || sameSidebarChatShortcut(previous, next)) return defaultSidebarChatShortcuts
    return { previous, next }
  } catch {
    return defaultSidebarChatShortcuts
  }
}

export function saveSidebarChatShortcuts(shortcuts: SidebarChatShortcuts) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(shortcuts))
  } catch {
    // Shortcuts still apply for the current session when storage is unavailable.
  }
}

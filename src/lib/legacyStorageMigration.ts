type StorageKind = 'local' | 'session'

const storageKeyMigrations: Array<[StorageKind, string, string, boolean?]> = [
  ['local', 'codex-remote-token', 'devwisp-token'],
  ['local', 'codex-remote:chat-overlay-height', 'devwisp:chat-overlay-height'],
  ['local', 'codex-remote.workspace-explorer-width', 'devwisp.workspace-explorer-width'],
  ['local', 'code-remote.workspace-explorer-collapsed', 'devwisp.workspace-explorer-collapsed'],
  ['local', 'codex-remote.retro-side-panel-width', 'devwisp.retro-side-panel-width'],
  ['local', 'codex-remote.workspace-explorer-root', 'devwisp.workspace-explorer-root'],
  ['local', 'codex-remote.composer-preferences', 'devwisp.composer-preferences'],
  ['local', 'codex-remote.thread-composer-preferences', 'devwisp.thread-composer-preferences'],
  ['local', 'codex-remote.composer-draft', 'devwisp.composer-draft'],
  ['local', 'codex-remote.composer-draft.', 'devwisp.composer-draft.', true],
  ['local', 'codex-remote.composer-table-draft.', 'devwisp.composer-table-draft.', true],
  ['local', 'codex-remote.composer-focus-restore', 'devwisp.composer-focus-restore'],
  ['local', 'codex-remote.pinned-thread-ids', 'devwisp.pinned-thread-ids'],
  ['local', 'codex-remote.active-thread-id', 'devwisp.active-thread-id'],
  ['local', 'codex-remote.active-thread-cache', 'devwisp.active-thread-cache'],
  ['local', 'codex-remote.queued-messages', 'devwisp.queued-messages'],
  ['local', 'codex-remote.queued-message-recovery', 'devwisp.queued-message-recovery'],
  ['local', 'codex-remote.cpa-usage-settings', 'devwisp.cpa-usage-settings'],
  ['local', 'codex-remote.pane-layout', 'devwisp.pane-layout'],
  ['local', 'code-remote.settings-active-section.v1', 'devwisp.settings-active-section.v1'],
  ['local', 'codex-remote.sidebar-chat-shortcuts', 'devwisp.sidebar-chat-shortcuts'],
  ['local', 'codex-remote.theme-preferences', 'devwisp.theme-preferences'],
  ['local', 'codex-remote.translation-preferences', 'devwisp.translation-preferences'],
  ['local', 'code-remote-ui-language', 'devwisp-ui-language'],
  ['session', 'code-remote:terminal-screens-v1', 'devwisp:terminal-screens-v1'],
  ['session', 'code-remote:open-terminals-v1', 'devwisp:open-terminals-v1'],
]

export function migrateLegacyBrowserStorage() {
  if (typeof window === 'undefined') return

  for (const [kind, legacyKey, currentKey, isPrefix] of storageKeyMigrations) {
    const storage = kind === 'local' ? window.localStorage : window.sessionStorage
    try {
      const legacyKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter((key): key is string => key !== null && (isPrefix ? key.startsWith(legacyKey) : key === legacyKey))
      for (const oldKey of legacyKeys) {
        const newKey = `${currentKey}${isPrefix ? oldKey.slice(legacyKey.length) : ''}`
        if (storage.getItem(newKey) === null) {
          const value = storage.getItem(oldKey)
          if (value !== null) storage.setItem(newKey, value)
        }
        storage.removeItem(oldKey)
      }
    } catch {
      // Storage can be unavailable or full; the app can still start without migrating this key.
    }
  }
}

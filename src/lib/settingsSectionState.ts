export type SettingsSectionId =
  | 'devices'
  | 'theme'
  | 'display'
  | 'translation'
  | 'codex-config'
  | 'claude-config'
  | 'chat-shortcuts'
  | 'cpa-manager'
  | 'mcp-approvals'
  | 'system-notifications'
  | 'about'

const storageKey = 'code-remote.settings-active-section.v1'
const sections: readonly SettingsSectionId[] = [
  'devices', 'theme', 'display', 'translation', 'codex-config', 'claude-config', 'chat-shortcuts',
  'cpa-manager', 'mcp-approvals', 'system-notifications', 'about',
]

export function readActiveSettingsSection(): SettingsSectionId {
  if (typeof window === 'undefined') return 'theme'
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (sections.includes(stored as SettingsSectionId)) return stored as SettingsSectionId
  } catch {
    // Unavailable storage should not prevent the settings page from opening.
  }
  return 'theme'
}

export function saveActiveSettingsSection(sectionId: SettingsSectionId) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey, sectionId)
  } catch {
    // A full or unavailable localStorage should not interrupt navigation.
  }
}

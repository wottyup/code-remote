export type SettingsSectionId =
  | 'mcp-approvals'
  | 'cpa-manager'
  | 'theme'
  | 'display'
  | 'chat-shortcuts'
  | 'system-notifications'
  | 'about'

const storageKeyPrefix = 'code-remote.settings-section-open.v1.'

export function readSettingsSectionOpen(sectionId: SettingsSectionId, defaultOpen = false) {
  if (typeof window === 'undefined') return defaultOpen
  try {
    const stored = window.localStorage.getItem(`${storageKeyPrefix}${sectionId}`)
    if (stored === 'true') return true
    if (stored === 'false') return false
  } catch {
    // Unavailable storage should not prevent the settings page from opening.
  }
  return defaultOpen
}

export function saveSettingsSectionOpen(sectionId: SettingsSectionId, open: boolean) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(`${storageKeyPrefix}${sectionId}`, String(open))
  } catch {
    // A full or unavailable localStorage should not interrupt section toggling.
  }
}

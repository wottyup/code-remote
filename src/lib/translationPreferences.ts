import type { TranslationProvider, TranslationStyle } from './codexRemoteClient'

export interface TranslationPreferences {
  enabled: boolean
  showTranslated: boolean
  provider: TranslationProvider
  style: TranslationStyle
}

const key = 'codex-remote.translation-preferences'
const providers = new Set<TranslationProvider>(['google', 'microsoft', 'deepl', 'codex', 'claude', 'chat'])

export const defaultTranslationPreferences: TranslationPreferences = {
  enabled: false,
  showTranslated: false,
  provider: 'microsoft',
  style: 'natural',
}

export function readTranslationPreferences(): TranslationPreferences {
  try {
    const value = window.localStorage.getItem(key)
    if (!value) return defaultTranslationPreferences
    const parsed = JSON.parse(value) as Partial<TranslationPreferences>
    return {
      enabled: parsed.enabled === true,
      showTranslated: parsed.showTranslated === true,
      provider: providers.has(parsed.provider as TranslationProvider) ? parsed.provider as TranslationProvider : defaultTranslationPreferences.provider,
      style: parsed.style === 'formal' ? 'formal' : 'natural',
    }
  } catch {
    return defaultTranslationPreferences
  }
}

export function saveTranslationPreferences(value: TranslationPreferences) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // The current page can still use the selected provider.
  }
}

export function containsChinese(value: string) {
  return /[\u3400-\u9fff]/.test(value)
}

export function containsEnglish(value: string) {
  return /[A-Za-z]/.test(value)
}

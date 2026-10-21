import type { CSSProperties } from 'react'

export type AppTheme = 'light' | 'dark' | 'warm' | 'custom' | 'retro' | 'pixel'

export interface ThemePreferences {
  theme: AppTheme
  customBackgroundColor: string
  customTextColor: string
  customBackgroundTransparency: number
  customBackgroundPositionX: number
  customBackgroundPositionY: number
  customBackgroundZoom: number
  fontSizeAdjustment: number
  systemNotificationsEnabled: boolean
  customBackgroundImage?: string
}

const themePreferencesStorageKey = 'codex-remote.theme-preferences'
const maxThemeImageDataUrlLength = 1_450_000

const defaultThemePreferences: ThemePreferences = {
  theme: 'dark',
  customBackgroundColor: '#4b5563',
  customTextColor: '#f1f5f9',
  customBackgroundTransparency: 0,
  customBackgroundPositionX: 50,
  customBackgroundPositionY: 50,
  customBackgroundZoom: 100,
  fontSizeAdjustment: 0,
  systemNotificationsEnabled: false,
}

export function normalizeHexColor(value: unknown, fallback: string) {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toUpperCase() : fallback
}

export function normalizeTransparency(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0
}

export function normalizeBackgroundPosition(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
    : 50
}

export function normalizeBackgroundZoom(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(250, Math.max(100, Math.round(value))) : 100
}

export function normalizeFontSizeAdjustment(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(6, Math.max(-3, Math.round(value))) : 0
}

function normalizeThemeBackgroundImage(value: unknown) {
  if (typeof value !== 'string') return undefined
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : undefined
}

export function isCompactThemeBackgroundImage(value: string) {
  return value.length <= maxThemeImageDataUrlLength && Boolean(normalizeThemeBackgroundImage(value))
}

export function readThemePreferences(): ThemePreferences {
  if (typeof window === 'undefined') return defaultThemePreferences
  try {
    const value = window.localStorage.getItem(themePreferencesStorageKey)
    if (!value) return defaultThemePreferences
    const parsed = JSON.parse(value) as Record<string, unknown>
    const theme = parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'warm' || parsed.theme === 'custom' || parsed.theme === 'retro' || parsed.theme === 'pixel'
      ? parsed.theme
      : defaultThemePreferences.theme
    const customBackgroundImage = normalizeThemeBackgroundImage(parsed.customBackgroundImage)
    return {
      theme,
      customBackgroundColor: normalizeHexColor(parsed.customBackgroundColor, defaultThemePreferences.customBackgroundColor),
      customTextColor: normalizeHexColor(parsed.customTextColor, defaultThemePreferences.customTextColor),
      customBackgroundTransparency: normalizeTransparency(parsed.customBackgroundTransparency),
      customBackgroundPositionX: normalizeBackgroundPosition(parsed.customBackgroundPositionX),
      customBackgroundPositionY: normalizeBackgroundPosition(parsed.customBackgroundPositionY),
      customBackgroundZoom: normalizeBackgroundZoom(parsed.customBackgroundZoom),
      fontSizeAdjustment: normalizeFontSizeAdjustment(parsed.fontSizeAdjustment),
      systemNotificationsEnabled: parsed.systemNotificationsEnabled === true,
      ...(customBackgroundImage ? { customBackgroundImage } : {}),
    }
  } catch {
    return defaultThemePreferences
  }
}

function rgbaFromHex(hex: string, alpha: number) {
  const value = normalizeHexColor(hex, '#4b5563').slice(1)
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`
}

function isLightColor(hex: string) {
  const value = normalizeHexColor(hex, '#f1f5f9').slice(1)
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)
  return red * 0.299 + green * 0.587 + blue * 0.114 >= 128
}

export function saveThemePreferences(preferences: ThemePreferences) {
  try {
    window.localStorage.setItem(themePreferencesStorageKey, JSON.stringify(preferences))
  } catch {
    // Theme preferences still apply for the current session when storage is unavailable.
  }
}

export function themeRootStyle(preferences: ThemePreferences): CSSProperties {
  const customBackgroundOpacity = (100 - preferences.customBackgroundTransparency) / 100
  const darkCustomTheme = isLightColor(preferences.customTextColor)
  return {
    '--custom-theme-background': preferences.customBackgroundColor,
    '--custom-theme-background-opacity': customBackgroundOpacity,
    '--custom-theme-background-position': `${normalizeBackgroundPosition(preferences.customBackgroundPositionX)}% ${normalizeBackgroundPosition(preferences.customBackgroundPositionY)}%`,
    '--custom-theme-background-zoom': normalizeBackgroundZoom(preferences.customBackgroundZoom) / 100,
    '--custom-theme-background-image': preferences.customBackgroundImage
      ? 'linear-gradient(rgba(0, 0, 0, .2), rgba(0, 0, 0, .2)), url("' + preferences.customBackgroundImage + '")'
      : 'none',
    '--custom-theme-text-color': preferences.customTextColor,
    '--custom-theme-send-circle': darkCustomTheme ? '#fff' : '#000',
    '--custom-theme-send-arrow': darkCustomTheme ? '#000' : '#fff',
    '--custom-theme-send-disabled-circle': darkCustomTheme ? '#6f737a' : '#8b8e95',
    '--custom-theme-surface': rgbaFromHex(preferences.customBackgroundColor, 0.38),
    '--custom-theme-control': rgbaFromHex(preferences.customBackgroundColor, 0.58),
    '--custom-theme-active': rgbaFromHex(preferences.customBackgroundColor, 0.24),
    '--custom-theme-border': rgbaFromHex(preferences.customTextColor, 0.32),
    '--custom-theme-panel-blur': '8px',
    '--user-font-offset': `${normalizeFontSizeAdjustment(preferences.fontSizeAdjustment)}px`,
  } as CSSProperties
}

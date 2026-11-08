import { useSyncExternalStore } from 'react'
import english from './uiEnglish.json'

export type UiLanguage = 'zh-CN' | 'en'

const storageKey = 'code-remote-ui-language'
const translations: Record<string, string> = english
const listeners = new Set<() => void>()

function savedLanguage(): UiLanguage {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(storageKey) === 'en' ? 'en' : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

let language: UiLanguage = savedLanguage()

function publishLanguage(next: UiLanguage) {
  if (typeof document !== 'undefined') document.documentElement.lang = next
  if (next === language) return
  language = next
  listeners.forEach((listener) => listener())
}

if (typeof document !== 'undefined') document.documentElement.lang = language
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) publishLanguage(savedLanguage())
  })
}

export function getUiLanguage(): UiLanguage {
  return language
}

export function setUiLanguage(next: UiLanguage) {
  try {
    window.localStorage.setItem(storageKey, next)
  } catch {
    // The selection still applies for this page if storage is unavailable.
  }
  publishLanguage(next)
}

export function useUiLanguage(): UiLanguage {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getUiLanguage,
    getUiLanguage,
  )
}

/** Translate only known application copy, never arbitrary chat or file content. */
export function ui(text: string): string {
  return language === 'en' ? translations[text] ?? text : text
}

/** Placeholders make the word order independent of the source language. */
export function uiFormat(template: string, ...values: unknown[]): string {
  return ui(template).replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = values[Number(index)]
    return value === undefined ? placeholder : String(value)
  })
}

// Some backend errors and pending UI notices arrive as already formatted text.
// Match only application-owned templates, leaving interpolated details intact.
const formattedMessages = Object.entries(translations).flatMap(([source, translated]) => {
  const placeholders = [...source.matchAll(/\{(\d+)\}/g)]
  if (!placeholders.length) return []
  let position = 0
  let pattern = ''
  for (const match of placeholders) {
    pattern += source.slice(position, match.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\S]*?)'
    position = match.index! + match[0].length
  }
  pattern += source.slice(position).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [{ pattern: new RegExp(`^${pattern}$`), indices: placeholders.map((match) => Number(match[1])), translated, specificity: source.replace(/\{\d+\}/g, '').length }]
}).sort((left, right) => right.specificity - left.specificity)

export function uiMessage(text: string): string {
  if (language !== 'en') return text
  if (translations[text]) return translations[text]
  for (const entry of formattedMessages) {
    const match = entry.pattern.exec(text)
    if (!match) continue
    const values: string[] = []
    entry.indices.forEach((index, position) => { values[index] = match[position + 1] })
    return entry.translated.replace(/\{(\d+)\}/g, (_, index: string) => values[Number(index)] ?? '')
  }
  return text
}

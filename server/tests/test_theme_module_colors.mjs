import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../../src/lib/themePreferences.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { readThemePreferences, saveThemePreferences, themeRootStyle } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

function withStorage(initial, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const values = new Map([['codex-remote.theme-preferences', JSON.stringify(initial)]])
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } },
  })
  try { run() } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete globalThis.window
  }
}

test('legacy custom themes keep following the background with the original opacity', () => {
  withStorage({ theme: 'custom', customBackgroundColor: '#123456', customTextColor: '#EEEEEE' }, () => {
    const preferences = readThemePreferences()
    assert.equal(preferences.customModuleColor, undefined)
    assert.equal(preferences.customModuleTransparency, 62)
    const style = themeRootStyle(preferences)
    assert.equal(style['--custom-theme-module-color'], '#123456')
    assert.equal(style['--custom-theme-surface'], 'rgba(18, 52, 86, 0.38)')
    assert.equal(style['--custom-theme-control'], 'rgba(18, 52, 86, 0.58)')
    assert.equal(style['--custom-theme-active'], 'rgba(18, 52, 86, 0.24)')
    assert.equal(themeRootStyle({ ...preferences, customBackgroundColor: '#ABCDEF' })['--custom-theme-module-color'], '#ABCDEF')
  })
})

test('module color and transparency persist independently of background and text colors', () => {
  withStorage({ theme: 'custom', customBackgroundColor: '#123456', customTextColor: '#EEEEEE' }, () => {
    const preferences = { ...readThemePreferences(), customModuleColor: '#ab540f', customModuleTransparency: 0 }
    saveThemePreferences(preferences)
    const restored = readThemePreferences()
    assert.equal(restored.customModuleColor, '#AB540F')
    assert.equal(restored.customModuleTransparency, 0)
    const style = themeRootStyle(restored)
    assert.equal(style['--custom-theme-background'], '#123456')
    assert.equal(style['--custom-theme-text-color'], '#EEEEEE')
    assert.equal(style['--custom-theme-surface'], 'rgba(171, 84, 15, 1)')
    assert.equal(themeRootStyle({ ...restored, customModuleTransparency: 100 })['--custom-theme-surface'], 'rgba(171, 84, 15, 0)')
    assert.equal(themeRootStyle({ ...restored, customModuleColor: undefined })['--custom-theme-module-color'], '#123456')
  })
})

test('invalid saved module settings fall back safely and transparency is clamped', () => {
  withStorage({ customModuleColor: 'invalid', customModuleTransparency: null }, () => {
    const preferences = readThemePreferences()
    assert.equal(preferences.customModuleColor, undefined)
    assert.equal(preferences.customModuleTransparency, 62)
  })
  withStorage({ customModuleColor: '#22bb44', customModuleTransparency: 170 }, () => {
    const preferences = readThemePreferences()
    assert.equal(preferences.customModuleColor, '#22BB44')
    assert.equal(preferences.customModuleTransparency, 100)
  })
})

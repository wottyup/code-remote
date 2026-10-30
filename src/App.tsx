import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { CodexRemotePage } from './components/CodexRemotePage'
import { PairingPage } from './components/PairingPage'
import { codexRemoteClient } from './lib/codexRemoteClient'
import { letterSpacingStyle, readThemePreferences, saveThemePreferences, themeRootStyle, type ThemePreferences } from './lib/themePreferences'

const STORAGE_KEY = 'codex-remote-token'

export default function App() {
  const [token, setToken] = useState(() => window.localStorage.getItem(STORAGE_KEY))
  const [themePreferences, setThemePreferences] = useState<ThemePreferences>(readThemePreferences)

  useEffect(() => {
    saveThemePreferences(themePreferences)
  }, [themePreferences])

  useLayoutEffect(() => {
    const root = document.documentElement
    const previousLetterSpacing = root.style.letterSpacing
    const previousDelta = root.style.getPropertyValue('--user-letter-spacing-delta')
    const spacing = letterSpacingStyle(themePreferences)
    root.style.letterSpacing = spacing.letterSpacing
    root.style.setProperty('--user-letter-spacing-delta', spacing['--user-letter-spacing-delta'])
    return () => {
      root.style.letterSpacing = previousLetterSpacing
      if (previousDelta) root.style.setProperty('--user-letter-spacing-delta', previousDelta)
      else root.style.removeProperty('--user-letter-spacing-delta')
    }
  }, [themePreferences.letterSpacingPercent])

  const paired = useCallback((nextToken: string) => {
    window.localStorage.setItem(STORAGE_KEY, nextToken)
    setToken(nextToken)
  }, [])

  const unpair = useCallback(async () => {
    const currentToken = window.localStorage.getItem(STORAGE_KEY)
    window.localStorage.removeItem(STORAGE_KEY)
    setToken(null)
    if (!currentToken) return
    try {
      await codexRemoteClient.unpair(currentToken)
    } catch {
      // The local token is already removed. A later server restart cannot restore it in this browser.
    }
  }, [])

  return (
    <div className={`app-root app-root--theme-${themePreferences.theme}`} style={themeRootStyle(themePreferences)}>
      {!token ? <PairingPage onPaired={paired} /> : (
        <CodexRemotePage
          token={token}
          onUnauthorized={unpair}
          onUnpair={unpair}
          themePreferences={themePreferences}
          onThemePreferencesChange={setThemePreferences}
        />
      )}
    </div>
  )
}

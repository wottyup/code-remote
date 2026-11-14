import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { DevWispPage } from './components/DevWispPage'
import { PairingPage } from './components/PairingPage'
import { devwispClient } from './lib/devwispClient'
import { letterSpacingStyle, readThemePreferences, saveThemePreferences, themeRootStyle, type ThemePreferences } from './lib/themePreferences'

const STORAGE_KEY = 'devwisp-token'

export default function App() {
  const [token, setToken] = useState<string | null>(() => window.localStorage.getItem(STORAGE_KEY))
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
    const currentToken = token
    window.localStorage.removeItem(STORAGE_KEY)
    setToken(null)
    if (!currentToken) return
    try {
      await devwispClient.unpair(currentToken)
    } catch {
      // The local token is already removed. A later server restart cannot restore it in this browser.
    }
  }, [token])

  return (
    <div className={`app-root app-root--theme-${themePreferences.theme}`} style={themeRootStyle(themePreferences)}>
      {!token ? <PairingPage onPaired={paired} /> : (
        <DevWispPage
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

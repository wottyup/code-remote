import { useCallback, useEffect, useState } from 'react'
import { CodexRemotePage } from './components/CodexRemotePage'
import { PairingPage } from './components/PairingPage'
import { codexRemoteClient } from './lib/codexRemoteClient'
import { readThemePreferences, saveThemePreferences, themeRootStyle, type ThemePreferences } from './lib/themePreferences'

const STORAGE_KEY = 'codex-remote-token'

export default function App() {
  const [token, setToken] = useState(() => window.localStorage.getItem(STORAGE_KEY))
  const [themePreferences, setThemePreferences] = useState<ThemePreferences>(readThemePreferences)

  useEffect(() => {
    saveThemePreferences(themePreferences)
  }, [themePreferences])

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

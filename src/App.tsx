import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { CodexRemotePage } from './components/CodexRemotePage'
import { PairingPage } from './components/PairingPage'
import { DeviceManagerShell } from './components/DeviceManagerShell'
import { codexRemoteClient } from './lib/codexRemoteClient'
import { letterSpacingStyle, readThemePreferences, saveThemePreferences, themeRootStyle, type ThemePreferences } from './lib/themePreferences'
import { postPairingStateToManager, useWebDeviceManager } from './lib/webDeviceManager'

const STORAGE_KEY = 'codex-remote-token'

declare global {
  interface Window {
    CodeRemoteDesktop?: {
      getToken: () => string | null
      saveToken: (token: string) => Promise<boolean>
      clearToken: () => Promise<boolean>
    }
  }
}

function readPairedToken() {
  if (window.CodeRemoteDesktop) return window.CodeRemoteDesktop.getToken()
  return window.localStorage.getItem(STORAGE_KEY)
}

function RemoteClientApp() {
  const deviceManager = useWebDeviceManager()
  const [token, setToken] = useState(readPairedToken)
  const [themePreferences, setThemePreferences] = useState<ThemePreferences>(readThemePreferences)

  useEffect(() => {
    saveThemePreferences(themePreferences)
  }, [themePreferences])

  useEffect(() => {
    if (window.parent === window) return
    postPairingStateToManager(Boolean(token))
  }, [token])

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
    if (window.CodeRemoteDesktop) void window.CodeRemoteDesktop.saveToken(nextToken)
    else window.localStorage.setItem(STORAGE_KEY, nextToken)
    setToken(nextToken)
  }, [])

  const unpair = useCallback(async () => {
    const currentToken = token
    if (window.CodeRemoteDesktop) await window.CodeRemoteDesktop.clearToken()
    else window.localStorage.removeItem(STORAGE_KEY)
    setToken(null)
    if (!currentToken) return
    try {
      await codexRemoteClient.unpair(currentToken)
    } catch {
      // The local token is already removed. A later server restart cannot restore it in this browser.
    }
  }, [token])

  return (
    <div className={`app-root app-root--theme-${themePreferences.theme}`} style={themeRootStyle(themePreferences)}>
      {!token ? <PairingPage onPaired={paired} deviceManager={deviceManager} /> : (
        <CodexRemotePage
          token={token}
          onUnauthorized={unpair}
          onUnpair={unpair}
          themePreferences={themePreferences}
          onThemePreferencesChange={setThemePreferences}
          deviceManager={deviceManager}
        />
      )}
    </div>
  )
}

export default function App() {
  if (window.CodeRemoteDesktop || window.CodexRemoteAndroid || window.parent !== window || new URLSearchParams(window.location.search).get('code-remote-client') === '1') {
    return <RemoteClientApp />
  }
  return <DeviceManagerShell />
}

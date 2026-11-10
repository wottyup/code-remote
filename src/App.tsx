import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { CodexRemotePage } from './components/CodexRemotePage'
import { PairingPage } from './components/PairingPage'
import { DeviceManagerShell } from './components/DeviceManagerShell'
import { codexRemoteClient } from './lib/codexRemoteClient'
import { letterSpacingStyle, readThemePreferences, saveThemePreferences, themeRootStyle, type ThemePreferences } from './lib/themePreferences'
import { useWebDeviceManager } from './lib/webDeviceManager'

const STORAGE_KEY = 'codex-remote-token'

function RemoteClientApp() {
  const deviceManager = useWebDeviceManager()
  const [desktopBridge] = useState(() => window.CodeRemoteDesktop)
  const [token, setToken] = useState<string | null>(() => desktopBridge ? null : window.localStorage.getItem(STORAGE_KEY))
  const [tokenReady, setTokenReady] = useState(!desktopBridge)
  const [themePreferences, setThemePreferences] = useState<ThemePreferences>(readThemePreferences)

  useEffect(() => {
    if (!desktopBridge) return
    let disposed = false
    void desktopBridge.getTokenAsync().then((savedToken) => {
      if (disposed) return
      setToken(savedToken)
      setTokenReady(true)
    }).catch(() => {
      if (disposed) return
      setToken(null)
      setTokenReady(true)
    })
    return () => { disposed = true }
  }, [desktopBridge])

  useEffect(() => {
    saveThemePreferences(themePreferences)
  }, [themePreferences])

  useEffect(() => {
    if (!deviceManager.available) return
    deviceManager.reportPairingState(Boolean(token))
  }, [deviceManager.activeProfileId, deviceManager.available, deviceManager.reportPairingState, token])

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
    if (desktopBridge) void desktopBridge.saveToken(nextToken)
    else window.localStorage.setItem(STORAGE_KEY, nextToken)
    setToken(nextToken)
  }, [desktopBridge])

  const unpair = useCallback(async () => {
    const currentToken = token
    if (desktopBridge) await desktopBridge.clearToken()
    else window.localStorage.removeItem(STORAGE_KEY)
    setToken(null)
    if (!currentToken) return
    try {
      await codexRemoteClient.unpair(currentToken)
    } catch {
      // The local token is already removed. A later server restart cannot restore it in this browser.
    }
  }, [desktopBridge, token])

  if (!tokenReady) return <div className="app-startup-loading" role="status"><span /></div>

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

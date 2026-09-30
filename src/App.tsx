import { useCallback, useState } from 'react'
import { CodexRemotePage } from './components/CodexRemotePage'
import { PairingPage } from './components/PairingPage'
import { codexRemoteClient } from './lib/codexRemoteClient'

const STORAGE_KEY = 'codex-remote-token'

export default function App() {
  const [token, setToken] = useState(() => window.localStorage.getItem(STORAGE_KEY))

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

  if (!token) return <PairingPage onPaired={paired} />
  return <CodexRemotePage token={token} onUnauthorized={unpair} onUnpair={unpair} />
}

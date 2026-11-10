import { useCallback, useEffect, useState } from 'react'

export const currentWebDeviceId = '__current__'
const clientModeKey = 'code-remote-client'
const managerOriginKey = 'code-remote-manager-origin'
const managerPathKey = 'code-remote-manager-path'
const managerSessionKey = 'code-remote-manager-session'

export function normalizePairingCode(value: string): string {
  return value.normalize('NFKC').toUpperCase().replace(/[\s_\-\u200b\ufeff]+/g, '').slice(0, 8)
}

export interface WebDeviceProfile {
  id: string
  name: string
  url: string
  paired: boolean
  verified?: boolean
  isCurrent: boolean
}

export interface WebDevicePairingResult {
  requestId: string
  profileId: string
  paired: boolean
  error?: string
}

export interface DesktopConnectionProfile {
  id: string
  name: string
  endpoint: string
  paired: boolean
}

export interface DesktopPairConnectionResult {
  profiles: DesktopConnectionProfile[]
  profileId: string
}

export interface DesktopRemoveConnectionResult {
  profiles: DesktopConnectionProfile[]
  remoteRevoked: boolean
}

export interface DesktopUpdateStatus {
  currentVersion: string
  latestVersion: string
  available: boolean
  filename: string
  sizeBytes: number
  sha256: string
}

export interface DownloadedDesktopUpdate {
  version: string
  filename: string
  sizeBytes: number
}

export interface CodeRemoteDesktopBridge {
  currentVersion?: string
  getToken: () => string | null
  getTokenAsync: () => Promise<string | null>
  saveToken: (token: string) => Promise<boolean>
  clearToken: () => Promise<boolean>
  getCurrentConnectionId: () => Promise<string | null>
  listConnections: () => Promise<DesktopConnectionProfile[]>
  pairConnection: (input: { name: string; endpoint: string; code: string }) => Promise<DesktopPairConnectionResult>
  renameConnection: (input: { id: string; name: string }) => Promise<DesktopConnectionProfile[]>
  removeConnection: (input: { id: string }) => Promise<DesktopRemoveConnectionResult>
  activateConnection: (profileId: string) => Promise<boolean>
  showConnectionManager: () => Promise<boolean>
  openConnectionWindow: (profileId: string) => Promise<boolean>
  checkDesktopUpdate: () => Promise<DesktopUpdateStatus>
  downloadDesktopUpdate: () => Promise<DownloadedDesktopUpdate>
  installDesktopUpdate: () => Promise<boolean>
  onConnectionsChanged: (callback: (connections: DesktopConnectionProfile[]) => void) => () => void
}

declare global {
  interface Window {
    CodeRemoteDesktop?: CodeRemoteDesktopBridge
  }
}

export function webDevicePairingLabel(profile: WebDeviceProfile): '已配对' | '未配对' | '状态未知' {
  return profile.verified === false ? '状态未知' : profile.paired ? '已配对' : '未配对'
}

interface DeviceManagerFrameConfig {
  origin: string
  path: string
  sessionId: string
}

let cachedFrameConfig: DeviceManagerFrameConfig | null | undefined

export interface WebDeviceManagerState {
  mode: 'browser' | 'desktop'
  available: boolean
  profiles: WebDeviceProfile[]
  activeProfileId: string
  pendingPairingCode: string | null
  pairingResult: WebDevicePairingResult | null
  completePendingPairing: (paired?: boolean, error?: string) => void
  reportPairingState: (paired: boolean) => void
  addProfile: (name: string, url: string, pairingCode?: string) => string | null | Promise<string | null>
  renameProfile: (id: string, name: string) => void | Promise<void>
  removeProfile: (id: string) => void | Promise<boolean | void>
  selectProfile: (id: string) => void | Promise<void>
  openWindow: ((id: string) => void | Promise<void>) | null
  windowHref: (id: string) => string | null
}

export function normalizeWebDeviceUrl(value: string): string {
  const raw = value.trim()
  if (!raw) throw new Error('请填写 Code Remote 网页地址。')

  let url: URL
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    throw new Error('请使用有效的 HTTP 或 HTTPS 地址，不要带账号、查询参数或片段。')
  }

  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('请使用有效的 HTTP 或 HTTPS 地址，不要带账号、查询参数或片段。')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

function readFrameConfig(): DeviceManagerFrameConfig | null {
  if (cachedFrameConfig !== undefined) return cachedFrameConfig
  if (typeof window === 'undefined' || window.parent === window) return null
  const search = new URLSearchParams(window.location.search)
  if (search.get(clientModeKey) !== '1') {
    cachedFrameConfig = null
    return cachedFrameConfig
  }

  try {
    const bridge = new URLSearchParams(window.location.hash.slice(1))
    const origin = new URL(bridge.get(managerOriginKey) ?? '').origin
    const path = bridge.get(managerPathKey) ?? '/'
    const sessionId = bridge.get(managerSessionKey) ?? ''
    if (!/^\/(?!\/)/.test(path) || path.includes('?') || path.includes('#') || !sessionId) return null
    cachedFrameConfig = { origin, path, sessionId }
    return cachedFrameConfig
  } catch {
    cachedFrameConfig = null
    return cachedFrameConfig
  }
}

function isDeviceProfile(value: unknown): value is WebDeviceProfile {
  if (!value || typeof value !== 'object') return false
  const profile = value as Partial<WebDeviceProfile>
  return typeof profile.id === 'string' && typeof profile.name === 'string'
    && typeof profile.url === 'string' && typeof profile.paired === 'boolean'
    && (profile.verified === undefined || typeof profile.verified === 'boolean')
    && typeof profile.isCurrent === 'boolean'
}

function randomId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // Insecure HTTP contexts may not expose randomUUID.
  }
  return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function useWebDeviceManager(): WebDeviceManagerState {
  const [config] = useState(readFrameConfig)
  const [desktopBridge] = useState(() => typeof window === 'undefined' ? undefined : window.CodeRemoteDesktop)
  const [profiles, setProfiles] = useState<WebDeviceProfile[]>([])
  const [activeProfileId, setActiveProfileId] = useState(currentWebDeviceId)
  const [available, setAvailable] = useState(false)
  const [pendingPairingCode, setPendingPairingCode] = useState<string | null>(null)
  const [pairingResult, setPairingResult] = useState<WebDevicePairingResult | null>(null)

  useEffect(() => {
    if (!desktopBridge) return
    let disposed = false

    const applyConnections = async (connections: DesktopConnectionProfile[]) => {
      const activeId = await desktopBridge.getCurrentConnectionId()
      if (disposed) return
      const nextProfiles = connections.flatMap((connection) => {
        if (!connection || typeof connection.id !== 'string' || typeof connection.name !== 'string'
          || typeof connection.endpoint !== 'string' || typeof connection.paired !== 'boolean') return []
        try {
          const url = normalizeWebDeviceUrl(connection.endpoint)
          return [{
            id: connection.id,
            name: connection.name,
            url,
            paired: connection.paired,
            verified: true,
            isCurrent: connection.id === activeId,
          }]
        } catch {
          return []
        }
      })
      setProfiles(nextProfiles)
      setActiveProfileId(activeId ?? currentWebDeviceId)
      setAvailable(true)
    }

    const refresh = async () => {
      await applyConnections(await desktopBridge.listConnections())
    }

    const unsubscribe = desktopBridge.onConnectionsChanged((connections) => {
      void applyConnections(connections).catch(() => undefined)
    })
    void refresh().catch(() => {
      if (!disposed) setAvailable(false)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [desktopBridge])

  const sendAction = useCallback((action: Record<string, unknown>) => {
    if (!config) return
    window.parent.postMessage({ source: 'code-remote-app', sessionId: config.sessionId, ...action }, config.origin)
  }, [config])

  const reportPairingState = useCallback((paired: boolean) => {
    setProfiles((current) => current.map((profile) => profile.id === activeProfileId ? { ...profile, paired, verified: true } : profile))
    if (!desktopBridge) sendAction({ type: 'pairing-state', paired })
  }, [activeProfileId, desktopBridge, sendAction])

  useEffect(() => {
    const frameConfig = config
    if (!frameConfig) return
    const managerOrigin = frameConfig.origin
    const sessionId = frameConfig.sessionId

    function receiveState(event: MessageEvent) {
      if (event.source !== window.parent || event.origin !== managerOrigin) return
      if (event.data?.source !== 'code-remote-manager' || event.data?.sessionId !== sessionId) return
      if (event.data.type === 'pairing-result') {
        if (typeof event.data.requestId !== 'string' || typeof event.data.profileId !== 'string'
          || typeof event.data.paired !== 'boolean') return
        setPairingResult({
          requestId: event.data.requestId,
          profileId: event.data.profileId,
          paired: event.data.paired,
          error: typeof event.data.error === 'string' ? event.data.error : undefined,
        })
        return
      }
      if (event.data.type !== 'state') return
      if (!Array.isArray(event.data.profiles) || !event.data.profiles.every(isDeviceProfile)) return
      if (typeof event.data.activeProfileId !== 'string') return
      setProfiles(event.data.profiles)
      setActiveProfileId(event.data.activeProfileId)
      const pairingCode = typeof event.data.pairingCode === 'string' ? normalizePairingCode(event.data.pairingCode) : ''
      setPendingPairingCode(pairingCode.length === 8 ? pairingCode : null)
      setAvailable(true)
    }

    window.addEventListener('message', receiveState)
    window.parent.postMessage({ source: 'code-remote-app', type: 'ready', sessionId }, managerOrigin)
    return () => window.removeEventListener('message', receiveState)
  }, [config])

  const addProfile = useCallback((name: string, value: string, valuePairingCode = '') => {
    const url = normalizeWebDeviceUrl(value)
    const trimmedName = name.trim().slice(0, 48) || new URL(url).host
    const pairingCode = normalizePairingCode(valuePairingCode)
    if (valuePairingCode.trim() && pairingCode.length !== 8) throw new Error('请输入有效的 8 位匹配码。')
    if (desktopBridge) {
      if (pairingCode.length !== 8) throw new Error('请输入有效的 8 位匹配码。')
      if (profiles.some((profile) => normalizeWebDeviceUrl(profile.url) === url)) throw new Error('这个地址已经添加了。')
      return desktopBridge.pairConnection({ name: trimmedName, endpoint: url, code: pairingCode }).then(async (result) => {
        const activeId = await desktopBridge.getCurrentConnectionId()
        setProfiles(result.profiles.map((connection) => ({
          id: connection.id,
          name: connection.name,
          url: connection.endpoint,
          paired: connection.paired,
          verified: true,
          isCurrent: connection.id === activeId,
        })))
        setActiveProfileId(activeId ?? currentWebDeviceId)
        setAvailable(true)
        return null
      })
    }
    const existingProfile = profiles.find((profile) => {
      try {
        return normalizeWebDeviceUrl(profile.url) === url
      } catch {
        return false
      }
    })
    if (existingProfile && (!pairingCode || existingProfile.isCurrent)) throw new Error('这个地址已经添加了。')
    const requestId = pairingCode ? createWebDeviceId() : null
    sendAction({ type: 'add', name: trimmedName, url, ...(pairingCode ? { pairingCode, requestId } : {}) })
    return requestId
  }, [desktopBridge, profiles, sendAction])

  const completePendingPairing = useCallback((paired = false, error?: string) => {
    if (!pendingPairingCode) return
    sendAction({ type: 'pairing-code-consumed', profileId: activeProfileId, paired, ...(error ? { error } : {}) })
  }, [activeProfileId, pendingPairingCode, sendAction])

  const renameProfile = useCallback((id: string, name: string) => {
    const trimmedName = name.trim().slice(0, 48)
    if (!trimmedName) throw new Error('设备名称不能为空。')
    if (!desktopBridge && id === currentWebDeviceId) throw new Error('当前网页不能重命名。')
    if (desktopBridge) {
      return desktopBridge.renameConnection({ id, name: trimmedName }).then((connections) => {
        setProfiles((current) => current.map((profile) => {
          const connection = connections.find((entry) => entry.id === profile.id)
          return connection ? { ...profile, name: connection.name } : profile
        }))
      })
    }
    sendAction({ type: 'rename', id, name: trimmedName })
  }, [desktopBridge, sendAction])

  const removeProfile = useCallback((id: string) => {
    if (!desktopBridge && id === currentWebDeviceId) throw new Error('当前网页不能移除。')
    if (desktopBridge) {
      return desktopBridge.removeConnection({ id }).then((result) => {
        setProfiles(result.profiles.map((connection) => ({
          id: connection.id,
          name: connection.name,
          url: connection.endpoint,
          paired: connection.paired,
          verified: true,
          isCurrent: connection.id === activeProfileId,
        })))
        return result.remoteRevoked
      })
    }
    sendAction({ type: 'remove', id })
  }, [activeProfileId, desktopBridge, sendAction])

  const selectProfile = useCallback((id: string) => {
    if (desktopBridge) {
      if (!profiles.some((profile) => profile.id === id) || id === activeProfileId) return
      setActiveProfileId(id)
      setProfiles((current) => current.map((profile) => ({ ...profile, isCurrent: profile.id === id })))
      void desktopBridge.activateConnection(id).catch(() => undefined)
      return
    }
    sendAction({ type: 'select', id })
  }, [activeProfileId, desktopBridge, profiles, sendAction])

  const openWindow = useCallback((id: string) => {
    if (!desktopBridge) return
    return desktopBridge.openConnectionWindow(id).then(() => undefined)
  }, [desktopBridge])

  const windowHref = useCallback((id: string) => {
    if (desktopBridge) return null
    if (!config) return null
    const url = new URL(config.path, config.origin)
    url.searchParams.set('device', id)
    return url.href
  }, [config, desktopBridge])

  return { mode: desktopBridge ? 'desktop' : 'browser', available, profiles, activeProfileId, pendingPairingCode, pairingResult, completePendingPairing, reportPairingState, addProfile, renameProfile, removeProfile, selectProfile, openWindow: desktopBridge ? openWindow : null, windowHref }
}

export function createWebDeviceFrameUrl(profile: WebDeviceProfile, managerOrigin: string, managerPath: string, sessionId: string): string {
  const url = new URL(normalizeWebDeviceUrl(profile.url))
  url.searchParams.set(clientModeKey, '1')
  const bridge = new URLSearchParams()
  bridge.set(managerOriginKey, managerOrigin)
  bridge.set(managerPathKey, managerPath)
  bridge.set(managerSessionKey, sessionId)
  url.hash = bridge.toString()
  return url.href
}

export function createWebDeviceId(): string {
  return randomId()
}

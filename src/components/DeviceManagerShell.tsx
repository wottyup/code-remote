import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createWebDeviceFrameUrl,
  createWebDeviceId,
  currentWebDeviceId,
  normalizePairingCode,
  normalizeWebDeviceUrl,
  type WebDeviceProfile,
} from '../lib/webDeviceManager'

const profilesStorageKey = 'code-remote.web-device-profiles.v1'
const legacyProfilesStorageKey = 'code-remote.browser-connections.v1'

interface InitialState {
  profiles: WebDeviceProfile[]
  activeProfileId: string
}

interface PendingPairing {
  profileId: string
  code: string
  sessionId: string
  requestId: string
  requesterWindow: Window
  requesterOrigin: string
  requesterSessionId: string
}

function sendPairingResult(attempt: PendingPairing, paired: boolean, error?: string): void {
  attempt.requesterWindow.postMessage({
    source: 'code-remote-manager',
    type: 'pairing-result',
    sessionId: attempt.requesterSessionId,
    requestId: attempt.requestId,
    profileId: attempt.profileId,
    paired,
    ...(error ? { error } : {}),
  }, attempt.requesterOrigin)
}

function readSavedProfiles(): WebDeviceProfile[] {
  try {
    const currentSaved = window.localStorage.getItem(profilesStorageKey)
    const migratingLegacyProfiles = currentSaved === null
    const saved = JSON.parse(currentSaved ?? window.localStorage.getItem(legacyProfilesStorageKey) ?? '[]')
    if (!Array.isArray(saved)) return []
    const profiles: WebDeviceProfile[] = []
    for (const item of saved) {
      if (!item || typeof item.id !== 'string' || !item.id || item.id === currentWebDeviceId
        || typeof item.name !== 'string' || typeof (item.url ?? item.endpoint) !== 'string') continue
      try {
        const url = normalizeWebDeviceUrl(item.url ?? item.endpoint)
        if (profiles.some((profile) => profile.id === item.id || profile.url === url)) continue
        profiles.push({
          id: item.id,
          name: item.name.trim().slice(0, 48) || new URL(url).host,
          url,
          paired: Boolean(item.paired),
          verified: item.verified !== false,
          isCurrent: false,
        })
      } catch {
        // Ignore broken records and keep the remaining device profiles usable.
      }
    }
    if (migratingLegacyProfiles && profiles.length > 0) {
      try {
        window.localStorage.setItem(profilesStorageKey, JSON.stringify(profiles))
        window.localStorage.removeItem(legacyProfilesStorageKey)
      } catch {
        // Keep legacy profiles usable in memory when storage is unavailable.
      }
    }
    return profiles
  } catch {
    return []
  }
}

function readInitialState(): InitialState {
  const profiles = readSavedProfiles()
  const requestedId = new URLSearchParams(window.location.search).get('device')
  return {
    profiles,
    activeProfileId: requestedId === currentWebDeviceId || profiles.some((profile) => profile.id === requestedId)
      ? requestedId!
      : currentWebDeviceId,
  }
}

function writeSavedProfiles(profiles: WebDeviceProfile[]): void {
  try {
    window.localStorage.setItem(profilesStorageKey, JSON.stringify(profiles.filter((profile) => !profile.isCurrent)))
  } catch {
    // The app remains usable for this page even if browser storage is unavailable.
  }
}

function newRootUrl(pathname: string, profileId: string): string {
  const url = new URL(pathname, window.location.origin)
  if (profileId === currentWebDeviceId) url.searchParams.delete('device')
  else url.searchParams.set('device', profileId)
  return url.href
}

export function DeviceManagerShell() {
  const [initial] = useState(readInitialState)
  const [savedProfiles, setSavedProfiles] = useState(initial.profiles)
  const savedProfilesRef = useRef(initial.profiles)
  const [activeProfileId, setActiveProfileId] = useState(initial.activeProfileId)
  const [homePaired, setHomePaired] = useState(false)
  const [homeVerified, setHomeVerified] = useState(false)
  const [pendingPairing, setPendingPairing] = useState<PendingPairing | null>(null)
  const pendingPairingRef = useRef<PendingPairing | null>(null)
  const [frameSessionId, setFrameSessionId] = useState(createWebDeviceId)
  const frame = useRef<HTMLIFrameElement>(null)
  const pairingFrame = useRef<HTMLIFrameElement>(null)
  const managerOrigin = window.location.origin
  const managerPath = window.location.pathname || '/'

  const profiles = useMemo<WebDeviceProfile[]>(() => [{
    id: currentWebDeviceId,
    name: window.location.host,
    url: `${managerOrigin}${managerPath}`,
    paired: homePaired,
    verified: homeVerified,
    isCurrent: true,
  }, ...savedProfiles], [homePaired, homeVerified, managerOrigin, managerPath, savedProfiles])
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]
  const frameUrl = useMemo(
    () => createWebDeviceFrameUrl(activeProfile, managerOrigin, managerPath, frameSessionId),
    [activeProfile, frameSessionId, managerOrigin, managerPath],
  )
  const pendingProfile = pendingPairing ? profiles.find((profile) => profile.id === pendingPairing.profileId) : null
  const pairingFrameUrl = pendingPairing && pendingProfile
    ? createWebDeviceFrameUrl(pendingProfile, managerOrigin, managerPath, pendingPairing.sessionId)
    : null

  const updateSavedProfiles = useCallback((next: WebDeviceProfile[]) => {
    savedProfilesRef.current = next
    setSavedProfiles(next)
    writeSavedProfiles(next)
  }, [])

  const updateProfilePairing = useCallback((profileId: string, paired: boolean) => {
    if (profileId === currentWebDeviceId) {
      setHomePaired(paired)
      setHomeVerified(true)
      return
    }
    const current = savedProfilesRef.current
    if (!current.some((profile) => profile.id === profileId)) return
    updateSavedProfiles(current.map((profile) => profile.id === profileId ? { ...profile, paired, verified: true } : profile))
  }, [updateSavedProfiles])

  const cancelPairing = useCallback((error = '自动配对已取消。') => {
    const attempt = pendingPairingRef.current
    if (!attempt) return
    pendingPairingRef.current = null
    setPendingPairing(null)
    sendPairingResult(attempt, false, error)
  }, [])

  const startPairing = useCallback((profileId: string, code: string, requestId: string, requesterWindow: Window, requesterOrigin: string, requesterSessionId: string) => {
    cancelPairing()
    const attempt: PendingPairing = {
      profileId, code, requestId, requesterWindow, requesterOrigin, requesterSessionId,
      sessionId: createWebDeviceId(),
    }
    pendingPairingRef.current = attempt
    setPendingPairing(attempt)
  }, [cancelPairing])

  const finishPairing = useCallback((sessionId: string, paired: boolean, error?: string, confirmedFailure = false) => {
    const attempt = pendingPairingRef.current
    if (!attempt || attempt.sessionId !== sessionId) return
    pendingPairingRef.current = null
    setPendingPairing(null)
    if (paired || confirmedFailure) updateProfilePairing(attempt.profileId, paired)
    sendPairingResult(attempt, paired, error)
  }, [updateProfilePairing])

  const selectProfile = useCallback((profileId: string, addHistoryEntry = true) => {
    if (!profiles.some((profile) => profile.id === profileId) || profileId === activeProfileId) return
    cancelPairing()
    setActiveProfileId(profileId)
    setFrameSessionId(createWebDeviceId())
    const nextUrl = newRootUrl(managerPath, profileId)
    if (addHistoryEntry) window.history.pushState({ codeRemoteDevice: profileId }, '', nextUrl)
    else window.history.replaceState({ codeRemoteDevice: profileId }, '', nextUrl)
  }, [activeProfileId, cancelPairing, managerPath, profiles])

  const sendState = useCallback(() => {
    const target = frame.current?.contentWindow
    if (!target) return
    let targetOrigin: string
    try {
      targetOrigin = new URL(activeProfile.url).origin
    } catch {
      return
    }
    target.postMessage({
      source: 'code-remote-manager',
      type: 'state',
      sessionId: frameSessionId,
      profiles,
      activeProfileId,
      managerPath,
      pairingCode: null,
    }, targetOrigin)
  }, [activeProfile.url, activeProfileId, frameSessionId, managerPath, profiles])

  const sendPendingState = useCallback(() => {
    const target = pairingFrame.current?.contentWindow
    if (!target || !pendingPairing || !pendingProfile) return
    target.postMessage({
      source: 'code-remote-manager',
      type: 'state',
      sessionId: pendingPairing.sessionId,
      profiles,
      activeProfileId: pendingPairing.profileId,
      managerPath,
      pairingCode: pendingPairing.code,
    }, new URL(pendingProfile.url).origin)
  }, [managerPath, pendingPairing, pendingProfile, profiles])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.source !== 'code-remote-app') return
      if (event.data?.sessionId !== frameSessionId) return
      let expectedOrigin = ''
      try {
        expectedOrigin = new URL(activeProfile.url).origin
      } catch {
        return
      }
      if (event.origin !== expectedOrigin) return

      const data = event.data
      if (data.type === 'ready') {
        sendState()
        return
      }
      if (data.type === 'pairing-state' && typeof data.paired === 'boolean') {
        updateProfilePairing(activeProfile.id, data.paired)
        return
      }
      if (data.type === 'add' && typeof data.name === 'string' && typeof data.url === 'string') {
        try {
          const url = normalizeWebDeviceUrl(data.url)
          const inputPairingCode = typeof data.pairingCode === 'string' ? data.pairingCode : ''
          const pairingCode = normalizePairingCode(inputPairingCode)
          if (inputPairingCode.trim() && pairingCode.length !== 8) return
          const currentUrl = normalizeWebDeviceUrl(new URL(managerPath, managerOrigin).href)
          const allProfiles = [{ id: currentWebDeviceId, url: currentUrl }, ...savedProfiles]
          const existingProfile = allProfiles.find((profile) => profile.url === url)
          if (existingProfile && (!pairingCode || existingProfile.id === currentWebDeviceId)) return
          const name = data.name.trim().slice(0, 48) || new URL(url).host
          const profileId = existingProfile?.id ?? createWebDeviceId()
          if (!existingProfile) {
            const profile: WebDeviceProfile = { id: profileId, name, url, paired: false, verified: false, isCurrent: false }
            updateSavedProfiles([...savedProfiles, profile])
          }
          if (pairingCode) {
            const requestId = typeof data.requestId === 'string' && data.requestId.length <= 96 && data.requestId
              ? data.requestId : createWebDeviceId()
            startPairing(profileId, pairingCode, requestId, event.source as Window, event.origin, frameSessionId)
          }
        } catch {
          // Settings performs the same validation before sending; ignore malformed messages.
        }
        return
      }
      if (data.type === 'rename' && typeof data.id === 'string' && typeof data.name === 'string') {
        const name = data.name.trim().slice(0, 48)
        if (!name) return
        updateSavedProfiles(savedProfiles.map((profile) => profile.id === data.id ? { ...profile, name } : profile))
        return
      }
      if (data.type === 'remove' && typeof data.id === 'string') {
        if (!savedProfiles.some((profile) => profile.id === data.id)) return
        if (pendingPairingRef.current?.profileId === data.id) cancelPairing()
        updateSavedProfiles(savedProfiles.filter((profile) => profile.id !== data.id))
        if (data.id === activeProfileId) selectProfile(currentWebDeviceId)
        return
      }
      if (data.type === 'select' && typeof data.id === 'string') selectProfile(data.id)
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [activeProfile, activeProfileId, cancelPairing, frameSessionId, managerOrigin, managerPath, savedProfiles, selectProfile, sendState, startPairing, updateProfilePairing, updateSavedProfiles])

  useEffect(() => {
    if (!pendingPairing || !pendingProfile) return
    const expectedOrigin = new URL(pendingProfile.url).origin
    const sessionId = pendingPairing.sessionId
    const profileId = pendingPairing.profileId

    const handlePairingMessage = (event: MessageEvent) => {
      if (event.source !== pairingFrame.current?.contentWindow || event.origin !== expectedOrigin) return
      if (event.data?.source !== 'code-remote-app' || event.data?.sessionId !== sessionId) return
      const data = event.data
      if (data.type === 'ready') {
        sendPendingState()
        return
      }
      if (data.type === 'pairing-state' && data.paired === true) {
        finishPairing(sessionId, true)
        return
      }
      if (data.type === 'pairing-code-consumed' && data.profileId === profileId) {
        const paired = data.paired === true
        const error = paired ? undefined : typeof data.error === 'string'
          ? data.error.slice(0, 200) : '配对失败，请确认匹配码。'
        finishPairing(sessionId, paired, error, !paired)
      }
    }

    window.addEventListener('message', handlePairingMessage)
    return () => window.removeEventListener('message', handlePairingMessage)
  }, [finishPairing, pendingPairing, pendingProfile, sendPendingState])

  useEffect(() => {
    if (!pendingPairing) return
    const timer = window.setTimeout(() => {
      finishPairing(pendingPairing.sessionId, false, '目标网页未回应自动配对。请检查地址，或在该设备页面手动输入匹配码。')
    }, 20_000)
    return () => window.clearTimeout(timer)
  }, [finishPairing, pendingPairing])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== profilesStorageKey) return
      const next = readSavedProfiles()
      savedProfilesRef.current = next
      setSavedProfiles(next)
      if (pendingPairingRef.current && !next.some((profile) => profile.id === pendingPairingRef.current?.profileId)) cancelPairing()
      if (activeProfileId !== currentWebDeviceId && !next.some((profile) => profile.id === activeProfileId)) {
        setActiveProfileId(currentWebDeviceId)
        setFrameSessionId(createWebDeviceId())
        window.history.replaceState({ codeRemoteDevice: currentWebDeviceId }, '', newRootUrl(managerPath, currentWebDeviceId))
      }
    }
    const handlePopState = () => {
      const requestedId = new URLSearchParams(window.location.search).get('device') ?? currentWebDeviceId
      const targetId = profiles.some((profile) => profile.id === requestedId) ? requestedId : currentWebDeviceId
      cancelPairing()
      setActiveProfileId(targetId)
      setFrameSessionId(createWebDeviceId())
    }

    window.addEventListener('storage', handleStorage)
    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('popstate', handlePopState)
    }
  }, [activeProfileId, cancelPairing, managerPath, profiles])

  useEffect(() => {
    sendState()
  }, [sendState])

  useEffect(() => {
    sendPendingState()
  }, [sendPendingState])

  return (
    <main className="web-device-manager" aria-label="Code Remote">
      <iframe
        key={`${activeProfile.id}:${frameSessionId}`}
        ref={frame}
        className="web-device-manager__frame"
        src={frameUrl}
        title={`Code Remote — ${activeProfile.name}`}
        allow="camera; microphone; clipboard-read; clipboard-write; display-capture"
        referrerPolicy="no-referrer"
        onLoad={sendState}
      />
      {pendingPairing && pendingProfile && pairingFrameUrl ? <iframe
        key={pendingPairing.sessionId}
        ref={pairingFrame}
        className="web-device-manager__pairing-frame"
        src={pairingFrameUrl}
        title={`Code Remote — ${pendingProfile.name}`}
        aria-hidden="true"
        tabIndex={-1}
        referrerPolicy="no-referrer"
        onLoad={sendPendingState}
      /> : null}
    </main>
  )
}

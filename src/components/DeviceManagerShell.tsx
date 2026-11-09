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
  const [activeProfileId, setActiveProfileId] = useState(initial.activeProfileId)
  const [homePaired, setHomePaired] = useState(false)
  const [pendingPairing, setPendingPairing] = useState<{ profileId: string; code: string } | null>(null)
  const [frameSessionId, setFrameSessionId] = useState(createWebDeviceId)
  const frame = useRef<HTMLIFrameElement>(null)
  const managerOrigin = window.location.origin
  const managerPath = window.location.pathname || '/'

  const profiles = useMemo<WebDeviceProfile[]>(() => [{
    id: currentWebDeviceId,
    name: window.location.host,
    url: `${managerOrigin}${managerPath}`,
    paired: homePaired,
    isCurrent: true,
  }, ...savedProfiles], [homePaired, managerOrigin, managerPath, savedProfiles])
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]
  const frameUrl = useMemo(
    () => createWebDeviceFrameUrl(activeProfile, managerOrigin, managerPath, frameSessionId),
    [activeProfile, frameSessionId, managerOrigin, managerPath],
  )

  const updateSavedProfiles = useCallback((next: WebDeviceProfile[]) => {
    setSavedProfiles(next)
    writeSavedProfiles(next)
  }, [])

  const selectProfile = useCallback((profileId: string, addHistoryEntry = true) => {
    if (!profiles.some((profile) => profile.id === profileId) || profileId === activeProfileId) return
    if (pendingPairing && pendingPairing.profileId !== profileId) setPendingPairing(null)
    setActiveProfileId(profileId)
    setFrameSessionId(createWebDeviceId())
    const nextUrl = newRootUrl(managerPath, profileId)
    if (addHistoryEntry) window.history.pushState({ codeRemoteDevice: profileId }, '', nextUrl)
    else window.history.replaceState({ codeRemoteDevice: profileId }, '', nextUrl)
  }, [activeProfileId, managerPath, pendingPairing, profiles])

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
      pairingCode: pendingPairing?.profileId === activeProfileId ? pendingPairing.code : null,
    }, targetOrigin)
  }, [activeProfile.url, activeProfileId, frameSessionId, managerPath, pendingPairing, profiles])

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
        if (data.paired && pendingPairing?.profileId === activeProfile.id) setPendingPairing(null)
        if (activeProfile.isCurrent) setHomePaired(data.paired)
        else updateSavedProfiles(savedProfiles.map((profile) => profile.id === activeProfile.id ? { ...profile, paired: data.paired } : profile))
        return
      }
      if (data.type === 'pairing-code-consumed' && data.profileId === activeProfile.id && pendingPairing?.profileId === activeProfile.id) {
        if (data.paired === true) {
          if (activeProfile.isCurrent) setHomePaired(true)
          else updateSavedProfiles(savedProfiles.map((profile) => profile.id === activeProfile.id ? { ...profile, paired: true } : profile))
        }
        setPendingPairing(null)
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
          if (allProfiles.some((profile) => profile.url === url)) return
          const name = data.name.trim().slice(0, 48) || new URL(url).host
          const profile: WebDeviceProfile = { id: createWebDeviceId(), name, url, paired: false, isCurrent: false }
          updateSavedProfiles([...savedProfiles, profile])
          if (pairingCode) {
            setPendingPairing({ profileId: profile.id, code: pairingCode })
            setActiveProfileId(profile.id)
            setFrameSessionId(createWebDeviceId())
            window.history.pushState({ codeRemoteDevice: profile.id }, '', newRootUrl(managerPath, profile.id))
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
        updateSavedProfiles(savedProfiles.filter((profile) => profile.id !== data.id))
        if (pendingPairing?.profileId === data.id) setPendingPairing(null)
        if (data.id === activeProfileId) selectProfile(currentWebDeviceId)
        return
      }
      if (data.type === 'select' && typeof data.id === 'string') selectProfile(data.id)
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [activeProfile, activeProfileId, frameSessionId, managerOrigin, managerPath, pendingPairing, savedProfiles, selectProfile, sendState, updateSavedProfiles])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== profilesStorageKey) return
      const next = readSavedProfiles()
      setSavedProfiles(next)
      if (pendingPairing && !next.some((profile) => profile.id === pendingPairing.profileId)) setPendingPairing(null)
      if (activeProfileId !== currentWebDeviceId && !next.some((profile) => profile.id === activeProfileId)) {
        setActiveProfileId(currentWebDeviceId)
        setFrameSessionId(createWebDeviceId())
        window.history.replaceState({ codeRemoteDevice: currentWebDeviceId }, '', newRootUrl(managerPath, currentWebDeviceId))
      }
    }
    const handlePopState = () => {
      const requestedId = new URLSearchParams(window.location.search).get('device') ?? currentWebDeviceId
      const targetId = profiles.some((profile) => profile.id === requestedId) ? requestedId : currentWebDeviceId
      if (pendingPairing && pendingPairing.profileId !== targetId) setPendingPairing(null)
      setActiveProfileId(targetId)
      setFrameSessionId(createWebDeviceId())
    }

    window.addEventListener('storage', handleStorage)
    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('popstate', handlePopState)
    }
  }, [activeProfileId, managerPath, pendingPairing, profiles])

  useEffect(() => {
    sendState()
  }, [sendState])

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
    </main>
  )
}

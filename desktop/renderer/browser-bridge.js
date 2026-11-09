(() => {
  if (window.codeRemoteDesktop) return

  const storageKey = 'code-remote.browser-connections.v1'
  const activeDeviceKey = 'code-remote.active-desktop-device'
  const frame = document.getElementById('remote-frame')
  const listeners = new Set()

  function readConnections() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]')
      return Array.isArray(saved) ? saved.filter(isValidProfile) : []
    } catch {
      return []
    }
  }

  function isValidProfile(profile) {
    return profile && typeof profile.id === 'string' && typeof profile.name === 'string'
      && typeof profile.endpoint === 'string' && typeof profile.paired === 'boolean'
  }

  function writeConnections(profiles) {
    localStorage.setItem(storageKey, JSON.stringify(profiles))
    for (const listener of listeners) listener(profiles)
  }

  function normalizeEndpoint(value) {
    const raw = String(value ?? '').trim()
    if (!raw) throw new Error('请填写 Code Remote 网页地址。')
    const endpoint = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
    if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('请使用有效的 HTTP 或 HTTPS 地址，不要带账号、查询参数或片段。')
    }
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/'
    return endpoint.toString().replace(/\/$/, '')
  }

  function createProfileId() {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }

  function updateProfile(profileId, update) {
    const profiles = readConnections().map((profile) => profile.id === profileId
      ? { ...profile, ...update }
      : profile)
    writeConnections(profiles)
  }

  window.addEventListener('message', (event) => {
    const activeId = sessionStorage.getItem(activeDeviceKey)
    const profile = readConnections().find((entry) => entry.id === activeId)
    if (!profile || event.source !== frame.contentWindow) return
    try {
      if (event.origin !== new URL(profile.endpoint).origin) return
    } catch {
      return
    }
    if (event.data?.type !== 'code-remote:pairing-state' || typeof event.data.paired !== 'boolean') return
    updateProfile(profile.id, { paired: event.data.paired })
  })

  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey) return
    const profiles = readConnections()
    for (const listener of listeners) listener(profiles)
  })

  window.codeRemoteDesktop = {
    mode: 'browser',
    initialProfileId: new URLSearchParams(window.location.search).get('profile'),
    async listConnections() {
      return readConnections()
    },
    async pairConnection(input) {
      const endpoint = normalizeEndpoint(input.endpoint)
      const profiles = readConnections()
      const profile = {
        id: createProfileId(),
        name: String(input.name || '').trim().slice(0, 48) || new URL(endpoint).hostname,
        endpoint,
        paired: false,
      }
      profiles.push(profile)
      writeConnections(profiles)
      return { profiles, profileId: profile.id }
    },
    async renameConnection({ id, name }) {
      const nextName = String(name ?? '').trim().slice(0, 48)
      if (!nextName) throw new Error('设备名称不能为空。')
      const profiles = readConnections().map((profile) => profile.id === id ? { ...profile, name: nextName } : profile)
      writeConnections(profiles)
      return profiles
    },
    async removeConnection({ id }) {
      const profiles = readConnections().filter((profile) => profile.id !== id)
      writeConnections(profiles)
      return { profiles, remoteRevoked: false }
    },
    async activateConnection(profileId) {
      sessionStorage.setItem(activeDeviceKey, profileId || '')
      const profile = readConnections().find((entry) => entry.id === profileId)
      if (!profile) {
        frame.removeAttribute('src')
        frame.hidden = true
        return
      }
      frame.src = profile.endpoint
      frame.hidden = false
    },
    async openConnectionWindow(profileId) {
      const nextUrl = new URL('./', window.location.href)
      nextUrl.searchParams.set('profile', profileId)
      const opened = window.open(nextUrl.href, '_blank')
      if (!opened) throw new Error('无法打开新窗口。')
      opened.opener = null
    },
    async setOverlayOpen() {},
    onConnectionsChanged(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  }
})()

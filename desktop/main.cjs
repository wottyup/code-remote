const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  safeStorage,
  session,
  shell,
} = require('electron')

const SIDEBAR_WIDTH = 252
const STORE_VERSION = 1
const shellPreload = path.join(__dirname, 'preload-shell.cjs')
const remotePreload = path.join(__dirname, 'preload-remote.cjs')
const shellHtml = path.join(__dirname, 'renderer', 'index.html')
const shellWindows = new Map()
const remoteProfilesByWebContents = new Map()
let profiles = []

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const first = BrowserWindow.getAllWindows()[0]
    if (!first) return
    if (first.isMinimized()) first.restore()
    first.focus()
  })

  app.whenReady().then(async () => {
    await loadProfiles()
    registerIpcHandlers()
    createShellWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createShellWindow()
    })
  }).catch((error) => {
    console.error('Code Remote desktop failed to start:', error)
    app.quit()
  })

  app.on('window-all-closed', () => app.quit())
}

function profileStorePath() {
  return path.join(app.getPath('userData'), 'connections.json')
}

async function loadProfiles() {
  try {
    const saved = JSON.parse(await fs.readFile(profileStorePath(), 'utf8'))
    if (saved.version !== STORE_VERSION || !Array.isArray(saved.connections)) return
    profiles = saved.connections.flatMap((entry) => {
      if (!entry || typeof entry.id !== 'string' || typeof entry.name !== 'string'
        || typeof entry.endpoint !== 'string' || typeof entry.encryptedToken !== 'string') return []
      try {
        normalizeEndpoint(entry.endpoint)
      } catch {
        return []
      }
      return [{
        id: entry.id,
        name: entry.name.slice(0, 48),
        endpoint: entry.endpoint,
        encryptedToken: entry.encryptedToken,
      }]
    })
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read saved desktop connections:', error)
  }
}

async function saveProfiles() {
  const destination = profileStorePath()
  const temporary = `${destination}.${process.pid}.tmp`
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const payload = JSON.stringify({ version: STORE_VERSION, connections: profiles }, null, 2)
  await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, destination)
}

function normalizeEndpoint(rawValue) {
  const raw = String(rawValue ?? '').trim()
  if (!raw) throw new Error('请填写 Code Remote 网页地址。')
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let endpoint
  try {
    endpoint = new URL(withScheme)
  } catch {
    throw new Error('网页地址格式无效。')
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('请使用有效的 HTTP 或 HTTPS 地址，不要带账号、查询参数或片段。')
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/'
  const result = endpoint.toString()
  return result.endsWith('/') ? result.slice(0, -1) : result
}

function apiUrl(endpoint, route) {
  const url = new URL(endpoint)
  const basePath = url.pathname.replace(/\/+$/, '')
  url.pathname = `${basePath}${route}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function normalizePairingCode(rawValue) {
  const code = String(rawValue ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s\-_\u200b\ufeff]/g, '')
  if (code.length !== 8) throw new Error('请输入电脑终端显示的 8 位匹配码。')
  return code
}

function encryptToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统凭据加密不可用，无法安全保存配对信息。')
  }
  return safeStorage.encryptString(token).toString('base64')
}

function decryptToken(profile) {
  if (!profile?.encryptedToken || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(profile.encryptedToken, 'base64'))
  } catch {
    return null
  }
}

function publicProfiles() {
  return profiles.map(({ id, name, endpoint, encryptedToken }) => ({
    id,
    name,
    endpoint,
    paired: Boolean(encryptedToken),
  }))
}

function notifyProfilesChanged() {
  const nextProfiles = publicProfiles()
  for (const { window } of shellWindows.values()) {
    if (!window.isDestroyed()) window.webContents.send('connections:changed', nextProfiles)
  }
}

function getShellState(sender) {
  for (const state of shellWindows.values()) {
    if (state.window.webContents.id === sender.id) return state
  }
  return null
}

function setRemoteBounds(state) {
  const view = state.view
  if (!view || state.window.isDestroyed()) return
  const { width, height } = state.window.getContentBounds()
  if (state.overlayOpen || !state.activeProfileId) {
    view.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: 0, height: 0 })
    return
  }
  view.setBounds({
    x: SIDEBAR_WIDTH,
    y: 0,
    width: Math.max(0, width - SIDEBAR_WIDTH),
    height: Math.max(0, height),
  })
}

function disposeRemoteView(state) {
  const view = state.view
  if (!view) return
  remoteProfilesByWebContents.delete(view.webContents.id)
  try {
    state.window.contentView.removeChildView(view)
  } catch {
    // The owning window may already be closing.
  }
  if (!view.webContents.isDestroyed()) view.webContents.destroy()
  state.view = null
}

function openExternalUrl(value) {
  try {
    const url = new URL(value)
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) void shell.openExternal(url.href)
  } catch {
    // Ignore invalid and unsupported external navigation targets.
  }
}

function activateProfile(state, profileId) {
  const profile = profiles.find((entry) => entry.id === profileId)
  disposeRemoteView(state)
  state.activeProfileId = profile?.id ?? null
  if (!profile) {
    state.window.setTitle('Code Remote')
    setRemoteBounds(state)
    return
  }

  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:code-remote-${profile.id}`,
      preload: remotePreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--code-remote-profile-id=${profile.id}`],
    },
  })
  state.view = view
  remoteProfilesByWebContents.set(view.webContents.id, profile.id)
  state.window.contentView.addChildView(view)
  state.window.setTitle(`${profile.name} — Code Remote`)
  setRemoteBounds(state)

  const trustedOrigin = new URL(profile.endpoint).origin
  view.webContents.on('will-navigate', (event, target) => {
    let targetUrl
    try {
      targetUrl = new URL(target)
    } catch {
      event.preventDefault()
      return
    }
    if (targetUrl.origin === trustedOrigin) return
    event.preventDefault()
    openExternalUrl(targetUrl.href)
  })
  view.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })
  view.webContents.on('render-process-gone', (_event, details) => {
    console.warn(`Remote page renderer exited (${details.reason}).`)
  })
  void view.webContents.loadURL(profile.endpoint).catch((error) => {
    console.warn(`Could not load ${profile.endpoint}:`, error)
  })
}

function createShellWindow(initialProfileId = null) {
  const additionalArguments = initialProfileId
    ? [`--code-remote-initial-profile=${initialProfileId}`]
    : []
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 580,
    backgroundColor: '#101114',
    title: 'Code Remote',
    webPreferences: {
      preload: shellPreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments,
    },
  })
  const state = { window, view: null, activeProfileId: null, overlayOpen: false }
  shellWindows.set(window.id, state)
  window.on('resize', () => setRemoteBounds(state))
  window.on('closed', () => {
    disposeRemoteView(state)
    shellWindows.delete(window.id)
  })
  void window.loadFile(shellHtml, initialProfileId ? { query: { profile: initialProfileId } } : undefined)
  return window
}

function registerIpcHandlers() {
  ipcMain.handle('connections:list', () => publicProfiles())
  ipcMain.handle('connections:pair', async (_event, input) => {
    const endpoint = normalizeEndpoint(input?.endpoint)
    const code = normalizePairingCode(input?.code)
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统凭据加密不可用，无法安全保存配对信息。')
    }

    let response
    try {
      response = await fetch(apiUrl(endpoint, '/api/v1/pair'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? '连接超时，请确认 Code Remote 服务正在运行。'
        : '连接失败，请检查网页地址和网络。'
      throw new Error(message)
    }

    const result = await response.json().catch(() => ({}))
    if (!response.ok || typeof result.token !== 'string') {
      const detail = typeof result.detail === 'string' ? result.detail : '配对失败，请检查匹配码。'
      throw new Error(detail)
    }

    const id = randomUUID()
    const host = new URL(endpoint).hostname
    const name = String(input?.name ?? '').trim().slice(0, 48) || host
    const profile = { id, name, endpoint, encryptedToken: encryptToken(result.token) }
    profiles = [profile, ...profiles]
    await saveProfiles()
    notifyProfilesChanged()
    return { profiles: publicProfiles(), profileId: id }
  })

  ipcMain.handle('connections:rename', async (_event, input) => {
    const profile = profiles.find((entry) => entry.id === input?.id)
    if (!profile) throw new Error('找不到这台设备。')
    const name = String(input?.name ?? '').trim().slice(0, 48)
    if (!name) throw new Error('设备名称不能为空。')
    profile.name = name
    await saveProfiles()
    for (const state of shellWindows.values()) {
      if (state.activeProfileId === profile.id) state.window.setTitle(`${profile.name} — Code Remote`)
    }
    notifyProfilesChanged()
    return publicProfiles()
  })

  ipcMain.handle('connections:remove', async (_event, input) => {
    const profile = profiles.find((entry) => entry.id === input?.id)
    if (!profile) return { profiles: publicProfiles(), remoteRevoked: true }

    const token = decryptToken(profile)
    let remoteRevoked = !token
    if (token) {
      try {
        const response = await fetch(apiUrl(profile.endpoint, '/api/v1/unpair'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        })
        remoteRevoked = response.ok
      } catch {
        remoteRevoked = false
      }
    }

    profiles = profiles.filter((entry) => entry.id !== profile.id)
    await saveProfiles()
    for (const state of shellWindows.values()) {
      if (state.activeProfileId === profile.id) activateProfile(state, null)
    }
    await session.fromPartition(`persist:code-remote-${profile.id}`).clearStorageData().catch(() => undefined)
    notifyProfilesChanged()
    return { profiles: publicProfiles(), remoteRevoked }
  })

  ipcMain.handle('connections:activate', (event, profileId) => {
    const state = getShellState(event.sender)
    if (!state) throw new Error('桌面窗口已关闭。')
    activateProfile(state, typeof profileId === 'string' ? profileId : null)
    return true
  })

  ipcMain.handle('connections:open-window', (_event, profileId) => {
    if (!profiles.some((entry) => entry.id === profileId)) throw new Error('找不到这台设备。')
    createShellWindow(profileId)
    return true
  })

  ipcMain.handle('shell:overlay-open', (event, isOpen) => {
    const state = getShellState(event.sender)
    if (!state) return false
    state.overlayOpen = isOpen === true
    setRemoteBounds(state)
    return true
  })

  ipcMain.on('remote:read-token', (event) => {
    const profileId = remoteProfilesByWebContents.get(event.sender.id)
    const profile = profiles.find((entry) => entry.id === profileId)
    event.returnValue = decryptToken(profile) ?? ''
  })

  ipcMain.handle('remote:save-token', async (event, token) => {
    const profileId = remoteProfilesByWebContents.get(event.sender.id)
    const profile = profiles.find((entry) => entry.id === profileId)
    if (!profile || typeof token !== 'string' || token.length < 16) return false
    profile.encryptedToken = encryptToken(token)
    await saveProfiles()
    notifyProfilesChanged()
    return true
  })

  ipcMain.handle('remote:clear-token', async (event) => {
    const profileId = remoteProfilesByWebContents.get(event.sender.id)
    const profile = profiles.find((entry) => entry.id === profileId)
    if (!profile) return false
    profile.encryptedToken = ''
    await saveProfiles()
    notifyProfilesChanged()
    return true
  })
}

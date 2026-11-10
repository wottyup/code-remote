const bridge = window.codeRemoteDesktop
const deviceList = document.getElementById('device-list')
const deviceCount = document.getElementById('device-count')
const dialog = document.getElementById('device-dialog')
const form = document.getElementById('device-form')
const endpointInput = document.getElementById('device-endpoint')
const nameInput = document.getElementById('device-name')
const codeInput = document.getElementById('pairing-code')
const errorMessage = document.getElementById('form-error')
const submitButton = document.getElementById('pair-device')
const menu = document.getElementById('device-menu')
const toast = document.getElementById('toast')
const isBrowserMode = bridge?.mode === 'browser'
const stayOnManager = new URLSearchParams(window.location.search).get('view') === 'devices'
const languageStorageKey = 'code-remote.desktop-language'
const translations = {
  'zh-CN': {
    connections: '设备连接', desktopSubtitle: '多设备连接', addDevice: '添加设备', myDevices: '我的设备',
    localStorageNote: '连接信息加密保存在本机', emptyTitle: '连接一台 Code Remote 设备',
    emptyDescription: '添加电脑地址和匹配码，即可在这里继续查看它的聊天、文件与终端。',
    newConnection: '新连接', close: '关闭', deviceName: '设备名称', optional: '选填',
    namePlaceholder: '例如：家里的电脑', webAddress: 'Code Remote 网页地址',
    addressPlaceholder: 'http://192.168.1.10:4173', addressHelp: '填写运行这台设备上 Code Remote 的电脑地址。',
    pairingCode: '连接匹配码', codePlaceholder: '输入电脑终端显示的 8 位匹配码', cancel: '取消',
    pairAdd: '配对并添加', pairing: '正在配对…', privacyNote: '匹配码只用于配对。配对凭据会加密保存在本机，不会放进网页地址。',
    openWindow: '在新窗口打开', rename: '重命名', removeDevice: '移除设备', noDevices: '还没有设备连接',
    paired: '已配对', needsPairing: '需要配对', moreActions: '更多操作',
    renamePrompt: '输入新的设备名称', removeConfirm: '移除“{0}”？这会删除本机连接并尝试撤销该设备的配对。',
    remoteRevokedWarning: '本机连接已移除，但远端暂时无法撤销配对。', openWindowError: '无法打开新窗口。',
    renameError: '重命名失败。', removeError: '移除设备失败。', activateError: '打开设备失败。',
    pairError: '配对失败，请检查地址和匹配码。', shellUnavailable: '桌面连接管理不可用，请重新安装应用。',
    readListError: '读取设备列表失败。', toggleLanguage: '切换界面语言', incorrectCode: '配对码错误。',
    pausedPairing: '配对尝试次数已达上限，配对已暂停。',
    browserStorageNote: '连接信息保存在当前浏览器',
    browserEmptyDescription: '添加 Code Remote 网页地址后，可在侧栏切换设备，也能右键在新窗口打开。',
    browserPairNote: '添加后会打开目标网页，请在远端页面输入匹配码完成配对。',
    browserPrivacyNote: '此页仅保存设备名称和网页地址。配对码由远端网页接收，配对凭据由远端网页按原有方式保存。',
    browserPairAdd: '添加并打开',
    browserRemoveConfirm: '移除“{0}”？这只会删除此浏览器里的连接记录，远端网页中已保存的配对仍会保留。',
  },
  en: {
    connections: 'Device connections', desktopSubtitle: 'Multi-device access', addDevice: 'Add device', myDevices: 'My devices',
    localStorageNote: 'Connection details are encrypted on this PC', emptyTitle: 'Connect a Code Remote device',
    emptyDescription: 'Add a computer address and pairing code to view its chats, files, and terminal here.',
    newConnection: 'New connection', close: 'Close', deviceName: 'Device name', optional: 'Optional',
    namePlaceholder: 'For example: Home computer', webAddress: 'Code Remote web address',
    addressPlaceholder: 'http://192.168.1.10:4173', addressHelp: 'Enter the address of the computer running Code Remote.',
    pairingCode: 'Pairing code', codePlaceholder: 'Enter the 8-character code shown in the computer terminal', cancel: 'Cancel',
    pairAdd: 'Pair and add', pairing: 'Pairing…', privacyNote: 'The code is only used to pair. Credentials are encrypted on this PC and never put in the page URL.',
    openWindow: 'Open in new window', rename: 'Rename', removeDevice: 'Remove device', noDevices: 'No devices added yet',
    paired: 'Paired', needsPairing: 'Needs pairing', moreActions: 'More actions',
    renamePrompt: 'Enter a new device name', removeConfirm: 'Remove “{0}”? This deletes the local connection and attempts to revoke its pairing.',
    remoteRevokedWarning: 'The local connection was removed, but the remote pairing could not be revoked.', openWindowError: 'Could not open a new window.',
    renameError: 'Could not rename the device.', removeError: 'Could not remove the device.', activateError: 'Could not open the device.',
    pairError: 'Pairing failed. Check the address and pairing code.', shellUnavailable: 'Desktop connection manager is unavailable. Reinstall the app.',
    readListError: 'Could not read the device list.', toggleLanguage: 'Switch interface language', incorrectCode: 'Incorrect pairing code.',
    pausedPairing: 'Too many pairing attempts. Pairing is temporarily paused.',
    browserStorageNote: 'Connection details are saved in this browser',
    browserEmptyDescription: 'Add a Code Remote web address to switch devices in the sidebar or open one in a separate window.',
    browserPairNote: 'After adding, the remote page opens. Enter the pairing code there to finish pairing.',
    browserPrivacyNote: 'This page saves only the device name and web address. The remote page receives the pairing code and stores its credential using its existing flow.',
    browserPairAdd: 'Add and open',
    browserRemoveConfirm: 'Remove “{0}”? This only deletes the connection record in this browser. Pairing saved by the remote page remains.',
  },
}

let devices = []
let activeDeviceId = null
let contextDeviceId = null
let toastTimer = 0
let isPairing = false
const savedLanguage = localStorage.getItem(languageStorageKey)
let language = savedLanguage === 'en' || savedLanguage === 'zh-CN'
  ? savedLanguage
  : navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'

function t(key) {
  return translations[language][key] ?? translations['zh-CN'][key] ?? key
}

function format(key, ...values) {
  return t(key).replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? ''))
}

function localizeError(message) {
  if (language !== 'en') return message
  const errors = {
    '请填写 Code Remote 网页地址。': 'Enter the Code Remote web address.',
    '网页地址格式无效。': 'The web address is invalid.',
    '请输入电脑终端显示的 8 位匹配码。': 'Enter the 8-character code shown in the computer terminal.',
    '配对码错误': t('incorrectCode'),
    '配对码错误。': t('incorrectCode'),
    '配对尝试次数已达上限，配对已暂停': t('pausedPairing'),
  }
  return errors[message] ?? message
}

function errorText(error, fallback) {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return message ? localizeError(message) : t(fallback)
}

function applyLanguage() {
  document.documentElement.lang = language
  document.querySelectorAll('[data-l10n]').forEach((element) => {
    element.textContent = t(element.dataset.l10n)
  })
  document.querySelectorAll('[data-l10n-placeholder]').forEach((element) => {
    element.placeholder = t(element.dataset.l10nPlaceholder)
  })
  document.querySelectorAll('[data-l10n-aria]').forEach((element) => {
    element.setAttribute('aria-label', t(element.dataset.l10nAria))
  })
  document.querySelectorAll('[data-l10n-title]').forEach((element) => {
    element.title = t(element.dataset.l10nTitle)
  })
  document.getElementById('language-toggle').textContent = language === 'en' ? '中文' : 'EN'
  applyMode()
  renderDevices()
}

function applyMode() {
  document.getElementById('pairing-code-field').hidden = isBrowserMode
  document.getElementById('browser-pair-note').hidden = !isBrowserMode
  document.getElementById('storage-note').dataset.l10n = isBrowserMode ? 'browserStorageNote' : 'localStorageNote'
  document.querySelector('.empty-state p').dataset.l10n = isBrowserMode ? 'browserEmptyDescription' : 'emptyDescription'
  document.getElementById('privacy-note').dataset.l10n = isBrowserMode ? 'browserPrivacyNote' : 'privacyNote'
  submitButton.dataset.l10n = isBrowserMode ? 'browserPairAdd' : 'pairAdd'
  codeInput.required = !isBrowserMode
  document.querySelector('.sidebar-footer .status-mark').hidden = isBrowserMode
  document.getElementById('storage-note').textContent = t(isBrowserMode ? 'browserStorageNote' : 'localStorageNote')
  document.querySelector('.empty-state p').textContent = t(isBrowserMode ? 'browserEmptyDescription' : 'emptyDescription')
  document.getElementById('privacy-note').textContent = t(isBrowserMode ? 'browserPrivacyNote' : 'privacyNote')
  submitButton.textContent = isPairing ? t('pairing') : t(isBrowserMode ? 'browserPairAdd' : 'pairAdd')
}

function endpointLabel(endpoint) {
  try {
    const url = new URL(endpoint)
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch {
    return endpoint
  }
}

function renderDevices() {
  deviceList.replaceChildren()
  deviceCount.textContent = String(devices.length)
  document.getElementById('empty-state').hidden = devices.length > 0

  for (const device of devices) {
    const entry = document.createElement('div')
    entry.className = `connection-entry${device.id === activeDeviceId ? ' connection-entry--active' : ''}`
    entry.dataset.deviceId = device.id

    const select = document.createElement('button')
    select.className = 'connection-select'
    select.type = 'button'
    select.setAttribute('aria-current', device.id === activeDeviceId ? 'page' : 'false')
    select.title = `${device.name} · ${endpointLabel(device.endpoint)}`

    const glyph = document.createElement('span')
    glyph.className = 'connection-glyph'
    glyph.setAttribute('aria-hidden', 'true')
    glyph.innerHTML = '<svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="10" rx="2"/><path d="M7 17h6M10 14v3"/></svg>'

    const copy = document.createElement('span')
    copy.className = 'connection-copy'
    const title = document.createElement('strong')
    title.textContent = device.name
    const endpoint = document.createElement('small')
    endpoint.textContent = endpointLabel(device.endpoint)
    copy.append(title, endpoint)

    const indicator = document.createElement('span')
    indicator.className = `connection-indicator${device.paired ? ' connection-indicator--paired' : ''}`
    indicator.title = device.paired ? t('paired') : t('needsPairing')
    select.append(glyph, copy, indicator)
    select.addEventListener('click', () => void selectDevice(device.id))

    const more = document.createElement('button')
    more.className = 'connection-more'
    more.type = 'button'
    more.setAttribute('aria-label', `${device.name} · ${t('moreActions')}`)
    more.title = t('moreActions')
    more.innerHTML = '<svg viewBox="0 0 20 20"><circle cx="4" cy="10" r="1.35"/><circle cx="10" cy="10" r="1.35"/><circle cx="16" cy="10" r="1.35"/></svg>'
    more.addEventListener('click', (event) => {
      event.stopPropagation()
      showDeviceMenu(device.id, more.getBoundingClientRect().left, more.getBoundingClientRect().bottom + 4)
    })

    entry.append(select, more)
    deviceList.append(entry)
  }
  if (devices.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'device-list-empty'
    empty.textContent = t('noDevices')
    deviceList.append(empty)
  }
}

async function selectDevice(deviceId) {
  if (!devices.some((device) => device.id === deviceId)) return
  activeDeviceId = deviceId
  sessionStorage.setItem('code-remote.active-desktop-device', deviceId)
  renderDevices()
  try {
    await bridge.activateConnection(deviceId)
  } catch (error) {
    showToast(errorText(error, 'activateError'))
  }
}

async function showDeviceDialog() {
  hideDeviceMenu()
  form.reset()
  showFormError('')
  await bridge.setOverlayOpen(true)
  dialog.showModal()
  endpointInput.focus()
}

function closeDeviceDialog() {
  if (dialog.open) dialog.close()
}

function showFormError(message) {
  errorMessage.textContent = message
  errorMessage.hidden = !message
}

function setPairingState(pairing) {
  isPairing = pairing
  submitButton.disabled = pairing
  submitButton.textContent = pairing ? t('pairing') : t('pairAdd')
}

function showToast(message) {
  if (!message) return
  toast.textContent = message
  toast.hidden = false
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.hidden = true }, 4_500)
}

function showDeviceMenu(deviceId, x, y) {
  const menuWidth = 178
  const menuHeight = 150
  contextDeviceId = deviceId
  menu.hidden = false
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8))}px`
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8))}px`
  menu.querySelector('[data-action="open-window"]').focus()
}

function hideDeviceMenu() {
  menu.hidden = true
  contextDeviceId = null
}

function updateDevices(nextDevices) {
  devices = Array.isArray(nextDevices) ? nextDevices : []
  renderDevices()
  if (activeDeviceId && !devices.some((device) => device.id === activeDeviceId)) {
    activeDeviceId = null
  }
  if (!stayOnManager && !activeDeviceId && devices.length > 0 && !isPairing) {
    void selectDevice(devices[0].id)
  } else if (!stayOnManager && devices.length === 0) {
    void bridge.activateConnection(null)
  }
}

document.getElementById('add-device').addEventListener('click', () => void showDeviceDialog())
document.getElementById('empty-add-device').addEventListener('click', () => void showDeviceDialog())
document.getElementById('language-toggle').addEventListener('click', () => {
  language = language === 'en' ? 'zh-CN' : 'en'
  localStorage.setItem(languageStorageKey, language)
  applyLanguage()
})
document.getElementById('close-dialog').addEventListener('click', closeDeviceDialog)
document.getElementById('cancel-dialog').addEventListener('click', closeDeviceDialog)

dialog.addEventListener('close', () => {
  void bridge.setOverlayOpen(false)
  if (!isPairing) showFormError('')
})

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.normalize('NFKC').toUpperCase().replace(/[\s\-_\u200b\ufeff]/g, '').slice(0, 8)
  showFormError('')
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (isPairing) return
  showFormError('')
  setPairingState(true)
  try {
    const result = await bridge.pairConnection({
      name: nameInput.value,
      endpoint: endpointInput.value,
      code: isBrowserMode ? '' : codeInput.value,
    })
    devices = result.profiles
    activeDeviceId = result.profileId
    sessionStorage.setItem('code-remote.active-desktop-device', activeDeviceId)
    renderDevices()
    closeDeviceDialog()
    await bridge.activateConnection(activeDeviceId)
    form.reset()
  } catch (error) {
    showFormError(errorText(error, 'pairError'))
  } finally {
    setPairingState(false)
  }
})

deviceList.addEventListener('contextmenu', (event) => {
  const entry = event.target.closest('.connection-entry')
  if (!entry) return
  event.preventDefault()
  showDeviceMenu(entry.dataset.deviceId, event.clientX, event.clientY)
})

menu.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action
  const device = devices.find((entry) => entry.id === contextDeviceId)
  hideDeviceMenu()
  if (!device || !action) return

  if (action === 'open-window') {
    try {
      await bridge.openConnectionWindow(device.id)
    } catch (error) {
      showToast(errorText(error, 'openWindowError'))
    }
    return
  }

  if (action === 'rename') {
    const nextName = window.prompt(t('renamePrompt'), device.name)
    if (nextName === null || !nextName.trim()) return
    try {
      updateDevices(await bridge.renameConnection({ id: device.id, name: nextName }))
    } catch (error) {
      showToast(errorText(error, 'renameError'))
    }
    return
  }

  if (action === 'remove') {
    const confirmed = window.confirm(format(isBrowserMode ? 'browserRemoveConfirm' : 'removeConfirm', device.name))
    if (!confirmed) return
    try {
      const result = await bridge.removeConnection({ id: device.id })
      updateDevices(result.profiles)
      if (!result.remoteRevoked) showToast(t('remoteRevokedWarning'))
    } catch (error) {
      showToast(errorText(error, 'removeError'))
    }
  }
})

document.addEventListener('click', (event) => {
  if (!event.target.closest('#device-menu, .connection-more')) hideDeviceMenu()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideDeviceMenu()
})

async function initialize() {
  if (!bridge) {
    showToast(t('shellUnavailable'))
    return
  }
  const unsubscribe = bridge.onConnectionsChanged(updateDevices)
  window.addEventListener('beforeunload', unsubscribe, { once: true })
  devices = await bridge.listConnections()
  renderDevices()
  const initialProfileId = new URLSearchParams(window.location.search).get('profile')
    || bridge.initialProfileId
    || sessionStorage.getItem('code-remote.active-desktop-device')
  const selected = devices.find((device) => device.id === initialProfileId) ?? devices[0]
  if (selected && !stayOnManager) await selectDevice(selected.id)
}

void initialize().catch((error) => {
  showToast(errorText(error, 'readListError'))
})

applyLanguage()

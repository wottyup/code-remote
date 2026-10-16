interface ClipboardBridgeWindow extends Window {
  CodexRemoteAndroid?: {
    copyToClipboard?: (text: string) => boolean
    readClipboardText?: () => string | null
  }
}

export async function readTextFromClipboard(): Promise<string | null> {
  const androidBridge = (window as ClipboardBridgeWindow).CodexRemoteAndroid
  if (typeof androidBridge?.readClipboardText === 'function') {
    try {
      const value = androidBridge.readClipboardText()
      if (typeof value === 'string') return value
    } catch {
      // Keep the browser clipboard path available if the native bridge fails.
    }
  }

  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText()
  } catch {
    // LAN HTTP pages and denied clipboard permissions use the manual paste fallback.
  }
  return null
}

export async function copyTextToClipboard(value: string): Promise<boolean> {
  const androidBridge = (window as ClipboardBridgeWindow).CodexRemoteAndroid
  if (typeof androidBridge?.copyToClipboard === 'function') {
    try {
      if (androidBridge.copyToClipboard(value)) return true
    } catch {
      // Keep the browser clipboard path available if the native bridge fails.
    }
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the legacy clipboard path for LAN HTTP pages.
  }
  const helper = document.createElement('textarea')
  helper.value = value
  helper.style.position = 'fixed'
  helper.style.opacity = '0'
  document.body.appendChild(helper)
  helper.focus()
  helper.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    helper.remove()
  }
}

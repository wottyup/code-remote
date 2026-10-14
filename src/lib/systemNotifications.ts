export interface AndroidNotificationBridge {
  changeEndpoint?: () => void
  copyToClipboard?: (text: string) => boolean
  getComposerBottomInsetDp?: () => number
  getStatusBarInsetDp?: () => number
  requestNotificationPermission?: () => void
  hasNotificationPermission?: () => boolean
  isAppInBackground?: () => boolean
  showSystemNotification?: (title: string, body: string, threadId: string, eventKey: string) => boolean
  consumeNotificationThreadId?: () => string | null
  setStatusBarDarkIcons?: (darkIcons: boolean) => void
  showKeyboard?: () => void
}

declare global {
  interface Window {
    CodexRemoteAndroid?: AndroidNotificationBridge
    CodexRemoteOpenThread?: (threadId: string) => void
    __codexRemotePendingThreadId?: string
  }
}

const permissionResultEvent = 'codex-remote-notification-permission'

export function canRequestSystemNotifications() {
  const android = window.CodexRemoteAndroid
  if (android?.requestNotificationPermission && android.showSystemNotification) return true
  return window.isSecureContext && 'Notification' in window
}

export async function requestSystemNotificationPermission(): Promise<boolean> {
  const android = window.CodexRemoteAndroid
  if (android?.requestNotificationPermission && android.showSystemNotification) {
    try {
      if (android.hasNotificationPermission?.()) return true
    } catch {
      return false
    }

    return new Promise((resolve) => {
      let settled = false
      let timeout = 0
      const finish = (granted: boolean) => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        window.removeEventListener(permissionResultEvent, handlePermissionResult)
        resolve(granted)
      }
      const handlePermissionResult = (event: Event) => {
        const detail = (event as CustomEvent<{ granted?: boolean }>).detail
        finish(detail?.granted === true)
      }
      timeout = window.setTimeout(() => finish(false), 120_000)
      window.addEventListener(permissionResultEvent, handlePermissionResult)
      try {
        android.requestNotificationPermission?.()
      } catch {
        finish(false)
      }
    })
  }

  if (!window.isSecureContext || !('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  try {
    return await Notification.requestPermission() === 'granted'
  } catch {
    return false
  }
}

export function sendSystemNotification(title: string, body: string, threadId: string, eventKey: string) {
  const android = window.CodexRemoteAndroid
  if (android?.showSystemNotification) {
    try {
      if (android.isAppInBackground && !android.isAppInBackground()) return false
      return android.showSystemNotification(title, body, threadId, eventKey)
    } catch {
      return false
    }
  }

  if (document.visibilityState !== 'hidden') return false
  if (!window.isSecureContext || !('Notification' in window) || Notification.permission !== 'granted') return false
  try {
    const notification = new Notification(title, {
      body,
      icon: '/codex-remote.webp',
      tag: eventKey,
    })
    notification.onclick = () => {
      window.focus()
      notifyThreadOpenedBySystem(threadId)
      notification.close()
    }
    return true
  } catch {
    return false
  }
}

export function notifyThreadOpenedBySystem(threadId: string) {
  if (!threadId) return
  if (window.CodexRemoteOpenThread) window.CodexRemoteOpenThread(threadId)
  else window.__codexRemotePendingThreadId = threadId
}

import { StrictMode, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AppRecoveryBoundary } from './components/AppRecoveryBoundary'
import { syncMobileLayout } from './lib/mobileLayout'
import './styles.css'

syncMobileLayout()

function MobileViewportGuard({ children }: { children: ReactNode }) {
  useEffect(() => {
    let frame: number | undefined
    let settleTimer: number | undefined
    let keyboardTransitionTimer: number | undefined
    let nativeLayoutHeight: number | undefined
    let nativeLayoutWidth = Math.round(window.innerWidth)
    let checkingForUpdate = false
    let lastUpdateCheckAt = 0
    const editingInput = () => document.activeElement instanceof HTMLElement
      && document.activeElement.matches('textarea, input, [contenteditable="true"]')
    const writePixels = (name: string, value: number) => {
      const next = `${value}px`
      const style = document.documentElement.style
      if (style.getPropertyValue(name) !== next) style.setProperty(name, next)
    }
    const markKeyboardTransition = () => {
      document.documentElement.dataset.keyboardTransition = 'true'
      if (keyboardTransitionTimer !== undefined) window.clearTimeout(keyboardTransitionTimer)
      keyboardTransitionTimer = window.setTimeout(() => {
        keyboardTransitionTimer = undefined
        delete document.documentElement.dataset.keyboardTransition
      }, 320)
    }
    const assetSignature = (root: ParentNode, baseUrl: string) => Array.from(
      root.querySelectorAll('link[rel="stylesheet"][href], script[type="module"][src]'),
      (element) => {
        const reference = element.getAttribute(element.tagName === 'LINK' ? 'href' : 'src')
        return reference ? new URL(reference, baseUrl).href : ''
      },
    ).filter(Boolean).sort().join('\n')
    const loadedAssetSignature = assetSignature(document, window.location.href)
    const checkForUpdate = async () => {
      if (!('CodexRemoteAndroid' in window) || document.hidden || checkingForUpdate || editingInput()) return
      const now = Date.now()
      if (now - lastUpdateCheckAt < 1_000) return
      lastUpdateCheckAt = now
      checkingForUpdate = true
      try {
        const response = await fetch(window.location.href, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'text/html' },
        })
        if (!response.ok) return
        const html = new DOMParser().parseFromString(await response.text(), 'text/html')
        const latestAssetSignature = assetSignature(html, response.url || window.location.href)
        if (loadedAssetSignature && latestAssetSignature && latestAssetSignature !== loadedAssetSignature && !editingInput()) {
          window.location.reload()
        }
      } catch {
        // A failed update check must not interfere with the existing chat.
      } finally {
        checkingForUpdate = false
      }
    }
    const syncViewportHeight = () => {
      syncMobileLayout()
      const viewport = window.visualViewport
      const layoutHeight = Math.round(window.innerHeight)
      const visualHeight = Math.round(viewport?.height ?? layoutHeight)
      const nativeBridge = 'CodexRemoteAndroid' in window
      const nativeKeyboardInsetAvailable = typeof window.CodexRemoteAndroid?.getKeyboardInsetDp === 'function'
      const nativeKeyboardInset = nativeKeyboardInsetAvailable
        ? Math.max(0, window.CodexRemoteAndroid?.getKeyboardInsetDp?.() ?? 0)
        : 0
      const offsetTop = Math.max(0, viewport?.offsetTop ?? 0)
      const pannedVisualBottom = Math.round(visualHeight + offsetTop)
      const focusedComposer = document.activeElement instanceof HTMLElement
        && document.activeElement.matches('.message-composer textarea, .message-composer input:not([type="file"]), .message-composer [contenteditable="true"]')
      const composerKeyboardActive = focusedComposer
      const nativeViewportIsPanned = nativeBridge && offsetTop > 1
      const browserViewportIsPanned = !nativeBridge && focusedComposer && offsetTop > 1
      if (nativeKeyboardInsetAvailable) {
        const layoutWidth = Math.round(window.innerWidth)
        if (layoutWidth !== nativeLayoutWidth) {
          nativeLayoutWidth = layoutWidth
          nativeLayoutHeight = undefined
        }
        if (nativeKeyboardInset === 0 && !editingInput()) {
          nativeLayoutHeight = layoutHeight
        } else {
          // WebView can briefly report an innerHeight that already excludes the
          // IME while the native bridge reports the full IME inset. Retain the
          // pre-keyboard height so that inset is never subtracted twice.
          nativeLayoutHeight = Math.max(nativeLayoutHeight ?? 0, layoutHeight)
        }
      }
      const height = nativeKeyboardInsetAvailable
        ? composerKeyboardActive
          ? Math.max(160, nativeLayoutHeight ?? layoutHeight)
          : Math.max(160, (nativeLayoutHeight ?? layoutHeight) - nativeKeyboardInset)
        : nativeViewportIsPanned
          ? Math.max(layoutHeight, pannedVisualBottom)
          : browserViewportIsPanned
            ? pannedVisualBottom
            : visualHeight
      document.documentElement.dataset.nativeKeyboardInsets = String(nativeKeyboardInsetAvailable)
      document.documentElement.dataset.keyboardVisible = String(nativeKeyboardInset > 0)
      document.documentElement.dataset.composerKeyboard = String(nativeKeyboardInsetAvailable && composerKeyboardActive)
      writePixels('--native-keyboard-inset', nativeKeyboardInset)
      const composerBottomInset = window.CodexRemoteAndroid?.getComposerBottomInsetDp?.() ?? 0
      if (Number.isFinite(composerBottomInset) && composerBottomInset >= 0) {
        writePixels('--native-composer-bottom-inset', composerBottomInset)
      }
      const statusBarInset = window.CodexRemoteAndroid?.getStatusBarInsetDp?.() ?? 0
      if (Number.isFinite(statusBarInset) && statusBarInset >= 0) {
        writePixels('--native-status-bar-inset', statusBarInset)
      }
      // Do not replace a working viewport value with the occasional zero-sized
      // value that some mobile browsers report while returning from background.
      if (height < 160) return
      writePixels('--app-viewport-height', height)
    }
    const scheduleViewportSync = () => {
      if (frame !== undefined) return
      if (settleTimer !== undefined) window.clearTimeout(settleTimer)
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        syncViewportHeight()
        settleTimer = window.setTimeout(() => {
          settleTimer = undefined
          syncViewportHeight()
        }, 80)
      })
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if ((window.CodexRemoteAndroid?.getKeyboardInsetDp?.() ?? 0) <= 0) nativeLayoutHeight = undefined
      scheduleViewportSync()
      void checkForUpdate()
    }
    const handleAppResume = () => {
      if ((window.CodexRemoteAndroid?.getKeyboardInsetDp?.() ?? 0) <= 0) nativeLayoutHeight = undefined
      scheduleViewportSync()
      void checkForUpdate()
    }
    const handlePageShow = () => {
      if ((window.CodexRemoteAndroid?.getKeyboardInsetDp?.() ?? 0) <= 0) nativeLayoutHeight = undefined
      scheduleViewportSync()
    }
    const handleOrientationChange = () => {
      nativeLayoutHeight = undefined
      nativeLayoutWidth = Math.round(window.innerWidth)
      scheduleViewportSync()
    }
    const handleFocusChange = () => scheduleViewportSync()
    const handleKeyboardInset = () => {
      markKeyboardTransition()
      scheduleViewportSync()
    }
    const viewport = window.visualViewport
    scheduleViewportSync()
    window.addEventListener('resize', scheduleViewportSync)
    window.addEventListener('orientationchange', handleOrientationChange)
    window.screen.orientation?.addEventListener('change', handleOrientationChange)
    window.addEventListener('pageshow', handlePageShow)
    window.addEventListener('codex-remote:resume', handleAppResume)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    document.addEventListener('focusin', handleFocusChange)
    document.addEventListener('focusout', handleFocusChange)
    window.addEventListener('codex-remote:keyboard-inset', handleKeyboardInset)
    viewport?.addEventListener('resize', scheduleViewportSync)
    viewport?.addEventListener('scroll', scheduleViewportSync)
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      if (settleTimer !== undefined) window.clearTimeout(settleTimer)
      if (keyboardTransitionTimer !== undefined) window.clearTimeout(keyboardTransitionTimer)
      delete document.documentElement.dataset.keyboardTransition
      window.removeEventListener('resize', scheduleViewportSync)
      window.removeEventListener('orientationchange', handleOrientationChange)
      window.screen.orientation?.removeEventListener('change', handleOrientationChange)
      window.removeEventListener('pageshow', handlePageShow)
      window.removeEventListener('codex-remote:resume', handleAppResume)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      document.removeEventListener('focusin', handleFocusChange)
      document.removeEventListener('focusout', handleFocusChange)
      window.removeEventListener('codex-remote:keyboard-inset', handleKeyboardInset)
      viewport?.removeEventListener('resize', scheduleViewportSync)
      viewport?.removeEventListener('scroll', scheduleViewportSync)
    }
  }, [])
  return <>{children}</>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MobileViewportGuard>
      <AppRecoveryBoundary>
        <App />
      </AppRecoveryBoundary>
    </MobileViewportGuard>
  </StrictMode>,
)

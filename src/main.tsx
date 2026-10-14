import { StrictMode, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AppRecoveryBoundary } from './components/AppRecoveryBoundary'
import './styles.css'

function MobileViewportGuard({ children }: { children: ReactNode }) {
  useEffect(() => {
    let frame: number | undefined
    let settleTimer: number | undefined
    const syncViewportHeight = () => {
      const viewport = window.visualViewport
      const layoutHeight = Math.round(window.innerHeight)
      const visualHeight = Math.round(viewport?.height ?? layoutHeight)
      // Android WebView can keep the layout viewport at its full height while
      // panning the visual viewport above the keyboard. Using only
      // visualViewport.height in that state shortens the app twice and leaves
      // a blank area between the composer and the keyboard. Keep the layout
      // bottom when the native bridge is present; regular mobile browsers
      // still follow their resized visual viewport.
      const nativeBridge = 'CodexRemoteAndroid' in window
      const offsetTop = Math.max(0, viewport?.offsetTop ?? 0)
      const pannedVisualBottom = Math.round(visualHeight + offsetTop)
      const nativeViewportIsPanned = nativeBridge && offsetTop > 1
      const height = nativeViewportIsPanned ? Math.max(layoutHeight, pannedVisualBottom) : visualHeight
      const composerBottomInset = window.CodexRemoteAndroid?.getComposerBottomInsetDp?.() ?? 0
      if (Number.isFinite(composerBottomInset) && composerBottomInset >= 0) {
        document.documentElement.style.setProperty('--native-composer-bottom-inset', `${composerBottomInset}px`)
      }
      const statusBarInset = window.CodexRemoteAndroid?.getStatusBarInsetDp?.() ?? 0
      if (Number.isFinite(statusBarInset) && statusBarInset >= 0) {
        document.documentElement.style.setProperty('--native-status-bar-inset', `${statusBarInset}px`)
      }
      // Do not replace a working viewport value with the occasional zero-sized
      // value that some mobile browsers report while returning from background.
      if (height < 160) return
      document.documentElement.style.setProperty('--app-viewport-height', `${height}px`)
    }
    const scheduleViewportSync = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
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
      if (document.visibilityState === 'visible') scheduleViewportSync()
    }
    const viewport = window.visualViewport
    scheduleViewportSync()
    window.addEventListener('resize', scheduleViewportSync)
    window.addEventListener('orientationchange', scheduleViewportSync)
    window.addEventListener('pageshow', scheduleViewportSync)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    viewport?.addEventListener('resize', scheduleViewportSync)
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      if (settleTimer !== undefined) window.clearTimeout(settleTimer)
      window.removeEventListener('resize', scheduleViewportSync)
      window.removeEventListener('orientationchange', scheduleViewportSync)
      window.removeEventListener('pageshow', scheduleViewportSync)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      viewport?.removeEventListener('resize', scheduleViewportSync)
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

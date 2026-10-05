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
      const height = Math.round(window.visualViewport?.height ?? window.innerHeight)
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

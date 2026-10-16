export const mobileLayoutMediaQuery = '(max-width: 700px), (pointer: coarse)'
export const mobileLayoutChangedEvent = 'codex-remote:layout-change'

export function isCompactLandscape() {
  if (typeof window === 'undefined' || !window.matchMedia('(pointer: coarse)').matches) return false
  const orientation = window.screen.orientation?.type
  if (orientation) return orientation.startsWith('landscape')
  const legacyAngle = (window as Window & { orientation?: number }).orientation
  if (typeof legacyAngle === 'number') return Math.abs(legacyAngle) % 180 === 90
  // Screen geometry is unaffected by the software keyboard.
  return window.screen.width > window.screen.height
}

export function isMobileLayout() {
  return typeof window !== 'undefined'
    && (window.matchMedia('(max-width: 700px)').matches || isCompactLandscape())
}

export function syncMobileLayout() {
  const landscape = String(isCompactLandscape())
  if (document.documentElement.dataset.touchLandscape === landscape) return
  document.documentElement.dataset.touchLandscape = landscape
  window.dispatchEvent(new Event(mobileLayoutChangedEvent))
}

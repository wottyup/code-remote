export type MobilePanel = 'sidebar' | 'workspace'

export interface MobilePanelGestureStart {
  panel: MobilePanel
  x: number
  y: number
  panelWasOpen: boolean
}

export type MobilePanelGestureAction =
  | 'open-sidebar'
  | 'close-sidebar'
  | 'open-workspace'
  | 'close-workspace'

export function beginMobilePanelGesture(
  x: number,
  y: number,
  viewportWidth: number,
  sidebarOpen: boolean,
  workspaceOpen: boolean,
): MobilePanelGestureStart | null {
  const panel: MobilePanel = x < viewportWidth / 2 ? 'sidebar' : 'workspace'
  const otherPanelOpen = panel === 'sidebar' ? workspaceOpen : sidebarOpen
  if (otherPanelOpen) return null

  return {
    panel,
    x,
    y,
    panelWasOpen: panel === 'sidebar' ? sidebarOpen : workspaceOpen,
  }
}

export function resolveMobilePanelGesture(
  start: MobilePanelGestureStart,
  endX: number,
  endY: number,
  threshold = 64,
): MobilePanelGestureAction | null {
  const deltaX = endX - start.x
  const deltaY = endY - start.y
  if (Math.abs(deltaX) < threshold || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return null

  if (start.panel === 'sidebar') {
    if (start.panelWasOpen) return deltaX < 0 ? 'close-sidebar' : null
    return deltaX > 0 ? 'open-sidebar' : null
  }

  if (start.panelWasOpen) return deltaX > 0 ? 'close-workspace' : null
  return deltaX < 0 ? 'open-workspace' : null
}

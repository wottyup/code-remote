export type MobilePanel = 'sidebar' | 'workspace' | 'global'

export interface MobilePanelGestureStart {
  panel: MobilePanel
  x: number
  y: number
  panelWasOpen: boolean
  returnDirection?: 'left' | 'right'
}

export type MobilePanelGestureAction =
  | 'open-sidebar'
  | 'close-sidebar'
  | 'open-workspace'
  | 'close-workspace'
  | 'close-global'

const mobilePanelGestureThreshold = 44
const mobileBackEdgeSize = 36
const mobileSidebarClosedOffsetRatio = 1.05

export function mobileSidebarDragOffset(panelOpen: boolean, panelWidth: number, deltaX: number) {
  const closedOffset = -Math.max(0, panelWidth) * mobileSidebarClosedOffsetRatio
  const startOffset = panelOpen ? 0 : closedOffset
  return Math.max(closedOffset, Math.min(0, startOffset + deltaX))
}

export function shouldOpenMobileSidebarAfterDrag(offset: number, panelWidth: number, action: MobilePanelGestureAction | null) {
  if (action === 'open-sidebar') return true
  if (action === 'close-sidebar') return false
  return offset > -(Math.max(0, panelWidth) * mobileSidebarClosedOffsetRatio) / 2
}

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

export function beginMobileGlobalBackGesture(
  x: number,
  y: number,
  viewportWidth: number,
  globalOpen: boolean,
  edgeSize = mobileBackEdgeSize,
): MobilePanelGestureStart | null {
  if (!globalOpen || viewportWidth <= 0) return null
  const edge = Math.max(0, edgeSize)
  if (x > edge && x < viewportWidth - edge) return null
  return {
    panel: 'global',
    x,
    y,
    panelWasOpen: true,
    returnDirection: x <= edge ? 'right' : 'left',
  }
}

export function resolveMobilePanelGesture(
  start: MobilePanelGestureStart,
  endX: number,
  endY: number,
  threshold = mobilePanelGestureThreshold,
): MobilePanelGestureAction | null {
  const deltaX = endX - start.x
  const deltaY = endY - start.y
  if (Math.abs(deltaX) < threshold || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return null

  if (start.panel === 'sidebar') {
    if (start.panelWasOpen) return deltaX < 0 ? 'close-sidebar' : null
    return deltaX > 0 ? 'open-sidebar' : null
  }

  if (start.panel === 'global') {
    return start.returnDirection === 'right'
      ? (deltaX > 0 ? 'close-global' : null)
      : (deltaX < 0 ? 'close-global' : null)
  }

  if (start.panelWasOpen) return deltaX > 0 ? 'close-workspace' : null
  return deltaX < 0 ? 'open-workspace' : null
}

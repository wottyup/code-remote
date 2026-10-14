interface MenuAnchor {
  left: number
  top: number
  bottom: number
}

interface MenuViewport {
  left: number
  top: number
  width: number
  height: number
}

export function composerMenuPosition(anchor: MenuAnchor, menu: { width: number; height: number }, viewport: MenuViewport) {
  const margin = 8
  const gap = 8
  const maxWidth = Math.max(0, viewport.width - margin * 2)
  const width = Math.min(menu.width, maxWidth)
  const minTop = viewport.top + margin
  const maxBottom = viewport.top + viewport.height - margin
  const above = Math.max(0, Math.min(viewport.height - margin * 2, anchor.top - gap - minTop))
  const below = Math.max(0, Math.min(viewport.height - margin * 2, maxBottom - anchor.bottom - gap))
  const placeAbove = above >= Math.min(menu.height, 180) || above >= below
  const maxHeight = Math.max(0, Math.min(340, placeAbove ? above : below))
  const height = Math.min(menu.height, maxHeight)
  return {
    left: Math.max(viewport.left + margin, Math.min(anchor.left, viewport.left + viewport.width - margin - width)),
    top: Math.max(minTop, Math.min(placeAbove ? anchor.top - gap - height : anchor.bottom + gap, maxBottom - height)),
    maxHeight,
    maxWidth,
  }
}

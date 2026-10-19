export interface TerminalTouchSelection {
  point?: { x: number; y: number }
  text: string
  range: {
    start: { x: number; y: number }
    end: { x: number; y: number }
  }
}

export interface TerminalTouchSelectionRect {
  left: number
  top: number
  width: number
  height: number
}

export function terminalTouchSelectionRects(
  selection: TerminalTouchSelection,
  viewport: { cols: number; rows: number; viewportY: number; width: number; height: number },
): TerminalTouchSelectionRect[] {
  const { cols, rows, viewportY, width, height } = viewport
  if (cols <= 0 || rows <= 0 || width <= 0 || height <= 0) return []

  const firstRow = Math.max(selection.range.start.y, viewportY)
  const lastRow = Math.min(selection.range.end.y, viewportY + rows - 1)
  const cellWidth = width / cols
  const cellHeight = height / rows
  const rectangles: TerminalTouchSelectionRect[] = []
  for (let row = firstRow; row <= lastRow; row += 1) {
    const start = Math.max(0, Math.min(cols, row === selection.range.start.y ? selection.range.start.x : 0))
    const end = Math.max(0, Math.min(cols, row === selection.range.end.y ? selection.range.end.x : cols))
    if (end <= start) continue
    rectangles.push({
      left: start * cellWidth,
      top: (row - viewportY) * cellHeight,
      width: (end - start) * cellWidth,
      height: cellHeight,
    })
  }
  return rectangles
}

interface TerminalSelectionTarget {
  cols: number
  select: (column: number, row: number, length: number) => void
}

export function restoreTerminalTouchSelection(
  terminal: TerminalSelectionTarget,
  selection: TerminalTouchSelection | null,
) {
  if (!selection) return ''

  const { start, end } = selection.range
  const length = (end.y - start.y) * terminal.cols + end.x - start.x
  if (length > 0) terminal.select(start.x, start.y, length)

  return selection.text
}

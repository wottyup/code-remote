export interface TerminalTouchSelection {
  point: { x: number; y: number }
  text: string
  range: {
    start: { x: number; y: number }
    end: { x: number; y: number }
  }
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

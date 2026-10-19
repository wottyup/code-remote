import type { Terminal } from '@xterm/xterm'

type CellPosition = { x: number; y: number }

interface MouseSelectionOptions {
  selectWordAt: (clientX: number, clientY: number) => boolean
  onSelectionEnd: () => void
}

// tmux requests mouse reporting, which disables xterm's ordinary selection.
// Keep unmodified primary-button selection in the browser so release cannot
// trigger tmux's copy-and-cancel binding. Wheel and modified clicks still pass through.
export function installTerminalMouseSelection(
  terminal: Terminal,
  container: HTMLElement,
  screen: HTMLElement,
  { selectWordAt, onSelectionEnd }: MouseSelectionOptions,
) {
  const document = container.ownerDocument
  let drag: { start: CellPosition; end: CellPosition; line: boolean } | null = null

  const positionAt = (event: MouseEvent): CellPosition | null => {
    const bounds = screen.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0 || terminal.cols <= 0 || terminal.rows <= 0) return null
    return {
      x: Math.max(0, Math.min(terminal.cols, Math.round((event.clientX - bounds.left) / (bounds.width / terminal.cols)))),
      y: terminal.buffer.active.viewportY + Math.max(0, Math.min(terminal.rows - 1, Math.floor((event.clientY - bounds.top) / (bounds.height / terminal.rows)))),
    }
  }

  const selectTo = (position: CellPosition) => {
    if (!drag) return
    if (drag.line) {
      terminal.selectLines(Math.min(drag.start.y, position.y), Math.max(drag.end.y, position.y))
      return
    }
    const offset = (point: CellPosition) => point.y * terminal.cols + point.x
    let start = offset(position) < offset(drag.start) ? position : drag.start
    let end = offset(position) > offset(drag.end) ? position : drag.end
    if (offset(start) === offset(end)) {
      terminal.clearSelection()
      return
    }
    // A boundary inside a wide character must include its full cell width.
    if (terminal.buffer.active.getLine(start.y)?.getCell(start.x)?.getWidth() === 0) start = { x: start.x - 1, y: start.y }
    if (terminal.buffer.active.getLine(end.y)?.getCell(end.x)?.getWidth() === 0) end = { x: end.x + 1, y: end.y }
    const length = offset(end) - offset(start)
    terminal.select(start.x, start.y, length)
  }

  const stopDrag = () => {
    drag = null
    document.removeEventListener('mousemove', handleMouseMove, true)
    document.removeEventListener('mouseup', handleMouseUp, true)
    document.defaultView?.removeEventListener('blur', handleBlur)
  }
  const handleBlur = () => {
    if (!drag) return
    stopDrag()
    onSelectionEnd()
  }
  const handleMouseMove = (event: MouseEvent) => {
    if (!drag) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const position = positionAt(event)
    if (position) selectTo(position)
    if (!(event.buttons & 1)) handleBlur()
  }
  const handleMouseUp = (event: MouseEvent) => {
    if (event.button !== 0 || !drag) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const position = positionAt(event)
    if (position) selectTo(position)
    stopDrag()
    onSelectionEnd()
  }
  const handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || terminal.modes.mouseTrackingMode === 'none') return
    const bounds = screen.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom) return
    const position = positionAt(event)
    if (!position) return
    event.preventDefault()
    event.stopImmediatePropagation()
    stopDrag()
    terminal.focus()
    terminal.clearSelection()
    if (event.detail >= 3) terminal.selectLines(position.y, position.y)
    else if (event.detail === 2) selectWordAt(event.clientX, event.clientY)
    const range = terminal.getSelectionPosition()
    drag = { start: range?.start ?? position, end: range?.end ?? position, line: event.detail >= 3 }
    document.addEventListener('mousemove', handleMouseMove, true)
    document.addEventListener('mouseup', handleMouseUp, true)
    document.defaultView?.addEventListener('blur', handleBlur)
  }

  container.addEventListener('mousedown', handleMouseDown, true)
  return () => {
    stopDrag()
    container.removeEventListener('mousedown', handleMouseDown, true)
  }
}

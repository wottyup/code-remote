import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Clipboard, Copy, LoaderCircle, Terminal as TerminalIcon } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
import { ChatOverlayPanel } from './ChatOverlayPanel'
import '@xterm/xterm/css/xterm.css'

const compactTerminalQuery = '(max-width: 700px), (orientation: landscape) and (pointer: coarse)'
const terminalDirectionKeys = [
  { label: '向左', data: '\x1b[D', icon: ArrowLeft },
  { label: '向上', data: '\x1b[A', icon: ArrowUp },
  { label: '向下', data: '\x1b[B', icon: ArrowDown },
  { label: '向右', data: '\x1b[C', icon: ArrowRight },
]

interface TerminalDialogProps {
  token: string
  threadId?: string
  cwd?: string
  onClose: () => void
  onInsertText: (value: string) => void
}

type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'exited'

interface ContextMenuState {
  x: number
  y: number
  text: string
}

function selectTerminalTextAt(terminal: Terminal, xtermScreen: HTMLElement, clientX: number, clientY: number) {
  const bounds = xtermScreen.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0 || terminal.cols <= 0 || terminal.rows <= 0) return false

  const column = Math.min(terminal.cols - 1, Math.max(0, Math.floor(((clientX - bounds.left) / bounds.width) * terminal.cols)))
  const visibleRow = Math.min(terminal.rows - 1, Math.max(0, Math.floor(((clientY - bounds.top) / bounds.height) * terminal.rows)))
  const row = terminal.buffer.active.viewportY + visibleRow
  const line = terminal.buffer.active.getLine(row)
  if (!line) return false

  let startColumn = column
  let cell = line.getCell(startColumn)
  if (cell?.getWidth() === 0 && startColumn > 0) {
    startColumn -= 1
    cell = line.getCell(startColumn)
  }
  const characters = cell?.getChars() ?? ''
  if (!characters) return false

  if (/^\s+$/u.test(characters)) {
    terminal.selectLines(row, row)
    return terminal.hasSelection()
  }

  const separators = terminal.options.wordSeparator ?? ''
  const isSeparator = (value: string) => !value || Array.from(value).some((character) => separators.includes(character))
  if (isSeparator(characters)) {
    terminal.select(startColumn, row, Math.max(1, cell?.getWidth() ?? 1))
    return terminal.hasSelection()
  }

  let endColumn = startColumn + Math.max(1, cell?.getWidth() ?? 1)
  while (startColumn > 0) {
    let previousColumn = startColumn - 1
    let previousCell = line.getCell(previousColumn)
    if (previousCell?.getWidth() === 0 && previousColumn > 0) {
      previousColumn -= 1
      previousCell = line.getCell(previousColumn)
    }
    const previousCharacters = previousCell?.getChars() ?? ''
    if (isSeparator(previousCharacters)) break
    startColumn = previousColumn
  }
  while (endColumn < terminal.cols) {
    const nextCell = line.getCell(endColumn)
    const nextCharacters = nextCell?.getChars() ?? ''
    if (isSeparator(nextCharacters)) break
    endColumn += Math.max(1, nextCell?.getWidth() ?? 1)
  }
  terminal.select(startColumn, row, Math.max(1, endColumn - startColumn))
  return terminal.hasSelection()
}

export function TerminalDialog({ token, threadId, cwd, onClose, onInsertText }: TerminalDialogProps) {
  const screen = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const [workingDirectory, setWorkingDirectory] = useState(cwd ?? '')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const sendInput = useRef<(data: string) => void>(() => {})
  const directionRepeatDelay = useRef<number | undefined>(undefined)
  const directionRepeatInterval = useRef<number | undefined>(undefined)
  const directionPointer = useRef<number | null>(null)

  const stopDirectionRepeat = () => {
    if (directionRepeatDelay.current !== undefined) window.clearTimeout(directionRepeatDelay.current)
    if (directionRepeatInterval.current !== undefined) window.clearInterval(directionRepeatInterval.current)
    directionRepeatDelay.current = undefined
    directionRepeatInterval.current = undefined
    directionPointer.current = null
  }

  const beginDirectionRepeat = (event: ReactPointerEvent<HTMLButtonElement>, data: string) => {
    event.preventDefault()
    event.stopPropagation()
    stopDirectionRepeat()
    const pointerId = event.pointerId
    directionPointer.current = pointerId
    event.currentTarget.setPointerCapture(pointerId)
    sendInput.current(data)
    directionRepeatDelay.current = window.setTimeout(() => {
      directionRepeatDelay.current = undefined
      if (directionPointer.current !== pointerId) return
      directionRepeatInterval.current = window.setInterval(() => sendInput.current(data), 80)
    }, 360)
  }

  const endDirectionRepeat = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (directionPointer.current !== event.pointerId) return
    stopDirectionRepeat()
  }

  useEffect(() => {
    const container = screen.current
    if (!container) return

    const compactTerminal = window.matchMedia(compactTerminalQuery)

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: compactTerminal.matches ? 12 : 13,
      lineHeight: 1.2,
      scrollback: 5_000,
      theme: {
        background: '#111317',
        foreground: '#e3e6ed',
        cursor: '#b7c4ff',
        selectionBackground: 'rgba(130, 151, 225, .42)',
        black: '#1c1f26',
        red: '#e06c75',
        green: '#98c379',
        yellow: '#e5c07b',
        blue: '#61afef',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#abb2bf',
        brightBlack: '#5c6370',
        brightRed: '#e06c75',
        brightGreen: '#98c379',
        brightYellow: '#e5c07b',
        brightBlue: '#61afef',
        brightMagenta: '#c678dd',
        brightCyan: '#56b6c2',
        brightWhite: '#ffffff',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)

    const socketUrl = new URL('/api/v1/codex/terminal', window.location.origin)
    socketUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(socketUrl)
    socket.binaryType = 'arraybuffer'
    let ready = false
    let exited = false
    let disposed = false
    let fitFrame = 0
    const pendingInput: string[] = []
    const send = (message: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    }

    const fitAndResize = () => {
      if (disposed || container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fitAddon.fit()
        if (ready) send({ type: 'resize', columns: terminal.cols, rows: terminal.rows })
      } catch {
        // The dialog can briefly have no measurable size while the pane is switching.
      }
    }
    const updateFontSize = () => {
      const fontSize = compactTerminal.matches ? 12 : 13
      if (terminal.options.fontSize === fontSize) return
      terminal.options.fontSize = fontSize
      window.cancelAnimationFrame(fitFrame)
      fitFrame = window.requestAnimationFrame(fitAndResize)
    }
    compactTerminal.addEventListener('change', updateFontSize)
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
        window.cancelAnimationFrame(fitFrame)
        fitFrame = window.requestAnimationFrame(fitAndResize)
      })
    resizeObserver?.observe(container)

    const dataSubscription = terminal.onData((data) => {
      if (!ready) {
        pendingInput.push(data)
        return
      }
      send({ type: 'input', data })
    })
    sendInput.current = (data) => {
      if (!ready) {
        pendingInput.push(data)
        return
      }
      send({ type: 'input', data })
    }
    const showContextMenu = (clientX: number, clientY: number) => {
      const selectedText = terminal.getSelection()
      if (!selectedText) return false
      const menuHost = container.closest<HTMLElement>('.chat-overlay-panel') ?? container
      const bounds = menuHost.getBoundingClientRect()
      setContextMenu({
        x: Math.min(Math.max(8, clientX - bounds.left), Math.max(8, bounds.width - 200)),
        y: Math.min(Math.max(8, clientY - bounds.top), Math.max(8, bounds.height - 92)),
        text: selectedText,
      })
      return true
    }
    const handleContextMenu = (event: MouseEvent) => {
      if (!terminal.hasSelection()) return
      event.preventDefault()
      showContextMenu(event.clientX, event.clientY)
    }
    container.addEventListener('contextmenu', handleContextMenu)

    let longPressTimer = 0
    let touchStart: { x: number; y: number } | null = null
    let longPressPoint: { x: number; y: number } | null = null
    const clearLongPress = () => {
      if (longPressTimer) window.clearTimeout(longPressTimer)
      longPressTimer = 0
      touchStart = null
    }
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        clearLongPress()
        longPressPoint = null
        return
      }
      clearLongPress()
      setContextMenu(null)
      longPressPoint = null
      const touch = event.touches[0]
      const point = { x: touch.clientX, y: touch.clientY }
      touchStart = point
      longPressTimer = window.setTimeout(() => {
        longPressTimer = 0
        const xtermScreen = container.querySelector<HTMLElement>('.xterm-screen')
        if (touchStart && xtermScreen && selectTerminalTextAt(terminal, xtermScreen, point.x, point.y)) {
          longPressPoint = point
        }
      }, 500)
    }
    const handleTouchMove = (event: TouchEvent) => {
      if (!touchStart || !longPressTimer) return
      const touch = event.touches[0]
      if (!touch || Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > 12) clearLongPress()
    }
    const handleTouchEnd = () => {
      if (longPressTimer) window.clearTimeout(longPressTimer)
      longPressTimer = 0
      touchStart = null
      if (longPressPoint) showContextMenu(longPressPoint.x, longPressPoint.y)
      longPressPoint = null
    }
    const handleTouchCancel = () => {
      clearLongPress()
      longPressPoint = null
    }
    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: true })
    container.addEventListener('touchend', handleTouchEnd, { passive: true })
    container.addEventListener('touchcancel', handleTouchCancel, { passive: true })

    socket.addEventListener('open', () => {
      fitAndResize()
      send({ type: 'terminal.connect', token, threadId, cwd, columns: terminal.cols, rows: terminal.rows })
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data))
        else if (event.data instanceof Blob) void event.data.arrayBuffer().then((data) => terminal.write(new Uint8Array(data)))
        return
      }
      let payload: { type?: string; cwd?: string; shell?: string; message?: string }
      try {
        payload = JSON.parse(event.data) as typeof payload
      } catch {
        return
      }
      if (payload.type === 'ready') {
        ready = true
        setStatus('connected')
        if (payload.cwd) setWorkingDirectory(payload.cwd)
        for (const data of pendingInput.splice(0)) send({ type: 'input', data })
        fitAndResize()
      } else if (payload.type === 'error') {
        stopDirectionRepeat()
        setStatus('disconnected')
        terminal.writeln(`\r\n\x1b[31m${payload.message || '无法启动终端。'}\x1b[0m`)
      } else if (payload.type === 'exit') {
        exited = true
        stopDirectionRepeat()
        setStatus('exited')
        terminal.writeln('\r\n\x1b[90m[终端会话已结束]\x1b[0m')
      }
    })
    socket.addEventListener('close', () => {
      if (!disposed && ready && !exited) {
        stopDirectionRepeat()
        setStatus('disconnected')
      }
    })
    socket.addEventListener('error', () => {
      if (!disposed) {
        stopDirectionRepeat()
        setStatus('disconnected')
      }
    })

    if (!window.matchMedia('(pointer: coarse)').matches) terminal.focus()
    fitFrame = window.requestAnimationFrame(fitAndResize)

    return () => {
      disposed = true
      window.cancelAnimationFrame(fitFrame)
      compactTerminal.removeEventListener('change', updateFontSize)
      resizeObserver?.disconnect()
      container.removeEventListener('contextmenu', handleContextMenu)
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', handleTouchEnd)
      container.removeEventListener('touchcancel', handleTouchCancel)
      clearLongPress()
      stopDirectionRepeat()
      sendInput.current = () => {}
      dataSubscription.dispose()
      send({ type: 'close' })
      socket.close()
      terminal.dispose()
    }
  }, [cwd, threadId, token])

  const statusLabel = {
    connecting: '正在启动',
    connected: '已连接',
    disconnected: '连接断开',
    exited: '已结束',
  }[status]

  return (
    <ChatOverlayPanel
      ariaLabel="本机终端"
      backdropLabel="关闭本机终端"
      onClose={onClose}
      showCloseButton={false}
      className="terminal-dialog"
      onPanelPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest('.terminal-context-menu')) setContextMenu(null)
      }}
      footer={(
        <div className="terminal-dialog__navigation" role="group" aria-label="终端方向键">
          {terminalDirectionKeys.map(({ label, data, icon: DirectionIcon }) => (
            <button
              className="terminal-dialog__navigation-button"
              type="button"
              key={label}
              disabled={status !== 'connected'}
              aria-label={`终端${label}`}
              title={`终端${label}，长按连续输入`}
              onPointerDown={(event) => beginDirectionRepeat(event, data)}
              onPointerUp={endDirectionRepeat}
              onPointerCancel={endDirectionRepeat}
              onPointerLeave={endDirectionRepeat}
              onLostPointerCapture={endDirectionRepeat}
              onClick={(event) => { if (event.detail === 0) sendInput.current(data) }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <DirectionIcon size={18} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      header={(
        <div className="terminal-dialog__title">
          <TerminalIcon size={16} aria-hidden="true" />
          <strong>本机终端</strong>
          <span className={`terminal-dialog__status terminal-dialog__status--${status}`}>
            {status === 'connecting' ? <LoaderCircle className="spin" size={12} /> : <i />}
            {statusLabel}
          </span>
          {workingDirectory ? <code title={workingDirectory}>{workingDirectory}</code> : null}
        </div>
      )}
    >
      <div className="terminal-dialog__screen" ref={screen} aria-label="终端内容" />
      {contextMenu ? (
        <div
          className="terminal-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void copyTextToClipboard(contextMenu.text).then((copied) => {
                if (copied) setContextMenu(null)
              })
            }}
          >
            <Copy size={14} />
            复制
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onInsertText(contextMenu.text)
              setContextMenu(null)
            }}
          >
            <Clipboard size={14} />
            粘贴到输入框
          </button>
        </div>
      ) : null}
    </ChatOverlayPanel>
  )
}

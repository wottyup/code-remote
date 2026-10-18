import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Clipboard, ClipboardPaste, Copy, CornerDownLeft, Delete, Eraser, LoaderCircle, RotateCw, Terminal as TerminalIcon, TextSelect } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { copyTextToClipboard, readTextFromClipboard } from '../lib/clipboard'
import { restoreTerminalTouchSelection, type TerminalTouchSelection } from '../lib/terminalTouchSelection'
import { terminalChangeDirectoryCommand } from '../lib/terminalPathCommand'
import { ChatOverlayPanel } from './ChatOverlayPanel'
import '@xterm/xterm/css/xterm.css'

const terminalControlKeys = [
  { label: '向左', code: 'D', icon: ArrowLeft },
  { label: '向上', code: 'A', icon: ArrowUp },
  { label: '向下', code: 'B', icon: ArrowDown },
  { label: '向右', code: 'C', icon: ArrowRight },
  { label: '退格', code: 'Backspace', icon: Delete },
] as const
type TerminalControlCode = (typeof terminalControlKeys)[number]['code']
type TerminalModifier = 'ctrl' | 'alt'

interface TerminalDialogProps {
  token: string
  threadId?: string
  cwd?: string
  directoryRequest: { id: number; path: string } | null
  onDirectoryRequestConsumed: (id: number) => void
  onClose: () => void
  onInsertText: (value: string) => void
}

type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'exited'

interface ContextMenuState {
  x: number
  y: number
  text: string
}

interface TerminalActions {
  clear: () => void
  focus: () => void
  paste: (value: string) => void
  selectAll: () => string
}

function applyTerminalModifier(data: string, modifier: TerminalModifier | null) {
  if (!modifier || !data) return data

  const cursorMatch = /^\x1b(?:\[|O)([ABCD])$/u.exec(data)
  if (cursorMatch) return `\x1b[1;${modifier === 'ctrl' ? '5' : '3'}${cursorMatch[1]}`

  if (modifier === 'alt') return `\x1b${data}`
  if (data.length !== 1) return data

  const code = data.toUpperCase().charCodeAt(0)
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
  if (data === '?') return '\x7f'
  return data
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

export function TerminalDialog({ token, threadId, cwd, directoryRequest, onDirectoryRequestConsumed, onClose, onInsertText }: TerminalDialogProps) {
  const screen = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const [shellName, setShellName] = useState('')
  const [workingDirectory, setWorkingDirectory] = useState(cwd ?? '')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [activeModifier, setActiveModifier] = useState<TerminalModifier | null>(null)
  const [manualPasteOpen, setManualPasteOpen] = useState(false)
  const [manualPasteText, setManualPasteText] = useState('')
  const [desktopPasteHintVisible, setDesktopPasteHintVisible] = useState(false)
  const [connectionRound, setConnectionRound] = useState(0)
  const handledDirectoryRequestId = useRef<number | null>(null)
  const activeModifierRef = useRef<TerminalModifier | null>(null)
  const desktopPasteHintTimer = useRef<number | undefined>(undefined)
  const terminalActions = useRef<TerminalActions>({
    clear: () => {},
    focus: () => {},
    paste: () => {},
    selectAll: () => '',
  })
  const sendTerminalInput = useRef<(data: string) => void>(() => {})
  const sendControlInput = useRef<(code: TerminalControlCode) => void>(() => {})
  const controlRepeatDelay = useRef<number | undefined>(undefined)
  const controlRepeatInterval = useRef<number | undefined>(undefined)
  const controlPointer = useRef<number | null>(null)

  const resetModifier = () => {
    activeModifierRef.current = null
    setActiveModifier(null)
  }

  const toggleModifier = (modifier: TerminalModifier) => {
    const nextModifier = activeModifierRef.current === modifier ? null : modifier
    activeModifierRef.current = nextModifier
    setActiveModifier(nextModifier)
    terminalActions.current.focus()
  }

  const sendQuickInput = (data: string) => {
    sendTerminalInput.current(data)
  }

  const pasteIntoTerminal = async () => {
    setContextMenu(null)
    const value = await readTextFromClipboard()
    if (value === null) {
      if (window.matchMedia('(pointer: coarse)').matches) {
        setManualPasteText('')
        setManualPasteOpen(true)
      } else {
        terminalActions.current.focus()
        setDesktopPasteHintVisible(true)
        if (desktopPasteHintTimer.current !== undefined) window.clearTimeout(desktopPasteHintTimer.current)
        desktopPasteHintTimer.current = window.setTimeout(() => {
          setDesktopPasteHintVisible(false)
          desktopPasteHintTimer.current = undefined
        }, 3_500)
      }
      return
    }
    setDesktopPasteHintVisible(false)
    if (desktopPasteHintTimer.current !== undefined) window.clearTimeout(desktopPasteHintTimer.current)
    desktopPasteHintTimer.current = undefined
    if (value) terminalActions.current.paste(value)
    terminalActions.current.focus()
  }

  const submitManualPaste = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (manualPasteText) terminalActions.current.paste(manualPasteText)
    setManualPasteOpen(false)
    setManualPasteText('')
    window.requestAnimationFrame(() => terminalActions.current.focus())
  }

  const reconnect = () => {
    stopControlRepeat()
    resetModifier()
    setContextMenu(null)
    setManualPasteOpen(false)
    setStatus('connecting')
    setConnectionRound((value) => value + 1)
  }

  const stopControlRepeat = () => {
    if (controlRepeatDelay.current !== undefined) window.clearTimeout(controlRepeatDelay.current)
    if (controlRepeatInterval.current !== undefined) window.clearInterval(controlRepeatInterval.current)
    controlRepeatDelay.current = undefined
    controlRepeatInterval.current = undefined
    controlPointer.current = null
  }

  const beginControlRepeat = (event: ReactPointerEvent<HTMLButtonElement>, code: TerminalControlCode) => {
    event.preventDefault()
    event.stopPropagation()
    stopControlRepeat()
    const pointerId = event.pointerId
    controlPointer.current = pointerId
    event.currentTarget.setPointerCapture(pointerId)
    sendControlInput.current(code)
    controlRepeatDelay.current = window.setTimeout(() => {
      controlRepeatDelay.current = undefined
      if (controlPointer.current !== pointerId) return
      controlRepeatInterval.current = window.setInterval(() => sendControlInput.current(code), 80)
    }, 360)
  }

  const endControlRepeat = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (controlPointer.current !== event.pointerId) return
    stopControlRepeat()
  }

  useEffect(() => {
    const container = screen.current
    if (!container) return

    setStatus('connecting')
    setWorkingDirectory(cwd ?? '')
    activeModifierRef.current = null
    setActiveModifier(null)
    const readFontSize = () => {
      const fontSize = Number.parseFloat(window.getComputedStyle(container).fontSize)
      return Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: readFontSize(),
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
    let lastTerminalSelection: TerminalTouchSelection | null = null
    let retainedTouchSelection: TerminalTouchSelection | null = null
    let touchStart: { x: number; y: number } | null = null
    let selectionRestoreVersion = 0
    let selectionRestoreFrame = 0
    let ignoreSyntheticMouseUntil = 0
    const pendingInput: string[] = []
    const send = (message: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    }
    const cacheTerminalSelection = (point?: { x: number; y: number }) => {
      const text = terminal.getSelection()
      const range = terminal.getSelectionPosition()
      if (!text || !range) return null
      const selection = { point, text, range }
      lastTerminalSelection = selection
      return selection
    }
    const clearSelectionSnapshot = () => {
      retainedTouchSelection = null
      lastTerminalSelection = null
      selectionRestoreVersion += 1
      if (selectionRestoreFrame) window.cancelAnimationFrame(selectionRestoreFrame)
      selectionRestoreFrame = 0
    }
    const restoreSelectionAfterRelease = (selection: TerminalTouchSelection) => {
      retainedTouchSelection = selection
      const restoreVersion = ++selectionRestoreVersion
      if (selectionRestoreFrame) window.cancelAnimationFrame(selectionRestoreFrame)
      selectionRestoreFrame = window.requestAnimationFrame(() => {
        selectionRestoreFrame = 0
        if (!disposed && restoreVersion === selectionRestoreVersion && terminal.getSelection() !== selection.text) {
          restoreTerminalTouchSelection(terminal, selection)
        }
      })
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
    const scheduleFit = () => {
      window.cancelAnimationFrame(fitFrame)
      fitFrame = window.requestAnimationFrame(fitAndResize)
    }
    const updateFontSize = () => {
      const fontSize = readFontSize()
      if (terminal.options.fontSize === fontSize) return
      terminal.options.fontSize = fontSize
      scheduleFit()
    }
    const appRoot = container.closest('.app-root')
    const fontPreferenceObserver = typeof MutationObserver === 'undefined' || !appRoot
      ? null
      : new MutationObserver(updateFontSize)
    if (fontPreferenceObserver && appRoot) {
      fontPreferenceObserver.observe(appRoot, { attributes: true, attributeFilter: ['style'] })
    }
    window.addEventListener('resize', updateFontSize)
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
        updateFontSize()
        scheduleFit()
      })
    resizeObserver?.observe(container)

    const sendInput = (data: string) => {
      if (!ready) {
        pendingInput.push(data)
        return
      }
      send({ type: 'input', data })
    }
    const dispatchInput = (data: string) => {
      clearSelectionSnapshot()
      const modifier = activeModifierRef.current
      sendInput(applyTerminalModifier(data, modifier))
      if (modifier) resetModifier()
    }
    sendTerminalInput.current = dispatchInput
    terminalActions.current = {
      clear: () => {
        clearSelectionSnapshot()
        terminal.clear()
        terminal.focus()
      },
      focus: () => terminal.focus(),
      paste: (value) => terminal.paste(value),
      selectAll: () => {
        clearSelectionSnapshot()
        terminal.selectAll()
        return terminal.getSelection()
      },
    }
    const dataSubscription = terminal.onData(dispatchInput)
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || (!event.ctrlKey && !event.metaKey) || event.altKey) return true

      const key = event.key.toLowerCase()
      if (key === 'c' && terminal.hasSelection()) {
        const selection = terminal.getSelection()
        if (!selection) return true
        event.preventDefault()
        event.stopPropagation()
        void copyTextToClipboard(selection).finally(() => terminal.focus())
        return false
      }

      if (key === 'v') {
        // Let the browser dispatch its native paste event to xterm's clipboard handler.
        return false
      }

      return true
    })
    sendControlInput.current = (code) => {
      if (code === 'Backspace') {
        dispatchInput('\x7f')
        return
      }
      const cursorPrefix = terminal.modes.applicationCursorKeysMode ? 'O' : '['
      dispatchInput(`\x1b${cursorPrefix}${code}`)
    }
    const selectionSubscription = terminal.onSelectionChange(() => {
      const selection = cacheTerminalSelection()
      // Some touch browsers clear xterm's programmatic range after touchend; restore it until the next user gesture.
      if (!selection && retainedTouchSelection && !touchStart) restoreSelectionAfterRelease(retainedTouchSelection)
    })
    const showContextMenu = (clientX: number, clientY: number, selectedText = terminal.getSelection()) => {
      const menuHost = container.parentElement ?? container
      const bounds = menuHost.getBoundingClientRect()
      setContextMenu({
        x: Math.min(Math.max(8, clientX - bounds.left), Math.max(8, bounds.width - 200)),
        y: Math.min(Math.max(8, clientY - bounds.top), Math.max(8, bounds.height - 190)),
        text: selectedText,
      })
      return true
    }
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      const selection = cacheTerminalSelection() ?? lastTerminalSelection ?? retainedTouchSelection
      if (selection) {
        retainedTouchSelection = null
        restoreTerminalTouchSelection(terminal, selection)
        showContextMenu(event.clientX, event.clientY, selection.text)
        return
      }
      showContextMenu(event.clientX, event.clientY)
    }
    container.addEventListener('contextmenu', handleContextMenu)
    const handleMouseDown = (event: MouseEvent) => {
      // Browsers can synthesize a left-mouse sequence after a touch release.
      if (event.button === 0 && Date.now() >= ignoreSyntheticMouseUntil) clearSelectionSnapshot()
    }
    container.addEventListener('mousedown', handleMouseDown)

    let longPressTimer = 0
    let longPressSelection: TerminalTouchSelection | null = null
    const clearLongPress = () => {
      if (longPressTimer) window.clearTimeout(longPressTimer)
      longPressTimer = 0
      touchStart = null
      longPressSelection = null
    }
    const handleTouchStart = (event: TouchEvent) => {
      clearSelectionSnapshot()
      if (event.touches.length !== 1) {
        clearLongPress()
        return
      }
      clearLongPress()
      setContextMenu(null)
      const touch = event.touches[0]
      const point = { x: touch.clientX, y: touch.clientY }
      touchStart = point
      longPressTimer = window.setTimeout(() => {
        longPressTimer = 0
        const xtermScreen = container.querySelector<HTMLElement>('.xterm-screen')
        if (touchStart && xtermScreen && selectTerminalTextAt(terminal, xtermScreen, point.x, point.y)) {
          longPressSelection = cacheTerminalSelection(point)
          retainedTouchSelection = longPressSelection
        }
      }, 500)
    }
    const handleTouchMove = (event: TouchEvent) => {
      if (!touchStart || !longPressTimer) return
      const touch = event.touches[0]
      if (!touch || Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > 12) clearLongPress()
    }
    const handleTouchEnd = () => {
      ignoreSyntheticMouseUntil = Date.now() + 800
      if (longPressTimer) window.clearTimeout(longPressTimer)
      longPressTimer = 0
      touchStart = null
      const selection = longPressSelection ?? cacheTerminalSelection() ?? lastTerminalSelection
      longPressSelection = null
      if (selection) restoreSelectionAfterRelease(selection)
    }
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return
      const selection = cacheTerminalSelection() ?? lastTerminalSelection ?? retainedTouchSelection
      if (selection) restoreSelectionAfterRelease(selection)
    }
    const handleTouchCancel = () => {
      ignoreSyntheticMouseUntil = Date.now() + 800
      const selection = longPressSelection ?? cacheTerminalSelection() ?? lastTerminalSelection
      clearLongPress()
      if (selection) restoreSelectionAfterRelease(selection)
      else clearSelectionSnapshot()
    }
    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: true })
    container.addEventListener('touchend', handleTouchEnd, { passive: true })
    container.addEventListener('touchcancel', handleTouchCancel, { passive: true })
    container.addEventListener('mouseup', handleMouseUp)

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
        setShellName(payload.shell ?? '')
        if (payload.cwd) setWorkingDirectory(payload.cwd)
        for (const data of pendingInput.splice(0)) send({ type: 'input', data })
        fitAndResize()
      } else if (payload.type === 'error') {
        ready = false
        stopControlRepeat()
        resetModifier()
        setStatus('disconnected')
        terminal.writeln(`\r\n\x1b[31m${payload.message || '无法启动终端。'}\x1b[0m`)
      } else if (payload.type === 'exit') {
        ready = false
        exited = true
        stopControlRepeat()
        resetModifier()
        setStatus('exited')
        terminal.writeln('\r\n\x1b[90m[终端会话已结束]\x1b[0m')
      }
    })
    socket.addEventListener('close', () => {
      if (!disposed && !exited) {
        ready = false
        stopControlRepeat()
        resetModifier()
        setStatus('disconnected')
      }
    })
    socket.addEventListener('error', () => {
      if (!disposed) {
        ready = false
        stopControlRepeat()
        resetModifier()
        setStatus('disconnected')
      }
    })

    if (!window.matchMedia('(pointer: coarse)').matches) terminal.focus()
    fitFrame = window.requestAnimationFrame(fitAndResize)

    return () => {
      disposed = true
      window.cancelAnimationFrame(fitFrame)
      window.removeEventListener('resize', updateFontSize)
      fontPreferenceObserver?.disconnect()
      resizeObserver?.disconnect()
      container.removeEventListener('contextmenu', handleContextMenu)
      container.removeEventListener('mousedown', handleMouseDown)
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', handleTouchEnd)
      container.removeEventListener('touchcancel', handleTouchCancel)
      container.removeEventListener('mouseup', handleMouseUp)
      retainedTouchSelection = null
      selectionRestoreVersion += 1
      if (selectionRestoreFrame) window.cancelAnimationFrame(selectionRestoreFrame)
      clearLongPress()
      stopControlRepeat()
      if (desktopPasteHintTimer.current !== undefined) window.clearTimeout(desktopPasteHintTimer.current)
      desktopPasteHintTimer.current = undefined
      activeModifierRef.current = null
      sendTerminalInput.current = () => {}
      sendControlInput.current = () => {}
      terminalActions.current = {
        clear: () => {},
        focus: () => {},
        paste: () => {},
        selectAll: () => '',
      }
      dataSubscription.dispose()
      selectionSubscription.dispose()
      send({ type: 'close' })
      socket.close()
      terminal.dispose()
    }
  }, [connectionRound, cwd, threadId, token])

  useEffect(() => {
    if (status !== 'connected' || !shellName || !directoryRequest || handledDirectoryRequestId.current === directoryRequest.id) return
    handledDirectoryRequestId.current = directoryRequest.id
    terminalActions.current.paste(terminalChangeDirectoryCommand(shellName, directoryRequest.path))
    terminalActions.current.focus()
    onDirectoryRequestConsumed(directoryRequest.id)
  }, [directoryRequest, onDirectoryRequestConsumed, shellName, status])

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
        <div className="terminal-dialog__navigation" role="group" aria-label="终端快捷键">
          <div className="terminal-dialog__navigation-row terminal-dialog__navigation-row--primary">
            <button
              className="terminal-dialog__navigation-button"
              type="button"
              disabled={status !== 'connected'}
              onPointerDown={(event) => {
                event.preventDefault()
                sendQuickInput('\x1b')
              }}
              onClick={(event) => { if (event.detail === 0) sendQuickInput('\x1b') }}
            >
              Esc
            </button>
            <button
              className="terminal-dialog__navigation-button"
              type="button"
              disabled={status !== 'connected'}
              onPointerDown={(event) => {
                event.preventDefault()
                sendQuickInput('\t')
              }}
              onClick={(event) => { if (event.detail === 0) sendQuickInput('\t') }}
            >
              Tab
            </button>
            {(['ctrl', 'alt'] as const).map((modifier) => (
              <button
                className="terminal-dialog__navigation-button"
                type="button"
                key={modifier}
                disabled={status !== 'connected'}
                aria-pressed={activeModifier === modifier}
                onPointerDown={(event) => {
                  event.preventDefault()
                  toggleModifier(modifier)
                }}
                onClick={(event) => { if (event.detail === 0) toggleModifier(modifier) }}
              >
                {modifier === 'ctrl' ? 'Ctrl' : 'Alt'}
              </button>
            ))}
            <button
              className="terminal-dialog__navigation-button"
              type="button"
              disabled={status !== 'connected'}
              aria-label="粘贴到终端"
              title="粘贴到终端"
              onPointerDown={(event) => {
                event.preventDefault()
                void pasteIntoTerminal()
              }}
              onClick={(event) => { if (event.detail === 0) void pasteIntoTerminal() }}
            >
              <ClipboardPaste size={17} aria-hidden="true" />
            </button>
            <button
              className="terminal-dialog__navigation-button"
              type="button"
              disabled={status !== 'connected'}
              aria-label="终端回车"
              title="终端回车"
              onPointerDown={(event) => {
                event.preventDefault()
                sendQuickInput('\r')
              }}
              onClick={(event) => { if (event.detail === 0) sendQuickInput('\r') }}
            >
              <CornerDownLeft size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="terminal-dialog__navigation-row terminal-dialog__navigation-row--secondary">
            {terminalControlKeys.map(({ label, code, icon: ControlIcon }) => (
              <button
                className="terminal-dialog__navigation-button"
                type="button"
                key={label}
                disabled={status !== 'connected'}
                aria-label={`终端${label}`}
                title={code === 'Backspace' ? '终端退格，长按连续删除' : `终端${label}，长按连续输入`}
                onPointerDown={(event) => beginControlRepeat(event, code)}
                onPointerUp={endControlRepeat}
                onPointerCancel={endControlRepeat}
                onPointerLeave={endControlRepeat}
                onLostPointerCapture={endControlRepeat}
                onClick={(event) => { if (event.detail === 0) sendControlInput.current(code) }}
                onContextMenu={(event) => event.preventDefault()}
              >
                <ControlIcon size={18} aria-hidden="true" />
              </button>
            ))}
          </div>
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
          {status === 'disconnected' || status === 'exited' ? (
            <button className="terminal-dialog__reconnect" type="button" onClick={reconnect}>
              <RotateCw size={13} aria-hidden="true" />
              重连
            </button>
          ) : null}
          {workingDirectory ? <code title={workingDirectory}>{workingDirectory}</code> : null}
        </div>
      )}
    >
      <div className="terminal-dialog__screen" ref={screen} aria-label="终端内容" />
      {desktopPasteHintVisible ? (
        <div className="terminal-dialog__paste-hint" role="status">
          终端已聚焦，请按 Ctrl/⌘+V 粘贴
        </div>
      ) : null}
      {contextMenu ? (
        <div
          className="terminal-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            disabled={!contextMenu.text}
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
            disabled={status !== 'connected'}
            onClick={() => void pasteIntoTerminal()}
          >
            <ClipboardPaste size={14} />
            粘贴到终端
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const text = terminalActions.current.selectAll()
              setContextMenu((current) => current ? { ...current, text } : current)
            }}
          >
            <TextSelect size={14} />
            全选
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!contextMenu.text}
            onClick={() => {
              onInsertText(contextMenu.text)
              setContextMenu(null)
            }}
          >
            <Clipboard size={14} />
            粘贴到输入框
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              terminalActions.current.clear()
              setContextMenu(null)
            }}
          >
            <Eraser size={14} />
            清空显示
          </button>
        </div>
      ) : null}
      {manualPasteOpen ? (
        <div className="terminal-manual-paste" role="dialog" aria-modal="true" aria-label="手动粘贴到终端">
          <form onSubmit={submitManualPaste}>
            <strong>手动粘贴</strong>
            <p>浏览器无法直接读取剪贴板，请把内容粘贴到这里。</p>
            <textarea
              autoFocus
              value={manualPasteText}
              onChange={(event) => setManualPasteText(event.target.value)}
              placeholder="在此粘贴终端输入"
              rows={5}
            />
            <div>
              <button
                type="button"
                onClick={() => {
                  setManualPasteOpen(false)
                  setManualPasteText('')
                  window.requestAnimationFrame(() => terminalActions.current.focus())
                }}
              >
                取消
              </button>
              <button type="submit" disabled={!manualPasteText}>粘贴到终端</button>
            </div>
          </form>
        </div>
      ) : null}
    </ChatOverlayPanel>
  )
}

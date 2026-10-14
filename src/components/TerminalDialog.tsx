import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Clipboard, LoaderCircle, Terminal as TerminalIcon, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'

interface TerminalDialogProps {
  token: string
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

export function TerminalDialog({ token, cwd, onClose, onInsertText }: TerminalDialogProps) {
  const screen = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const [workingDirectory, setWorkingDirectory] = useState(cwd ?? '')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  useEffect(() => {
    const container = screen.current
    if (!container) return

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
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
    const handleContextMenu = (event: MouseEvent) => {
      const selectedText = terminal.getSelection()
      if (!selectedText) return
      event.preventDefault()
      const bounds = (container.parentElement ?? container).getBoundingClientRect()
      setContextMenu({
        x: Math.min(Math.max(8, event.clientX - bounds.left), Math.max(8, bounds.width - 190)),
        y: Math.min(Math.max(8, event.clientY - bounds.top), Math.max(8, bounds.height - 52)),
        text: selectedText,
      })
    }
    container.addEventListener('contextmenu', handleContextMenu)

    socket.addEventListener('open', () => {
      fitAndResize()
      send({ type: 'terminal.connect', token, cwd, columns: terminal.cols, rows: terminal.rows })
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
        setStatus('disconnected')
        terminal.writeln(`\r\n\x1b[31m${payload.message || '无法启动终端。'}\x1b[0m`)
      } else if (payload.type === 'exit') {
        exited = true
        setStatus('exited')
        terminal.writeln('\r\n\x1b[90m[终端会话已结束]\x1b[0m')
      }
    })
    socket.addEventListener('close', () => {
      if (!disposed && ready && !exited) setStatus('disconnected')
    })
    socket.addEventListener('error', () => {
      if (!disposed) setStatus('disconnected')
    })

    if (!window.matchMedia('(pointer: coarse)').matches) terminal.focus()
    fitFrame = window.requestAnimationFrame(fitAndResize)

    return () => {
      disposed = true
      window.cancelAnimationFrame(fitFrame)
      resizeObserver?.disconnect()
      container.removeEventListener('contextmenu', handleContextMenu)
      dataSubscription.dispose()
      send({ type: 'close' })
      socket.close()
      terminal.dispose()
    }
  }, [cwd, token])

  const statusLabel = {
    connecting: '正在启动',
    connected: '已连接',
    disconnected: '连接断开',
    exited: '已结束',
  }[status]

  return (
    <div
      className="terminal-dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
        else if (!(event.target as HTMLElement).closest('.terminal-context-menu')) setContextMenu(null)
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <section className="terminal-dialog" role="dialog" aria-label="本机终端">
        <header className="terminal-dialog__header">
          <div className="terminal-dialog__title">
            <TerminalIcon size={16} aria-hidden="true" />
            <strong>本机终端</strong>
            <span className={`terminal-dialog__status terminal-dialog__status--${status}`}>
              {status === 'connecting' ? <LoaderCircle className="spin" size={12} /> : <i />}
              {statusLabel}
            </span>
            {workingDirectory ? <code title={workingDirectory}>{workingDirectory}</code> : null}
          </div>
          <button className="icon-button terminal-dialog__close" type="button" onClick={onClose} aria-label="关闭终端" title="关闭终端">
            <X size={16} />
          </button>
        </header>
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
                onInsertText(contextMenu.text)
                setContextMenu(null)
              }}
            >
              <Clipboard size={14} />
              粘贴到输入框
            </button>
          </div>
        ) : null}
      </section>
    </div>
  )
}

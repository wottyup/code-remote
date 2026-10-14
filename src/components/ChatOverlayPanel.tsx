import { X } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'

const heightStorageKey = 'codex-remote:chat-overlay-height'
const minimumPanelHeight = 180

interface ChatOverlayPanelProps {
  ariaLabel: string
  backdropLabel: string
  header: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  closeButtonRef?: RefObject<HTMLButtonElement | null>
  ariaModal?: boolean
  className?: string
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void
  onPanelPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
}

function readStoredHeight() {
  if (typeof window === 'undefined') return null
  try {
    const value = Number(window.sessionStorage.getItem(heightStorageKey))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function panelMinimumHeight(maximum: number) {
  return Math.min(minimumPanelHeight, maximum)
}

export function ChatOverlayPanel({
  ariaLabel,
  backdropLabel,
  header,
  children,
  footer,
  onClose,
  closeButtonRef,
  ariaModal,
  className = '',
  onKeyDown,
  onPanelPointerDown,
}: ChatOverlayPanelProps) {
  const backdrop = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const resizeStart = useRef<{ pointerId: number; clientY: number; height: number } | null>(null)
  const [availableHeight, setAvailableHeight] = useState(0)
  const [height, setHeight] = useState<number | null>(readStoredHeight)
  const [resizing, setResizing] = useState(false)

  useLayoutEffect(() => {
    const host = backdrop.current?.parentElement
    if (!host) return
    const updateAvailableHeight = () => {
      const nextMaximum = host.getBoundingClientRect().height
      setAvailableHeight(nextMaximum)
      setHeight((current) => current === null || nextMaximum <= 0
        ? current
        : Math.min(Math.max(current, panelMinimumHeight(nextMaximum)), nextMaximum))
    }
    updateAvailableHeight()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateAvailableHeight)
    observer?.observe(host)
    window.addEventListener('resize', updateAvailableHeight)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateAvailableHeight)
    }
  }, [])

  const maximumHeight = Math.max(availableHeight, 0)
  const minimumHeight = panelMinimumHeight(maximumHeight)
  const currentHeight = height === null
    ? maximumHeight
    : maximumHeight > 0
      ? Math.min(Math.max(height, minimumHeight), maximumHeight)
      : height

  function saveHeight(nextHeight: number) {
    const maximum = panel.current?.parentElement?.getBoundingClientRect().height ?? maximumHeight
    const next = Math.min(Math.max(nextHeight, panelMinimumHeight(maximum)), maximum)
    setHeight(next)
    try {
      window.sessionStorage.setItem(heightStorageKey, String(Math.round(next)))
    } catch {
      // The current tab still keeps the chosen height when storage is unavailable.
    }
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.pointerType !== 'touch') return
    event.preventDefault()
    event.stopPropagation()
    const startingHeight = panel.current?.getBoundingClientRect().height ?? currentHeight
    resizeStart.current = { pointerId: event.pointerId, clientY: event.clientY, height: startingHeight }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const start = resizeStart.current
    if (!start || start.pointerId !== event.pointerId) return
    saveHeight(start.height + event.clientY - start.clientY)
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizeStart.current?.pointerId !== event.pointerId) return
    resizeStart.current = null
    setResizing(false)
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const increment = event.shiftKey ? 96 : 32
    const next = event.key === 'ArrowUp'
      ? currentHeight - increment
      : event.key === 'ArrowDown'
        ? currentHeight + increment
        : event.key === 'Home'
          ? minimumHeight
          : event.key === 'End'
            ? maximumHeight
            : null
    if (next === null) return
    event.preventDefault()
    saveHeight(next)
  }

  function resetHeight() {
    setHeight(null)
    try {
      window.sessionStorage.removeItem(heightStorageKey)
    } catch {
      // A full-height panel still works when storage is unavailable.
    }
  }

  return (
    <div ref={backdrop} className={`chat-overlay-backdrop${resizing ? ' chat-overlay-backdrop--resizing' : ''}`}>
      <button className="chat-overlay-backdrop__dismiss" type="button" aria-label={backdropLabel} tabIndex={-1} onClick={onClose} />
      <section
        ref={panel}
        className={`chat-overlay-panel${className ? ` ${className}` : ''}`}
        style={{ '--chat-overlay-height': height === null ? '100%' : `${currentHeight}px` } as CSSProperties}
        role="dialog"
        aria-modal={ariaModal}
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        onPointerDown={onPanelPointerDown}
      >
        <header className="chat-overlay-panel__header">
          <div className="chat-overlay-panel__heading">{header}</div>
          <button ref={closeButtonRef} className="icon-button chat-overlay-panel__close" type="button" onClick={onClose} aria-label={`关闭${ariaLabel}`} title={`关闭${ariaLabel}`}>
            <X size={16} />
          </button>
        </header>
        <div className="chat-overlay-panel__body">{children}</div>
        {footer !== undefined ? <footer className="chat-overlay-panel__footer">{footer}</footer> : null}
        <div
          className="chat-overlay-panel__resize-handle"
          role="separator"
          aria-label="调整浮层高度"
          aria-orientation="horizontal"
          aria-valuemin={minimumHeight}
          aria-valuemax={maximumHeight}
          aria-valuenow={Math.round(currentHeight)}
          aria-valuetext={`${Math.round(currentHeight)} 像素`}
          tabIndex={0}
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          onDoubleClick={resetHeight}
          onKeyDown={handleResizeKeyDown}
          title="拖动调整高度，双击恢复铺满；方向键微调，Shift 加大步长"
        />
      </section>
    </div>
  )
}

import { ui, useUiLanguage } from '../lib/uiLanguage'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'

interface TranslationSelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface TranslationSelectProps {
  label: string
  value: string
  options: readonly TranslationSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  hideLabel?: boolean
  className?: string
}

export function TranslationSelect({ label, value, options, onChange, disabled = false, hideLabel = false, className = '' }: TranslationSelectProps) {
  useUiLanguage()
  const labelId = useId()
  const valueId = useId()
  const listboxId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const wasOpenOnPointerDown = useRef(false)
  const [open, setOpen] = useState(false)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const [activeIndex, setActiveIndex] = useState(Math.max(0, selectedIndex))
  const selectedLabel = options[selectedIndex]?.label ?? ui('请选择')
  const popoverSupported = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function'

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu || !menu.matches(':popover-open')) return
    const rect = trigger.getBoundingClientRect()
    const edge = 8
    const gap = 6
    if (rect.width <= 0 || rect.bottom < 0 || rect.top > window.innerHeight) {
      menu.hidePopover()
      return
    }
    const width = Math.min(rect.width, window.innerWidth - edge * 2)
    menu.style.width = `${width}px`
    menu.style.left = `${Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge))}px`
    const below = window.innerHeight - rect.bottom - gap - edge
    const above = rect.top - gap - edge
    const openAbove = below < Math.min(menu.scrollHeight, 240) && above > below
    const maxHeight = Math.min(320, Math.max(48, openAbove ? above : below))
    menu.style.maxHeight = `${maxHeight}px`
    const height = Math.min(menu.scrollHeight, maxHeight)
    const top = openAbove ? rect.top - gap - height : rect.bottom + gap
    menu.style.top = `${Math.max(edge, Math.min(top, window.innerHeight - height - edge))}px`
  }, [])

  useEffect(() => {
    if (!open) return
    positionMenu()
    window.addEventListener('resize', positionMenu)
    document.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      document.removeEventListener('scroll', positionMenu, true)
    }
  }, [open, positionMenu, options.length])

  useEffect(() => {
    const menu = menuRef.current
    if (disabled && menu?.matches(':popover-open')) menu.hidePopover()
  }, [disabled])

  function focusOption(index: number) {
    setActiveIndex(index)
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>(`[data-option-index="${index}"]`)?.focus()
    })
  }

  function showMenu(index = selectedIndex) {
    const menu = menuRef.current
    if (disabled || !menu || menu.matches(':popover-open')) return
    const firstEnabled = options.findIndex((option) => !option.disabled)
    if (firstEnabled < 0) return
    const target = index >= 0 && !options[index]?.disabled ? index : firstEnabled
    setActiveIndex(target)
    menu.showPopover()
    setOpen(true)
    positionMenu()
    focusOption(target)
  }

  function hideMenu(restoreFocus = false) {
    const menu = menuRef.current
    if (menu?.matches(':popover-open')) menu.hidePopover()
    if (restoreFocus) triggerRef.current?.focus()
  }

  function moveActive(step: number) {
    const enabled = options.flatMap((option, index) => option.disabled ? [] : [index])
    if (enabled.length === 0) return
    const current = enabled.indexOf(activeIndex)
    const next = enabled[(current + step + enabled.length) % enabled.length]
    focusOption(next)
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      hideMenu(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      event.stopPropagation()
      const enabled = options.flatMap((option, index) => option.disabled ? [] : [index])
      const next = event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1]
      if (next !== undefined) focusOption(next)
    }
  }

  if (!popoverSupported) {
    return <label className={`translation-settings__field ${className}`.trim()}>
      <span className={hideLabel ? 'translation-select__label--visually-hidden' : undefined}>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
    </label>
  }

  return <div className={`translation-settings__field translation-select ${className}`.trim()}>
    <span id={labelId} className={hideLabel ? 'translation-select__label--visually-hidden' : undefined}>{label}</span>
    <button
      ref={triggerRef}
      className="translation-select__trigger"
      type="button"
      disabled={disabled}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-labelledby={`${labelId} ${valueId}`}
      onPointerDown={() => { wasOpenOnPointerDown.current = Boolean(menuRef.current?.matches(':popover-open')) }}
      onClick={() => {
        if (wasOpenOnPointerDown.current) {
          wasOpenOnPointerDown.current = false
          hideMenu(true)
        } else if (menuRef.current?.matches(':popover-open')) hideMenu(true)
        else showMenu()
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          const first = options.findIndex((option) => !option.disabled)
          const last = options.reduce((found, option, index) => option.disabled ? found : index, -1)
          showMenu(event.key === 'Home' ? first : event.key === 'End' ? last : selectedIndex)
        }
      }}
    >
      <span id={valueId} className="translation-select__value">{selectedLabel}</span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
    <div
      ref={menuRef}
      id={listboxId}
      className="translation-select__menu"
      role="listbox"
      aria-label={label}
      popover="auto"
      onToggle={(event) => setOpen(event.currentTarget.matches(':popover-open'))}
      onKeyDown={handleMenuKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next && !event.currentTarget.contains(next)) hideMenu()
      }}
    >
      {options.map((option, index) => <button
        key={option.value}
        className="translation-select__option"
        type="button"
        role="option"
        aria-selected={option.value === value}
        data-option-index={index}
        tabIndex={index === activeIndex ? 0 : -1}
        disabled={option.disabled}
        onMouseEnter={() => { if (!option.disabled) setActiveIndex(index) }}
        onClick={() => {
          onChange(option.value)
          hideMenu(true)
        }}
      >
        <span>{option.label}</span>
        {option.value === value ? <Check size={15} aria-hidden="true" /> : null}
      </button>)}
    </div>
  </div>
}

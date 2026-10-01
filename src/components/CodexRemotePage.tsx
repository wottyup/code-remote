import { useEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Copy,
  FileText,
  ImagePlus,
  LoaderCircle,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react'
import { useCodexRemote, type CodexActivity, type CodexFileChange } from '../hooks/useCodexRemote'
import type { CodexApprovalPolicy, CodexDocumentAttachment, CodexImageAttachment, CodexMessage, CodexModel, CodexThread } from '../lib/codexRemoteClient'

interface Props {
  token: string
  onUnauthorized: () => void
  onUnpair: () => void | Promise<void>
}

const connectionLabel = {
  connecting: '正在连接',
  connected: 'Codex 已连接',
  disconnected: '连接已断开',
  unavailable: 'Codex 不可用',
}

const imageTypes = new Set<CodexImageAttachment['mediaType']>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const maxImageSize = 8 * 1024 * 1024
const maxImagesPerTurn = 4
const longPasteThreshold = 4_000
const maxLongPasteChars = 24_000
const minComposerHeight = 45
const maxComposerHeight = 260
const composerPreferencesStorageKey = 'codex-remote.composer-preferences'
const composerDraftStorageKey = 'codex-remote.composer-draft'

interface ComposerPreferences {
  model?: string
  effort?: string
  approvalPolicy?: CodexApprovalPolicy
}

type AppTheme = 'light' | 'dark' | 'warm' | 'custom'

interface ThemePreferences {
  theme: AppTheme
  customBackgroundColor: string
  customTextColor: string
  customBackgroundTransparency: number
}

const themePreferencesStorageKey = 'codex-remote.theme-preferences'
const defaultThemePreferences: ThemePreferences = {
  theme: 'dark',
  customBackgroundColor: '#4b5563',
  customTextColor: '#f1f5f9',
  customBackgroundTransparency: 0,
}

function normalizeHexColor(value: unknown, fallback: string) {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toUpperCase() : fallback
}

function normalizeTransparency(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0
}

function readThemePreferences(): ThemePreferences {
  if (typeof window === 'undefined') return defaultThemePreferences
  try {
    const value = window.localStorage.getItem(themePreferencesStorageKey)
    if (!value) return defaultThemePreferences
    const parsed = JSON.parse(value) as Record<string, unknown>
    const theme = parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'warm' || parsed.theme === 'custom' ? parsed.theme : defaultThemePreferences.theme
    return {
      theme,
      customBackgroundColor: normalizeHexColor(parsed.customBackgroundColor, defaultThemePreferences.customBackgroundColor),
      customTextColor: normalizeHexColor(parsed.customTextColor, defaultThemePreferences.customTextColor),
      customBackgroundTransparency: normalizeTransparency(parsed.customBackgroundTransparency),
    }
  } catch {
    return defaultThemePreferences
  }
}

function rgbaFromHex(hex: string, alpha: number) {
  const value = normalizeHexColor(hex, '#4b5563').slice(1)
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`
}

function approvalPolicyOf(value: unknown): CodexApprovalPolicy | undefined {
  if (value === 'on-request' || value === 'untrusted' || value === 'never') return value
  // Migrate values saved by versions 0.0.20–0.0.24.
  if (value === 'onRequest') return 'on-request'
  if (value === 'unlessTrusted') return 'untrusted'
  return undefined
}

function readComposerPreferences(): ComposerPreferences {
  if (typeof window === 'undefined') return {}
  try {
    const value = window.localStorage.getItem(composerPreferencesStorageKey)
    if (!value) return {}
    const parsed = JSON.parse(value) as Record<string, unknown>
    return {
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      effort: typeof parsed.effort === 'string' ? parsed.effort : undefined,
      approvalPolicy: approvalPolicyOf(parsed.approvalPolicy),
    }
  } catch {
    return {}
  }
}

function saveComposerPreferences(preferences: ComposerPreferences) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(composerPreferencesStorageKey, JSON.stringify(preferences))
  } catch {
    // Ignore storage restrictions; the composer still works for this session.
  }
}

function readComposerDraft() {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(composerDraftStorageKey) ?? ''
  } catch {
    return ''
  }
}

function saveComposerDraft(draft: string) {
  if (typeof window === 'undefined') return
  try {
    if (draft) window.localStorage.setItem(composerDraftStorageKey, draft)
    else window.localStorage.removeItem(composerDraftStorageKey)
  } catch {
    // The composer still works for this session when storage is unavailable.
  }
}

function modelIdOf(model: CodexModel) {
  return model.model || model.id || ''
}

function modelLabelOf(model: CodexModel) {
  return model.displayName || modelIdOf(model) || '未命名模型'
}

function effortLabelOf(effort: string) {
  return ({ minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高' } as Record<string, string>)[effort] ?? effort
}

const approvalPolicyOptions: Array<{ value: CodexApprovalPolicy; label: string }> = [
  { value: 'on-request', label: '请求批准' },
  { value: 'untrusted', label: '帮我批准' },
  { value: 'never', label: '完全访问权限' },
]

function readImage(file: File): Promise<CodexImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const separator = result.indexOf(',')
      if (separator < 0) {
        reject(new Error(`无法读取图片：${file.name}`))
        return
      }
      resolve({ name: file.name || 'image', mediaType: file.type as CodexImageAttachment['mediaType'], data: result.slice(separator + 1) })
    }
    reader.readAsDataURL(file)
  })
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the legacy clipboard path for LAN HTTP pages.
  }
  const helper = document.createElement('textarea')
  helper.value = value
  helper.style.position = 'fixed'
  helper.style.opacity = '0'
  document.body.appendChild(helper)
  helper.focus()
  helper.select()
  const copied = document.execCommand('copy')
  helper.remove()
  return copied
}

function titleOf(thread: CodexThread) {
  const title = thread.name || thread.preview || '新对话'
  return title.length > 72 ? `${title.slice(0, 69)}…` : title
}

function timeOf(thread: CodexThread) {
  const value = thread.updatedAt ?? thread.createdAt
  if (typeof value !== 'number' && typeof value !== 'string') return ''
  const date = typeof value === 'number'
    ? new Date(value > 10_000_000_000 ? value : value * 1000)
    : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)
}

interface ComposerMenuOption {
  value: string
  label: string
}

function ComposerMenu({
  label,
  value,
  options,
  emptyLabel,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: ComposerMenuOption[]
  emptyLabel: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className={`composer-menu${open ? ' composer-menu--open' : ''}`} ref={root}>
      <button
        className="composer-menu__trigger"
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="composer-menu__label">{label}</span>
        <span className="composer-menu__value">{selected?.label ?? emptyLabel}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="composer-menu__popover" role="listbox" aria-label={label}>
          {options.length > 0 ? options.map((option) => (
            <button
              className={`composer-menu__option${option.value === value ? ' composer-menu__option--selected' : ''}`}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              <span className="composer-menu__option-copy">
                <strong>{option.label}</strong>
              </span>
              {option.value === value ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          )) : <span className="composer-menu__empty">{emptyLabel}</span>}
        </div>
      ) : null}
    </div>
  )
}

export function CodexRemotePage({ token, onUnauthorized, onUnpair }: Props) {
  const remote = useCodexRemote(token, onUnauthorized)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [themePreferences, setThemePreferences] = useState<ThemePreferences>(readThemePreferences)
  const [draft, setDraft] = useState(readComposerDraft)
  const [sending, setSending] = useState(false)
  const [selectedModel, setSelectedModel] = useState(() => readComposerPreferences().model ?? '')
  const [selectedEffort, setSelectedEffort] = useState(() => readComposerPreferences().effort ?? '')
  const [selectedApprovalPolicy, setSelectedApprovalPolicy] = useState<CodexApprovalPolicy>(() => readComposerPreferences().approvalPolicy ?? 'on-request')
  const [attachedImages, setAttachedImages] = useState<CodexImageAttachment[]>([])
  const [attachedDocument, setAttachedDocument] = useState<CodexDocumentAttachment | null>(null)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [composerHeight, setComposerHeight] = useState(72)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const messageContainer = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const resizeState = useRef<{ startY: number; startHeight: number } | null>(null)
  const copyResetTimer = useRef<number | undefined>(undefined)

  const chosenModel = remote.models.find((model) => modelIdOf(model) === selectedModel)
  const effortOptions = chosenModel?.supportedReasoningEfforts ?? []
  const customSurfaceOpacity = (100 - themePreferences.customBackgroundTransparency) / 100
  const themeStyle = {
    '--custom-theme-background': themePreferences.customBackgroundColor,
    '--custom-theme-text-color': themePreferences.customTextColor,
    '--custom-theme-surface': rgbaFromHex('#ffffff', Math.max(0.06, customSurfaceOpacity * 0.88)),
    '--custom-theme-control': rgbaFromHex('#ffffff', Math.max(0.04, customSurfaceOpacity * 0.72)),
    '--custom-theme-active': rgbaFromHex('#ffffff', Math.max(0.06, customSurfaceOpacity * 0.46)),
    '--custom-theme-border': rgbaFromHex(themePreferences.customTextColor, Math.max(0.12, customSurfaceOpacity * 0.32)),
    '--custom-theme-panel-blur': `${Math.min(18, 7 + customSurfaceOpacity * 11)}px`,
  } as CSSProperties

  useEffect(() => {
    try {
      window.localStorage.setItem(themePreferencesStorageKey, JSON.stringify(themePreferences))
    } catch {
      // Theme preferences still apply for the current session when storage is unavailable.
    }
  }, [themePreferences])

  useEffect(() => {
    saveComposerDraft(draft)
  }, [draft])

  useEffect(() => {
    const container = messageContainer.current
    if (container) container.scrollTop = container.scrollHeight
  }, [remote.messages, remote.isRunning, remote.activity])

  useEffect(() => {
    const interruptOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !remote.isRunning) return
      event.preventDefault()
      void remote.interrupt()
    }
    document.addEventListener('keydown', interruptOnEscape)
    return () => document.removeEventListener('keydown', interruptOnEscape)
  }, [remote.interrupt, remote.isRunning])

  useEffect(() => {
    const moveResize = (event: globalThis.PointerEvent) => {
      const resize = resizeState.current
      if (!resize) return
      const nextHeight = resize.startHeight + resize.startY - event.clientY
      setComposerHeight(Math.min(maxComposerHeight, Math.max(minComposerHeight, nextHeight)))
    }
    const endResize = () => {
      resizeState.current = null
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }
    window.addEventListener('pointermove', moveResize)
    window.addEventListener('pointerup', endResize)
    window.addEventListener('pointercancel', endResize)
    return () => {
      window.removeEventListener('pointermove', moveResize)
      window.removeEventListener('pointerup', endResize)
      window.removeEventListener('pointercancel', endResize)
      if (copyResetTimer.current !== undefined) window.clearTimeout(copyResetTimer.current)
    }
  }, [])

  useEffect(() => {
    if (remote.models.length === 0) return
    if (selectedModel && remote.models.some((model) => modelIdOf(model) === selectedModel)) return
    const defaultModel = remote.models.find((model) => model.isDefault) ?? remote.models[0]
    setSelectedModel(modelIdOf(defaultModel))
  }, [remote.models, selectedModel])

  useEffect(() => {
    if (remote.models.length === 0 || !chosenModel) return
    if (effortOptions.length === 0) {
      setSelectedEffort('')
      return
    }
    if (selectedEffort && effortOptions.some((option) => option.reasoningEffort === selectedEffort)) return
    setSelectedEffort(chosenModel?.defaultReasoningEffort ?? effortOptions[0].reasoningEffort)
  }, [chosenModel, effortOptions, remote.models.length, selectedEffort])

  useEffect(() => {
    if (!selectedModel && !selectedEffort && selectedApprovalPolicy === 'on-request') return
    saveComposerPreferences({
      model: selectedModel || undefined,
      effort: selectedEffort || undefined,
      approvalPolicy: selectedApprovalPolicy,
    })
  }, [selectedApprovalPolicy, selectedEffort, selectedModel])

  async function createThread() {
    setSidebarOpen(false)
    await remote.createThread(selectedModel || undefined, selectedApprovalPolicy)
    composer.current?.focus()
  }

  async function selectThread(thread: CodexThread) {
    setSidebarOpen(false)
    await remote.selectThread(thread)
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const prompt = draft.trim()
    if ((!prompt && attachedImages.length === 0 && !attachedDocument) || sending || remote.loadingHistory || remote.isRunning || remote.connection !== 'connected') return
    if (!modelSupportsImages && attachedImages.length > 0) {
      setAttachmentError('当前模型不支持图片输入，请选择支持图片的模型。')
      return
    }
    const previousDraft = draft
    const previousImages = attachedImages
    const previousDocument = attachedDocument
    const previousAttachmentError = attachmentError
    setSending(true)
    setDraft('')
    setAttachedImages([])
    setAttachedDocument(null)
    setAttachmentError(null)
    const sent = await remote.sendMessage({
      prompt,
      images: previousImages,
      document: previousDocument || undefined,
      model: selectedModel || undefined,
      effort: selectedEffort || undefined,
      approvalPolicy: selectedApprovalPolicy,
    })
    if (!sent) {
      setDraft((current) => !current ? previousDraft : !previousDraft ? current : `${previousDraft}${previousDraft.endsWith('\n') ? '' : '\n'}${current}`)
      setAttachedImages((current) => current.length > 0 ? [...previousImages, ...current].slice(0, maxImagesPerTurn) : previousImages)
      setAttachedDocument((current) => current ?? previousDocument)
      setAttachmentError((current) => current ?? previousAttachmentError)
    }
    setSending(false)
    composer.current?.focus()
  }

  async function attachImages(files: File[]) {
    if (files.length === 0) return
    if (!modelSupportsImages) {
      setAttachmentError('当前模型不支持图片输入，请选择支持图片的模型。')
      return
    }
    const candidates = files
    const unsupported = candidates.find((file) => !imageTypes.has(file.type as CodexImageAttachment['mediaType']))
    if (unsupported) {
      setAttachmentError('只支持 PNG、JPEG、WebP 和 GIF 图片。')
      return
    }
    const oversized = candidates.find((file) => file.size > maxImageSize)
    if (oversized) {
      setAttachmentError('单张图片不能超过 8 MB。')
      return
    }
    const remaining = maxImagesPerTurn - attachedImages.length
    if (remaining <= 0) {
      setAttachmentError('单条消息最多附加 4 张图片。')
      return
    }
    const chosen = candidates.slice(0, remaining)
    try {
      const next = await Promise.all(chosen.map(readImage))
      setAttachedImages((current) => [...current, ...next].slice(0, maxImagesPerTurn))
      setAttachmentError(candidates.length > remaining ? '单条消息最多附加 4 张图片，其余图片未添加。' : null)
    } catch (reason) {
      setAttachmentError(reason instanceof Error ? reason.message : '图片读取失败。')
    }
  }

  function handleInputKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    const canSubmit = (draft.trim().length > 0 || attachedImages.length > 0 || attachedDocument !== null)
      && !sending
      && !remote.loadingHistory
      && !remote.isRunning
      && remote.connection === 'connected'
    if (event.key !== 'Enter' || event.shiftKey || !canSubmit) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const directFiles = Array.from(event.clipboardData.files)
    const itemFiles = Array.from(event.clipboardData.items)
      .map((item) => item.kind === 'file' ? item.getAsFile() : null)
      .filter((file): file is File => file !== null)
    const images = (directFiles.length > 0 ? directFiles : itemFiles).filter((file) => file.type.startsWith('image/'))
    if (images.length > 0) {
      event.preventDefault()
      void attachImages(images)
      return
    }
    const pastedText = event.clipboardData.getData('text/plain')
    if (pastedText.length < longPasteThreshold) return
    event.preventDefault()
    if (pastedText.length > maxLongPasteChars) {
      setAttachmentError(`粘贴内容过长，最多支持 ${maxLongPasteChars.toLocaleString()} 个字符。`)
      return
    }
    setAttachedDocument({ name: 'pasted-content.md', content: pastedText })
    setAttachmentError(null)
  }

  function startComposerResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    resizeState.current = { startY: event.clientY, startHeight: composerHeight }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  async function copyMessage(message: CodexMessage) {
    const documentText = message.documents?.map((document) => `\n\n${document.name}\n${document.content}`).join('') ?? ''
    const value = `${message.text}${documentText}`.trim()
    if (!value || !(await copyText(value))) return
    setCopiedMessageId(message.id)
    if (copyResetTimer.current !== undefined) window.clearTimeout(copyResetTimer.current)
    copyResetTimer.current = window.setTimeout(() => setCopiedMessageId(null), 1600)
  }

  const activeTitle = remote.activeThread ? titleOf(remote.activeThread) : '新对话'
  const modelSupportsImages = !chosenModel || !Array.isArray(chosenModel.inputModalities) || chosenModel.inputModalities.includes('image')
  const canCompose = !sending && !remote.loadingHistory && !remote.isRunning && remote.connection === 'connected'
  const canSend = (draft.trim().length > 0 || attachedImages.length > 0 || attachedDocument !== null) && canCompose
  const canAttachImages = canCompose && modelSupportsImages
  const hasStreamingAssistant = remote.messages.some((message) => message.role === 'assistant' && message.streaming)
  const modelOptions: ComposerMenuOption[] = remote.models.flatMap((model) => {
    const id = modelIdOf(model)
    if (!id) return []
    return [{ value: id, label: modelLabelOf(model) }]
  })
  const reasoningOptions: ComposerMenuOption[] = effortOptions.map((option) => ({
    value: option.reasoningEffort,
    label: effortLabelOf(option.reasoningEffort),
  }))
  const authorizationOptions: ComposerMenuOption[] = approvalPolicyOptions

  return (
    <div className={`remote-shell remote-shell--theme-${themePreferences.theme}`} style={themeStyle}>
      <aside className={`remote-sidebar${sidebarOpen ? ' remote-sidebar--open' : ''}`} aria-label="Codex 对话记录">
        <div className="remote-sidebar__heading">
          <div className="remote-brand"><span className="remote-brand__mark">C</span><span className="remote-brand__copy"><strong>Codex Remote</strong><small>本机 Agent 工作台</small></span></div>
          <button className="icon-button remote-sidebar__close" type="button" aria-label="关闭对话列表" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>
        <button className="new-thread-button" type="button" onClick={() => void createThread()} disabled={remote.connection !== 'connected' || remote.loadingHistory}><span className="new-thread-button__icon"><Plus size={16} /></span><span>新建对话</span></button>
        <div className="thread-list-heading"><span>最近对话</span><button className="icon-button" type="button" aria-label="刷新对话记录" onClick={() => void remote.refreshThreads()}><RefreshCw size={14} /></button></div>
        <nav className="thread-list">
          {remote.threads.map((thread) => (
            <button className={`thread-row${remote.activeThread?.id === thread.id ? ' thread-row--active' : ''}`} type="button" key={thread.id} onClick={() => void selectThread(thread)} aria-current={remote.activeThread?.id === thread.id ? 'page' : undefined}>
              <MessageSquare size={15} />
              <span className="thread-row__copy"><strong>{titleOf(thread)}</strong><small>{timeOf(thread)}</small></span>
            </button>
          ))}
          {remote.threads.length === 0 && !remote.loadingHistory ? <p className="thread-list__empty">还没有对话</p> : null}
          {remote.loadingHistory && remote.threads.length === 0 ? <p className="thread-list__empty"><LoaderCircle className="spin" size={14} />读取对话中</p> : null}
        </nav>
        <button className={`sidebar-settings${settingsOpen ? ' sidebar-settings--active' : ''}`} type="button" onClick={() => { setSettingsOpen(true); setSidebarOpen(false) }}>
          <Settings2 size={16} />
          <span>设置</span>
        </button>
        <footer className="remote-sidebar__footer">
          <i className={`status-dot status-dot--${remote.connection}`} />
          <span>{connectionLabel[remote.connection]}</span>
          <button type="button" onClick={() => void onUnpair()}>退出</button>
        </footer>
      </aside>

      {sidebarOpen ? <button className="sidebar-backdrop" type="button" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} /> : null}

      {settingsOpen ? (
        <ThemeSettingsPanel preferences={themePreferences} onChange={setThemePreferences} onClose={() => setSettingsOpen(false)} />
      ) : <main className="remote-chat">
        <header className="remote-chat__header">
          <div className="remote-chat__title-wrap">
            <button className="icon-button menu-button" type="button" aria-label="打开对话列表" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
            <div className="remote-chat__title"><span className="remote-chat__eyebrow">当前工作区</span><strong>{activeTitle}</strong><span title={remote.activeThread?.cwd || remote.runtime.workspace}>{remote.activeThread?.cwd || remote.runtime.workspace || '本机项目'}</span></div>
          </div>
          <div className="remote-chat__controls">
            <div className={`connection-label connection-label--${remote.connection}`}><i className={`status-dot status-dot--${remote.connection}`} /><span>{connectionLabel[remote.connection]}</span></div>
          </div>
        </header>

        <section className="message-stream" ref={messageContainer} aria-live="polite" aria-label="Codex 对话">
          {remote.messages.length === 0 && !remote.loadingHistory ? (
            <div className="welcome-state">
              <span className="welcome-state__eyebrow">CODEX REMOTE · LOCAL AGENT</span>
              <span className="welcome-state__mark">C</span>
              <h1>你想在本机项目中完成什么？</h1>
              <p>消息交给本机 Codex 处理，回复会实时显示在这里。</p>
              <div className="prompt-suggestions">
                <button type="button" onClick={() => setDraft('先阅读这个项目，概括目录结构和主要技术栈。')}>了解这个项目</button>
                <button type="button" onClick={() => setDraft('检查当前代码中最值得优先处理的问题，并说明依据。')}>检查代码问题</button>
              </div>
            </div>
          ) : null}
          {remote.loadingHistory && remote.messages.length === 0 ? <div className="loading-state"><LoaderCircle className="spin" size={18} />正在加载对话…</div> : null}
          {remote.messages.map((message) => <MessageBubble key={message.id} message={message} activity={message.streaming ? remote.activity : null} copied={copiedMessageId === message.id} onCopy={() => void copyMessage(message)} />)}
          {remote.fileChanges.length > 0 ? <FileChangeCard changes={remote.fileChanges} /> : null}
          {remote.approval ? (
            <div className="approval-card" role="alert">
              <div className="approval-card__heading"><AlertTriangle size={17} /><strong>Codex 需要你的批准</strong></div>
              <p>{typeof remote.approval.params.reason === 'string' ? remote.approval.params.reason : 'Codex 请求执行一项需要批准的操作。'}</p>
              {typeof remote.approval.params.command === 'string' ? <code>{remote.approval.params.command}</code> : null}
              {typeof remote.approval.params.cwd === 'string' ? <small>目录：{remote.approval.params.cwd}</small> : null}
              <div className="approval-card__actions">
                <button type="button" onClick={() => remote.respondToApproval('decline')}><X size={14} />拒绝</button>
                <button className="approval-card__accept" type="button" onClick={() => remote.respondToApproval('accept')}><Check size={14} />允许一次</button>
              </div>
            </div>
          ) : null}
          {remote.isRunning && !hasStreamingAssistant ? (
            <div className="running-indicator" role="status" aria-live="polite">
              <span className="running-indicator__activity">
                <LoaderCircle className="spin" size={15} />
                <span>{remote.activity?.label ?? '正在思考'}</span>
                {remote.activity?.detail ? <small>{remote.activity.detail}</small> : null}
              </span>
            </div>
          ) : null}
        </section>

        {remote.error ? (
          <div className="remote-error" role="alert">
            <AlertTriangle size={15} />
            <span>{remote.error}</span>
            {remote.writerConflict ? <button type="button" onClick={() => void createThread()} disabled={remote.connection !== 'connected' || remote.loadingHistory}><Plus size={13} />新建远程对话</button> : null}
          </div>
        ) : null}

        <form className={`message-composer${remote.isRunning ? ' message-composer--running' : ''}`} onSubmit={(event) => void send(event)}>
          {attachedImages.length > 0 ? (
            <div className="composer-images" aria-label="待发送图片">
              {attachedImages.map((image, index) => <span className="composer-image" key={`${image.name}-${index}`}><img src={`data:${image.mediaType};base64,${image.data}`} alt={image.name} /><button type="button" onClick={() => setAttachedImages((current) => current.filter((_, currentIndex) => currentIndex !== index))} aria-label={`移除图片 ${image.name}`}><X size={12} /></button></span>)}
            </div>
          ) : null}
          {attachmentError ? <p className="attachment-error" role="alert">{attachmentError}</p> : null}
          {attachedDocument ? (
            <div className="composer-document" aria-label="待发送文档">
              <FileText size={16} />
              <span><strong>{attachedDocument.name}</strong><small>{attachedDocument.content.length.toLocaleString()} 个字符 · 将随消息发送</small></span>
              <button type="button" onClick={() => setAttachedDocument(null)} aria-label="移除文档"><X size={13} /></button>
            </div>
          ) : null}
          <div className="composer-editor" style={{ height: `${composerHeight}px` }}>
            <button className="composer-resize" type="button" onPointerDown={startComposerResize} aria-label="调整输入框高度" title="上下拖动调整输入框高度"><ChevronsUpDown size={14} /></button>
            <textarea ref={composer} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleInputKey} onPaste={handlePaste} disabled={remote.connection !== 'connected' || remote.loadingHistory} placeholder={remote.loadingHistory ? '正在恢复对话…' : remote.connection !== 'connected' ? '等待本机 Codex 连接…' : remote.isRunning || sending ? 'Codex 正在回复，可继续编辑下一条消息…' : '给 Codex 发送消息…'} aria-label="发送消息给 Codex" />
          </div>
          <div className="message-composer__footer">
            <div className="composer-preferences">
              <ComposerMenu label="模型" value={selectedModel} options={modelOptions} emptyLabel="读取模型…" disabled={!canCompose || remote.models.length === 0} onChange={setSelectedModel} />
              <ComposerMenu label="思考" value={selectedEffort} options={reasoningOptions} emptyLabel="默认" disabled={!canCompose || effortOptions.length === 0} onChange={setSelectedEffort} />
              <ComposerMenu label="授权" value={selectedApprovalPolicy} options={authorizationOptions} emptyLabel="请求批准" disabled={!canCompose} onChange={(value) => setSelectedApprovalPolicy(value as CodexApprovalPolicy)} />
              <span className="composer-hint"><ShieldCheck size={14} />Enter 发送 · Shift+Enter 换行</span>
            </div>
            <div className="composer-actions">
              <span className={`attach-button attach-button--native${canAttachImages ? '' : ' attach-button--disabled'}`} title={modelSupportsImages ? '附加图片' : '当前模型不支持图片输入'}>
                <ImagePlus size={16} />
                <input className="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={!canAttachImages} onChange={(event) => { void attachImages(Array.from(event.target.files ?? [])); event.currentTarget.value = '' }} aria-label="附加图片" />
              </span>
              {remote.writerConflict ? (
                <button className="stop-button" type="button" onClick={remote.refreshActiveThread}><RefreshCw size={13} />刷新状态</button>
              ) : remote.isRunning ? (
                <button className="stop-button" type="button" onClick={() => void remote.interrupt()} disabled={remote.isInterrupting}>{remote.isInterrupting ? <LoaderCircle className="spin" size={13} /> : <Square size={13} fill="currentColor" />}{remote.isInterrupting ? '停止中' : '停止'}</button>
              ) : (
                <button className="send-button" type="submit" disabled={!canSend} aria-label="发送消息">{sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button>
              )}
            </div>
          </div>
        </form>
      </main>}
    </div>
  )
}

function ThemeSettingsPanel({ preferences, onChange, onClose }: { preferences: ThemePreferences; onChange: (next: ThemePreferences) => void; onClose: () => void }) {
  const themeOptions: Array<{ value: AppTheme; label: string; description: string; previewClass: string }> = [
    { value: 'light', label: '白色', description: '清爽明亮', previewClass: 'theme-option__preview--light' },
    { value: 'dark', label: '黑色', description: '低光阅读', previewClass: 'theme-option__preview--dark' },
    { value: 'warm', label: '暖色', description: '柔和纸感', previewClass: 'theme-option__preview--warm' },
    { value: 'custom', label: '自定义颜色', description: '背景与文字', previewClass: 'theme-option__preview--custom' },
  ]

  return (
    <main className="theme-settings-panel" aria-label="主题设置">
      <header className="theme-settings-panel__header">
        <div>
          <span className="theme-settings-panel__eyebrow">PREFERENCES</span>
          <h1>设置</h1>
          <p>主题偏好只保存在当前浏览器，不会影响 Codex 会话。</p>
        </div>
        <button className="icon-button theme-settings-panel__close" type="button" aria-label="返回对话" onClick={onClose}><X size={18} /></button>
      </header>

      <div className="theme-settings-panel__content">
        <section className="theme-settings-card">
          <div className="theme-settings-card__heading"><div><h2>主题</h2><p>选择工作区的基础色彩。</p></div><span className="theme-settings-card__badge">即时预览</span></div>
          <div className="theme-options" role="radiogroup" aria-label="界面主题">
            {themeOptions.map((option) => (
              <button
                className={`theme-option${preferences.theme === option.value ? ' theme-option--active' : ''}`}
                type="button"
                role="radio"
                aria-checked={preferences.theme === option.value}
                key={option.value}
                onClick={() => onChange({ ...preferences, theme: option.value })}
              >
                <span className={`theme-option__preview ${option.previewClass}`} style={option.value === 'custom' ? { background: preferences.customBackgroundColor } : undefined} aria-hidden="true" />
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
              </button>
            ))}
          </div>

          {preferences.theme === 'custom' ? (
            <div className="theme-custom-controls">
              <label className="theme-control-row">
                <span><strong>背景颜色</strong><small>作为半透明面板背后的底色。</small></span>
                <span className="theme-color-input"><input type="color" value={preferences.customBackgroundColor} onChange={(event) => onChange({ ...preferences, customBackgroundColor: normalizeHexColor(event.target.value, preferences.customBackgroundColor) })} aria-label="自定义背景颜色" /><code>{preferences.customBackgroundColor}</code></span>
              </label>
              <label className="theme-control-row">
                <span><strong>字体颜色</strong><small>应用于工作区界面文字和控件。</small></span>
                <span className="theme-color-input"><input type="color" value={preferences.customTextColor} onChange={(event) => onChange({ ...preferences, customTextColor: normalizeHexColor(event.target.value, preferences.customTextColor) })} aria-label="自定义字体颜色" /><code>{preferences.customTextColor}</code></span>
              </label>
              <label className="theme-control-row theme-control-row--stacked">
                <span><strong>背景透明度</strong><small>数值越高，界面面板越透明。</small></span>
                <span className="theme-range-input"><input type="range" min="0" max="100" step="1" value={preferences.customBackgroundTransparency} onChange={(event) => onChange({ ...preferences, customBackgroundTransparency: normalizeTransparency(Number(event.target.value)) })} aria-label="自定义背景透明度" /><output>{preferences.customBackgroundTransparency}%</output></span>
              </label>
            </div>
          ) : <p className="theme-settings-hint">切换主题后会立即应用到侧边栏、聊天区和输入框。</p>}
        </section>
      </div>
    </main>
  )
}

function MessageContent({ text }: { text: string }) {
  const codePattern = /```([^\n]*)\n([\s\S]*?)```/g
  const blocks: Array<{ type: 'text' | 'code'; value: string; language?: string }> = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = codePattern.exec(text)) !== null) {
    if (match.index > cursor) blocks.push({ type: 'text', value: text.slice(cursor, match.index) })
    blocks.push({ type: 'code', value: match[2].replace(/\n$/, ''), language: match[1].trim() || undefined })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) blocks.push({ type: 'text', value: text.slice(cursor) })
  if (blocks.length === 0) blocks.push({ type: 'text', value: text })

  return (
    <div className="chat-message__content">
      {blocks.map((block, index) => block.type === 'code'
        ? <CodeBlock key={`code-${index}`} value={block.value} language={block.language} />
        : <div className="chat-message__text" key={`text-${index}`}>{block.value}</div>)}
    </div>
  )
}

function CodeBlock({ value, language }: { value: string; language?: string }) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => {
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current)
  }, [])

  async function copyCode() {
    if (!(await copyText(value))) return
    setCopied(true)
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <pre className="chat-message__code">
      <code data-language={language}>{value}</code>
      <button className="chat-message__code-copy" type="button" onClick={() => void copyCode()} aria-label={copied ? '代码已复制' : '复制代码'}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? '已复制' : '复制'}
      </button>
    </pre>
  )
}

function FileChangeCard({ changes }: { changes: CodexFileChange[] }) {
  const [expanded, setExpanded] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const files = [...changes.reduce((entries, change) => {
    for (const item of change.changes) {
      const previous = entries.get(item.path)
      if (!previous) {
        entries.set(item.path, { ...item })
        continue
      }
      const diffs = [previous.diff, item.diff].filter((diff): diff is string => Boolean(diff))
      entries.set(item.path, {
        ...previous,
        kind: item.kind ?? previous.kind,
        diff: diffs.length > 0 ? diffs.join('\n\n') : undefined,
        additions: previous.additions + item.additions,
        deletions: previous.deletions + item.deletions,
      })
    }
    return entries
  }, new Map<string, CodexFileChange['changes'][number]>()).values()]
  const additions = files.reduce((total, item) => total + item.additions, 0)
  const deletions = files.reduce((total, item) => total + item.deletions, 0)
  const inProgress = changes.some((change) => change.status === 'inProgress')
  const showAll = expanded || reviewing
  const visibleFiles = showAll ? files : files.slice(0, 3)
  const hiddenCount = files.length - 3

  function toggleFiles() {
    if (showAll) {
      setExpanded(false)
      setReviewing(false)
      return
    }
    setExpanded(true)
  }

  return (
    <article className={`file-change-card${inProgress ? ' file-change-card--inProgress' : ''}`}>
      <header className="file-change-card__heading">
        <span className="file-change-card__icon"><FileText size={15} /></span>
        <div className="file-change-card__summary">
          <strong>{inProgress ? '正在编辑' : '已编辑'} {files.length} 个文件</strong>
          <span className="file-change-card__stats"><i>+{additions}</i><em>-{deletions}</em></span>
        </div>
        <button className={`file-change-card__review${reviewing ? ' file-change-card__review--active' : ''}`} type="button" aria-expanded={reviewing} onClick={() => setReviewing((current) => !current)}>
          {reviewing ? '收起审核' : '审核'}
        </button>
      </header>
      <div className="file-change-card__files">
        {visibleFiles.map((item) => (
          <div className="file-change-card__file" key={item.path}>
            <div className="file-change-card__file-row">
              <span title={item.path}>{item.path}</span>
              <span className="file-change-card__file-stats"><i>+{item.additions}</i><em>-{item.deletions}</em></span>
            </div>
            {reviewing ? (
              item.diff
                ? <pre>{item.diff}</pre>
                : <small>{item.kind === 'add' ? '新增文件' : item.kind === 'delete' ? '删除文件' : '文件已更新'}</small>
            ) : null}
          </div>
        ))}
      </div>
      {hiddenCount > 0 ? (
        <button className="file-change-card__more" type="button" aria-expanded={showAll} onClick={toggleFiles}>
          {showAll ? '收起文件' : `再显示 ${hiddenCount} 个文件`}
          <ChevronDown size={14} />
        </button>
      ) : null}
    </article>
  )
}

function MessageBubble({ message, activity, copied, onCopy }: { message: CodexMessage; activity: CodexActivity | null; copied: boolean; onCopy: () => void }) {
  const showCopyAction = Boolean(message.text || message.documents?.length)

  return (
    <article className={`chat-message chat-message--${message.role}`}>
      <span className="chat-message__avatar">{message.role === 'user' ? '你' : 'C'}</span>
      <div className={`chat-message__body${message.role === 'user' && showCopyAction ? ' chat-message__body--copy-outside' : ''}`}>
        <div className="chat-message__meta">
          {message.role === 'assistant' ? <strong>Codex</strong> : null}
          {message.streaming ? (
            <span className="chat-message__activity" aria-live="polite">
              <LoaderCircle className="spin" size={12} />{activity?.label ?? '正在回复'}
              {activity?.detail ? <small title={activity.detail}>{activity.detail}</small> : null}
            </span>
          ) : null}
        </div>
        {message.images?.length ? <div className="chat-message__images">{message.images.map((image, index) => <img key={`${image.name}-${index}`} src={image.previewUrl} alt={image.name} />)}</div> : null}
        {message.documents?.map((document) => <div className="message-document" key={document.name}><FileText size={15} /><span><strong>{document.name}</strong><small>{document.charCount.toLocaleString()} 个字符</small></span></div>)}
        {message.text ? <MessageContent text={message.text} /> : null}
        {message.streaming ? <i className="stream-cursor" aria-hidden="true" /> : null}
        {showCopyAction ? <div className="chat-message__actions"><button type="button" onClick={onCopy}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button></div> : null}
      </div>
    </article>
  )
}

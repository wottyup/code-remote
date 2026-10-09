import { Fragment, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  File,
  FileText,
  Folder,
  FolderOpen,
  ImagePlus,
  Link2,
  LoaderCircle,
  Menu,
  MessagesSquare,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react'
import { useCodexRemote, type CodexActivity, type CodexFileChange, type CodexRemoteController, type QueuedTurnMessage } from '../hooks/useCodexRemote'
import { codexRemoteClient, type CodexApprovalPolicy, type CodexDocumentAttachment, type CodexImageAttachment, type CodexMessage, type CodexModel, type CodexThread, type CodexWorkspaceEntry, type CodexWorkspaceTree } from '../lib/codexRemoteClient'

interface Props {
  token: string
  onUnauthorized: () => void
  onUnpair: () => void | Promise<void>
}

declare global {
  interface Window {
    CodexRemoteAndroid?: {
      changeEndpoint?: () => void
      showKeyboard?: () => void
    }
    CodexRemoteHandleBack?: () => boolean
  }
}

const connectionLabel = {
  connecting: '正在连接',
  connected: 'Codex 已连接',
  disconnected: '连接已断开',
  unavailable: 'Codex 不可用',
}

const threadTimeFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })
const threadDateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })
const imageTypes = new Set<CodexImageAttachment['mediaType']>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const themeImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const maxImageSize = 8 * 1024 * 1024
const maxThemeImageSize = 2 * 1024 * 1024
const maxThemeImageDataUrlLength = Math.ceil(maxThemeImageSize * 4 / 3) + 256
const maxImagesPerTurn = 4
const maxDocumentsPerTurn = 8
const longPasteThreshold = 4_000
const maxLongPasteChars = 24_000
const workspaceTreeMaxEntries = 400
const workspaceFileDragMime = 'application/x-codex-workspace-file'
const workspaceFileDragTextPrefix = 'codex-remote-workspace-file:'
const minComposerHeight = 45
const maxComposerHeight = 260
const composerPreferencesStorageKey = 'codex-remote.composer-preferences'
const threadComposerPreferencesStorageKey = 'codex-remote.thread-composer-preferences'
const legacyComposerDraftStorageKey = 'codex-remote.composer-draft'
const composerDraftStoragePrefix = 'codex-remote.composer-draft.'
const newThreadComposerDraftScope = 'new'

interface ComposerPreferences {
  model?: string
  effort?: string
  approvalPolicy?: CodexApprovalPolicy
}

type ThreadComposerPreferences = Record<string, ComposerPreferences>

type AppTheme = 'light' | 'dark' | 'warm' | 'custom'

interface ThemePreferences {
  theme: AppTheme
  customBackgroundColor: string
  customTextColor: string
  customBackgroundTransparency: number
  customBackgroundImage?: string
}

const themePreferencesStorageKey = 'codex-remote.theme-preferences'
const defaultThemePreferences: ThemePreferences = {
  theme: 'dark',
  customBackgroundColor: '#4b5563',
  customTextColor: '#f1f5f9',
  customBackgroundTransparency: 0,
}

function hasWorkspaceFileDrag(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types)
  return types.includes(workspaceFileDragMime) || types.includes('text/plain')
}

function workspaceFilePathFromDrag(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return ''
  const raw = dataTransfer.getData(workspaceFileDragMime)
  try {
    const value = JSON.parse(raw) as { path?: unknown }
    if (typeof value.path === 'string' && value.path) return value.path
  } catch {
    // Some browsers strip custom MIME data while dragging inside a page.
  }
  const fallback = dataTransfer.getData('text/plain')
  return fallback.startsWith(workspaceFileDragTextPrefix)
    ? fallback.slice(workspaceFileDragTextPrefix.length)
    : ''
}

function workspaceAbsolutePath(cwd: string | undefined, path: string) {
  const base = cwd?.replace(/[\\/]+$/, '')
  return base ? `${base}/${path}` : path
}

function normalizeHexColor(value: unknown, fallback: string) {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toUpperCase() : fallback
}

function normalizeTransparency(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0
}

function normalizeThemeBackgroundImage(value: unknown) {
  if (typeof value !== 'string' || value.length > maxThemeImageDataUrlLength) return undefined
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : undefined
}

function readThemePreferences(): ThemePreferences {
  if (typeof window === 'undefined') return defaultThemePreferences
  try {
    const value = window.localStorage.getItem(themePreferencesStorageKey)
    if (!value) return defaultThemePreferences
    const parsed = JSON.parse(value) as Record<string, unknown>
    const theme = parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'warm' || parsed.theme === 'custom' ? parsed.theme : defaultThemePreferences.theme
    const customBackgroundImage = normalizeThemeBackgroundImage(parsed.customBackgroundImage)
    return {
      theme,
      customBackgroundColor: normalizeHexColor(parsed.customBackgroundColor, defaultThemePreferences.customBackgroundColor),
      customTextColor: normalizeHexColor(parsed.customTextColor, defaultThemePreferences.customTextColor),
      customBackgroundTransparency: normalizeTransparency(parsed.customBackgroundTransparency),
      ...(customBackgroundImage ? { customBackgroundImage } : {}),
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

function composerPreferencesFrom(value: unknown): ComposerPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const parsed = value as Record<string, unknown>
  const preferences: ComposerPreferences = {}
  if (typeof parsed.model === 'string' && parsed.model) preferences.model = parsed.model
  if (typeof parsed.effort === 'string' && parsed.effort) preferences.effort = parsed.effort
  const approvalPolicy = approvalPolicyOf(parsed.approvalPolicy)
  if (approvalPolicy) preferences.approvalPolicy = approvalPolicy
  return preferences
}

function mergeComposerPreferences(current: ComposerPreferences, changes: Partial<ComposerPreferences>) {
  return composerPreferencesFrom({ ...current, ...changes })
}

function resolvedComposerPreferences(defaults: ComposerPreferences, threadPreferences?: ComposerPreferences): ComposerPreferences {
  return {
    model: threadPreferences?.model ?? defaults.model,
    effort: threadPreferences?.effort ?? defaults.effort,
    approvalPolicy: threadPreferences?.approvalPolicy ?? defaults.approvalPolicy,
  }
}

function readComposerPreferences(): ComposerPreferences {
  if (typeof window === 'undefined') return {}
  try {
    const value = window.localStorage.getItem(composerPreferencesStorageKey)
    if (!value) return {}
    return composerPreferencesFrom(JSON.parse(value))
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

function readThreadComposerPreferences(): ThreadComposerPreferences {
  if (typeof window === 'undefined') return {}
  try {
    const value = window.localStorage.getItem(threadComposerPreferencesStorageKey)
    if (!value) return {}
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const preferences: ThreadComposerPreferences = {}
    for (const [threadId, savedPreferences] of Object.entries(parsed as Record<string, unknown>)) {
      if (!threadId || threadId.length > 512) continue
      preferences[threadId] = composerPreferencesFrom(savedPreferences)
    }
    return preferences
  } catch {
    return {}
  }
}

function saveThreadComposerPreferences(preferences: ThreadComposerPreferences) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(threadComposerPreferencesStorageKey, JSON.stringify(preferences))
  } catch {
    // Ignore storage restrictions; the composer still works for this session.
  }
}

function composerDraftScopeForThread(threadId?: string) {
  return threadId ? `thread:${threadId}` : newThreadComposerDraftScope
}

function composerDraftStorageKeyFor(scope: string) {
  return `${composerDraftStoragePrefix}${encodeURIComponent(scope)}`
}

function readComposerDraft(scope: string) {
  if (typeof window === 'undefined') return ''
  try {
    const storageKey = composerDraftStorageKeyFor(scope)
    const savedDraft = window.localStorage.getItem(storageKey)
    if (savedDraft !== null) return savedDraft
    // Keep an existing draft from older versions, but assign it to the first
    // active scope instead of continuing to leak it into every conversation.
    const legacyDraft = window.localStorage.getItem(legacyComposerDraftStorageKey)
    if (!legacyDraft) return ''
    window.localStorage.setItem(storageKey, legacyDraft)
    window.localStorage.removeItem(legacyComposerDraftStorageKey)
    return legacyDraft
  } catch {
    return ''
  }
}

function saveComposerDraft(scope: string, draft: string) {
  if (typeof window === 'undefined') return
  try {
    const storageKey = composerDraftStorageKeyFor(scope)
    if (draft) window.localStorage.setItem(storageKey, draft)
    else window.localStorage.removeItem(storageKey)
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

function readThemeBackgroundImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? normalizeThemeBackgroundImage(reader.result) : undefined
      if (result) resolve(result)
      else reject(new Error('背景图片格式无效或图片过大。'))
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
    ? threadTimeFormatter.format(date)
    : threadDateFormatter.format(date)
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
  open,
  onOpenChange,
  onChange,
}: {
  label: string
  value: string
  options: ComposerMenuOption[]
  emptyLabel: string
  disabled?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (value: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [onOpenChange, open])

  return (
    <div className={`composer-menu${open ? ' composer-menu--open' : ''}`} ref={root}>
      <button
        className="composer-menu__trigger"
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
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
                onOpenChange(false)
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

type RemoteConnection = keyof typeof connectionLabel

interface ComposerSendInput {
  prompt: string
  images: CodexImageAttachment[]
  documents?: CodexDocumentAttachment[]
  model?: string
  effort?: string
  approvalPolicy?: CodexApprovalPolicy
}

interface ComposerHandle {
  replaceDraft(value: string): void
  appendDraft(value: string): void
  adoptUnassignedDraft(threadId: string): void
  closeOpenMenu(): boolean
}

interface MessageComposerProps {
  draftScope: string
  connection: RemoteConnection
  isRunning: boolean
  isInterrupting: boolean
  writerConflict: boolean
  modelSupportsImages: boolean
  selectedModel: string
  selectedEffort: string
  selectedApprovalPolicy: CodexApprovalPolicy
  modelOptions: ComposerMenuOption[]
  reasoningOptions: ComposerMenuOption[]
  authorizationOptions: ComposerMenuOption[]
  onModelChange: (model: string) => void
  onEffortChange: (effort: string) => void
  onApprovalPolicyChange: (approvalPolicy: CodexApprovalPolicy) => void
  onSend: (input: ComposerSendInput) => Promise<boolean>
  queuedMessages: QueuedTurnMessage[]
  onSendQueuedNow: (messageId: string) => Promise<boolean>
  onRemoveQueued: (messageId: string) => void
  onInsertWorkspacePath: (path: string) => void
  onInterrupt: () => void
  onRefresh: () => void
}

const MessageComposer = memo(forwardRef<ComposerHandle, MessageComposerProps>(function MessageComposer({
  draftScope,
  connection,
  isRunning,
  isInterrupting,
  writerConflict,
  modelSupportsImages,
  selectedModel,
  selectedEffort,
  selectedApprovalPolicy,
  modelOptions,
  reasoningOptions,
  authorizationOptions,
  onModelChange,
  onEffortChange,
  onApprovalPolicyChange,
  onSend,
  queuedMessages,
  onSendQueuedNow,
  onRemoveQueued,
  onInsertWorkspacePath,
  onInterrupt,
  onRefresh,
}, ref) {
  const [draft, setDraft] = useState(() => readComposerDraft(draftScope))
  const [sending, setSending] = useState(false)
  const [attachedImages, setAttachedImages] = useState<CodexImageAttachment[]>([])
  const [attachedDocuments, setAttachedDocuments] = useState<CodexDocumentAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [composerHeight, setComposerHeight] = useState(72)
  const [sendingQueuedId, setSendingQueuedId] = useState<string | null>(null)
  const [openMenu, setOpenMenu] = useState<'model' | 'effort' | 'approval' | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const draftRef = useRef(draft)
  const openMenuRef = useRef<'model' | 'effort' | 'approval' | null>(null)
  const draftSaveTimer = useRef<number | undefined>(undefined)
  const resizeState = useRef<{ startY: number; startHeight: number } | null>(null)
  const inputIsComposing = useRef(false)

  const changeOpenMenu = useCallback((next: 'model' | 'effort' | 'approval' | null) => {
    openMenuRef.current = next
    setOpenMenu(next)
  }, [])

  const updateDraft = useCallback((next: string | ((current: string) => string)) => {
    setDraft((current) => {
      const value = typeof next === 'function' ? next(current) : next
      draftRef.current = value
      return value
    })
  }, [])

  useImperativeHandle(ref, () => ({
    replaceDraft(value) {
      updateDraft(value)
      window.requestAnimationFrame(() => composer.current?.focus())
    },
    appendDraft(value) {
      const current = draftRef.current
      const separator = current && !/\s$/.test(current) ? '\n' : ''
      updateDraft(`${current}${separator}${value}`)
      window.requestAnimationFrame(() => composer.current?.focus())
    },
    adoptUnassignedDraft(threadId) {
      const targetScope = composerDraftScopeForThread(threadId)
      const unassignedDraft = draftScope === newThreadComposerDraftScope
        ? draftRef.current
        : readComposerDraft(newThreadComposerDraftScope)
      if (!unassignedDraft) return
      saveComposerDraft(targetScope, unassignedDraft)
      // The old keyed composer may unmount immediately after this callback.
      // Keep its cleanup from restoring the transferred text to the new-chat scope.
      if (draftScope === newThreadComposerDraftScope) {
        if (draftSaveTimer.current !== undefined) window.clearTimeout(draftSaveTimer.current)
        draftSaveTimer.current = undefined
        draftRef.current = ''
      }
      saveComposerDraft(newThreadComposerDraftScope, '')
      if (draftScope === targetScope) updateDraft(unassignedDraft)
    },
    closeOpenMenu() {
      if (!openMenuRef.current) return false
      changeOpenMenu(null)
      return true
    },
  }), [changeOpenMenu, draftScope, updateDraft])

  useEffect(() => {
    if (draftSaveTimer.current !== undefined) window.clearTimeout(draftSaveTimer.current)
    const timer = window.setTimeout(() => saveComposerDraft(draftScope, draft), 260)
    draftSaveTimer.current = timer
    return () => {
      if (draftSaveTimer.current !== timer) return
      window.clearTimeout(timer)
      draftSaveTimer.current = undefined
    }
  }, [draft, draftScope])

  useLayoutEffect(() => {
    const persistDraft = () => saveComposerDraft(draftScope, draftRef.current)
    window.addEventListener('pagehide', persistDraft)
    return () => {
      window.removeEventListener('pagehide', persistDraft)
      persistDraft()
    }
  }, [draftScope])

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
      endResize()
    }
  }, [])

  const canCompose = !sending && !writerConflict && connection === 'connected'
  const canConfigure = canCompose && !isRunning
  const canSend = (draft.trim().length > 0 || attachedImages.length > 0 || attachedDocuments.length > 0) && canCompose
  const canAttachImages = canCompose && modelSupportsImages

  async function attachImages(files: File[]) {
    if (files.length === 0) return
    if (!modelSupportsImages) {
      setAttachmentError('当前模型不支持图片输入，请选择支持图片的模型。')
      return
    }
    const unsupported = files.find((file) => !imageTypes.has(file.type as CodexImageAttachment['mediaType']))
    if (unsupported) {
      setAttachmentError('只支持 PNG、JPEG、WebP 和 GIF 图片。')
      return
    }
    const oversized = files.find((file) => file.size > maxImageSize)
    if (oversized) {
      setAttachmentError('单张图片不能超过 8 MB。')
      return
    }
    const remaining = maxImagesPerTurn - attachedImages.length
    if (remaining <= 0) {
      setAttachmentError('单条消息最多附加 4 张图片。')
      return
    }
    const chosen = files.slice(0, remaining)
    try {
      const next = await Promise.all(chosen.map(readImage))
      setAttachedImages((current) => [...current, ...next].slice(0, maxImagesPerTurn))
      setAttachmentError(files.length > remaining ? '单条消息最多附加 4 张图片，其余图片未添加。' : null)
    } catch (reason) {
      setAttachmentError(reason instanceof Error ? reason.message : '图片读取失败。')
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const prompt = draft.trim()
    if ((!prompt && attachedImages.length === 0 && attachedDocuments.length === 0) || !canCompose) return
    if (!modelSupportsImages && attachedImages.length > 0) {
      setAttachmentError('当前模型不支持图片输入，请选择支持图片的模型。')
      return
    }
    const previousDraft = draft
    const previousImages = attachedImages
    const previousDocuments = attachedDocuments
    const previousAttachmentError = attachmentError
    setSending(true)
    updateDraft('')
    setAttachedImages([])
    setAttachedDocuments([])
    setAttachmentError(null)
    const sent = await onSend({
      prompt,
      images: previousImages,
      documents: previousDocuments,
      model: selectedModel || undefined,
      effort: selectedEffort || undefined,
      approvalPolicy: selectedApprovalPolicy,
    })
    if (!sent) {
      updateDraft((current) => !current ? previousDraft : !previousDraft ? current : `${previousDraft}${previousDraft.endsWith('\n') ? '' : '\n'}${current}`)
      setAttachedImages((current) => current.length > 0 ? [...previousImages, ...current].slice(0, maxImagesPerTurn) : previousImages)
      setAttachedDocuments((current) => current.length > 0 ? [...previousDocuments, ...current] : previousDocuments)
      setAttachmentError((current) => current ?? previousAttachmentError)
    }
    setSending(false)
  }

  async function sendQueuedNow(messageId: string) {
    if (sendingQueuedId) return
    setSendingQueuedId(messageId)
    try {
      await onSendQueuedNow(messageId)
    } finally {
      setSendingQueuedId((current) => current === messageId ? null : current)
    }
  }

  function handleInputKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter is commonly used to confirm Chinese/Japanese/Korean IME candidates.
    if (inputIsComposing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key !== 'Enter' || event.shiftKey || !canSend) return
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
    appendDocument({ name: 'pasted-content.md', content: pastedText })
    setAttachmentError(null)
  }

  function startComposerResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    resizeState.current = { startY: event.clientY, startHeight: composerHeight }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  const [workspaceDragOver, setWorkspaceDragOver] = useState(false)

  function appendDocument(document: CodexDocumentAttachment) {
    setAttachedDocuments((current) => {
      if (current.some((item) => item.name === document.name && item.content === document.content)) return current
      return [...current, document].slice(0, maxDocumentsPerTurn)
    })
    setAttachmentError(null)
  }

  async function dropWorkspaceFile(event: DragEvent<HTMLFormElement>) {
    setWorkspaceDragOver(false)
    const path = workspaceFilePathFromDrag(event.dataTransfer)
    if (!path) return
    event.preventDefault()
    if (!canCompose) return
    onInsertWorkspacePath(path)
    setAttachmentError(null)
    window.requestAnimationFrame(() => composer.current?.focus())
  }

  return (
    <form
      className={`message-composer${isRunning ? ' message-composer--running' : ''}${workspaceDragOver ? ' message-composer--drag-over' : ''}`}
      onSubmit={(event) => void send(event)}
      onDragEnter={(event) => {
        if (hasWorkspaceFileDrag(event.dataTransfer)) setWorkspaceDragOver(true)
      }}
      onDragOver={(event) => {
        if (!hasWorkspaceFileDrag(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setWorkspaceDragOver(true)
      }}
      onDragLeave={() => setWorkspaceDragOver(false)}
      onDrop={(event) => void dropWorkspaceFile(event)}
    >
      {attachedImages.length > 0 ? (
        <div className="composer-images" aria-label="待发送图片">
          {attachedImages.map((image, index) => <span className="composer-image" key={`${image.name}-${index}`}><img src={`data:${image.mediaType};base64,${image.data}`} alt={image.name} /><button type="button" onClick={() => setAttachedImages((current) => current.filter((_, currentIndex) => currentIndex !== index))} aria-label={`移除图片 ${image.name}`}><X size={12} /></button></span>)}
        </div>
      ) : null}
      {attachmentError ? <p className="attachment-error" role="alert">{attachmentError}</p> : null}
      {attachedDocuments.length > 0 ? (
        <div className="composer-documents" aria-label={`待发送文档 ${attachedDocuments.length} 个`}>
          {attachedDocuments.map((document, index) => (
            <div className="composer-document" key={`${document.name}-${index}`}>
              <FileText size={16} />
              <span><strong>{document.name}</strong><small>{document.content.length.toLocaleString()} 个字符 · 将随消息发送</small></span>
              <button type="button" onClick={() => setAttachedDocuments((current) => current.filter((_, currentIndex) => currentIndex !== index))} aria-label={`移除文档 ${document.name}`}><X size={13} /></button>
            </div>
          ))}
        </div>
      ) : null}
      {queuedMessages.length > 0 ? (
        <div className="composer-queue" aria-live="polite" aria-label={`已排队 ${queuedMessages.length} 条消息`}>
          <div className="composer-queue__heading">
            <span>已排队 {queuedMessages.length} 条</span>
            <small>{isRunning ? '当前回复结束后会依次发送' : '点击立即发送可重试'}</small>
          </div>
          <div className="composer-queue__list">
            {queuedMessages.map((message, index) => {
              const sendingNow = sendingQueuedId === message.id
              const summary = message.text || (message.documents?.length
                ? `附件文档：${message.documents.length} 个文件`
                : `${message.images.length} 张图片`)
              return (
                <div className="composer-queue__item" key={message.id}>
                  <span className="composer-queue__index">{index + 1}</span>
                  <span className="composer-queue__copy"><strong>{summary}</strong><small>{isRunning ? (index === 0 ? '下一条待发送' : '等待前面的消息完成') : '等待手动发送'}</small></span>
                  <button className="composer-queue__send" type="button" disabled={sendingNow} onClick={() => void sendQueuedNow(message.id)} title="立即发送给当前 Codex 回复">
                    {sendingNow ? <LoaderCircle className="spin" size={12} /> : <Send size={12} />}<span>立即发送</span>
                  </button>
                  <button className="composer-queue__remove" type="button" disabled={sendingNow} onClick={() => onRemoveQueued(message.id)} aria-label="移除排队消息" title="移除排队消息"><X size={13} /></button>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
      <div className="composer-editor" style={{ height: `${composerHeight}px` }}>
        <button className="composer-resize" type="button" onPointerDown={startComposerResize} aria-label="调整输入框高度" title="上下拖动调整输入框高度"><ChevronsUpDown size={14} /></button>
        <textarea
          ref={composer}
          value={draft}
          onChange={(event) => updateDraft(event.target.value)}
          onCompositionStart={() => { inputIsComposing.current = true }}
          onCompositionEnd={() => { inputIsComposing.current = false }}
          onBlur={() => { inputIsComposing.current = false }}
          onKeyDownCapture={(event) => {
            if (inputIsComposing.current && event.key === 'Escape') event.stopPropagation()
          }}
          onKeyDown={handleInputKey}
          onPaste={handlePaste}
          onFocus={() => window.CodexRemoteAndroid?.showKeyboard?.()}
          onPointerDown={() => window.CodexRemoteAndroid?.showKeyboard?.()}
          placeholder="给 Codex 发送消息…"
          aria-label="发送消息给 Codex"
          inputMode="text"
          enterKeyHint="send"
        />
      </div>
      <div className="message-composer__footer">
        <div className="composer-preferences">
          <ComposerMenu label="模型" value={selectedModel} options={modelOptions} emptyLabel="读取模型…" disabled={!canConfigure || modelOptions.length === 0} open={openMenu === 'model'} onOpenChange={(open) => changeOpenMenu(open ? 'model' : null)} onChange={onModelChange} />
          <ComposerMenu label="思考" value={selectedEffort} options={reasoningOptions} emptyLabel="默认" disabled={!canConfigure || reasoningOptions.length === 0} open={openMenu === 'effort'} onOpenChange={(open) => changeOpenMenu(open ? 'effort' : null)} onChange={onEffortChange} />
          <ComposerMenu label="授权" value={selectedApprovalPolicy} options={authorizationOptions} emptyLabel="请求批准" disabled={!canConfigure} open={openMenu === 'approval'} onOpenChange={(open) => changeOpenMenu(open ? 'approval' : null)} onChange={(approvalPolicy) => onApprovalPolicyChange(approvalPolicy as CodexApprovalPolicy)} />
          <span className="composer-hint"><ShieldCheck size={14} />Enter 发送 · Shift+Enter 换行</span>
        </div>
        <div className="composer-actions">
          <span className={`attach-button attach-button--native${canAttachImages ? '' : ' attach-button--disabled'}`} title={modelSupportsImages ? '附加图片' : '当前模型不支持图片输入'}>
            <ImagePlus size={16} />
            <input className="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={!canAttachImages} onChange={(event) => { void attachImages(Array.from(event.target.files ?? [])); event.currentTarget.value = '' }} aria-label="附加图片" />
          </span>
          {writerConflict ? (
            <button className="stop-button" type="button" onClick={onRefresh}><RefreshCw size={13} />刷新状态</button>
          ) : (
            <>
              {isRunning ? <button className="stop-button" type="button" onClick={onInterrupt} disabled={isInterrupting}>{isInterrupting ? <LoaderCircle className="spin" size={13} /> : <Square size={13} fill="currentColor" />}{isInterrupting ? '停止中' : '停止'}</button> : null}
              <button className={`send-button${isRunning ? ' send-button--queue' : ''}`} type="submit" disabled={!canSend} aria-label={isRunning ? '将消息加入发送队列' : '发送消息'} title={isRunning ? '加入发送队列' : '发送消息'}>{sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button>
            </>
          )}
        </div>
      </div>
    </form>
  )
}))

interface WorkspaceExplorerProps {
  token: string
  cwd?: string
  threadId?: string
  onInsertPath: (path: string) => void
}

const WorkspaceExplorer = memo(function WorkspaceExplorer({ token, cwd, threadId, onInsertPath }: WorkspaceExplorerProps) {
  const [directories, setDirectories] = useState<Record<string, CodexWorkspaceTree>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({})
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [contextMenu, setContextMenu] = useState<{ entry: CodexWorkspaceEntry; paths: string[]; x: number; y: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const scopeKey = `${threadId ?? 'new'}:${cwd ?? ''}`

  const directoryKey = (path: string) => path || '.'
  const loadDirectory = useCallback(async (path: string) => {
    if (!cwd) return
    const generation = requestGeneration.current
    const key = directoryKey(path)
    setLoadingPaths((current) => ({ ...current, [key]: true }))
    try {
      const tree = await codexRemoteClient.workspaceTree(token, cwd, path)
      if (generation !== requestGeneration.current) return
      setDirectories((current) => ({ ...current, [key]: tree }))
      setError(null)
    } catch (reason) {
      if (generation !== requestGeneration.current) return
      setError(reason instanceof Error ? reason.message : '无法读取文件目录')
    } finally {
      if (generation === requestGeneration.current) {
        setLoadingPaths((current) => ({ ...current, [key]: false }))
      }
    }
  }, [cwd, token])

  useEffect(() => {
    requestGeneration.current += 1
    setDirectories({})
    setExpanded({})
    setLoadingPaths({})
    setSelectedPaths([])
    setContextMenu(null)
    setError(null)
    if (cwd) void loadDirectory('')
  }, [cwd, loadDirectory, scopeKey])

  useEffect(() => {
    if (!contextMenu) return
    const closeMenu = () => setContextMenu(null)
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  function toggleDirectory(path: string) {
    const nextExpanded = !expanded[path]
    setExpanded((current) => ({ ...current, [path]: nextExpanded }))
    if (nextExpanded && !directories[directoryKey(path)]) void loadDirectory(path)
  }

  function openEntryContextMenu(event: ReactMouseEvent<HTMLButtonElement>, entry: CodexWorkspaceEntry) {
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 176
    const menuHeight = 72
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8))
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    const paths = selectedPaths.includes(entry.path) ? selectedPaths : [entry.path]
    setSelectedPaths(paths)
    setContextMenu({ entry, paths, x, y })
  }

  function handleEntryClick(event: ReactMouseEvent<HTMLButtonElement>, entry: CodexWorkspaceEntry) {
    if (event.ctrlKey || event.metaKey) {
      setSelectedPaths((current) => current.includes(entry.path)
        ? current.filter((path) => path !== entry.path)
        : [...current, entry.path])
      return
    }
    setSelectedPaths([entry.path])
    if (entry.kind === 'directory') toggleDirectory(entry.path)
    else onInsertPath(entryAbsolutePath(entry))
  }

  function entryAbsolutePath(entry: CodexWorkspaceEntry) {
    return workspaceAbsolutePath(cwd, entry.path)
  }

  function dragFile(event: DragEvent<HTMLButtonElement>, entry: CodexWorkspaceEntry) {
    event.dataTransfer.effectAllowed = 'copy'
    const path = entryAbsolutePath(entry)
    event.dataTransfer.setData(workspaceFileDragMime, JSON.stringify({ path }))
    // Keep a prefixed text fallback for browsers that remove custom MIME data.
    event.dataTransfer.setData('text/plain', `${workspaceFileDragTextPrefix}${path}`)
  }

  function sizeLabel(size: number | null | undefined) {
    if (size === undefined || size === null) return ''
    if (size < 1_024) return `${size} B`
    if (size < 1_024 * 1_024) return `${Math.ceil(size / 1_024)} KB`
    return `${(size / (1_024 * 1_024)).toFixed(1)} MB`
  }

  function renderDirectory(path: string, depth: number): ReactNode[] {
    const tree = directories[directoryKey(path)]
    if (!tree) return []
    return tree.entries.flatMap((entry) => {
      const isDirectory = entry.kind === 'directory'
      const isOpen = Boolean(expanded[entry.path])
      const row = (
        <Fragment key={entry.path}>
          <button
            className={`workspace-explorer__entry workspace-explorer__entry--${entry.kind}${isOpen ? ' workspace-explorer__entry--open' : ''}${selectedPaths.includes(entry.path) ? ' workspace-explorer__entry--selected' : ''}`}
            type="button"
            draggable={!isDirectory}
            style={{ paddingLeft: `${10 + depth * 14}px` }}
            title={isDirectory ? entry.path : `${entry.path} · 拖到输入框插入路径`}
            onClick={(event) => handleEntryClick(event, entry)}
            onDragStart={(event) => { if (!isDirectory) dragFile(event, entry) }}
            onContextMenuCapture={(event) => openEntryContextMenu(event, entry)}
          >
            {isDirectory ? <ChevronRight className={`workspace-explorer__chevron${isOpen ? ' workspace-explorer__chevron--open' : ''}`} size={13} /> : <span className="workspace-explorer__chevron-spacer" />}
            {isDirectory ? (isOpen ? <FolderOpen size={15} /> : <Folder size={15} />) : <File size={14} />}
            <span className="workspace-explorer__entry-name">{entry.name}</span>
            {!isDirectory ? <small>{sizeLabel(entry.size)}</small> : null}
          </button>
          {isDirectory && isOpen ? (
            loadingPaths[directoryKey(entry.path)]
              ? <div className="workspace-explorer__loading" style={{ paddingLeft: `${37 + depth * 14}px` }}><LoaderCircle className="spin" size={12} />读取中…</div>
              : renderDirectory(entry.path, depth + 1)
          ) : null}
        </Fragment>
      )
      return [row]
    })
  }

  const rootLoading = loadingPaths['.']
  return (
    <aside className="workspace-explorer" aria-label="工作区文件资源管理器">
      <header className="workspace-explorer__header">
        <div><span className="workspace-explorer__eyebrow">当前窗口</span><strong>文件</strong></div>
        <button className="icon-button" type="button" onClick={() => void loadDirectory('')} disabled={!cwd || rootLoading} aria-label="刷新文件目录" title="刷新文件目录"><RefreshCw className={rootLoading ? 'spin' : undefined} size={14} /></button>
      </header>
      <div className="workspace-explorer__root" title={cwd}>{cwd ? cwd : '选择对话后显示工作目录'}</div>
      <div className="workspace-explorer__tree">
        {!cwd ? <p className="workspace-explorer__empty">当前窗口还没有工作目录。</p> : null}
        {rootLoading && !directories['.'] ? <div className="workspace-explorer__loading"><LoaderCircle className="spin" size={13} />读取文件目录…</div> : null}
        {error ? <p className="workspace-explorer__error" role="alert">{error}</p> : null}
        {cwd && directories['.'] ? renderDirectory('', 0) : null}
        {cwd && directories['.']?.truncated ? <p className="workspace-explorer__hint">目录条目过多，已截取前 {workspaceTreeMaxEntries} 项。</p> : null}
      </div>
      <footer className="workspace-explorer__footer">Ctrl/⌘ 多选后右键加入输入框</footer>
      {contextMenu && typeof document !== 'undefined' ? createPortal(
        <div className="thread-context-menu workspace-file-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
          <div className="workspace-file-context-menu__name" title={contextMenu.entry.path}>{contextMenu.entry.name}{contextMenu.paths.length > 1 ? ` · 已选 ${contextMenu.paths.length} 项` : ''}</div>
          <button type="button" role="menuitem" onClick={() => { const paths = contextMenu.paths.map((path) => workspaceAbsolutePath(cwd, path)).join('\n'); setContextMenu(null); onInsertPath(paths) }}><Link2 size={14} />加入输入框</button>
        </div>,
        document.body,
      ) : null}
    </aside>
  )
})

interface RemoteChatPaneProps {
  remote: CodexRemoteController
  active: boolean
  showActiveFrame: boolean
  canClose: boolean
  onActivate: () => void
  onClose: () => void
  onCreateThread: () => void
  onHandoff: () => void
  onReclaim: () => void
  onOpenSidebar: () => void
  composerHandle: RefObject<ComposerHandle | null>
  copiedMessageId: string | null
  onCopy: (message: CodexMessage) => void | Promise<void>
}

function RemoteChatPane({
  remote,
  active,
  showActiveFrame,
  canClose,
  onActivate,
  onClose,
  onCreateThread,
  onHandoff,
  onReclaim,
  onOpenSidebar,
  composerHandle,
  copiedMessageId,
  onCopy,
}: RemoteChatPaneProps) {
  const messageContainer = useRef<HTMLDivElement>(null)
  const messageContent = useRef<HTMLDivElement>(null)
  const scrollAnimationFrame = useRef<number | undefined>(undefined)
  const forceMessageStreamBottomFor = useRef<string | null>(null)
  const forceMessageStreamBottomVersion = useRef(0)
  const forceMessageStreamBottomTimer = useRef<number | undefined>(undefined)
  const followMessageStream = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const activeThreadId = remote.activeThread?.id

  const positionMessageStreamAtBottom = useCallback(() => {
    const container = messageContainer.current
    if (container) container.scrollTop = container.scrollHeight
  }, [])

  const forceMessageStreamToBottom = useCallback((threadId: string | null | undefined) => {
    forceMessageStreamBottomFor.current = threadId ?? null
    forceMessageStreamBottomVersion.current += 1
    if (forceMessageStreamBottomTimer.current !== undefined) {
      window.clearTimeout(forceMessageStreamBottomTimer.current)
      forceMessageStreamBottomTimer.current = undefined
    }
    followMessageStream.current = true
    setShowScrollToBottom(false)
  }, [])

  const settleForcedMessageStreamBottom = useCallback(() => {
    const threadId = activeThreadId
    if (!threadId || remote.loadingHistory || forceMessageStreamBottomFor.current !== threadId) return
    if (forceMessageStreamBottomTimer.current !== undefined) window.clearTimeout(forceMessageStreamBottomTimer.current)
    const version = forceMessageStreamBottomVersion.current
    const timer = window.setTimeout(() => {
      if (forceMessageStreamBottomVersion.current === version && forceMessageStreamBottomFor.current === threadId) {
        forceMessageStreamBottomFor.current = null
      }
      if (forceMessageStreamBottomTimer.current === timer) forceMessageStreamBottomTimer.current = undefined
    }, 360)
    forceMessageStreamBottomTimer.current = timer
  }, [activeThreadId, remote.loadingHistory])

  const handleMessageScroll = useCallback(() => {
    const container = messageContainer.current
    if (!container) return
    if (forceMessageStreamBottomFor.current === activeThreadId) return
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 72
    followMessageStream.current = atBottom
    setShowScrollToBottom((current) => current === !atBottom ? current : !atBottom)
  }, [activeThreadId])

  const scrollToBottom = useCallback(() => {
    followMessageStream.current = true
    setShowScrollToBottom(false)
    positionMessageStreamAtBottom()
  }, [positionMessageStreamAtBottom])

  useLayoutEffect(() => {
    if (!active) return
    forceMessageStreamToBottom(activeThreadId)
  }, [active, activeThreadId, forceMessageStreamToBottom])

  useLayoutEffect(() => {
    if (!active) return
    const forceToBottom = forceMessageStreamBottomFor.current === activeThreadId
    if (!forceToBottom && !followMessageStream.current) return
    positionMessageStreamAtBottom()
    followMessageStream.current = true
    setShowScrollToBottom(false)
    if (forceToBottom) settleForcedMessageStreamBottom()
    if (scrollAnimationFrame.current !== undefined) return
    scrollAnimationFrame.current = window.requestAnimationFrame(() => {
      scrollAnimationFrame.current = undefined
      const forced = forceMessageStreamBottomFor.current === activeThreadId
      if (!forced && !followMessageStream.current) return
      positionMessageStreamAtBottom()
      followMessageStream.current = true
      setShowScrollToBottom(false)
      if (forced) settleForcedMessageStreamBottom()
    })
  }, [active, activeThreadId, positionMessageStreamAtBottom, remote.activity, remote.isRunning, remote.loadingHistory, remote.messages, settleForcedMessageStreamBottom])

  useLayoutEffect(() => {
    if (!active) return
    const content = messageContent.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const forceToBottom = forceMessageStreamBottomFor.current === activeThreadId
      if (!forceToBottom && !followMessageStream.current) return
      positionMessageStreamAtBottom()
      followMessageStream.current = true
      setShowScrollToBottom(false)
      if (forceToBottom) settleForcedMessageStreamBottom()
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [active, activeThreadId, positionMessageStreamAtBottom, settleForcedMessageStreamBottom])

  useEffect(() => () => {
    if (scrollAnimationFrame.current !== undefined) window.cancelAnimationFrame(scrollAnimationFrame.current)
    if (forceMessageStreamBottomTimer.current !== undefined) window.clearTimeout(forceMessageStreamBottomTimer.current)
  }, [])

  const activeTitle = remote.activeThread ? titleOf(remote.activeThread) : '新对话'
  const currentConnectionLabel = remote.handedOff ? '已交还给本机' : connectionLabel[remote.connection]
  const hasStreamingAssistant = remote.messages.some((message) => message.role === 'assistant' && message.streaming)
  const lastMessageIndexByTurn = useMemo(() => {
    const indexes = new Map<string, number>()
    remote.messages.forEach((message, index) => {
      if (message.turnId) indexes.set(message.turnId, index)
    })
    return indexes
  }, [remote.messages])
  const unplacedFileChanges = useMemo(() => Object.entries(remote.fileChangesByTurn)
    .filter(([turnId, changes]) => turnId !== remote.runningTurnId && !lastMessageIndexByTurn.has(turnId) && changes.length > 0), [lastMessageIndexByTurn, remote.fileChangesByTurn, remote.runningTurnId])

  return (
    <main className={`remote-chat conversation-pane${active ? ' conversation-pane--selected' : ''}${active && showActiveFrame ? ' conversation-pane--active' : ''}`} onPointerDown={onActivate}>
      <header className="remote-chat__header">
        <div className="remote-chat__title-wrap">
          <button className="icon-button menu-button" type="button" aria-label="打开对话列表" onClick={(event) => { event.stopPropagation(); onOpenSidebar() }}><Menu size={20} /></button>
          <div className="remote-chat__title"><span className="remote-chat__eyebrow">当前工作区</span><strong>{activeTitle}</strong><span title={remote.activeThread?.cwd || remote.runtime.workspace}>{remote.activeThread?.cwd || remote.runtime.workspace || '本机项目'}</span></div>
        </div>
        <div className="remote-chat__controls">
          <div className={`connection-label connection-label--${remote.handedOff ? 'handoff' : remote.connection}`}><i className={`status-dot status-dot--${remote.handedOff ? 'handoff' : remote.connection}`} /><span>{currentConnectionLabel}</span></div>
          {remote.handedOff ? (
            <button className="handoff-button handoff-button--reclaim" type="button" onClick={(event) => { event.stopPropagation(); onReclaim() }} disabled={remote.handoffInProgress}>{remote.handoffInProgress ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{remote.handoffInProgress ? '接管中' : '重新接管'}</button>
          ) : remote.activeThread ? (
            <button className="handoff-button" type="button" onClick={(event) => { event.stopPropagation(); onHandoff() }} disabled={remote.isRunning || remote.isInterrupting || remote.handoffInProgress} title="停止网页端持有的 Codex 会话，让本机 Codex 可以打开"><Square size={11} />{remote.handoffInProgress ? '交还中' : '交还本机'}</button>
          ) : null}
          <button className="pane-close-button" type="button" onClick={(event) => { event.stopPropagation(); onClose() }} disabled={!canClose} aria-label="关闭并发窗口" title={canClose ? '关闭窗口' : '至少保留一个窗口'}><X size={15} /></button>
        </div>
      </header>

      <section className="message-stream" ref={messageContainer} onScroll={handleMessageScroll} aria-live="polite" aria-label={`${activeTitle} Codex 对话`}>
        <div className="message-stream__content" ref={messageContent}>
          {remote.handedOff ? <div className="handoff-notice" role="status"><strong>已交还给本机 Codex</strong><span>网页端已停止持有会话，也不会自动重新连接。请在本机 Codex 中继续；需要回到网页时再点“重新接管”。</span></div> : null}
          {remote.messages.length === 0 && !remote.loadingHistory ? (
            <div className="welcome-state">
              <span className="welcome-state__eyebrow">CODEX REMOTE · LOCAL AGENT</span>
              <span className="welcome-state__mark">C</span>
              <h1>你想在本机项目中完成什么？</h1>
              <p>消息交给本机 Codex 处理，回复会实时显示在这里。</p>
              <div className="prompt-suggestions">
                <button type="button" onClick={() => { onActivate(); composerHandle.current?.replaceDraft('先阅读这个项目，概括目录结构和主要技术栈。') }}>了解这个项目</button>
                <button type="button" onClick={() => { onActivate(); composerHandle.current?.replaceDraft('检查当前代码中最值得优先处理的问题，并说明依据。') }}>检查代码问题</button>
              </div>
            </div>
          ) : null}
          {remote.loadingHistory && remote.messages.length === 0 ? <div className="loading-state"><LoaderCircle className="spin" size={18} />正在加载对话…</div> : null}
          {remote.messages.map((message, index) => {
            const changes = message.turnId && message.turnId !== remote.runningTurnId && lastMessageIndexByTurn.get(message.turnId) === index
              ? remote.fileChangesByTurn[message.turnId]
              : undefined
            return (
              <Fragment key={message.id}>
                <MessageBubble message={message} activity={message.streaming ? remote.activity : null} copied={copiedMessageId === message.id} onCopy={onCopy} />
                {changes?.length ? <FileChangeCard changes={changes} /> : null}
              </Fragment>
            )
          })}
          {unplacedFileChanges.map(([turnId, changes]) => <FileChangeCard key={`unplaced-file-changes-${turnId}`} changes={changes} />)}
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
              <span className="running-indicator__activity"><LoaderCircle className="spin" size={15} /><span>{remote.activity?.label ?? '正在思考'}</span>{remote.activity?.detail ? <small>{remote.activity.detail}</small> : null}</span>
            </div>
          ) : null}
        </div>
      </section>
      {showScrollToBottom ? <button className="scroll-to-bottom" type="button" onClick={scrollToBottom} aria-label="回到底部" title="回到底部"><ChevronDown size={16} /><span>回到底部</span></button> : null}
      {remote.error ? (
        <div className="remote-error" role="alert">
          <AlertTriangle size={15} /><span>{remote.error}</span>
          {remote.writerConflict ? <button type="button" onClick={onCreateThread} disabled={remote.connection !== 'connected' || remote.loadingHistory}><Plus size={13} />新建远程对话</button> : null}
        </div>
      ) : null}
    </main>
  )
}

export function CodexRemotePage({ token, onUnauthorized, onUnpair }: Props) {
  const [openPaneIndexes, setOpenPaneIndexes] = useState<number[]>([0])
  const [selectedPaneIndex, setSelectedPaneIndex] = useState(0)
  const remote0 = useCodexRemote(token, onUnauthorized, { persistActiveThread: true, enabled: true })
  const remote1 = useCodexRemote(token, onUnauthorized, { persistActiveThread: false, enabled: openPaneIndexes.includes(1), loadThreads: false, loadModels: false, prefetchHistory: false })
  const remote2 = useCodexRemote(token, onUnauthorized, { persistActiveThread: false, enabled: openPaneIndexes.includes(2), loadThreads: false, loadModels: false, prefetchHistory: false })
  const remotes = [remote0, remote1, remote2]
  const activeRemote = remotes[selectedPaneIndex] ?? remote0
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [themePreferences, setThemePreferences] = useState<ThemePreferences>(readThemePreferences)
  const [defaultComposerPreferences, setDefaultComposerPreferences] = useState<ComposerPreferences>(readComposerPreferences)
  const [threadComposerPreferences, setThreadComposerPreferences] = useState<ThreadComposerPreferences>(readThreadComposerPreferences)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [completionToast, setCompletionToast] = useState<{ threadId: string; completedAt: number } | null>(null)
  const [paneNotice, setPaneNotice] = useState<string | null>(null)
  const [threadContextMenu, setThreadContextMenu] = useState<{ thread: CodexThread; x: number; y: number } | null>(null)
  const composerHandle = useRef<ComposerHandle>(null)
  const copyResetTimer = useRef<number | undefined>(undefined)
  const paneNoticeTimer = useRef<number | undefined>(undefined)
  const paneGrid = useRef<HTMLDivElement>(null)
  const paneRects = useRef(new Map<number, DOMRect>())

  const activeThreadId = activeRemote.activeThread?.id
  const composerDraftScope = composerDraftScopeForThread(activeThreadId)
  const activeComposerPreferences = activeThreadId
    ? resolvedComposerPreferences(defaultComposerPreferences, threadComposerPreferences[activeThreadId])
    : defaultComposerPreferences
  const selectedModel = activeComposerPreferences.model ?? ''
  const selectedEffort = activeComposerPreferences.effort ?? ''
  const selectedApprovalPolicy = activeComposerPreferences.approvalPolicy ?? 'on-request'
  const availableModels = useMemo(() => {
    const source = remotes.find((remote) => remote.models.length > 0)
    return source?.models ?? []
  }, [remote0.models, remote1.models, remote2.models])
  const chosenModel = availableModels.find((model) => modelIdOf(model) === selectedModel)
  const effortOptions = useMemo(() => chosenModel?.supportedReasoningEfforts ?? [], [chosenModel])
  const customSurfaceOpacity = (100 - themePreferences.customBackgroundTransparency) / 100
  const themeStyle = {
    '--custom-theme-background': themePreferences.customBackgroundColor,
    '--custom-theme-background-image': themePreferences.customBackgroundImage
      ? 'linear-gradient(rgba(0, 0, 0, .2), rgba(0, 0, 0, .2)), url("' + themePreferences.customBackgroundImage + '")'
      : 'none',
    '--custom-theme-text-color': themePreferences.customTextColor,
    '--custom-theme-surface': rgbaFromHex('#ffffff', Math.max(0.06, customSurfaceOpacity * 0.88)),
    '--custom-theme-control': rgbaFromHex('#ffffff', Math.max(0.04, customSurfaceOpacity * 0.72)),
    '--custom-theme-active': rgbaFromHex('#ffffff', Math.max(0.06, customSurfaceOpacity * 0.46)),
    '--custom-theme-border': rgbaFromHex(themePreferences.customTextColor, Math.max(0.12, customSurfaceOpacity * 0.32)),
    '--custom-theme-panel-blur': Math.min(18, 7 + customSurfaceOpacity * 11) + 'px',
  } as CSSProperties

  const updateComposerPreferences = useCallback((changes: Partial<ComposerPreferences>) => {
    if (!activeThreadId) {
      setDefaultComposerPreferences((current) => mergeComposerPreferences(current, changes))
      return
    }
    setThreadComposerPreferences((current) => ({
      ...current,
      [activeThreadId]: mergeComposerPreferences(
        resolvedComposerPreferences(defaultComposerPreferences, current[activeThreadId]),
        changes,
      ),
    }))
  }, [activeThreadId, defaultComposerPreferences])

  const rememberThreadComposerPreferences = useCallback((threadId: string, preferences: ComposerPreferences) => {
    if (!threadId) return
    const snapshot = composerPreferencesFrom(preferences)
    setThreadComposerPreferences((current) => ({ ...current, [threadId]: snapshot }))
  }, [])

  const changeModel = useCallback((model: string) => updateComposerPreferences({ model }), [updateComposerPreferences])
  const changeEffort = useCallback((effort: string) => updateComposerPreferences({ effort }), [updateComposerPreferences])
  const changeApprovalPolicy = useCallback((approvalPolicy: CodexApprovalPolicy) => updateComposerPreferences({ approvalPolicy }), [updateComposerPreferences])

  useEffect(() => {
    try {
      window.localStorage.setItem(themePreferencesStorageKey, JSON.stringify(themePreferences))
    } catch {
      // Theme preferences still apply for the current session when storage is unavailable.
    }
  }, [themePreferences])

  useEffect(() => {
    saveComposerPreferences(defaultComposerPreferences)
  }, [defaultComposerPreferences])

  useEffect(() => {
    saveThreadComposerPreferences(threadComposerPreferences)
  }, [threadComposerPreferences])

  useEffect(() => {
    const suppressBrowserContextMenu = (event: globalThis.MouseEvent) => event.preventDefault()
    document.addEventListener('contextmenu', suppressBrowserContextMenu)
    return () => document.removeEventListener('contextmenu', suppressBrowserContextMenu)
  }, [])

  useEffect(() => {
    if (!threadContextMenu) return
    const closeMenu = () => setThreadContextMenu(null)
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setThreadContextMenu(null)
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [threadContextMenu])

  useEffect(() => {
    const handleBack = () => {
      if (composerHandle.current?.closeOpenMenu()) return true
      if (threadContextMenu) {
        setThreadContextMenu(null)
        return true
      }
      if (sidebarOpen) {
        setSidebarOpen(false)
        return true
      }
      if (settingsOpen) {
        setSettingsOpen(false)
        return true
      }
      return false
    }
    window.CodexRemoteHandleBack = handleBack
    return () => {
      if (window.CodexRemoteHandleBack === handleBack) delete window.CodexRemoteHandleBack
    }
  }, [settingsOpen, sidebarOpen, threadContextMenu])

  useEffect(() => {
    const interruptOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || !activeRemote.isRunning) return
      event.preventDefault()
      void activeRemote.interrupt()
    }
    document.addEventListener('keydown', interruptOnEscape)
    return () => document.removeEventListener('keydown', interruptOnEscape)
  }, [activeRemote.isRunning, activeRemote.interrupt])

  useEffect(() => {
    if (availableModels.length === 0) return
    if (selectedModel && availableModels.some((model) => modelIdOf(model) === selectedModel)) return
    const defaultModel = availableModels.find((model) => model.isDefault) ?? availableModels[0]
    updateComposerPreferences({ model: modelIdOf(defaultModel) })
  }, [availableModels, selectedModel, updateComposerPreferences])

  useEffect(() => {
    if (availableModels.length === 0 || !chosenModel) return
    if (effortOptions.length === 0) {
      if (selectedEffort) updateComposerPreferences({ effort: undefined })
      return
    }
    if (selectedEffort && effortOptions.some((option) => option.reasoningEffort === selectedEffort)) return
    updateComposerPreferences({ effort: chosenModel.defaultReasoningEffort ?? effortOptions[0].reasoningEffort })
  }, [availableModels.length, chosenModel, effortOptions, selectedEffort, updateComposerPreferences])

  useEffect(() => {
    const completions = remotes
      .map((remote) => remote.latestThreadCompletion)
      .filter((completion): completion is { threadId: string; completedAt: number } => Boolean(completion))
      .sort((left, right) => right.completedAt - left.completedAt)
    const latest = completions[0]
    if (!latest) return
    setCompletionToast(latest)
    const timer = window.setTimeout(() => {
      setCompletionToast((current) => current?.completedAt === latest.completedAt ? null : current)
    }, 2_800)
    return () => window.clearTimeout(timer)
  }, [remote0.latestThreadCompletion, remote1.latestThreadCompletion, remote2.latestThreadCompletion])

  useLayoutEffect(() => {
    const grid = paneGrid.current
    if (!grid) return
    const previous = paneRects.current
    const next = new Map<number, DOMRect>()
    grid.querySelectorAll<HTMLElement>('[data-pane-index]').forEach((node) => {
      const index = Number(node.dataset.paneIndex)
      const rect = node.getBoundingClientRect()
      next.set(index, rect)
      const before = previous.get(index)
      if (!before) return
      const deltaX = before.left - rect.left
      const deltaY = before.top - rect.top
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return
      if (typeof node.animate === 'function') {
        node.animate([
          { transform: 'translate(' + deltaX + 'px, ' + deltaY + 'px)' },
          { transform: 'translate(0, 0)' },
        ], { duration: 220, easing: 'cubic-bezier(.22, .8, .25, 1)' })
      }
    })
    paneRects.current = next
  }, [openPaneIndexes])

  useEffect(() => () => {
    if (copyResetTimer.current !== undefined) window.clearTimeout(copyResetTimer.current)
    if (paneNoticeTimer.current !== undefined) window.clearTimeout(paneNoticeTimer.current)
  }, [])

  function showPaneNotice(message: string) {
    setPaneNotice(message)
    if (paneNoticeTimer.current !== undefined) window.clearTimeout(paneNoticeTimer.current)
    paneNoticeTimer.current = window.setTimeout(() => {
      paneNoticeTimer.current = undefined
      setPaneNotice(null)
    }, 2_400)
  }

  function paneIndexForThread(threadId: string) {
    return openPaneIndexes.find((index) => remotes[index]?.activeThread?.id === threadId)
  }

  async function createThreadForPane(paneIndex = selectedPaneIndex) {
    const target = remotes[paneIndex] ?? remote0
    const targetThreadId = target.activeThread?.id
    const targetPreferences = targetThreadId
      ? resolvedComposerPreferences(defaultComposerPreferences, threadComposerPreferences[targetThreadId])
      : activeComposerPreferences
    const thread = await target.createThread(targetPreferences.model, targetPreferences.approvalPolicy)
    if (!thread) return null
    if (paneIndex === selectedPaneIndex && !activeThreadId) composerHandle.current?.adoptUnassignedDraft(thread.id)
    rememberThreadComposerPreferences(thread.id, targetPreferences)
    return thread
  }

  async function createThread() {
    setSidebarOpen(false)
    await createThreadForPane(selectedPaneIndex)
  }

  async function selectThread(thread: CodexThread) {
    setSidebarOpen(false)
    setThreadContextMenu(null)
    const existingPane = paneIndexForThread(thread.id)
    if (existingPane !== undefined) {
      setSelectedPaneIndex(existingPane)
      return
    }
    const targetIndex = openPaneIndexes.includes(selectedPaneIndex) ? selectedPaneIndex : (openPaneIndexes[0] ?? 0)
    setSelectedPaneIndex(targetIndex)
    await remotes[targetIndex].selectThread(thread)
  }

  async function openConcurrentThread(thread: CodexThread) {
    setThreadContextMenu(null)
    const existingPane = paneIndexForThread(thread.id)
    if (existingPane !== undefined) {
      setSelectedPaneIndex(existingPane)
      return
    }
    const freePane = [0, 1, 2].find((index) => !openPaneIndexes.includes(index))
    if (freePane === undefined) {
      showPaneNotice('最多同时打开 3 个对话窗口')
      return
    }
    setOpenPaneIndexes((current) => [...current, freePane])
    setSelectedPaneIndex(freePane)
    await remotes[freePane].selectThread(thread)
  }
  function closePane(paneIndex: number) {
    if (openPaneIndexes.length <= 1) return
    const position = openPaneIndexes.indexOf(paneIndex)
    const nextOpen = openPaneIndexes.filter((index) => index !== paneIndex)
    setOpenPaneIndexes(nextOpen)
    if (selectedPaneIndex === paneIndex) {
      setSelectedPaneIndex(nextOpen[Math.min(Math.max(position, 0), nextOpen.length - 1)] ?? nextOpen[0] ?? 0)
    }
  }

  function activatePane(paneIndex: number) {
    if (openPaneIndexes.includes(paneIndex)) setSelectedPaneIndex(paneIndex)
  }

  async function handoffToLocalCodex(paneIndex = selectedPaneIndex) {
    const target = remotes[paneIndex]
    if (!target.activeThread || target.isRunning || target.isInterrupting || target.handoffInProgress) return
    const confirmed = window.confirm('交还后网页端会停止持有已加载的 Codex 会话，网页不会自动重新连接。开发服务、SSH 和配对不会重启。确认交还给本机 Codex？')
    if (!confirmed) return
    await target.handoffToLocalCodex()
  }

  async function reclaimForRemote(paneIndex = selectedPaneIndex) {
    const target = remotes[paneIndex]
    if (target.handoffInProgress) return
    const confirmed = window.confirm('重新接管后网页端会恢复连接。请确认本机 Codex 不再运行需要保留的任务。')
    if (!confirmed) return
    await target.reclaimForRemote()
  }

  function openCompletedThread() {
    if (!completionToast) return
    const thread = remote0.threads.find((item) => item.id === completionToast.threadId) ?? { id: completionToast.threadId }
    void selectThread(thread)
    setCompletionToast(null)
  }

  const copyMessage = useCallback(async (message: CodexMessage) => {
    const documentText = message.documents?.map((document) => '\n\n' + document.name + '\n' + document.content).join('') ?? ''
    const value = (message.text + documentText).trim()
    if (!value || !(await copyText(value))) return
    setCopiedMessageId(message.id)
    if (copyResetTimer.current !== undefined) window.clearTimeout(copyResetTimer.current)
    copyResetTimer.current = window.setTimeout(() => setCopiedMessageId(null), 1600)
  }, [])

  const sendComposerMessage = useCallback((input: ComposerSendInput) => {
    const target = remotes[selectedPaneIndex] ?? remote0
    const preferences = composerPreferencesFrom(input)
    return target.sendMessage({
      ...input,
      onThreadCreated: (thread) => {
        composerHandle.current?.adoptUnassignedDraft(thread.id)
        rememberThreadComposerPreferences(thread.id, preferences)
      },
    })
  }, [rememberThreadComposerPreferences, remote0, remote1, remote2, selectedPaneIndex])

  const activeWorkspaceCwd = activeRemote.activeThread?.cwd || activeRemote.runtime.workspace || undefined
  const insertWorkspacePath = useCallback((path: string) => {
    composerHandle.current?.appendDraft(path)
  }, [])

  const activeTitle = activeRemote.activeThread ? titleOf(activeRemote.activeThread) : '新对话'
  const currentConnectionLabel = activeRemote.handedOff ? '已交还给本机' : connectionLabel[activeRemote.connection]
  const androidEndpointBridgeAvailable = typeof window !== 'undefined' && typeof window.CodexRemoteAndroid?.changeEndpoint === 'function'
  const modelSupportsImages = !chosenModel || !Array.isArray(chosenModel.inputModalities) || chosenModel.inputModalities.includes('image')
  const modelOptions = useMemo<ComposerMenuOption[]>(() => availableModels.flatMap((model) => {
    const id = modelIdOf(model)
    return id ? [{ value: id, label: modelLabelOf(model) }] : []
  }), [availableModels])
  const reasoningOptions = useMemo<ComposerMenuOption[]>(() => effortOptions.map((option) => ({
    value: option.reasoningEffort,
    label: effortLabelOf(option.reasoningEffort),
  })), [effortOptions])

  return (
    <div className={'remote-shell remote-shell--theme-' + themePreferences.theme + (androidEndpointBridgeAvailable ? ' remote-shell--android' : '')} style={themeStyle}>
      {completionToast ? (
        <div className="thread-completion-toast" role="status" aria-live="polite">
          <button className="thread-completion-toast__open" type="button" onClick={openCompletedThread}>
            <span className="thread-completion-toast__icon"><Check size={15} strokeWidth={2.8} /></span>
            <span className="thread-completion-toast__copy"><strong>一条对话已完成回复</strong><small>点击查看这条对话</small></span>
          </button>
          <button className="thread-completion-toast__close" type="button" aria-label="关闭完成提示" onClick={() => setCompletionToast(null)}><X size={15} /></button>
        </div>
      ) : null}
      {paneNotice ? <div className="pane-limit-notice" role="status">{paneNotice}</div> : null}
      <aside className={'remote-sidebar' + (sidebarOpen ? ' remote-sidebar--open' : '')} aria-label="Codex 对话记录">
        <div className="remote-sidebar__heading">
          <div className="remote-brand"><span className="remote-brand__mark">C</span><span className="remote-brand__copy"><strong>Codex Remote</strong><small>本机 Agent 工作台</small></span></div>
          <button className="icon-button remote-sidebar__close" type="button" aria-label="关闭对话列表" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>
        <button className="new-thread-button" type="button" onClick={() => void createThread()} disabled={activeRemote.handedOff || activeRemote.connection !== 'connected' || activeRemote.loadingHistory}><span className="new-thread-button__icon"><Plus size={16} /></span><span>新建对话</span></button>
        <div className="thread-list-heading"><span>最近对话</span><button className="icon-button" type="button" aria-label="刷新对话记录" onClick={() => void remote0.refreshThreads()} disabled={remote0.handedOff}><RefreshCw size={14} /></button></div>
        <nav className="thread-list">
          {remote0.threads.map((thread) => {
            const paneIndex = paneIndexForThread(thread.id)
            const isActive = paneIndex === selectedPaneIndex
            return (
              <button className={'thread-row' + (isActive ? ' thread-row--active' : '') + (paneIndex !== undefined ? ' thread-row--open' : '')} type="button" key={thread.id} onClick={() => void selectThread(thread)} onContextMenu={(event) => { event.preventDefault(); setThreadContextMenu({ thread, x: event.clientX, y: event.clientY }) }} disabled={activeRemote.handedOff} aria-current={isActive ? 'page' : undefined}>
                <MessagesSquare size={15} />
                <span className="thread-row__copy"><strong>{titleOf(thread)}</strong><span className="thread-row__meta">{remote0.completedThreadIds.includes(thread.id) ? <span className="thread-row__completion-dot" role="status" aria-label="Codex 已完成回复" title="Codex 已完成回复" /> : null}<small>{timeOf(thread)}</small></span></span>
                {paneIndex !== undefined ? <span className="thread-row__pane-dot" title="已打开" /> : null}
              </button>
            )
          })}
          {remote0.threads.length === 0 && !remote0.loadingHistory ? <p className="thread-list__empty">还没有对话</p> : null}
          {remote0.loadingHistory && remote0.threads.length === 0 ? <p className="thread-list__empty"><LoaderCircle className="spin" size={14} />读取对话中</p> : null}
        </nav>
        {androidEndpointBridgeAvailable ? <button className="sidebar-settings sidebar-endpoint" type="button" onClick={() => window.CodexRemoteAndroid?.changeEndpoint?.()}><Link2 size={16} /><span>切换电脑地址</span></button> : null}
        <button className={'sidebar-settings' + (settingsOpen ? ' sidebar-settings--active' : '')} type="button" onClick={() => { setSettingsOpen(true); setSidebarOpen(false) }}><Settings2 size={16} /><span>设置</span></button>
        <footer className="remote-sidebar__footer"><i className={'status-dot status-dot--' + (activeRemote.handedOff ? 'handoff' : activeRemote.connection)} /><span>{currentConnectionLabel}</span><button type="button" onClick={() => void onUnpair()}>退出</button></footer>
      </aside>

      {sidebarOpen ? <button className="sidebar-backdrop" type="button" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} /> : null}
      {threadContextMenu ? (
        <div className="thread-context-menu" style={{ left: threadContextMenu.x, top: threadContextMenu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => void openConcurrentThread(threadContextMenu.thread)}><MessagesSquare size={14} />并发打开</button>
          <button type="button" role="menuitem" onClick={() => void selectThread(threadContextMenu.thread)}><Check size={14} />切换到此对话</button>
        </div>
      ) : null}

      {settingsOpen ? (
        <ThemeSettingsPanel preferences={themePreferences} onChange={setThemePreferences} onClose={() => setSettingsOpen(false)} />
      ) : (
        <>
          <section className="remote-workspace">
            <div className="remote-pane-grid" ref={paneGrid} style={{ '--pane-count': openPaneIndexes.length } as CSSProperties}>
              {openPaneIndexes.map((paneIndex) => (
                <div className="remote-pane-slot" data-pane-index={paneIndex} key={paneIndex}>
                  <RemoteChatPane
                    remote={remotes[paneIndex]}
                    active={paneIndex === selectedPaneIndex}
                    showActiveFrame={openPaneIndexes.length > 1}
                    canClose={openPaneIndexes.length > 1}
                    onActivate={() => activatePane(paneIndex)}
                    onClose={() => closePane(paneIndex)}
                    onCreateThread={() => void createThreadForPane(paneIndex)}
                    onHandoff={() => void handoffToLocalCodex(paneIndex)}
                    onReclaim={() => void reclaimForRemote(paneIndex)}
                    onOpenSidebar={() => setSidebarOpen(true)}
                    composerHandle={composerHandle}
                    copiedMessageId={copiedMessageId}
                    onCopy={copyMessage}
                  />
                </div>
              ))}
            </div>
            <MessageComposer
              key={composerDraftScope}
              ref={composerHandle}
              draftScope={composerDraftScope}
              connection={activeRemote.handedOff ? 'disconnected' : activeRemote.connection}
              isRunning={activeRemote.isRunning}
              isInterrupting={activeRemote.isInterrupting}
              writerConflict={activeRemote.writerConflict}
              modelSupportsImages={modelSupportsImages}
              selectedModel={selectedModel}
              selectedEffort={selectedEffort}
              selectedApprovalPolicy={selectedApprovalPolicy}
              modelOptions={modelOptions}
              reasoningOptions={reasoningOptions}
              authorizationOptions={approvalPolicyOptions}
              onModelChange={changeModel}
              onEffortChange={changeEffort}
              onApprovalPolicyChange={changeApprovalPolicy}
              onSend={sendComposerMessage}
              queuedMessages={activeRemote.queuedMessages}
              onSendQueuedNow={activeRemote.sendQueuedMessageNow}
              onRemoveQueued={activeRemote.removeQueuedMessage}
              onInsertWorkspacePath={insertWorkspacePath}
              onInterrupt={activeRemote.interrupt}
              onRefresh={activeRemote.refreshActiveThread}
            />
          </section>
          <WorkspaceExplorer
            token={token}
            cwd={activeWorkspaceCwd}
            threadId={activeRemote.activeThread?.id}
            onInsertPath={insertWorkspacePath}
          />
        </>
      )}
    </div>
  )
}

function ThemeSettingsPanel({ preferences, onChange, onClose }: { preferences: ThemePreferences; onChange: (next: ThemePreferences) => void; onClose: () => void }) {
  const [imageError, setImageError] = useState<string | null>(null)
  const themeOptions: Array<{ value: AppTheme; label: string; description: string; previewClass: string }> = [
    { value: 'light', label: '白色', description: '清爽明亮', previewClass: 'theme-option__preview--light' },
    { value: 'dark', label: '黑色', description: '低光阅读', previewClass: 'theme-option__preview--dark' },
    { value: 'warm', label: '暖色', description: '柔和纸感', previewClass: 'theme-option__preview--warm' },
    { value: 'custom', label: '自定义主题', description: '颜色、图片与透明度', previewClass: 'theme-option__preview--custom' },
  ]

  async function updateBackgroundImage(file: File | undefined) {
    setImageError(null)
    if (!file) return
    if (!themeImageTypes.has(file.type)) {
      setImageError('只支持 PNG、JPEG、WebP 和 GIF 图片。')
      return
    }
    if (file.size > maxThemeImageSize) {
      setImageError('背景图片不能超过 2 MB。')
      return
    }
    try {
      const customBackgroundImage = await readThemeBackgroundImage(file)
      onChange({ ...preferences, customBackgroundImage })
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : '背景图片读取失败。')
    }
  }

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
                <span
                  className={`theme-option__preview ${option.previewClass}`}
                  style={option.value === 'custom' ? {
                    backgroundColor: preferences.customBackgroundColor,
                    backgroundImage: preferences.customBackgroundImage
                      ? `linear-gradient(rgba(0, 0, 0, .2), rgba(0, 0, 0, .2)), url("${preferences.customBackgroundImage}")`
                      : 'none',
                    backgroundPosition: 'center',
                    backgroundSize: 'cover',
                  } : undefined}
                  aria-hidden="true"
                />
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
              <div className="theme-control-row theme-image-row">
                <span><strong>背景图片</strong><small>仅保存在当前浏览器，最大 2 MB。</small></span>
                <span className="theme-image-input">
                  <span className={`theme-image-preview${preferences.customBackgroundImage ? '' : ' theme-image-preview--empty'}`}>
                    {preferences.customBackgroundImage ? <img src={preferences.customBackgroundImage} alt="当前背景图片预览" /> : <span>未设置</span>}
                  </span>
                  <span className="theme-image-actions">
                    <label className="theme-image-upload">
                      <ImagePlus size={14} />
                      <span>选择图片</span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0]
                          event.currentTarget.value = ''
                          void updateBackgroundImage(file)
                        }}
                        aria-label="上传背景图片"
                      />
                    </label>
                    {preferences.customBackgroundImage ? <button className="theme-image-clear" type="button" onClick={() => { setImageError(null); onChange({ ...preferences, customBackgroundImage: undefined }) }}><X size={13} />清除</button> : null}
                  </span>
                </span>
              </div>
              {imageError ? <p className="theme-image-error" role="alert">{imageError}</p> : null}
            </div>
          ) : <p className="theme-settings-hint">切换主题后会立即应用到侧边栏、聊天区和输入框。</p>}
        </section>
      </div>
    </main>
  )
}

function stripStandaloneSeparators(text: string) {
  // Codex sometimes emits terminal-style divider rows outside code blocks. They
  // are not message content, and render as a full-width line on narrow screens.
  return text.replace(/^[\t ]*(?:[-_\u2500\u2501\u2550\u2014][\t ]*){3,}(?:\r?\n|$)/gm, '')
}

function MessageContent({ text, hideStandaloneSeparators = false, showCodeCopy = true }: { text: string; hideStandaloneSeparators?: boolean; showCodeCopy?: boolean }) {
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
      {blocks.map((block, index) => {
        if (block.type === 'code') return <CodeBlock key={`code-${index}`} value={block.value} language={block.language} showCopy={showCodeCopy} />
        const value = hideStandaloneSeparators ? stripStandaloneSeparators(block.value) : block.value
        return value ? <div className="chat-message__text" key={`text-${index}`}>{value}</div> : null
      })}
    </div>
  )
}

function CodeBlock({ value, language, showCopy = true }: { value: string; language?: string; showCopy?: boolean }) {
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
      {showCopy ? <button className="chat-message__code-copy" type="button" onClick={() => void copyCode()} aria-label={copied ? '代码已复制' : '复制代码'}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? '已复制' : '复制'}
      </button> : null}
    </pre>
  )
}

const FileChangeCard = memo(function FileChangeCard({ changes }: { changes: CodexFileChange[] }) {
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
  const hasLineStats = additions > 0 || deletions > 0
  const showAll = expanded || reviewing
  const visibleFiles = showAll ? files : files.slice(0, 1)
  const hiddenCount = files.length - 1

  function toggleFiles() {
    if (showAll) {
      setExpanded(false)
      setReviewing(false)
      return
    }
    setExpanded(true)
  }

  return (
    <article className="file-change-card">
      <header className="file-change-card__heading">
        <span className="file-change-card__icon"><FileText size={15} /></span>
        <div className="file-change-card__summary">
          <strong>本次已编辑 {files.length} 个文件</strong>
          {hasLineStats ? <span className="file-change-card__stats"><i>+{additions}</i><em>-{deletions}</em></span> : null}
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
              {item.additions > 0 || item.deletions > 0 ? <span className="file-change-card__file-stats"><i>+{item.additions}</i><em>-{item.deletions}</em></span> : null}
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
          {showAll ? '收起文件' : `查看另外 ${hiddenCount} 个文件`}
          <ChevronDown size={14} />
        </button>
      ) : null}
    </article>
  )
})

const MessageBubble = memo(function MessageBubble({ message, activity, copied, onCopy }: { message: CodexMessage; activity: CodexActivity | null; copied: boolean; onCopy: (message: CodexMessage) => void | Promise<void> }) {
  // A streaming answer is incomplete, so none of its copy controls should be
  // available until Codex has finished the turn.
  const showCopyAction = !message.streaming && Boolean(message.text || message.documents?.length)

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
        {message.text ? <MessageContent text={message.text} hideStandaloneSeparators={message.role === 'assistant'} showCodeCopy={!message.streaming} /> : null}
        {showCopyAction ? <div className="chat-message__actions"><button type="button" onClick={() => void onCopy(message)}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button></div> : null}
      </div>
    </article>
  )
})

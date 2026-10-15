import { Fragment, forwardRef, lazy, memo, Suspense, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject, type ReactNode, type TouchEvent as ReactTouchEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  ArrowUp,
  Bell,
  BellOff,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  Download,
  Eye,
  File,
  FileText,
  Folder,
  FolderOpen,
  ImagePlus,
  Link2,
  LoaderCircle,
  Menu,
  MessagesSquare,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Quote,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from 'lucide-react'
import { useCodexRemote, type CodexActivity, type CodexActivityTimelineEntry, type CodexFileChange, type CodexOperation, type CodexRemoteController, type QueuedTurnMessage } from '../hooks/useCodexRemote'
import { codexRemoteClient, messagesFromThread, type ClaudeCodePermissionMode, type CodexApprovalPolicy, type CodexDocumentAttachment, type CodexImageAttachment, type CodexMessage, type CodexModel, type CodexThread, type CodexWorkspaceEntry, type CodexWorkspaceFile, type CodexWorkspaceImage, type CodexWorkspaceTree } from '../lib/codexRemoteClient'
import { copyTextToClipboard } from '../lib/clipboard'
import { composerMenuPosition } from '../lib/composerMenuPosition'
import { forgetComposerImageDraftTarget, moveComposerImageDraft, pendingComposerImageDraftTarget, readComposerImageDraft, rememberComposerImageDraftTarget, saveComposerImageDraft, subscribeToComposerImageDraft } from '../lib/composerImageDrafts'
import { documentAttachmentAccept, documentExtensionOf, isSupportedDocumentFile, maxDocumentFileSize, maxDocumentsPerTurn } from '../lib/documentAttachmentRules'
import { beginMobileGlobalBackGesture, beginMobilePanelGesture, resolveMobilePanelGesture, type MobilePanelGestureStart } from '../lib/mobilePanelGestures'
import { earlierMessageWindow, recentMessageWindow, visibleMessageStart } from '../lib/messageWindow'
import { isCompactThemeBackgroundImage, normalizeFontSizeAdjustment, normalizeHexColor, normalizeTransparency, themeRootStyle, type AppTheme, type ThemePreferences } from '../lib/themePreferences'
import { canRequestSystemNotifications, requestSystemNotificationPermission, sendSystemNotification, type AndroidNotificationBridge } from '../lib/systemNotifications'
import { createThreadTranscript, threadTranscriptFilename } from '../lib/threadTranscript'
import { createWorkspaceSelectionDocument, isWorkspaceSelectionDocument, numberWorkspaceSelectionDocument, sameWorkspaceSelectionDocument, workspaceSelectionMenuPosition, workspaceTextSelectionLineRange, type WorkspaceSelectionBounds } from '../lib/workspaceSelection'
import { ChatOverlayPanel } from './ChatOverlayPanel'

interface Props {
  token: string
  onUnauthorized: () => void
  onUnpair: () => void | Promise<void>
  themePreferences: ThemePreferences
  onThemePreferencesChange: (next: ThemePreferences) => void
}

declare global {
  interface Window {
    CodexRemoteAndroid?: AndroidNotificationBridge
    CodexRemoteOpenThread?: (threadId: string) => void
    __codexRemotePendingThreadId?: string
    CodexRemoteHandleBack?: () => boolean
  }
}

const connectionLabel = {
  connecting: '正在连接',
  connected: 'Codex 已连接',
  disconnected: '连接已断开',
  unavailable: 'Codex 不可用',
}

const TerminalDialog = lazy(() => import('./TerminalDialog').then(({ TerminalDialog: component }) => ({ default: component })))

type ChatEngine = 'codex' | 'claude-code'

function EngineBrandIcon({ engine, size = 16 }: { engine: ChatEngine; size?: number }) {
  return <span className={`engine-brand-icon engine-brand-icon--${engine}`} style={{ width: size, height: size }} aria-hidden="true" />
}

function shouldUseDarkStatusBarIcons(preferences: ThemePreferences) {
  if (preferences.theme === 'light' || preferences.theme === 'warm') return true
  if (preferences.theme === 'dark') return false

  const hex = preferences.customBackgroundColor.slice(1)
  const channels = [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
  const linearChannels = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4)
  const relativeLuminance = 0.2126 * linearChannels[0] + 0.7152 * linearChannels[1] + 0.0722 * linearChannels[2]
  return relativeLuminance >= 0.179
}

const threadTimeFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })
const threadDateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })
const messageTimestampFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
const imageTypes = new Set<CodexImageAttachment['mediaType']>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const imageMediaTypesByExtension: Record<string, CodexImageAttachment['mediaType']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}
const imageAttachmentAccept = [...imageTypes].join(',')
const mobileAttachmentAccept = `${imageAttachmentAccept},${documentAttachmentAccept}`
const maxImageSize = 8 * 1024 * 1024
const maxThemeImageUploadSize = 20 * 1024 * 1024
const maxThemeImageEdge = 1_920
const maxImagesPerTurn = 4
const longPasteThreshold = 4_000

function formatMessageTimestamp(value: string | undefined) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : messageTimestampFormatter.format(date)
}

function formatTurnDuration(durationMs: number) {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${seconds}秒`
}
const workspaceTreeMaxEntries = 400
const workspaceExplorerWidthStorageKey = 'codex-remote.workspace-explorer-width'
const workspaceExplorerRootStorageKey = 'codex-remote.workspace-explorer-root'
const paneLayoutStorageKey = 'codex-remote.pane-layout'
const settingsHistoryStateKey = '__codexRemoteSettingsOpen'
const workspaceExplorerDefaultWidth = 340
const workspaceExplorerMinWidth = 220
const workspaceExplorerMaxWidth = 2_400
const workspaceChatMinWidth = 240
const minComposerHeight = 45
const maxComposerHeight = 260
const defaultComposerHeight = 72
const compactLandscapeComposerHeight = 50
const compactLandscapeMediaQuery = '(orientation: landscape) and (pointer: coarse)'
const mobileLayoutMediaQuery = '(max-width: 700px), (orientation: landscape) and (pointer: coarse)'
const composerPreferencesStorageKey = 'codex-remote.composer-preferences'
const threadComposerPreferencesStorageKey = 'codex-remote.thread-composer-preferences'
const legacyComposerDraftStorageKey = 'codex-remote.composer-draft'
const composerDraftStoragePrefix = 'codex-remote.composer-draft.'
const composerFocusRestoreStorageKey = 'codex-remote.composer-focus-restore'
const pinnedThreadIdsStorageKey = 'codex-remote.pinned-thread-ids'
const newThreadComposerDraftScope = 'new'

interface PersistedPaneLayout {
  openPaneIndexes: number[]
  selectedPaneIndex: number
  threadIdsByPane: Record<string, string>
}

function readPersistedPaneLayout(): PersistedPaneLayout {
  const fallback: PersistedPaneLayout = { openPaneIndexes: [0], selectedPaneIndex: 0, threadIdsByPane: {} }
  if (typeof window === 'undefined') return fallback
  try {
    const value = window.localStorage.getItem(paneLayoutStorageKey)
    if (!value) return fallback
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
    const paneLimit = concurrentPaneLimit()
    const openPaneIndexes = Array.isArray(parsed.openPaneIndexes)
      ? [...new Set(parsed.openPaneIndexes.filter((index): index is number => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < paneLimit))]
      : []
    if (openPaneIndexes.length === 0) openPaneIndexes.push(0)
    const requestedSelection = parsed.selectedPaneIndex
    const selectedPaneIndex = typeof requestedSelection === 'number'
      && Number.isInteger(requestedSelection)
      && openPaneIndexes.includes(requestedSelection)
      ? requestedSelection
      : openPaneIndexes[0]
    const savedThreads = parsed.threadIdsByPane && typeof parsed.threadIdsByPane === 'object' && !Array.isArray(parsed.threadIdsByPane)
      ? parsed.threadIdsByPane as Record<string, unknown>
      : {}
    const threadIdsByPane = Object.fromEntries(openPaneIndexes.flatMap((index) => {
      const threadId = savedThreads[String(index)]
      return typeof threadId === 'string' && threadId.trim().length > 0 && threadId.length <= 512
        ? [[String(index), threadId.trim()]]
        : []
    }))
    return { openPaneIndexes, selectedPaneIndex, threadIdsByPane }
  } catch {
    return fallback
  }
}

function savePersistedPaneLayout(layout: PersistedPaneLayout) {
  try {
    window.localStorage.setItem(paneLayoutStorageKey, JSON.stringify(layout))
  } catch {
    // Open panes still work for the current page when storage is unavailable.
  }
}

function readPinnedThreadIds() {
  if (typeof window === 'undefined') return new Set<string>()
  try {
    const value = window.localStorage.getItem(pinnedThreadIdsStorageKey)
    if (!value) return new Set<string>()
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return new Set<string>()
    return new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 512))
  } catch {
    return new Set<string>()
  }
}

function isSettingsHistoryEntry(state: unknown): boolean {
  return Boolean(state && typeof state === 'object' && (state as Record<string, unknown>)[settingsHistoryStateKey] === true)
}

interface ComposerPreferences {
  model?: string
  effort?: string
  approvalPolicy?: CodexApprovalPolicy
  claudeModel?: string
  claudeEffort?: string
  claudePermissionMode?: ClaudeCodePermissionMode
}

type ThreadComposerPreferences = Record<string, ComposerPreferences>

function workspacePanelsWidthLimit() {
  if (typeof window !== 'undefined' && window.matchMedia(mobileLayoutMediaQuery).matches) {
    return workspaceExplorerMaxWidth
  }
  const viewportWidth = typeof window === 'undefined' ? 1_400 : window.innerWidth
  const sidebarWidth = Math.round(Math.max(180, Math.min(284, viewportWidth * 0.22)))
  const availableWorkspaceWidth = viewportWidth - sidebarWidth - 8
  const chatMinimumLimit = availableWorkspaceWidth - workspaceChatMinWidth
  return Math.max(0, Math.min(workspaceExplorerMaxWidth, chatMinimumLimit))
}

function workspaceExplorerMinimumWidth() {
  const viewportWidth = typeof window === 'undefined' ? 1_400 : window.innerWidth
  return viewportWidth <= 900 ? 160 : workspaceExplorerMinWidth
}

function workspaceExplorerWidthLimit() {
  return Math.max(workspaceExplorerMinimumWidth(), Math.min(workspaceExplorerMaxWidth, workspacePanelsWidthLimit()))
}

function clampWorkspaceExplorerWidth(value: number) {
  return Math.round(Math.max(workspaceExplorerMinimumWidth(), Math.min(workspaceExplorerWidthLimit(), value)))
}

function readWorkspaceExplorerWidth() {
  if (typeof window === 'undefined') return workspaceExplorerDefaultWidth
  try {
    const stored = Number(window.localStorage.getItem(workspaceExplorerWidthStorageKey))
    return clampWorkspaceExplorerWidth(Number.isFinite(stored) && stored > 0 ? stored : workspaceExplorerDefaultWidth)
  } catch {
    return clampWorkspaceExplorerWidth(workspaceExplorerDefaultWidth)
  }
}

function readWorkspaceExplorerRoot() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(workspaceExplorerRootStorageKey)?.trim() || null
  } catch {
    return null
  }
}

function workspaceAbsolutePath(cwd: string | undefined, path: string) {
  if (!cwd) return path
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const separator = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'
  const base = trimmed || (cwd.startsWith('\\') ? '\\' : '/')
  const rootedDrive = /^[a-z]:$/i.test(base) ? `${base}${separator}` : base
  if (!path) return cwd
  return `${rootedDrive}${rootedDrive.endsWith('/') || rootedDrive.endsWith('\\') ? '' : separator}${path}`
}

function workspaceParentPath(path: string) {
  const drivePath = /^([a-z]:)[\\/]*(.*)$/i.exec(path)
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  if (drivePath) {
    const segments = drivePath[2].split(/[\\/]+/).filter(Boolean)
    if (segments.length === 0) return `${drivePath[1]}${separator}`
    segments.pop()
    return `${drivePath[1]}${separator}${segments.join(separator) || ''}`
  }
  const normalized = path.replace(/[\\/]+$/, '')
  if (!normalized) return path.startsWith('\\') ? '\\' : '/'
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparator < 0) return path
  if (lastSeparator === 0) return normalized[0]
  return normalized.slice(0, lastSeparator)
}

function workspaceFileReference(cwd: string | undefined, path: string) {
  const isAbsolute = path.startsWith('/') || path.startsWith('\\\\') || /^[a-z]:[\\/]/i.test(path)
  return isAbsolute || !cwd ? path : workspaceAbsolutePath(cwd, path)
}

function workspaceRelativePath(cwd: string | undefined, path: string) {
  if (!cwd) return path
  const normalizedCwd = cwd.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const normalizedPath = path.replace(/[\\/]+/g, '/')
  const prefix = `${normalizedCwd}/`
  const isWindowsPath = /^[a-z]:\//i.test(prefix)
  if (normalizedPath.toLowerCase() === normalizedCwd.toLowerCase()) return ''
  if (isWindowsPath
    ? normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())
    : normalizedPath.startsWith(prefix)) return normalizedPath.slice(prefix.length)
  return path.replace(/^\.\//, '')
}

function draftContainsWorkspacePath(draft: string, path: string) {
  if (!draft || !path) return false
  let index = draft.indexOf(path)
  while (index >= 0) {
    const previous = draft[index - 1]
    const next = draft[index + path.length]
    const startsAtBoundary = previous === undefined || /[\s"'`([{<]/.test(previous)
    const endsAtBoundary = next === undefined || /[\s"'`)\]}>]/.test(next)
    if (startsAtBoundary && endsAtBoundary) return true
    index = draft.indexOf(path, index + path.length)
  }
  return false
}

function workspacePathsMissingFromDraft(draft: string, paths: string[]) {
  const seen = new Set<string>()
  return paths.filter((path) => {
    if (!path || seen.has(path) || draftContainsWorkspacePath(draft, path)) return false
    seen.add(path)
    return true
  })
}

function approvalPolicyOf(value: unknown): CodexApprovalPolicy | undefined {
  if (value === 'on-request' || value === 'untrusted' || value === 'never') return value
  // Migrate values saved by versions 0.0.20–0.0.24.
  if (value === 'onRequest') return 'on-request'
  if (value === 'unlessTrusted') return 'untrusted'
  return undefined
}

function claudePermissionModeOf(value: unknown): ClaudeCodePermissionMode | undefined {
  return value === 'default' || value === 'manual' || value === 'acceptEdits'
    || value === 'auto' || value === 'dontAsk' || value === 'plan' ? value : undefined
}

function composerPreferencesFrom(value: unknown): ComposerPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const parsed = value as Record<string, unknown>
  const preferences: ComposerPreferences = {}
  if (typeof parsed.model === 'string' && parsed.model) preferences.model = parsed.model
  if (typeof parsed.effort === 'string' && parsed.effort) preferences.effort = parsed.effort
  const approvalPolicy = approvalPolicyOf(parsed.approvalPolicy)
  if (approvalPolicy) preferences.approvalPolicy = approvalPolicy
  if (typeof parsed.claudeModel === 'string' && parsed.claudeModel) preferences.claudeModel = parsed.claudeModel
  if (typeof parsed.claudeEffort === 'string' && parsed.claudeEffort) preferences.claudeEffort = parsed.claudeEffort
  const claudePermissionMode = claudePermissionModeOf(parsed.claudePermissionMode)
  if (claudePermissionMode) preferences.claudePermissionMode = claudePermissionMode
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
    claudeModel: threadPreferences?.claudeModel ?? defaults.claudeModel,
    claudeEffort: threadPreferences?.claudeEffort ?? defaults.claudeEffort,
    claudePermissionMode: threadPreferences?.claudePermissionMode ?? defaults.claudePermissionMode,
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

interface ComposerFocusRestoreState {
  scope: string
  selectionStart: number
  selectionEnd: number
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

function imageMediaTypeFor(file: Pick<File, 'name' | 'type'>): CodexImageAttachment['mediaType'] | null {
  if (imageTypes.has(file.type as CodexImageAttachment['mediaType'])) return file.type as CodexImageAttachment['mediaType']
  const extension = file.name.toLowerCase().split('.').at(-1) ?? ''
  return imageMediaTypesByExtension[extension] ?? null
}

function isImageAttachmentFile(file: Pick<File, 'name' | 'type'>) {
  return file.type.startsWith('image/') || imageMediaTypeFor(file) !== null
}

const approvalPolicyOptions: Array<{ value: CodexApprovalPolicy; label: string }> = [
  { value: 'on-request', label: '请求批准' },
  { value: 'untrusted', label: '帮我批准' },
  { value: 'never', label: '完全访问' },
]

const claudeModelOptions = [
  { value: 'default', label: '本机默认模型' },
  { value: 'fable', label: 'Claude Fable' },
  { value: 'opus', label: 'Claude Opus' },
  { value: 'sonnet', label: 'Claude Sonnet' },
]

const claudeEffortOptions = [
  { value: 'default', label: '本机默认' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
]

const claudePermissionModeOptions: Array<{ value: ClaudeCodePermissionMode; label: string }> = [
  { value: 'default', label: '本机默认权限' },
  { value: 'manual', label: '手动确认' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'auto', label: '自动模式' },
  { value: 'dontAsk', label: '不询问（拒绝需授权操作）' },
  { value: 'plan', label: '计划模式' },
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
      const mediaType = imageMediaTypeFor(file)
      if (!mediaType) {
        reject(new Error(`不支持的图片格式：${file.name}`))
        return
      }
      resolve({ name: file.name || 'image', mediaType, data: result.slice(separator + 1) })
    }
    reader.readAsDataURL(file)
  })
}

function optimizeThemeBackgroundImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = document.createElement('img')
    const sourceUrl = URL.createObjectURL(file)
    image.onload = () => {
      URL.revokeObjectURL(sourceUrl)
      try {
        const longestEdge = Math.max(image.naturalWidth, image.naturalHeight)
        if (!longestEdge) throw new Error('图片尺寸无效。')
        let scale = Math.min(1, maxThemeImageEdge / longestEdge)
        let smallestResult = ''
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const width = Math.max(1, Math.round(image.naturalWidth * scale))
          const height = Math.max(1, Math.round(image.naturalHeight * scale))
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d')
          if (!context) throw new Error('浏览器不支持图片处理。')
          context.drawImage(image, 0, 0, width, height)
          for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
            const dataUrl = canvas.toDataURL('image/webp', quality)
            if (!smallestResult || dataUrl.length < smallestResult.length) smallestResult = dataUrl
            if (isCompactThemeBackgroundImage(dataUrl)) {
              resolve(dataUrl)
              return
            }
          }
          scale *= 0.72
        }
        if (isCompactThemeBackgroundImage(smallestResult)) {
          resolve(smallestResult)
          return
        }
        throw new Error('图片无法压缩到浏览器可保存的大小。')
      } catch (reason) {
        reject(reason instanceof Error ? reason : new Error('背景图片处理失败。'))
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(sourceUrl)
      reject(new Error('背景图片读取失败。'))
    }
    image.src = sourceUrl
  })
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
  const popover = useRef<HTMLDivElement>(null)
  const composerFocusBeforeOpen = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState<ReturnType<typeof composerMenuPosition> | null>(null)
  const selected = options.find((option) => option.value === value)

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const updatePosition = () => {
      if (!root.current || !popover.current) return
      const viewport = window.visualViewport
      const rect = popover.current.getBoundingClientRect()
      const next = composerMenuPosition(root.current.getBoundingClientRect(), {
        width: rect.width,
        height: Math.min(340, popover.current.scrollHeight + 2),
      }, {
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
      })
      setPosition((current) => current && current.left === next.left && current.top === next.top
        && current.maxWidth === next.maxWidth && current.maxHeight === next.maxHeight ? current : next)
    }
    const handleScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !popover.current?.contains(event.target)) updatePosition()
    }
    updatePosition()
    const settleStartedAt = window.performance.now()
    let settleFrame: number | undefined
    const trackAnchorWhileViewportSettles = () => {
      updatePosition()
      if (window.performance.now() - settleStartedAt < 600) {
        settleFrame = window.requestAnimationFrame(trackAnchorWhileViewportSettles)
      }
    }
    settleFrame = window.requestAnimationFrame(trackAnchorWhileViewportSettles)
    const observer = new ResizeObserver(updatePosition)
    if (root.current) observer.observe(root.current)
    if (popover.current) observer.observe(popover.current)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', handleScroll, true)
    window.visualViewport?.addEventListener('resize', updatePosition)
    window.visualViewport?.addEventListener('scroll', updatePosition)
    return () => {
      if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame)
      observer.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', handleScroll, true)
      window.visualViewport?.removeEventListener('resize', updatePosition)
      window.visualViewport?.removeEventListener('scroll', updatePosition)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) onOpenChange(false)
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
        onPointerDown={(event) => {
          const activeElement = document.activeElement
          if (!(activeElement instanceof HTMLElement) || !activeElement.matches('.message-composer textarea')) {
            composerFocusBeforeOpen.current = null
            return
          }
          composerFocusBeforeOpen.current = activeElement
          event.preventDefault()
        }}
        onClick={() => onOpenChange(!open)}
      >
        <span className="composer-menu__value">{selected?.label ?? emptyLabel}</span>
      </button>
      {open ? createPortal(
        <div
          ref={popover}
          className="composer-menu__popover composer-menu__popover--floating"
          style={position ?? { visibility: 'hidden' }}
          role="listbox"
          aria-label={label}
        >
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
                const focusTarget = composerFocusBeforeOpen.current
                composerFocusBeforeOpen.current = null
                if (focusTarget?.isConnected) {
                  window.requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }))
                }
              }}
            >
              <span className="composer-menu__option-copy">
                <strong>{option.label}</strong>
              </span>
              {option.value === value ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          )) : <span className="composer-menu__empty">{emptyLabel}</span>}
        </div>,
        root.current?.closest('.remote-shell') ?? document.body,
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
  claudeModel?: string
  claudeEffort?: string
  claudePermissionMode?: ClaudeCodePermissionMode
}

interface ComposerHandle {
  replaceDraft(value: string): void
  appendDraft(value: string, focus?: boolean): void
  insertDraftAtCursor(value: string, focus?: boolean): void
  addDocumentAttachment(document: CodexDocumentAttachment, focus?: boolean): boolean
  adoptUnassignedDraft(threadId: string, includeImages?: boolean): void
  closeOpenMenu(): boolean
}

interface MessageComposerProps {
  draftScope: string
  onDraftChange: (draft: string) => void
  composerHeightMemory: RefObject<{ height: number; manuallyResized: boolean } | null>
  connection: RemoteConnection
  isRunning: boolean
  fileChangeSummary: FileChangeSummary | null
  fileChangeSummaryKey: string | null
  reserveFileChangeSummarySpace: boolean
  reserveQueuedMessageSpace: boolean
  showCodexPreferences: boolean
  isInterrupting: boolean
  writerConflict: boolean
  modelSupportsImages: boolean
  selectedModel: string
  selectedEffort: string
  selectedApprovalPolicy: CodexApprovalPolicy
  selectedClaudePermissionMode: ClaudeCodePermissionMode
  modelOptions: ComposerMenuOption[]
  reasoningOptions: ComposerMenuOption[]
  authorizationOptions: ComposerMenuOption[]
  claudeModelOptions: ComposerMenuOption[]
  claudeEffortOptions: ComposerMenuOption[]
  claudePermissionModeOptions: ComposerMenuOption[]
  onModelChange: (model: string) => void
  onEffortChange: (effort: string) => void
  onApprovalPolicyChange: (approvalPolicy: CodexApprovalPolicy) => void
  onClaudePermissionModeChange: (mode: ClaudeCodePermissionMode) => void
  approvalPolicyUpdating?: boolean
  onUploadPdf: (file: File) => Promise<{ attachment_id: string; name: string; size: number }>
  onSend: (input: ComposerSendInput) => Promise<boolean>
  queuedMessages: QueuedTurnMessage[]
  onSendQueuedNow: (messageId: string) => Promise<boolean>
  onBeginQueuedEdit: (messageId: string) => boolean | Promise<boolean>
  onUpdateQueuedMessage: (messageId: string, input: Pick<ComposerSendInput, 'prompt' | 'images' | 'documents'>) => boolean | Promise<boolean>
  onEndQueuedEdit: (messageId: string) => void | boolean | Promise<boolean>
  onRemoveQueued: (messageId: string) => void | boolean | Promise<boolean>
  onInterrupt: () => void
  onRefresh: () => void
}

const MessageComposer = memo(forwardRef<ComposerHandle, MessageComposerProps>(function MessageComposer({
  draftScope,
  onDraftChange,
  composerHeightMemory,
  connection,
  isRunning,
  fileChangeSummary,
  fileChangeSummaryKey,
  reserveFileChangeSummarySpace,
  reserveQueuedMessageSpace,
  showCodexPreferences,
  isInterrupting,
  writerConflict,
  modelSupportsImages,
  selectedModel,
  selectedEffort,
  selectedApprovalPolicy,
  selectedClaudePermissionMode,
  modelOptions,
  reasoningOptions,
  authorizationOptions,
  claudeModelOptions,
  claudeEffortOptions,
  claudePermissionModeOptions,
  onModelChange,
  onEffortChange,
  onApprovalPolicyChange,
  onClaudePermissionModeChange,
  approvalPolicyUpdating = false,
  onUploadPdf,
  onSend,
  queuedMessages,
  onSendQueuedNow,
  onBeginQueuedEdit,
  onUpdateQueuedMessage,
  onEndQueuedEdit,
  onRemoveQueued,
  onInterrupt,
  onRefresh,
}, ref) {
  const [draft, setDraft] = useState(() => readComposerDraft(draftScope))
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [attachedImages, setAttachedImages] = useState<CodexImageAttachment[]>([])
  const [imagesReady, setImagesReady] = useState(false)
  const [readingImages, setReadingImages] = useState(false)
  const [attachedDocuments, setAttachedDocuments] = useState<CodexDocumentAttachment[]>([])
  const [readingDocuments, setReadingDocuments] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [compactLandscape, setCompactLandscape] = useState(() => typeof window !== 'undefined' && window.matchMedia(compactLandscapeMediaQuery).matches)
  const [mobileLayout, setMobileLayout] = useState(() => typeof window !== 'undefined' && (
    window.matchMedia(mobileLayoutMediaQuery).matches || Boolean(window.CodexRemoteAndroid?.changeEndpoint)
  ))
  const [expandedFileChangesKey, setExpandedFileChangesKey] = useState<string | null>(null)
  const [composerHeight, setComposerHeight] = useState(() => {
    if (composerHeightMemory.current?.manuallyResized) return composerHeightMemory.current.height
    if (typeof window === 'undefined') return defaultComposerHeight
    return window.matchMedia(compactLandscapeMediaQuery).matches ? compactLandscapeComposerHeight : defaultComposerHeight
  })
  const [queuedMessagesExpanded, setQueuedMessagesExpanded] = useState(false)
  const [sendingQueuedId, setSendingQueuedId] = useState<string | null>(null)
  const [editingQueuedMessageId, setEditingQueuedMessageId] = useState<string | null>(null)
  const [openMenu, setOpenMenu] = useState<'model' | 'effort' | 'approval' | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const draftRef = useRef(draft)
  const draftScopeRef = useRef(draftScope)
  draftScopeRef.current = draftScope
  const attachedImagesRef = useRef(attachedImages)
  attachedImagesRef.current = attachedImages
  const attachedDocumentsRef = useRef(attachedDocuments)
  attachedDocumentsRef.current = attachedDocuments
  const editingQueuedMessageIdRef = useRef<string | null>(null)
  const openMenuRef = useRef<'model' | 'effort' | 'approval' | null>(null)
  const draftSaveTimer = useRef<number | undefined>(undefined)
  const focusRestoreAttempted = useRef(false)
  const resizeState = useRef<{ startY: number; startHeight: number } | null>(null)
  const composerHeightWasResized = useRef(composerHeightMemory.current?.manuallyResized ?? false)
  const inputIsComposing = useRef(false)
  const editingDraftSnapshot = useRef<{
    draft: string
    images: CodexImageAttachment[]
    documents: CodexDocumentAttachment[]
    attachmentError: string | null
  } | null>(null)

  useLayoutEffect(() => {
    composerHeightMemory.current = { height: composerHeight, manuallyResized: composerHeightWasResized.current }
  }, [composerHeight, composerHeightMemory])

  useEffect(() => {
    const mediaQuery = window.matchMedia(compactLandscapeMediaQuery)
    const syncComposerHeight = () => {
      setCompactLandscape(mediaQuery.matches)
      if (composerHeightWasResized.current) return
      setComposerHeight(mediaQuery.matches ? compactLandscapeComposerHeight : defaultComposerHeight)
    }
    syncComposerHeight()
    if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', syncComposerHeight)
    else mediaQuery.addListener(syncComposerHeight)
    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') mediaQuery.removeEventListener('change', syncComposerHeight)
      else mediaQuery.removeListener(syncComposerHeight)
    }
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia(mobileLayoutMediaQuery)
    const syncMobileLayout = () => {
      setMobileLayout(mediaQuery.matches || Boolean(window.CodexRemoteAndroid?.changeEndpoint))
    }
    syncMobileLayout()
    if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', syncMobileLayout)
    else mediaQuery.addListener(syncMobileLayout)
    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') mediaQuery.removeEventListener('change', syncMobileLayout)
      else mediaQuery.removeListener(syncMobileLayout)
    }
  }, [])

  useEffect(() => {
    if (queuedMessages.length === 0) setQueuedMessagesExpanded(false)
  }, [queuedMessages.length])

  useLayoutEffect(() => {
    if (!compactLandscape || composerHeightWasResized.current) return
    const textarea = composer.current
    if (!textarea) return
    const measureComposerHeight = () => {
      const previousHeight = textarea.style.height
      textarea.style.height = '0px'
      const contentHeight = textarea.scrollHeight
      textarea.style.height = previousHeight
      const nextHeight = Math.min(maxComposerHeight, Math.max(minComposerHeight, contentHeight))
      setComposerHeight((current) => current === nextHeight ? current : nextHeight)
    }
    measureComposerHeight()
    window.addEventListener('resize', measureComposerHeight)
    return () => window.removeEventListener('resize', measureComposerHeight)
  }, [compactLandscape, draft, attachedDocuments.length, attachedImages.length])

  const changeOpenMenu = useCallback((next: 'model' | 'effort' | 'approval' | null) => {
    openMenuRef.current = next
    setOpenMenu(next)
  }, [])

  const updateDraft = useCallback((next: string | ((current: string) => string)) => {
    const value = typeof next === 'function' ? next(draftRef.current) : next
    draftRef.current = value
    setDraft(value)
  }, [])

  const updateAttachedImages = useCallback((next: CodexImageAttachment[], persist = true) => {
    const images = next.slice(0, maxImagesPerTurn)
    attachedImagesRef.current = images
    setAttachedImages(images)
    if (persist && !editingQueuedMessageIdRef.current) {
      void saveComposerImageDraft(draftScope, images).catch((reason: unknown) => {
        if (draftScopeRef.current !== draftScope) return
        setAttachmentError(reason instanceof Error
          ? `图片草稿暂未保存：${reason.message} 刷新后可能无法恢复。`
          : '图片草稿暂未保存，刷新后可能无法恢复。')
      })
    }
  }, [draftScope])

  useEffect(() => {
    let active = true
    setImagesReady(false)
    const unsubscribe = subscribeToComposerImageDraft(draftScope, (images) => {
      if (!active) return
      attachedImagesRef.current = images
      setAttachedImages(images)
      setImagesReady(true)
    })
    void readComposerImageDraft(draftScope).then((images) => {
      if (!active) return
      attachedImagesRef.current = images
      setAttachedImages(images)
    }).catch((reason: unknown) => {
      if (!active) return
      setAttachmentError(reason instanceof Error
        ? `待发送图片恢复失败：${reason.message}`
        : '待发送图片恢复失败。')
    }).finally(() => {
      if (active) setImagesReady(true)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [draftScope])

  useLayoutEffect(() => onDraftChange(draft), [draft, onDraftChange])

  useLayoutEffect(() => {
    if (focusRestoreAttempted.current) return
    focusRestoreAttempted.current = true

    const navigation = window.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    let restoreState: ComposerFocusRestoreState | null = null
    try {
      const stored = window.sessionStorage.getItem(composerFocusRestoreStorageKey)
      window.sessionStorage.removeItem(composerFocusRestoreStorageKey)
      if (stored) {
        const parsed: unknown = JSON.parse(stored)
        if (parsed && typeof parsed === 'object') {
          const candidate = parsed as Record<string, unknown>
          if (typeof candidate.scope === 'string'
            && typeof candidate.selectionStart === 'number'
            && typeof candidate.selectionEnd === 'number') {
            restoreState = {
              scope: candidate.scope,
              selectionStart: candidate.selectionStart,
              selectionEnd: candidate.selectionEnd,
            }
          }
        }
      }
    } catch {
      // Ignore browser storage restrictions; the composer still works normally.
    }
    if (navigation?.type !== 'reload' || restoreState?.scope !== draftScope) return
    const savedFocus = restoreState

    window.requestAnimationFrame(() => {
      const textarea = composer.current
      if (!textarea) return
      textarea.focus({ preventScroll: true })
      const selectionStart = Math.max(0, Math.min(savedFocus.selectionStart, textarea.value.length))
      const selectionEnd = Math.max(selectionStart, Math.min(savedFocus.selectionEnd, textarea.value.length))
      textarea.setSelectionRange(selectionStart, selectionEnd)
    })
  }, [draftScope])

  useEffect(() => () => {
    const messageId = editingQueuedMessageIdRef.current
    if (messageId) onEndQueuedEdit(messageId)
  }, [onEndQueuedEdit])

  useImperativeHandle(ref, () => ({
    replaceDraft(value) {
      updateDraft(value)
      window.requestAnimationFrame(() => composer.current?.focus())
    },
    appendDraft(value, focus = true) {
      const current = draftRef.current
      const additions = workspacePathsMissingFromDraft(current, value.split(/\r?\n/))
      if (additions.length === 0) {
        if (focus) window.requestAnimationFrame(() => composer.current?.focus())
        return
      }
      const separator = current && !/\s$/.test(current) ? '\n' : ''
      updateDraft(`${current}${separator}${additions.join('\n')}`)
      if (focus) window.requestAnimationFrame(() => composer.current?.focus())
    },
    insertDraftAtCursor(value, focus = true) {
      const textarea = composer.current
      const current = draftRef.current
      const start = textarea?.selectionStart ?? current.length
      const end = textarea?.selectionEnd ?? start
      const next = `${current.slice(0, start)}${value}${current.slice(end)}`
      updateDraft(next)
      if (focus) {
        window.requestAnimationFrame(() => {
          const activeTextarea = composer.current
          if (!activeTextarea) return
          activeTextarea.focus()
          const cursor = start + value.length
          activeTextarea.setSelectionRange(cursor, cursor)
        })
      }
    },
    addDocumentAttachment(document, focus = true) {
      const added = appendDocument(document)
      if (focus) window.requestAnimationFrame(() => composer.current?.focus())
      return added
    },
    adoptUnassignedDraft(threadId, includeImages = true) {
      const targetScope = composerDraftScopeForThread(threadId)
      const unassignedDraft = draftScope === newThreadComposerDraftScope
        ? draftRef.current
        : readComposerDraft(newThreadComposerDraftScope)
      if (includeImages
        && targetScope !== newThreadComposerDraftScope
        && (attachedImagesRef.current.length > 0 || !imagesReady)) {
        void moveComposerImageDraft(newThreadComposerDraftScope, targetScope).then((images) => {
          if (draftScopeRef.current === targetScope) updateAttachedImages(images, false)
        }).catch((reason: unknown) => {
          if (draftScopeRef.current === targetScope) {
            setAttachmentError(reason instanceof Error
              ? `图片草稿转移失败：${reason.message}`
              : '图片草稿转移失败。')
          }
        })
      } else if (targetScope !== newThreadComposerDraftScope) {
        rememberComposerImageDraftTarget(newThreadComposerDraftScope, targetScope)
      }
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
  }), [changeOpenMenu, draftScope, updateAttachedImages, updateDraft])

  useEffect(() => {
    if (draftSaveTimer.current !== undefined) window.clearTimeout(draftSaveTimer.current)
    const snapshot = editingDraftSnapshot.current
    if (snapshot) {
      saveComposerDraft(draftScope, snapshot.draft)
      draftSaveTimer.current = undefined
      return
    }
    const timer = window.setTimeout(() => saveComposerDraft(draftScope, draft), 260)
    draftSaveTimer.current = timer
    return () => {
      if (draftSaveTimer.current !== timer) return
      window.clearTimeout(timer)
      draftSaveTimer.current = undefined
    }
  }, [draft, draftScope, editingQueuedMessageId])

  useLayoutEffect(() => {
    const persistDraft = () => saveComposerDraft(draftScope, editingDraftSnapshot.current?.draft ?? draftRef.current)
    window.addEventListener('pagehide', persistDraft)
    return () => {
      window.removeEventListener('pagehide', persistDraft)
      persistDraft()
    }
  }, [draftScope])

  useEffect(() => {
    const rememberComposerFocus = () => {
      const textarea = composer.current
      try {
        if (!textarea || document.activeElement !== textarea) {
          window.sessionStorage.removeItem(composerFocusRestoreStorageKey)
          return
        }
        window.sessionStorage.setItem(composerFocusRestoreStorageKey, JSON.stringify({
          scope: draftScope,
          selectionStart: textarea.selectionStart,
          selectionEnd: textarea.selectionEnd,
        } satisfies ComposerFocusRestoreState))
      } catch {
        // The page reload remains safe even when session storage is disabled.
      }
    }
    window.addEventListener('pagehide', rememberComposerFocus)
    return () => window.removeEventListener('pagehide', rememberComposerFocus)
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
  const canSend = (draft.trim().length > 0 || attachedImages.length > 0 || attachedDocuments.length > 0)
    && !readingDocuments
    && !readingImages
    && imagesReady
    && (editingQueuedMessageId ? !sending : canCompose)
  const canAttachFiles = (editingQueuedMessageId ? !sending : canCompose) && !readingDocuments && !readingImages
  const stopWithSendButton = isRunning && !writerConflict && !editingQueuedMessageId
  const fileChangeSummaryExpanded = Boolean(
    mobileLayout && fileChangeSummary && fileChangeSummaryKey && expandedFileChangesKey === fileChangeSummaryKey,
  )
  const fileChangeSummaryTotals = fileChangeSummary ? (
    <>
      <FileText size={12} aria-hidden="true" />
      <span>{fileChangeSummary.files.length} 个文件已更改</span>
      {fileChangeSummary.additions > 0 || fileChangeSummary.deletions > 0 ? (
        <span className="composer-file-change-summary__stats"><i>+{fileChangeSummary.additions}</i><em>-{fileChangeSummary.deletions}</em></span>
      ) : null}
    </>
  ) : null

  async function attachImages(files: File[]): Promise<string | null> {
    if (files.length === 0) return null
    if (!imagesReady) {
      const message = '正在恢复待发送图片，请稍后再添加图片。'
      setAttachmentError(message)
      return message
    }
    if (readingImages) {
      const message = '图片仍在处理中，请稍后再添加。'
      setAttachmentError(message)
      return message
    }
    if (!modelSupportsImages) {
      const message = '当前模型不支持图片输入，请选择支持图片的模型。'
      setAttachmentError(message)
      return message
    }
    const unsupported = files.find((file) => !imageMediaTypeFor(file))
    if (unsupported) {
      const message = '只支持 PNG、JPEG、WebP 和 GIF 图片。'
      setAttachmentError(message)
      return message
    }
    const oversized = files.find((file) => file.size > maxImageSize)
    if (oversized) {
      const message = '单张图片不能超过 8 MB。'
      setAttachmentError(message)
      return message
    }
    const remaining = maxImagesPerTurn - attachedImagesRef.current.length
    if (remaining <= 0) {
      const message = '单条消息最多附加 4 张图片。'
      setAttachmentError(message)
      return message
    }
    const chosen = files.slice(0, remaining)
    setReadingImages(true)
    try {
      const next = await Promise.all(chosen.map(readImage))
      updateAttachedImages([...attachedImagesRef.current, ...next])
      const message = files.length > remaining ? '单条消息最多附加 4 张图片，其余图片未添加。' : null
      setAttachmentError(message)
      return message
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '图片读取失败。'
      setAttachmentError(message)
      return message
    } finally {
      setReadingImages(false)
    }
  }

  async function attachDocuments(files: File[]): Promise<string | null> {
    if (files.length === 0) return null
    if (readingDocuments) {
      const message = '文档仍在处理中，请稍后再添加。'
      setAttachmentError(message)
      return message
    }
    const availableSlots = maxDocumentsPerTurn - attachedDocumentsRef.current.length
    if (availableSlots <= 0) {
      const message = `单条消息最多附加 ${maxDocumentsPerTurn} 个文档。`
      setAttachmentError(message)
      return message
    }
    setReadingDocuments(true)
    const parsed: CodexDocumentAttachment[] = []
    const notices: string[] = files.length > availableSlots
      ? [`单条消息最多附加 ${maxDocumentsPerTurn} 个文档，其余文件未添加。`]
      : []
    try {
      const { readDocumentAttachment } = await import('../lib/documentAttachments')
      for (const file of files.slice(0, availableSlots)) {
        try {
          if (!isSupportedDocumentFile(file)) throw new Error('暂不支持这个文件格式。')
          if (file.size > maxDocumentFileSize) throw new Error('单个文档不能超过 20 MB。')
          if (['pdf', 'xls', 'xlsx', 'xlsm'].includes(documentExtensionOf(file.name)) || file.type === 'application/pdf') {
            const uploaded = await onUploadPdf(file)
            parsed.push({ name: uploaded.name, content: '', sourceFileId: uploaded.attachment_id })
            continue
          }
          const result = await readDocumentAttachment(file)
          parsed.push({ name: result.name, content: result.content })
          if (result.truncated) notices.push(`${file.name} 内容较多，受文件解析范围限制，部分内容未提取。`)
        } catch (reason) {
          notices.push(`${file.name || '文件'}：${reason instanceof Error ? reason.message : '读取失败。'}`)
        }
      }

      let nextDocuments = [...attachedDocumentsRef.current]
      for (const item of parsed) {
        if (nextDocuments.some((current) => item.sourceFileId
          ? current.sourceFileId === item.sourceFileId
          : !current.sourceFileId && current.name === item.name && current.content === item.content)) continue
        if (nextDocuments.length >= maxDocumentsPerTurn) {
          notices.push(`单条消息最多附加 ${maxDocumentsPerTurn} 个文档，其余文件未添加。`)
          break
        }
        if (item.sourceFileId) {
          nextDocuments.push(item)
          continue
        }
        nextDocuments.push(item)
      }
      if (nextDocuments !== attachedDocumentsRef.current) {
        attachedDocumentsRef.current = nextDocuments
        setAttachedDocuments(nextDocuments)
      }
      const message = notices.length > 0 ? notices.slice(0, 4).join(' ') : null
      setAttachmentError(message)
      return message
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '无法加载文档解析器，请刷新页面后重试。'
      setAttachmentError(message)
      return message
    } finally {
      setReadingDocuments(false)
    }
  }

  async function attachSelectedFiles(files: File[]) {
    if (!mobileLayout) {
      await attachDocuments(files)
      return
    }

    const imageFiles = files.filter(isImageAttachmentFile)
    const documentFiles = files.filter((file) => !isImageAttachmentFile(file))
    const notices: string[] = []
    if (imageFiles.length > 0) {
      const notice = await attachImages(imageFiles)
      if (notice) notices.push(notice)
    }
    if (documentFiles.length > 0) {
      const notice = await attachDocuments(documentFiles)
      if (notice) notices.push(notice)
    }
    setAttachmentError(notices.length > 0 ? notices.join(' ') : null)
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sendingRef.current) return
    if (readingDocuments || readingImages || !imagesReady) return
    if (editingQueuedMessageId) {
      void confirmQueuedEdit()
      return
    }
    const prompt = draft.trim()
    if ((!prompt && attachedImagesRef.current.length === 0 && attachedDocuments.length === 0) || !canCompose) return
    if (!modelSupportsImages && attachedImagesRef.current.length > 0) {
      setAttachmentError('当前模型不支持图片输入，请选择支持图片的模型。')
      return
    }
    const previousDraft = draft
    const previousImages = attachedImagesRef.current
    const previousDocuments = attachedDocuments
    const previousAttachmentError = attachmentError
    sendingRef.current = true
    setSending(true)
    updateDraft('')
    saveComposerDraft(draftScope, '')
    updateAttachedImages([], false)
    attachedDocumentsRef.current = []
    setAttachedDocuments([])
    setAttachmentError(null)
    let sent = false
    try {
      sent = await onSend({
        prompt,
        images: previousImages,
        documents: previousDocuments,
        model: showCodexPreferences ? selectedModel || undefined : undefined,
        effort: showCodexPreferences ? selectedEffort || undefined : undefined,
        approvalPolicy: showCodexPreferences ? selectedApprovalPolicy : undefined,
        claudeModel: !showCodexPreferences && selectedModel !== 'default' ? selectedModel : undefined,
        claudeEffort: !showCodexPreferences && selectedEffort !== 'default' ? selectedEffort : undefined,
        claudePermissionMode: showCodexPreferences ? undefined : selectedClaudePermissionMode,
      })
    } catch (reason) {
      setAttachmentError(reason instanceof Error ? reason.message : '发送失败，草稿已恢复。')
    }
    if (!sent) {
      const transferredImageTarget = pendingComposerImageDraftTarget(draftScope)
      let imagesMovedToNewThread = false
      if (transferredImageTarget) {
        try {
          await moveComposerImageDraft(draftScope, transferredImageTarget)
          forgetComposerImageDraftTarget(draftScope)
          imagesMovedToNewThread = true
        } catch (reason) {
          forgetComposerImageDraftTarget(draftScope)
          setAttachmentError(reason instanceof Error
            ? `发送失败，图片仍保留在原草稿：${reason.message}`
            : '发送失败，图片仍保留在原草稿。')
        }
      }
      updateDraft((current) => !current ? previousDraft : !previousDraft ? current : `${previousDraft}${previousDraft.endsWith('\n') ? '' : '\n'}${current}`)
      const currentImages = attachedImagesRef.current
      updateAttachedImages(currentImages.length > 0 ? [...previousImages, ...currentImages] : previousImages, !imagesMovedToNewThread)
      const currentDocuments = attachedDocumentsRef.current
      const restoredDocuments = currentDocuments.length > 0 ? [...previousDocuments, ...currentDocuments] : previousDocuments
      attachedDocumentsRef.current = restoredDocuments
      setAttachedDocuments(restoredDocuments)
      setAttachmentError((current) => current ?? previousAttachmentError)
    } else {
      forgetComposerImageDraftTarget(draftScope)
      try {
        await saveComposerImageDraft(draftScope, [])
      } catch (reason) {
        if (draftScopeRef.current === draftScope) {
          setAttachmentError(reason instanceof Error
            ? `消息已发送，但清除图片草稿失败：${reason.message}`
            : '消息已发送，但清除图片草稿失败。')
        }
      }
    }
    sendingRef.current = false
    setSending(false)
  }

  function restoreDraftAfterQueuedEdit() {
    const snapshot = editingDraftSnapshot.current
    editingDraftSnapshot.current = null
    if (!snapshot) return
    updateDraft(snapshot.draft)
    updateAttachedImages(snapshot.images)
    attachedDocumentsRef.current = snapshot.documents
    setAttachedDocuments(snapshot.documents)
    setAttachmentError(snapshot.attachmentError)
  }

  async function beginQueuedEdit(message: QueuedTurnMessage) {
    if (editingQueuedMessageId || sending || sendingQueuedId) return
    if (!imagesReady) {
      setAttachmentError('图片草稿恢复完成后再编辑排队消息。')
      return
    }
    if (!await onBeginQueuedEdit(message.id)) {
      setAttachmentError('这条排队消息正在处理中，请稍后再试。')
      return
    }
    editingDraftSnapshot.current = {
      draft: draftRef.current,
      images: attachedImagesRef.current,
      documents: attachedDocuments,
      attachmentError,
    }
    editingQueuedMessageIdRef.current = message.id
    setEditingQueuedMessageId(message.id)
    updateDraft(message.text)
    updateAttachedImages(message.images, false)
    attachedDocumentsRef.current = message.documents ?? []
    setAttachedDocuments(message.documents ?? [])
    setAttachmentError(null)
    window.requestAnimationFrame(() => composer.current?.focus())
  }

  async function finishQueuedEdit() {
    const messageId = editingQueuedMessageIdRef.current
    if (messageId && await onEndQueuedEdit(messageId) === false) {
      setAttachmentError('无法结束排队消息编辑，请检查连接后重试。')
      return false
    }
    editingQueuedMessageIdRef.current = null
    setEditingQueuedMessageId(null)
    restoreDraftAfterQueuedEdit()
    return true
  }

  async function confirmQueuedEdit() {
    const messageId = editingQueuedMessageIdRef.current
    if (!messageId || sendingRef.current) return
    const prompt = draftRef.current.trim()
    if (!prompt && attachedImages.length === 0 && attachedDocuments.length === 0) {
      setAttachmentError('消息内容和附件不能同时为空。')
      return
    }
    sendingRef.current = true
    setSending(true)
    try {
      if (!await onUpdateQueuedMessage(messageId, {
        prompt,
        images: attachedImages,
        documents: attachedDocuments,
      })) {
        setAttachmentError('排队消息更新失败，请检查连接后重试。')
        return
      }
      await finishQueuedEdit()
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  function cancelQueuedEdit() {
    if (!editingQueuedMessageIdRef.current) return
    void finishQueuedEdit()
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
    if (readingDocuments) return
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
    appendDocument({ name: 'pasted-content.md', content: pastedText })
  }

  function startComposerResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    composerHeightWasResized.current = true
    composerHeightMemory.current = { height: composerHeight, manuallyResized: true }
    resizeState.current = { startY: event.clientY, startHeight: composerHeight }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  function appendDocument(document: CodexDocumentAttachment) {
    const current = attachedDocumentsRef.current
    const isSelection = isWorkspaceSelectionDocument(document)
    if (current.some((item) => document.sourceFileId
      ? item.sourceFileId === document.sourceFileId
      : !item.sourceFileId && (isSelection
        ? sameWorkspaceSelectionDocument(item, document)
        : item.name === document.name && item.content === document.content))) return false
    if (current.length >= maxDocumentsPerTurn) {
      setAttachmentError(`单条消息最多附加 ${maxDocumentsPerTurn} 个文档。`)
      return false
    }
    const numberedCurrent = current.reduce<CodexDocumentAttachment[]>((documents, item) => {
      documents.push(isWorkspaceSelectionDocument(item) ? numberWorkspaceSelectionDocument(item, documents) : item)
      return documents
    }, [])
    const nextDocument = isSelection ? numberWorkspaceSelectionDocument(document, numberedCurrent) : document
    if (document.sourceFileId) {
      const next = [...numberedCurrent, nextDocument]
      attachedDocumentsRef.current = next
      setAttachedDocuments(next)
      setAttachmentError(null)
      return true
    }
    const next = [...numberedCurrent, nextDocument]
    attachedDocumentsRef.current = next
    setAttachedDocuments(next)
    setAttachmentError(null)
    return true
  }

  return (
    <div className="composer-dock">
      {fileChangeSummary && fileChangeSummary.files.length > 0 ? (
        <div className={`composer-file-change-summary${fileChangeSummaryExpanded ? ' composer-file-change-summary--expanded' : ''}`} aria-live="polite" aria-label={`${fileChangeSummary.files.length} 个文件已更改，新增 ${fileChangeSummary.additions} 行，删除 ${fileChangeSummary.deletions} 行`}>
          {mobileLayout ? (
            <button
              className="composer-file-change-summary__toggle"
              type="button"
              aria-expanded={fileChangeSummaryExpanded}
              aria-controls="composer-file-change-files"
              aria-label={`${fileChangeSummary.files.length} 个文件已更改，${fileChangeSummaryExpanded ? '收起' : '展开'}文件明细`}
              title={fileChangeSummaryExpanded ? '收起文件明细' : '查看文件明细'}
              onClick={() => setExpandedFileChangesKey(fileChangeSummaryExpanded ? null : fileChangeSummaryKey)}
            >
              {fileChangeSummaryTotals}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          ) : fileChangeSummaryTotals}
          <span id="composer-file-change-files" className="composer-file-change-summary__files" aria-label="各文件增删行数">
            {fileChangeSummary.files.map((file) => {
              const fileName = file.path.split(/[\\/]/).at(-1) || file.path
              const hasStats = file.additions > 0 || file.deletions > 0
              return (
                <span className="composer-file-change-summary__file" key={file.path} title={file.path}>
                  <span>{fileName}</span>
                  {hasStats ? <span className="composer-file-change-summary__file-stats"><i>+{file.additions}</i><em>-{file.deletions}</em></span> : null}
                </span>
              )
            })}
          </span>
        </div>
      ) : null}
      {reserveFileChangeSummarySpace && !mobileLayout && (!fileChangeSummary || fileChangeSummary.files.length === 0) ? (
        <div className="composer-file-change-summary composer-file-change-summary--placeholder" aria-hidden="true">
          <FileText size={12} />
          <span>1 个文件已更改</span>
          <span className="composer-file-change-summary__stats"><i>+1</i><em>-1</em></span>
        </div>
      ) : null}
      <form
        className={`message-composer${isRunning ? ' message-composer--running' : ''}`}
        onSubmit={(event) => void send(event)}
      >
      {attachedImages.length > 0 ? (
        <div className="composer-images" aria-label="待发送图片">
          {attachedImages.map((image, index) => <span className="composer-image" key={`${image.name}-${index}`}><img src={`data:${image.mediaType};base64,${image.data}`} alt={image.name} /><button type="button" onClick={() => updateAttachedImages(attachedImagesRef.current.filter((_, currentIndex) => currentIndex !== index))} aria-label={`移除图片 ${image.name}`}><X size={12} /></button></span>)}
        </div>
      ) : null}
      {attachmentError ? <p className="attachment-error" role="alert">{attachmentError}</p> : null}
      {readingImages ? <p className="attachment-reading" role="status"><LoaderCircle className="spin" size={13} />正在读取图片…</p> : null}
      {readingDocuments ? <p className="attachment-reading" role="status"><LoaderCircle className="spin" size={13} />正在处理文档附件…</p> : null}
      {attachedDocuments.length > 0 ? (
        <div className="composer-documents" aria-label={`待发送文档 ${attachedDocuments.length} 个`}>
          {attachedDocuments.map((document, index) => (
            <div className="composer-document" key={`${document.name}-${index}`}>
              <FileText size={16} />
              <span><strong>{document.name}</strong><small>{document.sourceFileId ? '原始文件 · Codex 将读取原件' : `${document.content.length.toLocaleString()} 个字符 · 已提取文字`}</small></span>
              <button type="button" disabled={readingDocuments} onClick={() => {
                const next = attachedDocumentsRef.current.filter((_, currentIndex) => currentIndex !== index)
                attachedDocumentsRef.current = next
                setAttachedDocuments(next)
              }} aria-label={`移除文档 ${document.name}`}><X size={13} /></button>
            </div>
          ))}
        </div>
      ) : null}
      {queuedMessages.length > 0 ? (
        <div className={`composer-queue${queuedMessagesExpanded ? ' composer-queue--expanded' : ' composer-queue--collapsed'}`} aria-live="polite" aria-label={`已排队 ${queuedMessages.length} 条消息`}>
          <button
            className="composer-queue__heading"
            type="button"
            aria-expanded={queuedMessagesExpanded}
            aria-controls="composer-queue-list"
            aria-label={`已排队 ${queuedMessages.length} 条，${queuedMessagesExpanded ? '收起内容' : '展开内容'}`}
            onClick={() => setQueuedMessagesExpanded((expanded) => !expanded)}
          >
            <span>已排队 {queuedMessages.length} 条</span>
            {queuedMessagesExpanded ? <small>{editingQueuedMessageId || queuedMessages[0]?.editing ? '编辑期间暂停 · 结束后继续队列' : sendingQueuedId ? '正在插入当前回复' : queuedMessages[0]?.sendAttempt ? '有消息送达待核对' : queuedMessages[0]?.blockedReason ?? (isRunning ? '当前回复结束后会依次发送' : '等待电脑端自动发送')}</small> : null}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          <div id="composer-queue-list" className="composer-queue__list" hidden={!queuedMessagesExpanded}>
            {queuedMessages.map((message, index) => {
              const sendingNow = sendingQueuedId === message.id
              const isEditing = editingQueuedMessageId === message.id
              const deliveryUnverified = Boolean(message.sendAttempt)
              const queueLocked = Boolean(editingQueuedMessageId) || Boolean(sendingQueuedId)
              const summary = message.text || (message.documents?.length
                ? `附件文档：${message.documents.length} 个文件`
                : `${message.images.length} 张图片`)
              return (
                <div className={`composer-queue__item${isEditing ? ' composer-queue__item--editing' : ''}`} key={message.id}>
                  <span className="composer-queue__index">{index + 1}</span>
                  <span className="composer-queue__copy"><strong>{summary}</strong><small>{isEditing ? '正在输入框中编辑' : message.editing ? '另一设备正在编辑 · 暂停发送' : sendingNow ? '已插入对话 · 正在确认送达' : deliveryUnverified ? '可能已发送 · 请核对聊天记录' : message.blockedReason ?? (isRunning ? (index === 0 ? '下一条待发送' : '等待前面的消息完成') : '等待自动发送')}</small></span>
                  <button className="composer-queue__edit" type="button" disabled={queueLocked || deliveryUnverified} onClick={() => message.editing ? void onEndQueuedEdit(message.id) : void beginQueuedEdit(message)} title={deliveryUnverified ? '请先核对这条消息是否已发送' : message.editing ? '解除其它设备的编辑暂停' : '在输入框中编辑排队消息'}>
                    <Pencil size={14} /><span>{isEditing ? '编辑中' : message.editing ? '解除编辑' : '编辑'}</span>
                  </button>
                  <button className="composer-queue__send" type="button" disabled={queueLocked || sendingNow || deliveryUnverified || message.editing} onClick={() => void sendQueuedNow(message.id)} title={deliveryUnverified ? '请先核对这条消息是否已发送' : `立即发送给当前${showCodexPreferences ? ' Codex' : ' Claude Code'} 回复`}>
                    {sendingNow ? <LoaderCircle className="spin" size={14} /> : <ArrowUp size={14} />}<span>立即发送</span>
                  </button>
                  <button className="composer-queue__remove" type="button" disabled={queueLocked || sendingNow || message.editing} onClick={() => void onRemoveQueued(message.id)} aria-label="移除排队消息" title="移除排队消息"><X size={13} /></button>
                </div>
              )
            })}
          </div>
        </div>
      ) : reserveQueuedMessageSpace ? (
        <div className="composer-queue composer-queue--collapsed composer-queue--placeholder" aria-hidden="true">
          <span className="composer-queue__placeholder-label">已排队 0 条</span>
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
          onPointerDown={(event) => {
            if (document.activeElement === event.currentTarget) {
              window.CodexRemoteAndroid?.showKeyboard?.()
            }
          }}
          placeholder={editingQueuedMessageId ? '编辑排队消息…' : `给${showCodexPreferences ? ' Codex' : ' Claude Code'}发送消息…`}
          aria-label={editingQueuedMessageId ? '编辑排队消息' : `发送消息给${showCodexPreferences ? ' Codex' : ' Claude Code'}`}
          inputMode="text"
          enterKeyHint="send"
        />
      </div>
      <div className="message-composer__footer">
        <div className="composer-preferences">
          {showCodexPreferences ? <>
            <ComposerMenu label="模型" value={selectedModel} options={modelOptions} emptyLabel="读取模型…" disabled={!canConfigure || modelOptions.length === 0} open={openMenu === 'model'} onOpenChange={(open) => changeOpenMenu(open ? 'model' : null)} onChange={onModelChange} />
            <ComposerMenu label="思考" value={selectedEffort} options={reasoningOptions} emptyLabel="默认" disabled={!canConfigure || reasoningOptions.length === 0} open={openMenu === 'effort'} onOpenChange={(open) => changeOpenMenu(open ? 'effort' : null)} onChange={onEffortChange} />
            <ComposerMenu label={approvalPolicyUpdating ? '授权更新中' : '授权'} value={selectedApprovalPolicy} options={authorizationOptions} emptyLabel="请求批准" disabled={!canCompose || approvalPolicyUpdating} open={openMenu === 'approval'} onOpenChange={(open) => changeOpenMenu(open ? 'approval' : null)} onChange={(approvalPolicy) => onApprovalPolicyChange(approvalPolicy as CodexApprovalPolicy)} />
          </> : <>
            <ComposerMenu label="Claude 模型" value={selectedModel} options={claudeModelOptions} emptyLabel="本机默认模型" disabled={!canConfigure} open={openMenu === 'model'} onOpenChange={(open) => changeOpenMenu(open ? 'model' : null)} onChange={onModelChange} />
            <ComposerMenu label="思考等级" value={selectedEffort} options={claudeEffortOptions} emptyLabel="本机默认" disabled={!canConfigure} open={openMenu === 'effort'} onOpenChange={(open) => changeOpenMenu(open ? 'effort' : null)} onChange={onEffortChange} />
            <ComposerMenu label="权限模式" value={selectedClaudePermissionMode} options={claudePermissionModeOptions} emptyLabel="本机默认权限" disabled={!canConfigure} open={openMenu === 'approval'} onOpenChange={(open) => changeOpenMenu(open ? 'approval' : null)} onChange={(mode) => onClaudePermissionModeChange(mode as ClaudeCodePermissionMode)} />
          </>}
          <span className="composer-hint">{imagesReady ? <ShieldCheck size={14} /> : <LoaderCircle className="spin" size={14} />}{!imagesReady ? '正在恢复待发送图片…' : editingQueuedMessageId ? 'Enter 确定 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行'}</span>
        </div>
        <div className="composer-actions">
          <span className={`attach-button attach-button--native${canAttachFiles ? '' : ' attach-button--disabled'}`} title={readingDocuments || readingImages ? '正在处理附件' : mobileLayout ? '附加图片、文档或源码文件' : '附加文档或源码文件'}>
            {readingDocuments || readingImages ? <LoaderCircle className="spin" size={16} /> : <Plus size={17} />}
            <input className="image-input" type="file" accept={mobileLayout ? mobileAttachmentAccept : documentAttachmentAccept} multiple disabled={!canAttachFiles} onChange={(event) => { void attachSelectedFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = '' }} aria-label={mobileLayout ? '附加图片、文档或源码文件' : '附加文档或源码文件'} />
          </span>
          {writerConflict
            ? <button className="stop-button" type="button" onClick={onRefresh}><RefreshCw size={13} />刷新状态</button>
            : isRunning && !stopWithSendButton ? <button className="stop-button" type="button" onClick={onInterrupt} disabled={isInterrupting}>{isInterrupting ? <LoaderCircle className="spin" size={13} /> : <Square size={13} fill="currentColor" />}{isInterrupting ? '停止中' : '停止'}</button> : null}
          {editingQueuedMessageId ? <button className="composer-edit-cancel" type="button" onClick={cancelQueuedEdit} disabled={sending} aria-label="取消修改排队消息" title="取消修改排队消息"><X size={15} /></button> : null}
          {(!writerConflict || editingQueuedMessageId) ? (
            <button
              className={`send-button${isRunning && !stopWithSendButton ? ' send-button--queue' : ''}${editingQueuedMessageId ? ' send-button--confirm' : ''}${stopWithSendButton ? ' send-button--interrupt' : ''}`}
              type={stopWithSendButton ? 'button' : 'submit'}
              onClick={stopWithSendButton ? onInterrupt : undefined}
              disabled={stopWithSendButton ? isInterrupting : !canSend}
              aria-label={stopWithSendButton ? (isInterrupting ? '正在停止回复' : '停止回复') : editingQueuedMessageId ? '确定编辑消息' : isRunning ? '将消息加入发送队列' : '发送消息'}
              title={stopWithSendButton ? (isInterrupting ? '正在停止回复' : '停止回复') : editingQueuedMessageId ? '确定编辑消息' : isRunning ? '加入发送队列' : '发送消息'}
            >
              {sending || (!imagesReady && !stopWithSendButton) || (stopWithSendButton && isInterrupting)
                ? <LoaderCircle className="spin" size={16} />
                : editingQueuedMessageId ? <Check size={15} /> : stopWithSendButton ? <Pause size={15} /> : <Send size={16} />}
            </button>
          ) : null}
        </div>
      </div>
      </form>
    </div>
  )
}))

interface WorkspaceExplorerProps {
  token: string
  theme: AppTheme
  cwd?: string
  threadId?: string
  canBindThreadWorkspace: boolean
  onBindDirectory: (cwd: string) => Promise<boolean>
  previewRequest: WorkspacePreviewRequest | null
  previewContainerRef: RefObject<HTMLDivElement | null>
  onPreviewStateChange: (open: boolean, closePreview?: () => void) => void
  draft: string
  onInsertPath: (path: string, focus?: boolean) => void
  onAddDocument: (document: CodexDocumentAttachment, focus?: boolean) => void
  mobileOpen: boolean
  onCloseMobile: () => void
}

interface WorkspacePreviewRequest {
  id: number
  cwd?: string
  path: string
  diff?: string
  kind?: 'text' | 'image'
}

interface WorkspaceSelectionContextMenu {
  path: string
  startLine: number
  endLine: number
  content: string
  note: string
  anchorX: number
  anchorY: number
  mobile: boolean
  selectionBounds: WorkspaceSelectionBounds | null
  maxHeight: number
  x: number
  y: number
}

function selectedCodeFromPreview(root: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null

  const selectedText: string[] = []
  const selectedLineNumbers: number[] = []
  for (const line of root.querySelectorAll<HTMLElement>('.workspace-file-preview__line')) {
    const lineContent = line.querySelector<HTMLElement>('.workspace-file-preview__line-content')
    if (!lineContent || !range.intersectsNode(lineContent)) continue

    const lineRange = document.createRange()
    lineRange.selectNodeContents(lineContent)
    if (range.compareBoundaryPoints(Range.START_TO_START, lineRange) > 0) {
      lineRange.setStart(range.startContainer, range.startOffset)
    }
    if (range.compareBoundaryPoints(Range.END_TO_END, lineRange) < 0) {
      lineRange.setEnd(range.endContainer, range.endOffset)
    }

    const kind = line.dataset.diffKind
    const prefix = kind === 'added' ? '+' : kind === 'deleted' ? '-' : root.dataset.diffPreview === 'true' ? ' ' : ''
    selectedText.push(`${prefix}${lineRange.toString()}`)
    const lineNumber = Number(line.dataset.fileLine)
    if (Number.isInteger(lineNumber) && lineNumber > 0) selectedLineNumbers.push(lineNumber)
  }

  const content = selectedText.join('\n')
  if (!content.trim() || selectedLineNumbers.length === 0) return null
  return {
    content,
    startLine: Math.min(...selectedLineNumbers),
    endLine: Math.max(...selectedLineNumbers),
  }
}

function selectedCodeBoundsFromPreview(root: HTMLElement): WorkspaceSelectionBounds | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const rectangles = Array.from(range.getClientRects()).filter((rect) => rect.height > 0)
  if (rectangles.length === 0) return null
  return {
    top: Math.min(...rectangles.map((rect) => rect.top)),
    bottom: Math.max(...rectangles.map((rect) => rect.bottom)),
  }
}

function selectedCodeBoundsFromEditor(editor: HTMLTextAreaElement, startLine: number, endLine: number): WorkspaceSelectionBounds {
  const editorRect = editor.getBoundingClientRect()
  const editorStyle = window.getComputedStyle(editor)
  const lineHeight = Number.parseFloat(editorStyle.lineHeight) || 18
  const paddingTop = Number.parseFloat(editorStyle.paddingTop) || 0
  const firstLineTop = editorRect.top + paddingTop - editor.scrollTop
  return {
    top: firstLineTop + (startLine - 1) * lineHeight,
    bottom: firstLineTop + endLine * lineHeight,
  }
}

function selectedCodeFromEditor(editor: HTMLTextAreaElement) {
  const start = editor.selectionStart
  const end = editor.selectionEnd
  if (start === end) return null
  const lineRange = workspaceTextSelectionLineRange(editor.value, start, end)
  const content = editor.value.slice(start, end)
  if (!lineRange || !content.trim()) return null
  return { ...lineRange, content }
}

function desktopWorkspacePreviewAvailable() {
  return typeof window !== 'undefined'
    && !window.matchMedia(mobileLayoutMediaQuery).matches
}

function concurrentPaneLimit() {
  if (typeof window === 'undefined') return 5
  const mobileLayout = window.matchMedia(mobileLayoutMediaQuery).matches || Boolean(window.CodexRemoteAndroid?.changeEndpoint)
  return mobileLayout ? 3 : 5
}

const WorkspaceExplorer = memo(function WorkspaceExplorer({ token, theme, cwd, threadId, canBindThreadWorkspace, onBindDirectory, previewRequest, previewContainerRef, onPreviewStateChange, draft, onInsertPath, onAddDocument, mobileOpen, onCloseMobile }: WorkspaceExplorerProps) {
  const [manualRoot, setManualRoot] = useState<string | null>(readWorkspaceExplorerRoot)
  const [rootInput, setRootInput] = useState(() => readWorkspaceExplorerRoot() ?? cwd ?? '')
  const [directories, setDirectories] = useState<Record<string, CodexWorkspaceTree>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({})
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [contextMenu, setContextMenu] = useState<{ entry: CodexWorkspaceEntry; paths: string[]; x: number; y: number } | null>(null)
  const [selectionContextMenu, setSelectionContextMenu] = useState<WorkspaceSelectionContextMenu | null>(null)
  const selectionContextMenuElement = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewCwd, setPreviewCwd] = useState<string | undefined>(undefined)
  const [previewDiff, setPreviewDiff] = useState<string | null>(null)
  const [previewKind, setPreviewKind] = useState<'text' | 'image'>('text')
  const [mobilePreviewDialog, setMobilePreviewDialog] = useState(false)
  const [previewFile, setPreviewFile] = useState<CodexWorkspaceFile | null>(null)
  const [previewImage, setPreviewImage] = useState<CodexWorkspaceImage | null>(null)
  const [previewEditContent, setPreviewEditContent] = useState<string | null>(null)
  const [previewSaving, setPreviewSaving] = useState(false)
  const [highlightedPreview, setHighlightedPreview] = useState<{ file: CodexWorkspaceFile; lines: Array<Array<{ text: string; className: string }>> } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewCopied, setPreviewCopied] = useState(false)
  const previewCloseButton = useRef<HTMLButtonElement>(null)
  const previewEditor = useRef<HTMLTextAreaElement>(null)
  const previewReturnFocus = useRef<HTMLElement | null>(null)
  const requestGeneration = useRef(0)
  const previewRequestGeneration = useRef(0)
  const handledPreviewRequest = useRef(0)
  const previousScopeKey = useRef<string | null>(null)
  const pendingPreviewScopeReset = useRef(false)
  const browsingRoot = manualRoot || cwd
  const scopeKey = `${threadId ?? 'new'}:${cwd ?? ''}:${browsingRoot ?? ''}`
  const previewDirty = previewEditContent !== null && previewFile !== null && previewEditContent !== previewFile.content

  const directoryKey = (path: string) => path || '.'
  const closePreview = useCallback(() => {
    if (previewSaving) return
    if (previewDirty && !window.confirm('文件有未保存的修改，确定放弃并关闭吗？')) return
    previewRequestGeneration.current += 1
    setPreviewPath(null)
    setPreviewCwd(undefined)
    setPreviewDiff(null)
    setPreviewKind('text')
    setMobilePreviewDialog(false)
    setPreviewFile(null)
    setPreviewImage(null)
    setPreviewLoading(false)
    setPreviewError(null)
    setPreviewCopied(false)
    setPreviewEditContent(null)
    onPreviewStateChange(false)
  }, [onPreviewStateChange, previewDirty, previewSaving])

  useEffect(() => {
    if (!previewPath) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      event.stopPropagation()
      if (contextMenu || selectionContextMenu) {
        setContextMenu(null)
        setSelectionContextMenu(null)
        return
      }
      closePreview()
    }
    document.addEventListener('keydown', closeOnEscape, true)
    return () => document.removeEventListener('keydown', closeOnEscape, true)
  }, [closePreview, contextMenu, previewPath, selectionContextMenu])

  const loadDirectory = useCallback(async (path: string, offset = 0) => {
    if (!browsingRoot) return
    const generation = requestGeneration.current
    const key = directoryKey(path)
    setLoadingPaths((current) => ({ ...current, [key]: true }))
    try {
      const tree = await codexRemoteClient.workspaceTree(token, browsingRoot, path, offset)
      if (generation !== requestGeneration.current) return
      setDirectories((current) => {
        const entries = offset > 0 && current[key]
          ? [...current[key].entries, ...tree.entries]
          : tree.entries
        return { ...current, [key]: { ...tree, entries } }
      })
      setError(null)
    } catch (reason) {
      if (generation !== requestGeneration.current) return
      setError(reason instanceof Error ? reason.message : '无法读取文件目录')
    } finally {
      if (generation === requestGeneration.current) {
        setLoadingPaths((current) => ({ ...current, [key]: false }))
      }
    }
  }, [browsingRoot, token])

  const loadPreview = useCallback(async (path: string, requestedCwd: string | undefined, diff?: string, kind: 'text' | 'image' = 'text') => {
    if (previewSaving) return
    if (previewDirty && !window.confirm('文件有未保存的修改，继续操作会放弃这些修改。确定继续吗？')) return
    if (!previewReturnFocus.current && document.activeElement instanceof HTMLElement) {
      previewReturnFocus.current = document.activeElement
    }
    pendingPreviewScopeReset.current = false
    const generation = ++previewRequestGeneration.current
    const mobileDialog = !desktopWorkspacePreviewAvailable()
    if (mobileDialog && mobileOpen) {
      const workspaceButton = previewContainerRef.current?.querySelector<HTMLButtonElement>('.conversation-pane--selected .mobile-workspace-button')
      const composer = document.querySelector<HTMLTextAreaElement>('.message-composer textarea')
      const returnFocus = workspaceButton?.getClientRects().length ? workspaceButton : composer
      if (returnFocus) previewReturnFocus.current = returnFocus
      onCloseMobile()
    }
    onPreviewStateChange(true, closePreview)
    setPreviewPath(path)
    setPreviewCwd(requestedCwd)
    setPreviewDiff(kind === 'text' ? diff ?? null : null)
    setPreviewKind(kind)
    setMobilePreviewDialog(mobileDialog)
    setPreviewFile(null)
    setPreviewImage(null)
    setPreviewEditContent(null)
    setPreviewError(null)
    setPreviewCopied(false)
    setPreviewLoading(true)
    try {
      if (kind === 'image') {
        const image = await codexRemoteClient.workspaceImage(token, requestedCwd, path)
        if (generation !== previewRequestGeneration.current) return
        setPreviewImage(image)
      } else {
        const file = await codexRemoteClient.workspaceFile(token, requestedCwd, path)
        if (generation !== previewRequestGeneration.current) return
        setPreviewFile(file)
      }
    } catch (reason) {
      if (generation !== previewRequestGeneration.current) return
      if (!diff) setPreviewError(reason instanceof Error ? reason.message : '无法读取文件')
    } finally {
      if (generation === previewRequestGeneration.current) setPreviewLoading(false)
    }
  }, [closePreview, mobileOpen, onCloseMobile, onPreviewStateChange, previewDirty, previewSaving, token])

  async function savePreviewEdits() {
    if (!previewFile || previewEditContent === null || !previewDirty || previewSaving) return
    const fileBeingSaved = previewFile
    const contentBeingSaved = previewEditContent
    setPreviewSaving(true)
    setPreviewError(null)
    try {
      const savedFile = await codexRemoteClient.saveWorkspaceFile(
        token,
        previewCwd,
        fileBeingSaved.path,
        contentBeingSaved,
        fileBeingSaved.revision,
      )
      setPreviewFile(savedFile)
      setPreviewEditContent(null)
      setPreviewDiff(null)
      const fileDirectory = savedFile.path.split(/[\\/]/).slice(0, -1).join('/')
      if ((previewCwd ?? '') === (browsingRoot ?? '')) void loadDirectory(fileDirectory)
    } catch (reason) {
      setPreviewError(reason instanceof Error ? reason.message : '保存失败，文件内容仍保留在编辑器中。')
    } finally {
      setPreviewSaving(false)
    }
  }

  function beginPreviewEditing() {
    if (!previewFile || previewLoading || previewSaving) return
    setPreviewEditContent(previewFile.content)
    setPreviewError(null)
    window.requestAnimationFrame(() => previewEditor.current?.focus())
  }

  function cancelPreviewEditing() {
    if (previewSaving) return
    if (previewDirty && !window.confirm('确定放弃当前未保存的修改吗？')) return
    setPreviewEditContent(null)
    setPreviewError(null)
  }

  function handlePreviewEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void savePreviewEdits()
      return
    }
    if (event.key !== 'Tab' || previewEditContent === null) return
    event.preventDefault()
    const editor = event.currentTarget
    const start = editor.selectionStart
    const end = editor.selectionEnd
    const nextContent = `${previewEditContent.slice(0, start)}  ${previewEditContent.slice(end)}`
    setPreviewEditContent(nextContent)
    window.requestAnimationFrame(() => {
      editor.selectionStart = start + 2
      editor.selectionEnd = start + 2
    })
  }

  function bindRoot(path = rootInput) {
    const nextRoot = path.trim()
    if (!nextRoot) return
    setManualRoot(nextRoot)
    setRootInput(nextRoot)
    setError(null)
    try {
      window.localStorage.setItem(workspaceExplorerRootStorageKey, nextRoot)
    } catch {
      // Keep the selected root for this page even when browser storage is unavailable.
    }
  }

  function goToParentDirectory() {
    if (!browsingRoot) return
    const parent = workspaceParentPath(browsingRoot)
    if (parent !== browsingRoot) bindRoot(parent)
  }

  function followChatDirectory(nextCwd = cwd ?? '') {
    setManualRoot(null)
    setRootInput(nextCwd)
    try {
      window.localStorage.removeItem(workspaceExplorerRootStorageKey)
    } catch {
      // The current page can still return to the chat directory.
    }
  }

  useEffect(() => {
    const scopeChanged = previousScopeKey.current !== scopeKey
    if (scopeChanged) {
      previousScopeKey.current = scopeKey
      requestGeneration.current += 1
      previewRequestGeneration.current += 1
      setDirectories({})
      setExpanded({})
      setLoadingPaths({})
      setSelectedPaths([])
      setContextMenu(null)
      setError(null)
      if (browsingRoot) void loadDirectory('')
      if (previewDirty) pendingPreviewScopeReset.current = true
    }
    if (!scopeChanged && !(pendingPreviewScopeReset.current && !previewDirty)) return
    if (previewDirty) return
    setPreviewPath(null)
    setPreviewCwd(undefined)
    setPreviewDiff(null)
    setPreviewKind('text')
    setMobilePreviewDialog(false)
    setPreviewFile(null)
    setPreviewImage(null)
    setPreviewEditContent(null)
    setPreviewLoading(false)
    setPreviewError(null)
    setPreviewCopied(false)
    pendingPreviewScopeReset.current = false
    onPreviewStateChange(false)
  }, [browsingRoot, loadDirectory, onPreviewStateChange, previewDirty, scopeKey])

  useEffect(() => {
    if (!manualRoot) setRootInput(cwd ?? '')
  }, [cwd, manualRoot])

  useEffect(() => {
    if (!previewRequest || previewRequest.id === handledPreviewRequest.current) return
    if ((previewRequest.cwd ?? '') !== (cwd ?? '')) return
    handledPreviewRequest.current = previewRequest.id
    void loadPreview(previewRequest.path, previewRequest.cwd, previewRequest.diff, previewRequest.kind)
  }, [cwd, loadPreview, previewRequest])

  useEffect(() => {
    if (!contextMenu && !selectionContextMenu) return
    const closeMenu = () => {
      setContextMenu(null)
      setSelectionContextMenu(null)
    }
    const handleMenuKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.isComposing) return
        closeMenu()
        return
      }
      if (selectionContextMenu && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        const target = event.target
        if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]')) return
        event.preventDefault()
        void copyTextToClipboard(selectionContextMenu.content).then(setPreviewCopied)
      }
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', handleMenuKeyboard)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', handleMenuKeyboard)
    }
  }, [contextMenu, selectionContextMenu])

  useLayoutEffect(() => {
    const current = selectionContextMenu
    const menu = selectionContextMenuElement.current
    if (!current?.mobile || !menu) return
    const menuBounds = menu.getBoundingClientRect()
    if (menuBounds.width <= 0 || menuBounds.height <= 0) return
    const position = workspaceSelectionMenuPosition({
      anchorX: current.anchorX,
      anchorY: current.anchorY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      menuWidth: menuBounds.width,
      menuHeight: menuBounds.height,
      selectionBounds: current.selectionBounds,
    })
    if (Math.abs(current.x - position.x) < 1
      && Math.abs(current.y - position.y) < 1
      && Math.abs(current.maxHeight - position.maxHeight) < 1) return
    setSelectionContextMenu((latest) => {
      if (!latest || latest.anchorX !== current.anchorX || latest.anchorY !== current.anchorY) return latest
      return { ...latest, ...position }
    })
  }, [selectionContextMenu])

  function toggleDirectory(path: string) {
    const nextExpanded = !expanded[path]
    setExpanded((current) => ({ ...current, [path]: nextExpanded }))
    if (nextExpanded && !directories[directoryKey(path)]) void loadDirectory(path)
  }

  function openEntryContextMenu(event: ReactMouseEvent<HTMLButtonElement>, entry: CodexWorkspaceEntry) {
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = entry.kind === 'directory' ? 236 : 176
    const menuHeight = entry.kind === 'directory' ? 116 : 72
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8))
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    const paths = (selectedPaths.includes(entry.path) ? selectedPaths : [entry.path])
      .filter((path) => !draftContainsWorkspacePath(draft, workspaceAbsolutePath(browsingRoot, path)))
    if (paths.length === 0 && entry.kind !== 'directory') return
    setSelectedPaths(paths)
    setSelectionContextMenu(null)
    setContextMenu({ entry, paths, x, y })
  }

  async function bindDirectoryToCurrentThread() {
    if (!contextMenu || contextMenu.entry.kind !== 'directory') return
    const nextCwd = workspaceAbsolutePath(browsingRoot, contextMenu.entry.path)
    setContextMenu(null)
    try {
      if (await onBindDirectory(nextCwd)) {
        followChatDirectory(nextCwd)
        setError(null)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法绑定当前聊天到该目录')
    }
  }

  function openSelectionContextMenu(event: ReactMouseEvent<HTMLPreElement | HTMLTextAreaElement>) {
    if (!previewFile) return
    const editor = event.currentTarget instanceof HTMLTextAreaElement ? event.currentTarget : null
    const selected = editor
      ? selectedCodeFromEditor(editor)
      : selectedCodeFromPreview(event.currentTarget)
    if (!selected) return

    event.preventDefault()
    setContextMenu(null)
    const isMobile = window.matchMedia(mobileLayoutMediaQuery).matches || Boolean(window.CodexRemoteAndroid?.changeEndpoint)
    const menuWidth = Math.min(300, window.innerWidth - 16)
    const menuHeight = isMobile ? 132 : 240
    const selectionBounds = isMobile
      ? editor
        ? selectedCodeBoundsFromEditor(editor, selected.startLine, selected.endLine)
        : selectedCodeBoundsFromPreview(event.currentTarget)
      : null
    const position = workspaceSelectionMenuPosition({
      anchorX: event.clientX,
      anchorY: event.clientY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      menuWidth,
      menuHeight,
      selectionBounds,
    })
    setSelectionContextMenu({
      ...selected,
      path: workspaceAbsolutePath(previewCwd ?? browsingRoot, previewFile.path),
      note: '',
      anchorX: event.clientX,
      anchorY: event.clientY,
      mobile: isMobile,
      selectionBounds,
      ...position,
    })
  }

  function addSelectedCodeAsDocument() {
    if (!selectionContextMenu) return
    const { path, startLine, endLine, content, note } = selectionContextMenu
    setSelectionContextMenu(null)
    onAddDocument(createWorkspaceSelectionDocument(path, startLine, endLine, content, note), !mobileOpen)
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
    else void loadPreview(entry.path, browsingRoot)
  }

  async function copyPreview() {
    if (!previewFile) return
    setPreviewCopied(await copyTextToClipboard(previewEditContent ?? previewFile.content))
  }

  function entryAbsolutePath(entry: CodexWorkspaceEntry) {
    return workspaceAbsolutePath(browsingRoot, entry.path)
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
    const rows = tree.entries.flatMap((entry) => {
      const isDirectory = entry.kind === 'directory'
      const isOpen = Boolean(expanded[entry.path])
      const absolutePath = entryAbsolutePath(entry)
      const alreadyAdded = draftContainsWorkspacePath(draft, absolutePath)
      const row = (
          <Fragment key={entry.path}>
          <div className="workspace-explorer__entry-row">
            <button
              className={`workspace-explorer__entry workspace-explorer__entry--${entry.kind}${isOpen ? ' workspace-explorer__entry--open' : ''}${selectedPaths.includes(entry.path) ? ' workspace-explorer__entry--selected' : ''}`}
              type="button"
              style={{ paddingLeft: `${10 + depth * 14}px` }}
              title={entry.path}
              onClick={(event) => handleEntryClick(event, entry)}
              onContextMenuCapture={(event) => openEntryContextMenu(event, entry)}
            >
              {isDirectory ? <ChevronRight className={`workspace-explorer__chevron${isOpen ? ' workspace-explorer__chevron--open' : ''}`} size={13} /> : <span className="workspace-explorer__chevron-spacer" />}
              {isDirectory ? (isOpen ? <FolderOpen size={15} /> : <Folder size={15} />) : <File size={14} />}
              <span className="workspace-explorer__entry-name">{entry.name}</span>
              {!isDirectory ? <small>{sizeLabel(entry.size)}</small> : null}
            </button>
            {!alreadyAdded ? <button className="workspace-explorer__add" type="button" onClick={(event) => { event.stopPropagation(); onInsertPath(absolutePath, !mobileOpen) }} aria-label={`加入输入框 ${entry.name}`} title="加入输入框"><Plus size={14} /></button> : null}
          </div>
          {isDirectory && isOpen ? (
            loadingPaths[directoryKey(entry.path)]
              ? <div className="workspace-explorer__loading" style={{ paddingLeft: `${37 + depth * 14}px` }}><LoaderCircle className="spin" size={12} />读取中…</div>
              : renderDirectory(entry.path, depth + 1)
          ) : null}
        </Fragment>
      )
      return [row]
    })
    if (tree.nextOffset !== null) {
      rows.push(
        <button
          className="workspace-explorer__load-more"
          key={`${directoryKey(path)}:load-more`}
          type="button"
          style={{ paddingLeft: `${10 + depth * 14}px` }}
          disabled={Boolean(loadingPaths[directoryKey(path)])}
          onClick={() => void loadDirectory(path, tree.nextOffset ?? 0)}
        >
          {loadingPaths[directoryKey(path)] ? <LoaderCircle className="spin" size={12} /> : <ChevronDown size={12} />}
          {loadingPaths[directoryKey(path)] ? '继续读取…' : '加载更多'}
        </button>,
      )
    }
    return rows
  }

  const rootLoading = loadingPaths['.']
  const previewLines = useMemo(() => {
    if (!previewFile) return []
    const lines = previewFile.content.split(/\r\n|\n|\r/)
    if (lines.length > 1 && lines.at(-1) === '' && /(?:\r\n|\n|\r)$/.test(previewFile.content)) lines.pop()
    return lines
  }, [previewFile])
  const previewDiffLines = useMemo(() => {
    if (!previewDiff) return null
    const lines = numberDiffLines(previewDiff).filter(({ line, kind }) => (
      kind !== 'context' || !/^(?:diff --git |index |--- |\+\+\+ )/.test(line)
    ))
    return lines.length > 0 ? lines : null
  }, [previewDiff])
  const previewDiffStats = useMemo(() => previewDiffLines ? {
    additions: previewDiffLines.filter(({ kind }) => kind === 'added').length,
    deletions: previewDiffLines.filter(({ kind }) => kind === 'deleted').length,
  } : null, [previewDiffLines])
  useEffect(() => {
    if (!previewFile) {
      setHighlightedPreview(null)
      return
    }
    let cancelled = false
    void import('../lib/codeHighlight').then(async ({ highlightCodeLines }) => {
      const lines = await highlightCodeLines(previewFile.path, previewFile.content)
      if (!cancelled) setHighlightedPreview({ file: previewFile, lines })
    }).catch(() => {
      if (!cancelled) setHighlightedPreview(null)
    })
    return () => {
      cancelled = true
    }
  }, [previewFile])
  const highlightedPreviewLines = highlightedPreview?.file === previewFile ? highlightedPreview.lines : []
  useEffect(() => {
    if (!previewPath) return
    const frame = window.requestAnimationFrame(() => previewCloseButton.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [previewPath])
  useEffect(() => {
    if (previewPath) return
    const returnFocus = previewReturnFocus.current
    previewReturnFocus.current = null
    if (!returnFocus) return
    const frame = window.requestAnimationFrame(() => {
      if (returnFocus.isConnected) returnFocus.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [previewPath])
  const previewPortalTarget = previewContainerRef.current
  return (
    <>
      <aside className={`workspace-explorer${mobileOpen ? ' workspace-explorer--mobile-open' : ''}`} aria-label="工作区文件资源管理器">
        <header className="workspace-explorer__header">
          <div><span className="workspace-explorer__eyebrow">当前窗口</span><strong>文件</strong></div>
          <div className="workspace-explorer__header-actions">
            <button className="icon-button" type="button" onClick={() => void loadDirectory('')} disabled={!browsingRoot || rootLoading} aria-label="刷新文件目录" title="刷新文件目录"><RefreshCw className={rootLoading ? 'spin' : undefined} size={14} /></button>
            <button className="icon-button workspace-explorer__close" type="button" onClick={onCloseMobile} aria-label="关闭文件窗口" title="关闭文件窗口"><X size={16} /></button>
          </div>
        </header>
        <div className="workspace-explorer__root">
          <form className="workspace-explorer__root-form" onSubmit={(event) => { event.preventDefault(); bindRoot() }}>
            <input
              aria-label="服务端目录路径"
              title={browsingRoot ?? '输入后端主机上的目录路径'}
              value={rootInput}
              onChange={(event) => setRootInput(event.currentTarget.value)}
              placeholder="输入服务端目录路径"
              spellCheck={false}
            />
            <button className="workspace-explorer__root-open" type="submit" title="绑定并打开目录"><FolderOpen size={13} /><span>打开</span></button>
          </form>
          <div className="workspace-explorer__root-actions">
            <button type="button" onClick={goToParentDirectory} disabled={!browsingRoot || workspaceParentPath(browsingRoot) === browsingRoot} title="浏览上级目录"><ArrowUp size={12} />上级</button>
            <button type="button" onClick={() => followChatDirectory()} disabled={!manualRoot} title="恢复跟随当前聊天的工作目录"><RotateCcw size={12} />跟随聊天</button>
          </div>
        </div>
        <div className="workspace-explorer__body">
          <div className="workspace-explorer__tree">
            {!browsingRoot ? <p className="workspace-explorer__empty">还没有聊天工作目录，可以输入服务端路径打开文件夹。</p> : null}
            {rootLoading && !directories['.'] ? <div className="workspace-explorer__loading"><LoaderCircle className="spin" size={13} />读取文件目录…</div> : null}
            {error ? <p className="workspace-explorer__error" role="alert">{error}</p> : null}
            {browsingRoot && directories['.'] ? renderDirectory('', 0) : null}
            {browsingRoot && directories['.']?.truncated ? <p className="workspace-explorer__hint">此目录条目较多，可在列表底部继续加载。</p> : null}
          </div>
        </div>
        <footer className="workspace-explorer__footer">Ctrl/⌘ 多选后右键加入输入框</footer>
      </aside>
      {previewPath && previewPortalTarget ? createPortal(
        <ChatOverlayPanel
          ariaLabel={previewKind === 'image' ? '工作区图片预览' : '工作区文件预览'}
          backdropLabel="关闭文件预览"
          ariaModal={mobilePreviewDialog || undefined}
          className="workspace-file-preview-panel"
          closeButtonRef={previewCloseButton}
          onClose={closePreview}
          onKeyDown={(event) => {
            if (!mobilePreviewDialog || event.key !== 'Tab') return
            const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), [role="separator"][tabindex="0"]')
            const first = controls.item(0)
            const last = controls.item(controls.length - 1)
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }}
          header={(
            <div className="workspace-file-preview-panel__heading">
              <span className="workspace-explorer__eyebrow">{previewKind === 'image' ? '图片预览' : previewEditContent === null ? (previewDiff ? '差异预览' : '只读预览') : '编辑文件'}</span>
              <strong title={previewImage?.path ?? previewFile?.path ?? previewPath}>{(previewImage?.path ?? previewFile?.path ?? previewPath).split(/[\\/]/).at(-1) || previewPath}</strong>
            </div>
          )}
          footer={(
            <span className="workspace-file-preview-panel__footer">{previewSaving ? '正在保存到本机工作区…' : previewImage ? `${sizeLabel(previewImage.size)} · ${previewImage.mediaType}` : previewEditContent !== null ? (previewDirty ? '有未保存修改 · Ctrl/⌘+S 保存' : '编辑中 · 未修改') : previewDiffStats ? `新增 ${previewDiffStats.additions} 行 · 删除 ${previewDiffStats.deletions} 行` : previewFile ? `${previewLines.length} 行 · UTF-8 文本` : previewKind === 'image' ? '图片预览' : 'UTF-8 文本'}</span>
          )}
        >
          <section className="workspace-file-preview">
            <div className="workspace-file-preview__toolbar">
              <code title={previewImage?.path ?? previewFile?.path ?? previewPath}>{previewImage?.path ?? previewFile?.path ?? previewPath}</code>
              <div>
                {previewKind !== 'image' && previewEditContent === null ? (
                  <button className="workspace-file-preview__copy" type="button" onClick={beginPreviewEditing} disabled={!previewFile || previewLoading || previewSaving} title="编辑并保存文件"><Pencil size={13} />编辑</button>
                ) : previewKind !== 'image' ? (
                  <>
                    <button className="workspace-file-preview__copy" type="button" onClick={() => void savePreviewEdits()} disabled={!previewDirty || previewSaving} title="保存到本机工作区">{previewSaving ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}保存</button>
                    <button className="workspace-file-preview__copy" type="button" onClick={cancelPreviewEditing} disabled={previewSaving} title="取消编辑">取消</button>
                  </>
                ) : null}
                {previewKind !== 'image' ? <button className="workspace-file-preview__copy" type="button" onClick={() => void copyPreview()} disabled={!previewFile} title="复制文件内容"><Copy size={13} />{previewCopied ? '已复制' : '复制'}</button> : null}
                {previewEditContent === null ? <button className="icon-button" type="button" onClick={() => void loadPreview(previewPath, previewCwd, previewDiff ?? undefined, previewKind)} disabled={previewLoading || previewSaving} aria-label={previewKind === 'image' ? '重新读取图片' : '重新读取文件'} title={previewKind === 'image' ? '重新读取图片' : '重新读取文件'}><RefreshCw className={previewLoading ? 'spin' : undefined} size={14} /></button> : null}
              </div>
            </div>
            {previewLoading ? <div className="workspace-explorer__loading"><LoaderCircle className="spin" size={13} />{previewKind === 'image' ? '读取图片…' : '读取文件内容…'}</div> : null}
            {previewError ? <p className="workspace-explorer__error" role="alert">{previewError}</p> : null}
            {previewImage ? (
              <div className="workspace-image-preview"><img src={`data:${previewImage.mediaType};base64,${previewImage.data}`} alt={previewImage.path} /></div>
            ) : previewEditContent !== null && previewFile ? (
              <textarea
                ref={previewEditor}
                className="workspace-file-preview__editor"
                aria-label={`编辑文件 ${previewFile.path}`}
                value={previewEditContent}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap="off"
                disabled={previewSaving}
                onChange={(event) => setPreviewEditContent(event.currentTarget.value)}
                onKeyDown={handlePreviewEditorKeyDown}
                onContextMenu={openSelectionContextMenu}
              />
            ) : previewFile || previewDiffLines ? (
              <pre className="workspace-file-preview__code" data-diff-preview={previewDiffLines ? 'true' : undefined} onContextMenu={openSelectionContextMenu}><code>{previewDiffLines
                ? previewDiffLines.map((diffLine, index) => {
                  const content = diffLine.kind === 'added' || diffLine.kind === 'deleted'
                    ? diffLine.line.slice(1)
                    : diffLine.kind === 'context' && diffLine.line.startsWith(' ')
                      ? diffLine.line.slice(1)
                      : diffLine.line
                  const highlightedLine = diffLine.newLine === null ? undefined : highlightedPreviewLines[diffLine.newLine - 1]
                  return (
                    <span className={`workspace-file-preview__line workspace-file-preview__line--${diffLine.kind}`} data-file-line={diffLine.newLine ?? diffLine.oldLine ?? ''} data-diff-kind={diffLine.kind} key={`diff-${index}`}>
                      <span className="workspace-file-preview__line-number" aria-hidden="true">{diffLine.newLine ?? diffLine.oldLine ?? ''}</span>
                      <span className="workspace-file-preview__line-content">{diffLine.kind !== 'deleted' && highlightedLine?.length
                        ? highlightedLine.map((segment, segmentIndex) => <span className={segment.className || undefined} key={segmentIndex}>{segment.text}</span>)
                        : content || ' '}</span>
                    </span>
                  )
                })
                : previewLines.map((line, index) => (
                  <span className="workspace-file-preview__line" data-file-line={index + 1} key={`file-${index}`}><span className="workspace-file-preview__line-number" aria-hidden="true">{index + 1}</span><span className="workspace-file-preview__line-content">{highlightedPreviewLines[index]?.length
                    ? highlightedPreviewLines[index].map((segment, segmentIndex) => <span className={segment.className || undefined} key={segmentIndex}>{segment.text}</span>)
                    : line || ' '}</span></span>
                ))}</code></pre>
            ) : null}
          </section>
        </ChatOverlayPanel>,
        previewPortalTarget,
      ) : null}
      {contextMenu && typeof document !== 'undefined' ? createPortal(
        <div className={`thread-context-menu workspace-file-context-menu${theme === 'light' ? ' workspace-file-context-menu--light' : ''}`} style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
          <div className="workspace-file-context-menu__name" title={contextMenu.entry.path}>{contextMenu.entry.name}{contextMenu.paths.length > 1 ? ` · 已选 ${contextMenu.paths.length} 项` : ''}</div>
          {contextMenu.entry.kind === 'directory' && threadId ? <button type="button" role="menuitem" disabled={!canBindThreadWorkspace} onClick={() => void bindDirectoryToCurrentThread()}><FolderOpen size={14} />绑定当前聊天到此目录</button> : null}
          {workspacePathsMissingFromDraft(draft, contextMenu.paths.map((path) => workspaceAbsolutePath(browsingRoot, path))).length > 0 ? <button type="button" role="menuitem" onClick={() => { const paths = workspacePathsMissingFromDraft(draft, contextMenu.paths.map((path) => workspaceAbsolutePath(browsingRoot, path))).join('\n'); setContextMenu(null); onInsertPath(paths, !mobileOpen) }}><Link2 size={14} />加入输入框</button> : null}
        </div>,
        document.body,
      ) : null}
      {selectionContextMenu && typeof document !== 'undefined' ? createPortal(
        <div
          ref={selectionContextMenuElement}
          className={`thread-context-menu workspace-file-context-menu workspace-selection-context-menu${theme === 'light' ? ' workspace-file-context-menu--light' : ''}`}
          style={{ left: selectionContextMenu.x, top: selectionContextMenu.y, maxHeight: selectionContextMenu.mobile ? `${selectionContextMenu.maxHeight}px` : undefined }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="workspace-file-context-menu__name" title={selectionContextMenu.path}>{selectionContextMenu.path} · 第 {selectionContextMenu.startLine}{selectionContextMenu.endLine !== selectionContextMenu.startLine ? `–${selectionContextMenu.endLine}` : ''} 行</div>
          <textarea
            className="workspace-selection-context-menu__note"
            aria-label="选区备注"
            placeholder="写下这段代码需要修改什么…（可选）"
            value={selectionContextMenu.note}
            onChange={(event) => {
              const note = event.currentTarget.value
              setSelectionContextMenu((current) => current ? { ...current, note } : current)
            }}
          />
          <button type="button" role="menuitem" onClick={addSelectedCodeAsDocument}><FileText size={14} />添加到对话</button>
        </div>,
        document.body,
      ) : null}
    </>
  )
})

interface RemoteChatPaneProps {
  token: string
  remote: CodexRemoteController
  active: boolean
  showActiveFrame: boolean
  showPaneClose: boolean
  onActivate: () => void
  onClose: () => void
  onCreateThread: () => void
  claudeCodeAvailable: boolean | null
  onSwitchEngine: (engine: 'codex' | 'claude-code') => Promise<unknown>
  onOpenSidebar: () => void
  onOpenWorkspace: () => void
  onOpenWorkspaceFile: (path: string, cwd?: string, diff?: string) => void
  onOpenWorkspaceImage: (path: string, cwd?: string) => void
  composerHandle: RefObject<ComposerHandle | null>
  copiedMessageId: string | null
  onCopy: (message: CodexMessage) => void | Promise<void>
}

function RemoteChatPane({
  token,
  remote,
  active,
  showActiveFrame,
  showPaneClose,
  onActivate,
  onClose,
  onCreateThread,
  claudeCodeAvailable,
  onSwitchEngine,
  onOpenSidebar,
  onOpenWorkspace,
  onOpenWorkspaceFile,
  onOpenWorkspaceImage,
  composerHandle,
  copiedMessageId,
  onCopy,
}: RemoteChatPaneProps) {
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [engineSwitching, setEngineSwitching] = useState(false)
  const messageContainer = useRef<HTMLDivElement>(null)
  const messageContent = useRef<HTMLDivElement>(null)
  const scrollAnimationFrame = useRef<number | undefined>(undefined)
  const forceMessageStreamBottomFor = useRef<string | null>(null)
  const forceMessageStreamBottomVersion = useRef(0)
  const forceMessageStreamBottomTimer = useRef<number | undefined>(undefined)
  const olderMessageScrollAnchor = useRef<{ messageId: string; top: number } | null>(null)
  const lastObservedUserMessage = useRef<{ threadId: string | null; messageId: string | null }>({ threadId: null, messageId: null })
  const followMessageStream = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  const activeThreadId = remote.activeThread?.id
  const [messageWindow, setMessageWindow] = useState(() => recentMessageWindow(activeThreadId ?? null, remote.messages.length))
  const visibleStartIndex = visibleMessageStart(messageWindow, activeThreadId ?? null, remote.messages.length)
  const visibleMessages = remote.messages.slice(visibleStartIndex)
  const insertChangedFileIntoConversation = useCallback((path: string) => {
    const fileReference = workspaceFileReference(remote.activeThread?.cwd || remote.runtime.workspace, path)
    onActivate()
    window.requestAnimationFrame(() => composerHandle.current?.appendDraft(fileReference, true))
  }, [composerHandle, onActivate, remote.activeThread?.cwd, remote.runtime.workspace])
  const openChangedFilePreview = useCallback((path: string, diff?: string) => {
    const cwd = remote.activeThread?.cwd || remote.runtime.workspace || undefined
    onActivate()
    onOpenWorkspaceFile(workspaceRelativePath(cwd, path), cwd, diff)
  }, [onActivate, onOpenWorkspaceFile, remote.activeThread?.cwd, remote.runtime.workspace])
  const openViewedImagePreview = useCallback((path: string) => {
    const cwd = remote.activeThread?.cwd || remote.runtime.workspace || undefined
    onActivate()
    onOpenWorkspaceImage(workspaceRelativePath(cwd, path), cwd)
  }, [onActivate, onOpenWorkspaceImage, remote.activeThread?.cwd, remote.runtime.workspace])

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
    if (atBottom) {
      setMessageWindow((current) => current.threadId === activeThreadId && !current.anchoredToLatest
        ? recentMessageWindow(activeThreadId ?? null, remote.messages.length)
        : current)
    }
  }, [activeThreadId, remote.messages.length])

  const scrollToBottom = useCallback(() => {
    followMessageStream.current = true
    setShowScrollToBottom(false)
    setMessageWindow(recentMessageWindow(activeThreadId ?? null, remote.messages.length))
    positionMessageStreamAtBottom()
  }, [activeThreadId, positionMessageStreamAtBottom, remote.messages.length])

  const loadEarlierMessages = useCallback(() => {
    if (visibleStartIndex === 0) return
    const firstMessage = messageContent.current?.querySelector<HTMLElement>('[data-message-id]')
    olderMessageScrollAnchor.current = firstMessage?.dataset.messageId
      ? { messageId: firstMessage.dataset.messageId, top: firstMessage.getBoundingClientRect().top }
      : null
    followMessageStream.current = false
    forceMessageStreamBottomFor.current = null
    forceMessageStreamBottomVersion.current += 1
    if (forceMessageStreamBottomTimer.current !== undefined) window.clearTimeout(forceMessageStreamBottomTimer.current)
    if (scrollAnimationFrame.current !== undefined) window.cancelAnimationFrame(scrollAnimationFrame.current)
    forceMessageStreamBottomTimer.current = undefined
    scrollAnimationFrame.current = undefined
    setShowScrollToBottom(true)
    setMessageWindow((current) => earlierMessageWindow(current, activeThreadId ?? null, remote.messages.length))
  }, [activeThreadId, remote.messages.length, visibleStartIndex])

  useLayoutEffect(() => {
    if (!active) return
    forceMessageStreamToBottom(activeThreadId)
    olderMessageScrollAnchor.current = null
    setMessageWindow(recentMessageWindow(activeThreadId ?? null, remote.messages.length))
  }, [active, activeThreadId, forceMessageStreamToBottom])

  useLayoutEffect(() => {
    let latestUserMessageId: string | null = null
    for (let index = remote.messages.length - 1; index >= 0; index -= 1) {
      const message = remote.messages[index]
      if (message?.role === 'user') {
        latestUserMessageId = message.id
        break
      }
    }
    const previous = lastObservedUserMessage.current
    lastObservedUserMessage.current = { threadId: activeThreadId ?? null, messageId: latestUserMessageId }
    if (!active || !activeThreadId || remote.loadingHistory || previous.threadId !== activeThreadId) return
    if (!latestUserMessageId || latestUserMessageId === previous.messageId) return
    forceMessageStreamToBottom(activeThreadId)
  }, [active, activeThreadId, forceMessageStreamToBottom, remote.loadingHistory, remote.messages])

  useLayoutEffect(() => {
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
  }, [active, activeThreadId, positionMessageStreamAtBottom, remote.activity, remote.isRunning, remote.loadingHistory, remote.messages, settleForcedMessageStreamBottom, visibleStartIndex])

  useLayoutEffect(() => {
    const anchor = olderMessageScrollAnchor.current
    if (!anchor) return
    olderMessageScrollAnchor.current = null
    const container = messageContainer.current
    const message = [...(messageContent.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])]
      .find((element) => element.dataset.messageId === anchor.messageId)
    if (container && message) container.scrollTop += message.getBoundingClientRect().top - anchor.top
  }, [visibleStartIndex])

  useLayoutEffect(() => {
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
  }, [activeThreadId, positionMessageStreamAtBottom, settleForcedMessageStreamBottom])

  useEffect(() => () => {
    if (scrollAnimationFrame.current !== undefined) window.cancelAnimationFrame(scrollAnimationFrame.current)
    if (forceMessageStreamBottomTimer.current !== undefined) window.clearTimeout(forceMessageStreamBottomTimer.current)
  }, [])

  const activeTitle = remote.activeThread ? titleOf(remote.activeThread) : '新对话'
  const activeEngineLabel = remote.activeThread?.engine === 'claude-code' ? 'Claude Code' : 'Codex'
  const targetEngine = remote.activeThread?.engine === 'claude-code' ? 'codex' : 'claude-code'
  const targetEngineLabel = targetEngine === 'claude-code' ? 'Claude Code' : 'Codex'
  const claudeCodeUnavailable = targetEngine === 'claude-code' && claudeCodeAvailable === false
  const engineSwitchLabel = claudeCodeUnavailable
    ? 'Claude Code 不可用'
    : `切换到 ${targetEngineLabel} 聊天`
  const streamingAssistant = [...remote.messages].reverse().find((message) => message.role === 'assistant' && message.streaming)
  const hasStreamingAssistant = Boolean(streamingAssistant)
  const streamingStartedAt = streamingAssistant?.replyStartedAt ? Date.parse(streamingAssistant.replyStartedAt) : Number.NaN
  const activeTurnStartedAt = remote.turnStartedAt ?? (Number.isFinite(streamingStartedAt) ? streamingStartedAt : null)
  const runningOperations = remote.runningTurnId ? remote.operationsByTurn[remote.runningTurnId] ?? [] : []
  const runningTimeline = remote.runningTurnId ? remote.activityTimelineByTurn[remote.runningTurnId] ?? [] : []
  const runningOperationTimeline = runningTimeline.filter((entry) => entry.type === 'operation')
  const currentRunningOperation = [...runningOperations].reverse().find((operation) => operation.status === 'running') ?? null
  const lastMessageIndexByTurn = useMemo(() => {
    const indexes = new Map<string, number>()
    remote.messages.forEach((message, index) => {
      if (message.turnId) indexes.set(message.turnId, index)
    })
    return indexes
  }, [remote.messages])
  const lastAssistantMessageIndexByTurn = useMemo(() => {
    const indexes = new Map<string, number>()
    remote.messages.forEach((message, index) => {
      if (message.role === 'assistant' && message.turnId) indexes.set(message.turnId, index)
    })
    return indexes
  }, [remote.messages])
  return (
    <main className={`remote-chat conversation-pane${active ? ' conversation-pane--selected' : ''}${active && showActiveFrame ? ' conversation-pane--active' : ''}`} onPointerDown={onActivate}>
      <header className="remote-chat__header">
        <div className="remote-chat__title-wrap">
          <button className="icon-button menu-button" type="button" aria-label="打开对话列表" onClick={(event) => { event.stopPropagation(); onOpenSidebar() }}><Menu size={20} /></button>
          <div className="remote-chat__title"><span className="remote-chat__eyebrow">{activeEngineLabel} · 当前工作区</span><strong>{activeTitle}</strong><span title={remote.activeThread?.cwd || remote.runtime.workspace}>{remote.activeThread?.cwd || remote.runtime.workspace || '本机项目'}</span></div>
        </div>
        <div className="remote-chat__controls">
          <button
            className="icon-button engine-switch-button"
            type="button"
            aria-label={engineSwitchLabel}
            title={engineSwitchLabel}
            disabled={claudeCodeUnavailable || engineSwitching}
            onClick={async (event) => {
              event.stopPropagation()
              if (claudeCodeUnavailable || engineSwitching) return
              setEngineSwitching(true)
              try {
                await onSwitchEngine(targetEngine)
              } finally {
                setEngineSwitching(false)
              }
            }}
          >
            <EngineBrandIcon engine={targetEngine} />
          </button>
          <button
            className={`icon-button terminal-open-button${terminalOpen ? ' terminal-open-button--active' : ''}`}
            type="button"
            aria-label={terminalOpen ? '关闭本机终端' : '打开本机终端'}
            title={terminalOpen ? '关闭本机终端' : '本机终端'}
            onClick={(event) => {
              event.stopPropagation()
              if (terminalOpen) {
                setTerminalOpen(false)
              } else {
                onActivate()
                setTerminalOpen(true)
              }
            }}
          >
            {terminalOpen ? <X size={16} /> : <TerminalIcon size={16} />}
          </button>
          <button className="icon-button mobile-workspace-button" type="button" aria-label="打开文件窗口" title="打开文件窗口" onClick={(event) => { event.stopPropagation(); onOpenWorkspace() }}><Folder size={17} /></button>
          {showPaneClose ? <button className="icon-button pane-close-button" type="button" onClick={(event) => { event.stopPropagation(); onClose() }} aria-label="关闭并发窗口" title="关闭并发窗口"><X size={15} /></button> : null}
        </div>
      </header>

      <section className="message-stream" ref={messageContainer} onScroll={handleMessageScroll} aria-live="polite" aria-label={`${activeTitle} ${activeEngineLabel} 对话`}>
        <div className="message-stream__content" ref={messageContent}>
          {remote.handedOff ? <div className="handoff-notice" role="status"><strong>已交还给本机 Codex</strong><span>网页端已停止持有会话，也不会自动重新连接。请在本机 Codex 中继续；需要回到网页时再点“重新接管”。</span></div> : null}
          {remote.runtime.runtimeMode === 'isolated-fallback' && remote.runtime.runtimeMessage ? <div className="runtime-notice" role="status"><strong>已启用 Windows 兼容运行时</strong><span>{remote.runtime.runtimeMessage}</span></div> : null}
          {remote.messages.length === 0 && !remote.loadingHistory ? (
            <div className="welcome-state">
          <h1>{remote.activeThread?.engine === 'claude-code' ? '与 Claude Code 一起完成项目' : '与 Codex Remote 一起完成项目'}</h1>
            </div>
          ) : null}
          {remote.loadingHistory && remote.messages.length === 0 ? <div className="loading-state"><LoaderCircle className="spin" size={18} />正在加载对话…</div> : null}
          {visibleStartIndex > 0 ? <button className="message-stream__older" type="button" onClick={loadEarlierMessages}>查看更早消息（还有 {visibleStartIndex} 条）</button> : null}
          {visibleMessages.map((message, visibleIndex) => {
            const index = visibleStartIndex + visibleIndex
            const turnComplete = !message.streaming && message.turnId !== remote.runningTurnId
            const changes = turnComplete && message.turnId && lastMessageIndexByTurn.get(message.turnId) === index
              ? remote.fileChangesByTurn[message.turnId]
              : undefined
            const operations = message.role === 'assistant' && message.turnId
              ? remote.operationsByTurn[message.turnId] ?? []
              : []
            const operationFileChanges = message.turnId
              ? remote.fileChangesByTurn[message.turnId] ?? []
              : []
            const showOperations = message.role === 'assistant'
              && (!message.turnId || lastAssistantMessageIndexByTurn.get(message.turnId) === index)
            const activityTimeline = showOperations && message.turnId
              ? remote.activityTimelineByTurn[message.turnId] ?? []
              : []
            return (
              <Fragment key={message.id}>
                <MessageBubble
                  message={message}
                  operations={operations}
                  fileChanges={operationFileChanges}
                  activityTimeline={activityTimeline}
                  showOperations={showOperations}
                  copied={copiedMessageId === message.id}
                  onCopy={onCopy}
                  onOpenFile={openChangedFilePreview}
                  onOpenImage={openViewedImagePreview}
                />
                {changes?.length ? <FileChangeCard changes={changes} onInsertPath={insertChangedFileIntoConversation} onOpenFile={openChangedFilePreview} /> : null}
              </Fragment>
            )
          })}
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
          {remote.isRunning || remote.runningTurnId !== null || hasStreamingAssistant ? (
            <div className="running-indicator" role="status" aria-live="polite">
              <div className="running-indicator__row">
                <OperationActivityLine className="running-indicator__activity" operation={currentRunningOperation} activity={remote.activity} iconSize={15} />
                {activeTurnStartedAt !== null ? <TurnElapsed startedAt={activeTurnStartedAt} /> : null}
              </div>
              {!hasStreamingAssistant && runningOperations.length > 0 ? (
                runningOperationTimeline.length > 0
                  ? <ActivityTimelineContent text="" timeline={runningOperationTimeline} operations={runningOperations} fileChanges={remote.runningTurnId ? remote.fileChangesByTurn[remote.runningTurnId] ?? [] : []} onOpenFile={openChangedFilePreview} onOpenImage={openViewedImagePreview} />
                  : <OperationLog operations={runningOperations} fileChanges={remote.runningTurnId ? remote.fileChangesByTurn[remote.runningTurnId] ?? [] : []} onOpenFile={openChangedFilePreview} onOpenImage={openViewedImagePreview} />
              ) : null}
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
      {terminalOpen ? (
        <Suspense fallback={(
          <ChatOverlayPanel
            ariaLabel="本机终端"
            backdropLabel="关闭本机终端"
            className="terminal-dialog"
            onClose={() => setTerminalOpen(false)}
            showCloseButton={false}
            header={<div className="terminal-dialog__title"><TerminalIcon size={16} aria-hidden="true" /><strong>本机终端</strong></div>}
          >
            <div className="chat-overlay-panel__loading"><LoaderCircle className="spin" size={18} />正在加载终端…</div>
          </ChatOverlayPanel>
        )}>
          <TerminalDialog
            token={token}
            threadId={remote.activeThread?.id}
            cwd={remote.activeThread?.cwd || remote.runtime.workspace || undefined}
            onClose={() => setTerminalOpen(false)}
            onInsertText={(value) => {
              if (value.length >= longPasteThreshold) {
                composerHandle.current?.addDocumentAttachment({ name: 'terminal-output.md', content: value }, true)
              } else {
                composerHandle.current?.insertDraftAtCursor(value, true)
              }
            }}
          />
        </Suspense>
      ) : null}
    </main>
  )
}

export function CodexRemotePage({ token, onUnauthorized, onUnpair, themePreferences, onThemePreferencesChange: setThemePreferences }: Props) {
  const [initialPaneLayout] = useState(readPersistedPaneLayout)
  const [openPaneIndexes, setOpenPaneIndexes] = useState<number[]>(initialPaneLayout.openPaneIndexes)
  const [selectedPaneIndex, setSelectedPaneIndex] = useState(initialPaneLayout.selectedPaneIndex)
  const composerHeightMemory = useRef<{ height: number; manuallyResized: boolean } | null>(null)
  const remote0 = useCodexRemote(token, onUnauthorized, { persistActiveThread: true, enabled: true })
  const remote1 = useCodexRemote(token, onUnauthorized, { persistActiveThread: false, initialThreadId: initialPaneLayout.threadIdsByPane['1'], enabled: openPaneIndexes.includes(1), loadThreads: false, loadModels: false, prefetchHistory: false })
  const remote2 = useCodexRemote(token, onUnauthorized, { persistActiveThread: false, initialThreadId: initialPaneLayout.threadIdsByPane['2'], enabled: openPaneIndexes.includes(2), loadThreads: false, loadModels: false, prefetchHistory: false })
  const remote3 = useCodexRemote(token, onUnauthorized, { persistActiveThread: false, initialThreadId: initialPaneLayout.threadIdsByPane['3'], enabled: openPaneIndexes.includes(3), loadThreads: false, loadModels: false, prefetchHistory: false })
  const remote4 = useCodexRemote(token, onUnauthorized, { persistActiveThread: false, initialThreadId: initialPaneLayout.threadIdsByPane['4'], enabled: openPaneIndexes.includes(4), loadThreads: false, loadModels: false, prefetchHistory: false })
  const remotes = [remote0, remote1, remote2, remote3, remote4]
  const activeRemote = remotes[selectedPaneIndex] ?? remote0
  const isClaudeCodeThread = activeRemote.activeThread?.engine === 'claude-code'

  useEffect(() => {
    const threadIdsByPane = Object.fromEntries(openPaneIndexes.flatMap((paneIndex) => {
      const threadId = remotes[paneIndex]?.activeThread?.id
      return threadId ? [[String(paneIndex), threadId]] : []
    }))
    savePersistedPaneLayout({ openPaneIndexes, selectedPaneIndex, threadIdsByPane })
  }, [openPaneIndexes, selectedPaneIndex, remote0.activeThread?.id, remote1.activeThread?.id, remote2.activeThread?.id, remote3.activeThread?.id, remote4.activeThread?.id])

  const hasRunningFileChangesInOpenPanes = openPaneIndexes.some((paneIndex) => {
    const remote = remotes[paneIndex]
    return remote?.isRunning && remote.runningTurnId
      && remote.fileChangesByTurn[remote.runningTurnId]?.some((change) => change.changes.length > 0)
  })
  const runningFileChangeSummary = useMemo(() => {
    if (!activeRemote.isRunning || !activeRemote.runningTurnId) return null
    return summarizeFileChanges(activeRemote.fileChangesByTurn[activeRemote.runningTurnId] ?? [])
  }, [activeRemote.fileChangesByTurn, activeRemote.isRunning, activeRemote.runningTurnId])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState<boolean | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [workspaceExplorerWidth, setWorkspaceExplorerWidth] = useState(readWorkspaceExplorerWidth)
  const [workspaceResizing, setWorkspaceResizing] = useState(false)
  const [workspacePreviewRequest, setWorkspacePreviewRequest] = useState<WorkspacePreviewRequest | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(() => isSettingsHistoryEntry(window.history.state))
  const [defaultComposerPreferences, setDefaultComposerPreferences] = useState<ComposerPreferences>(readComposerPreferences)
  const [threadComposerPreferences, setThreadComposerPreferences] = useState<ThreadComposerPreferences>(readThreadComposerPreferences)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [completionToast, setCompletionToast] = useState<{ threadId: string; completedAt: number } | null>(null)
  const [paneNotice, setPaneNotice] = useState<string | null>(null)
  const [threadContextMenu, setThreadContextMenu] = useState<{ thread: CodexThread; x: number; y: number } | null>(null)
  const [pinnedThreadIds, setPinnedThreadIds] = useState<Set<string>>(readPinnedThreadIds)
  const [threadContextAction, setThreadContextAction] = useState<{ threadId: string; type: 'export' | 'quote' } | null>(null)
  const [threadRenameTarget, setThreadRenameTarget] = useState<CodexThread | null>(null)
  const [threadRenameDraft, setThreadRenameDraft] = useState('')
  const [threadRenameError, setThreadRenameError] = useState<string | null>(null)
  const [threadRenameSaving, setThreadRenameSaving] = useState(false)
  const [threadDeleteTarget, setThreadDeleteTarget] = useState<CodexThread | null>(null)
  const [threadDeleteError, setThreadDeleteError] = useState<string | null>(null)
  const [threadDeleteSaving, setThreadDeleteSaving] = useState(false)
  const [workspaceDraftSnapshot, setWorkspaceDraftSnapshot] = useState<{ scope: string; draft: string } | null>(null)

  useEffect(() => {
    let current = true
    void codexRemoteClient.claudeStatus(token).then((status) => {
      if (current) setClaudeCodeAvailable(status.available)
    }).catch(() => {
      if (current) setClaudeCodeAvailable(false)
    })
    return () => { current = false }
  }, [token])
  const openSettingsPanel = useCallback(() => {
    const currentState = window.history.state
    if (!isSettingsHistoryEntry(currentState)) {
      const previousState = currentState && typeof currentState === 'object' && !Array.isArray(currentState)
        ? currentState as Record<string, unknown>
        : {}
      window.history.pushState({ ...previousState, [settingsHistoryStateKey]: true }, '')
    }
    setWorkspacePreviewRequest(null)
    setSettingsOpen(true)
    setSidebarOpen(false)
    setWorkspaceOpen(false)
  }, [])
  const openSidebarPanel = useCallback(() => {
    setWorkspaceOpen(false)
    setSidebarOpen(true)
  }, [])
  const openWorkspacePanel = useCallback(() => {
    setSidebarOpen(false)
    setWorkspaceOpen(true)
  }, [])
  const closeSettingsPanel = useCallback(() => {
    setSettingsOpen(false)
    if (isSettingsHistoryEntry(window.history.state)) window.history.back()
  }, [])
  const composerHandle = useRef<ComposerHandle>(null)
  const sidebarTouchStart = useRef<MobilePanelGestureStart | null>(null)
  const threadLongPress = useRef<{ threadId: string; x: number; y: number; timer: number; triggered: boolean } | null>(null)
  const copyResetTimer = useRef<number | undefined>(undefined)
  const paneNoticeTimer = useRef<number | undefined>(undefined)
  const notifiedSystemEvents = useRef(new Set<string>())
  const systemThreadOpener = useRef<(threadId: string) => void>(() => undefined)
  const paneGrid = useRef<HTMLDivElement>(null)
  const paneRects = useRef(new Map<number, DOMRect>())
  const remoteShell = useRef<HTMLDivElement>(null)
  const workspaceExplorerWidthRef = useRef(workspaceExplorerWidth)
  const workspaceResizePointer = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const workspacePreviewSequence = useRef(0)
  const workspacePreviewModeRef = useRef<'desktop' | 'mobile' | null>(null)
  const workspacePreviewCloseRef = useRef<(() => void) | null>(null)

  const notifySystemOnce = useCallback((eventKey: string, title: string, body: string, threadId: string) => {
    if (!themePreferences.systemNotificationsEnabled || notifiedSystemEvents.current.has(eventKey)) return false
    if (!sendSystemNotification(title, body, threadId, eventKey)) return false
    notifiedSystemEvents.current.add(eventKey)
    if (notifiedSystemEvents.current.size > 256) {
      const oldest = notifiedSystemEvents.current.values().next().value
      if (typeof oldest === 'string') notifiedSystemEvents.current.delete(oldest)
    }
    return true
  }, [themePreferences.systemNotificationsEnabled])

  function openThreadContextMenu(thread: CodexThread, x: number, y: number) {
    setThreadContextMenu({
      thread,
      x: Math.max(8, Math.min(x, window.innerWidth - 174)),
      y: Math.max(8, Math.min(y, window.innerHeight - 226)),
    })
  }

  function clearThreadLongPress() {
    const pending = threadLongPress.current
    if (pending) window.clearTimeout(pending.timer)
    threadLongPress.current = null
  }

  function handleThreadTouchStart(event: ReactTouchEvent<HTMLButtonElement>, thread: CodexThread) {
    clearThreadLongPress()
    if (!window.matchMedia(mobileLayoutMediaQuery).matches || event.touches.length !== 1) return
    const touch = event.touches[0]
    if (!touch) return
    const pending = {
      threadId: thread.id,
      x: touch.clientX,
      y: touch.clientY,
      timer: 0,
      triggered: false,
    }
    pending.timer = window.setTimeout(() => {
      if (threadLongPress.current !== pending) return
      pending.triggered = true
      openThreadContextMenu(thread, pending.x, pending.y)
    }, 520)
    threadLongPress.current = pending
  }

  function handleThreadTouchMove(event: ReactTouchEvent<HTMLButtonElement>) {
    const pending = threadLongPress.current
    const touch = event.touches[0]
    if (!pending || !touch || Math.abs(touch.clientX - pending.x) > 10 || Math.abs(touch.clientY - pending.y) > 10) {
      clearThreadLongPress()
    }
  }

  function startThreadRename(thread: CodexThread) {
    setThreadContextMenu(null)
    setThreadRenameTarget(thread)
    setThreadRenameDraft((thread.name || thread.preview || '').slice(0, 72))
    setThreadRenameError(null)
  }

  function closeThreadRename() {
    if (threadRenameSaving) return
    setThreadRenameTarget(null)
    setThreadRenameError(null)
  }

  async function submitThreadRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!threadRenameTarget || threadRenameSaving) return
    const name = threadRenameDraft.trim().replace(/\s+/g, ' ')
    if (!name) {
      setThreadRenameError('对话名称不能为空。')
      return
    }
    if (name.length > 72) {
      setThreadRenameError('对话名称不能超过 72 个字符。')
      return
    }
    setThreadRenameSaving(true)
    setThreadRenameError(null)
    try {
      await remote0.renameThread(threadRenameTarget.id, name)
      setThreadRenameTarget(null)
    } catch (reason) {
      setThreadRenameError(reason instanceof Error ? reason.message : '重命名失败，请稍后重试。')
    } finally {
      setThreadRenameSaving(false)
    }
  }

  function startThreadDelete(thread: CodexThread) {
    setThreadContextMenu(null)
    setThreadDeleteTarget(thread)
    setThreadDeleteError(null)
  }

  function closeThreadDelete() {
    if (threadDeleteSaving) return
    setThreadDeleteTarget(null)
    setThreadDeleteError(null)
  }

  async function submitThreadDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!threadDeleteTarget || threadDeleteSaving) return
    const thread = threadDeleteTarget
    const deletedPaneIndex = paneIndexForThread(thread.id)
    setThreadDeleteSaving(true)
    setThreadDeleteError(null)
    try {
      const result = await codexRemoteClient.deleteThread(token, thread.id)
      if (deletedPaneIndex !== undefined && openPaneIndexes.length > 1) closePane(deletedPaneIndex)
      for (const remote of remotes) remote.removeDeletedThread(thread.id)
      setPinnedThreadIds(new Set(result.thread_ids))
      setCompletionToast((current) => current?.threadId === thread.id ? null : current)
      setThreadComposerPreferences((current) => {
        if (!(thread.id in current)) return current
        const next = { ...current }
        delete next[thread.id]
        return next
      })
      const draftScope = composerDraftScopeForThread(thread.id)
      saveComposerDraft(draftScope, '')
      forgetComposerImageDraftTarget(draftScope)
      void saveComposerImageDraft(draftScope, []).catch(() => undefined)
      setWorkspaceDraftSnapshot((current) => current?.scope === draftScope ? null : current)
      setThreadDeleteTarget(null)
      showPaneNotice(`已删除“${titleOf(thread)}”`)
    } catch (reason) {
      setThreadDeleteError(reason instanceof Error ? reason.message : '删除聊天失败，请稍后重试。')
    } finally {
      setThreadDeleteSaving(false)
    }
  }

  function handleSidebarTouchStart(event: ReactTouchEvent<HTMLDivElement>) {
    if (!window.matchMedia(mobileLayoutMediaQuery).matches || event.touches.length !== 1) {
      sidebarTouchStart.current = null
      return
    }
    const touch = event.touches[0]
    if (!touch) return
    const globalOverlayOpen = settingsOpen
      || Boolean(threadRenameTarget)
      || Boolean(threadDeleteTarget)
      || Boolean(threadContextMenu)
      || workspacePreviewModeRef.current === 'mobile'
    if (globalOverlayOpen) {
      sidebarTouchStart.current = beginMobileGlobalBackGesture(touch.clientX, touch.clientY, window.innerWidth, true)
      return
    }
    const target = event.target
    const targetElement = target instanceof Element ? target : null
    const startedOnBackdrop = Boolean(targetElement?.closest('.sidebar-backdrop, .workspace-backdrop'))
    const startedInsideSidebar = sidebarOpen && Boolean(targetElement?.closest('.remote-sidebar'))
    const startedInsideWorkspaceTree = workspaceOpen && Boolean(targetElement?.closest('.workspace-explorer__tree'))
    const startedOnInteractiveSurface = Boolean(targetElement?.closest([
      'button', 'input', 'textarea', 'select', '[contenteditable="true"]', '[role="button"]',
      '[role="dialog"]', '[role="menu"]', '[role="listbox"]',
      '.chat-message__code', '.workspace-file-preview__code', '.workspace-file-preview-panel',
      '.chat-overlay-backdrop', '.theme-settings-panel', '.thread-context-menu',
      '.thread-rename-backdrop', '.message-composer',
    ].join(', ')))
    sidebarTouchStart.current = startedOnInteractiveSurface && !startedOnBackdrop && !startedInsideSidebar && !startedInsideWorkspaceTree
      ? null
      : beginMobilePanelGesture(touch.clientX, touch.clientY, window.innerWidth, sidebarOpen, workspaceOpen)
  }

  function handleSidebarTouchEnd(event: ReactTouchEvent<HTMLDivElement>) {
    const start = sidebarTouchStart.current
    sidebarTouchStart.current = null
    const touch = event.changedTouches[0]
    if (!start || !touch) return
    const action = resolveMobilePanelGesture(start, touch.clientX, touch.clientY)
    if (!action) return
    event.preventDefault()
    if (action === 'close-global') {
      if (settingsOpen) closeSettingsPanel()
      else if (threadRenameTarget) closeThreadRename()
      else if (threadDeleteTarget) closeThreadDelete()
      else if (workspacePreviewModeRef.current === 'mobile') workspacePreviewCloseRef.current?.()
      else if (threadContextMenu) setThreadContextMenu(null)
    } else if (action === 'open-sidebar') openSidebarPanel()
    else if (action === 'close-sidebar') setSidebarOpen(false)
    else if (action === 'open-workspace') openWorkspacePanel()
    else if (action === 'close-workspace') setWorkspaceOpen(false)
  }

  const activeThreadId = activeRemote.activeThread?.id
  const composerDraftScope = composerDraftScopeForThread(activeThreadId)
  const activeWorkspaceDraft = workspaceDraftSnapshot?.scope === composerDraftScope
    ? workspaceDraftSnapshot.draft
    : readComposerDraft(composerDraftScope)
  const syncWorkspaceDraft = useCallback((draft: string) => {
    setWorkspaceDraftSnapshot({ scope: composerDraftScope, draft })
  }, [composerDraftScope])
  const activeComposerPreferences = activeThreadId
    ? resolvedComposerPreferences(defaultComposerPreferences, threadComposerPreferences[activeThreadId])
    : defaultComposerPreferences
  const selectedModel = isClaudeCodeThread
    ? activeComposerPreferences.claudeModel ?? 'default'
    : activeComposerPreferences.model ?? ''
  const selectedEffort = isClaudeCodeThread
    ? activeComposerPreferences.claudeEffort ?? 'default'
    : activeComposerPreferences.effort ?? ''
  const selectedApprovalPolicy = activeComposerPreferences.approvalPolicy ?? 'on-request'
  const selectedClaudePermissionMode = activeComposerPreferences.claudePermissionMode ?? 'default'
  const availableModels = useMemo(() => {
    const source = remotes.find((remote) => remote.models.length > 0)
    return source?.models ?? []
  }, [remote0.models, remote1.models, remote2.models, remote3.models, remote4.models])
  const chosenModel = availableModels.find((model) => modelIdOf(model) === selectedModel)
  const effortOptions = useMemo(() => chosenModel?.supportedReasoningEfforts ?? [], [chosenModel])
  const darkStatusBarIcons = shouldUseDarkStatusBarIcons(themePreferences)
  const themeStyle = {
    ...themeRootStyle(themePreferences),
    '--workspace-explorer-width': `${workspaceExplorerWidth}px`,
  } as CSSProperties

  useEffect(() => {
    window.CodexRemoteAndroid?.setStatusBarDarkIcons?.(darkStatusBarIcons)
  }, [darkStatusBarIcons])

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

  const changeModel = useCallback((model: string) => updateComposerPreferences(isClaudeCodeThread ? { claudeModel: model } : { model }), [isClaudeCodeThread, updateComposerPreferences])
  const changeEffort = useCallback((effort: string) => updateComposerPreferences(isClaudeCodeThread ? { claudeEffort: effort } : { effort }), [isClaudeCodeThread, updateComposerPreferences])
  const changeClaudePermissionMode = useCallback((claudePermissionMode: ClaudeCodePermissionMode) => updateComposerPreferences({ claudePermissionMode }), [updateComposerPreferences])
  const changeApprovalPolicy = useCallback(async (approvalPolicy: CodexApprovalPolicy) => {
    const updated = activeThreadId ? await (remotes[selectedPaneIndex] ?? remote0).updateApprovalPolicy(approvalPolicy) : true
    if (!updated) return
    updateComposerPreferences({ approvalPolicy })
  }, [activeThreadId, remote0, remotes, selectedPaneIndex, updateComposerPreferences])

  useEffect(() => {
    saveComposerPreferences(defaultComposerPreferences)
  }, [defaultComposerPreferences])

  useEffect(() => {
    saveThreadComposerPreferences(threadComposerPreferences)
  }, [threadComposerPreferences])

  useEffect(() => {
    const syncSettingsFromHistory = (event: PopStateEvent) => {
      setSettingsOpen(isSettingsHistoryEntry(event.state))
    }
    window.addEventListener('popstate', syncSettingsFromHistory)
    return () => window.removeEventListener('popstate', syncSettingsFromHistory)
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    const closeOnDesktopEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
      if (window.matchMedia(mobileLayoutMediaQuery).matches) return
      event.preventDefault()
      event.stopPropagation()
      closeSettingsPanel()
    }
    document.addEventListener('keydown', closeOnDesktopEscape, true)
    return () => document.removeEventListener('keydown', closeOnDesktopEscape, true)
  }, [closeSettingsPanel, settingsOpen])

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

  useEffect(() => () => {
    const pending = threadLongPress.current
    if (pending) window.clearTimeout(pending.timer)
  }, [])

  useEffect(() => {
    if (!threadRenameTarget) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      closeThreadRename()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [threadRenameTarget, threadRenameSaving])

  useEffect(() => {
    if (!threadDeleteTarget) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      closeThreadDelete()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [threadDeleteTarget, threadDeleteSaving])

  useLayoutEffect(() => {
    const handleBack = () => {
      if (settingsOpen) {
        closeSettingsPanel()
        return true
      }
      if (threadRenameTarget) {
        closeThreadRename()
        return true
      }
      if (threadDeleteTarget) {
        closeThreadDelete()
        return true
      }
      if (workspacePreviewModeRef.current === 'mobile') {
        workspacePreviewCloseRef.current?.()
        return true
      }
      if (composerHandle.current?.closeOpenMenu()) return true
      if (threadContextMenu) {
        setThreadContextMenu(null)
        return true
      }
      if (workspaceOpen) {
        setWorkspaceOpen(false)
        return true
      }
      if (sidebarOpen) {
        setSidebarOpen(false)
        return true
      }
      return false
    }
    window.CodexRemoteHandleBack = handleBack
    return () => {
      if (window.CodexRemoteHandleBack === handleBack) delete window.CodexRemoteHandleBack
    }
  }, [closeSettingsPanel, settingsOpen, sidebarOpen, threadContextMenu, threadDeleteSaving, threadDeleteTarget, threadRenameTarget, workspaceOpen, threadRenameSaving])

  useEffect(() => {
    const interruptOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      if (threadRenameTarget || threadDeleteTarget) return
      if (workspacePreviewModeRef.current !== null) {
        event.preventDefault()
        workspacePreviewCloseRef.current?.()
        return
      }
      if (!activeRemote.isRunning) return
      event.preventDefault()
      void activeRemote.interrupt()
    }
    document.addEventListener('keydown', interruptOnEscape)
    return () => document.removeEventListener('keydown', interruptOnEscape)
  }, [activeRemote.isRunning, activeRemote.interrupt, threadDeleteTarget, threadRenameTarget])

  useEffect(() => {
    if (isClaudeCodeThread || availableModels.length === 0) return
    if (selectedModel && availableModels.some((model) => modelIdOf(model) === selectedModel)) return
    const defaultModel = availableModels.find((model) => model.isDefault) ?? availableModels[0]
    updateComposerPreferences({ model: modelIdOf(defaultModel) })
  }, [availableModels, isClaudeCodeThread, selectedModel, updateComposerPreferences])

  useEffect(() => {
    if (isClaudeCodeThread || availableModels.length === 0 || !chosenModel) return
    if (effortOptions.length === 0) {
      if (selectedEffort) updateComposerPreferences({ effort: undefined })
      return
    }
    if (selectedEffort && effortOptions.some((option) => option.reasoningEffort === selectedEffort)) return
    updateComposerPreferences({ effort: chosenModel.defaultReasoningEffort ?? effortOptions[0].reasoningEffort })
  }, [availableModels.length, chosenModel, effortOptions, isClaudeCodeThread, selectedEffort, updateComposerPreferences])

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
  }, [remote0.latestThreadCompletion, remote1.latestThreadCompletion, remote2.latestThreadCompletion, remote3.latestThreadCompletion, remote4.latestThreadCompletion])

  useEffect(() => {
    const notifyWhileBackgrounded = () => {
      if (!themePreferences.systemNotificationsEnabled) return
      const android = window.CodexRemoteAndroid
      const inBackground = android?.isAppInBackground?.() ?? document.visibilityState === 'hidden'
      if (!inBackground) return

      const now = Date.now()
      for (const remote of remotes) {
        const completion = remote.latestThreadCompletion
        if (completion && now - completion.completedAt < 120_000) {
          const thread = remote0.threads.find((item) => item.id === completion.threadId)
            ?? remotes.find((item) => item.activeThread?.id === completion.threadId)?.activeThread
          const title = thread ? titleOf(thread) : 'Codex Remote'
          notifySystemOnce(
            `completion:${completion.threadId}:${completion.completedAt}`,
            `${title} 已完成回复`,
            '点按通知查看对话。',
            completion.threadId,
          )
        }

        const approval = remote.approval
        const thread = remote.activeThread
        if (approval && thread) {
          notifySystemOnce(
            `approval:${thread.id}:${String(approval.requestId)}`,
            `${titleOf(thread)} 需要批准`,
            'Codex 正在等待你批准一项操作。',
            thread.id,
          )
        }
      }
    }

    document.addEventListener('visibilitychange', notifyWhileBackgrounded)
    window.addEventListener('codex-remote-app-background', notifyWhileBackgrounded)
    notifyWhileBackgrounded()
    return () => {
      document.removeEventListener('visibilitychange', notifyWhileBackgrounded)
      window.removeEventListener('codex-remote-app-background', notifyWhileBackgrounded)
    }
  }, [
    notifySystemOnce,
    remote0.latestThreadCompletion,
    remote0.threads,
    remote0.approval,
    remote0.activeThread,
    remote1.latestThreadCompletion,
    remote1.approval,
    remote1.activeThread,
    remote2.latestThreadCompletion,
    remote2.approval,
    remote2.activeThread,
    remote3.latestThreadCompletion,
    remote3.approval,
    remote3.activeThread,
    remote4.latestThreadCompletion,
    remote4.approval,
    remote4.activeThread,
    themePreferences.systemNotificationsEnabled,
  ])

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

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const legacy = readPinnedThreadIds()
        const result = legacy.size > 0
          ? await codexRemoteClient.initializePins(token, [...legacy])
          : await codexRemoteClient.pins(token)
        if (legacy.size > 0) window.localStorage.removeItem(pinnedThreadIdsStorageKey)
        if (cancelled) return
        setPinnedThreadIds(new Set(result.thread_ids))
      } catch (reason) {
        if (cancelled) return
        setPaneNotice(reason instanceof Error ? `同步置顶失败：${reason.message}` : '同步置顶失败')
      }
    })()
    return () => { cancelled = true }
  }, [remote0.pinRevision, token])

  function showPaneNotice(message: string) {
    setPaneNotice(message)
    if (paneNoticeTimer.current !== undefined) window.clearTimeout(paneNoticeTimer.current)
    paneNoticeTimer.current = window.setTimeout(() => {
      paneNoticeTimer.current = undefined
      setPaneNotice(null)
    }, 2_400)
  }

  async function toggleThreadPin(thread: CodexThread) {
    const pinned = !pinnedThreadIds.has(thread.id)
    setThreadContextMenu(null)
    try {
      const result = await codexRemoteClient.setThreadPin(token, thread.id, pinned)
      setPinnedThreadIds(new Set(result.thread_ids))
    } catch (reason) {
      showPaneNotice(reason instanceof Error ? reason.message : '置顶操作失败')
    }
  }

  async function readThreadTranscript(thread: CodexThread) {
    const details = await codexRemoteClient.readThread(token, thread.id)
    return createThreadTranscript({ ...thread, ...details }, messagesFromThread(details))
  }

  function downloadThreadTranscript(thread: CodexThread, content: string) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = threadTranscriptFilename(thread, '对话导出')
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  async function exportThread(thread: CodexThread) {
    if (threadContextAction) return
    setThreadContextAction({ threadId: thread.id, type: 'export' })
    try {
      const transcript = await readThreadTranscript(thread)
      downloadThreadTranscript(thread, transcript)
      setThreadContextMenu(null)
      showPaneNotice('已导出完整对话 Markdown')
    } catch (reason) {
      showPaneNotice(reason instanceof Error ? `导出失败：${reason.message}` : '导出失败，请稍后重试。')
    } finally {
      setThreadContextAction(null)
    }
  }

  async function quoteThread(thread: CodexThread) {
    if (threadContextAction) return
    setThreadContextAction({ threadId: thread.id, type: 'quote' })
    try {
      const transcript = await readThreadTranscript(thread)
      const composer = composerHandle.current
      if (!composer) throw new Error('当前输入框尚未准备好，请稍后重试。')
      const added = composer.addDocumentAttachment({
        name: threadTranscriptFilename(thread, '对话引用'),
        content: transcript,
      })
      setThreadContextMenu(null)
      setSidebarOpen(false)
      if (!added) {
        showPaneNotice('引用未加入：该对话已在输入框中，或文档数量已达上限。')
        return
      }
      showPaneNotice('对话引用已加入输入框')
    } catch (reason) {
      showPaneNotice(reason instanceof Error ? `引用失败：${reason.message}` : '引用失败，请稍后重试。')
    } finally {
      setThreadContextAction(null)
    }
  }

  function paneIndexForThread(threadId: string) {
    return openPaneIndexes.find((index) => remotes[index]?.activeThread?.id === threadId)
  }

  async function createThreadForPane(paneIndex = selectedPaneIndex, cwd?: string, engine?: ChatEngine) {
    const target = remotes[paneIndex] ?? remote0
    const selectedEngine = engine ?? (target.activeThread?.engine === 'claude-code' ? 'claude-code' : 'codex')
    const targetThreadId = target.activeThread?.id
    const targetPreferences = targetThreadId
      ? resolvedComposerPreferences(defaultComposerPreferences, threadComposerPreferences[targetThreadId])
      : activeComposerPreferences
    const thread = await target.createThread(
      selectedEngine === 'codex' ? targetPreferences.model : undefined,
      selectedEngine === 'codex' ? targetPreferences.approvalPolicy : undefined,
      undefined,
      cwd,
      selectedEngine,
    )
    if (!thread) return null
    if (paneIndex === selectedPaneIndex && !activeThreadId) composerHandle.current?.adoptUnassignedDraft(thread.id)
    rememberThreadComposerPreferences(thread.id, selectedEngine === 'codex'
      ? {
          model: targetPreferences.model,
          effort: targetPreferences.effort,
          approvalPolicy: targetPreferences.approvalPolicy,
        }
      : {
          claudeModel: targetPreferences.claudeModel ?? 'default',
          claudeEffort: targetPreferences.claudeEffort ?? 'default',
          claudePermissionMode: targetPreferences.claudePermissionMode ?? 'default',
        })
    if (paneIndex !== 0) await remote0.refreshThreads()
    return thread
  }

  async function switchEngineForPane(paneIndex: number, engine: 'codex' | 'claude-code') {
    const targetRemote = remotes[paneIndex] ?? remote0
    const cwd = targetRemote.activeThread?.cwd || targetRemote.runtime.workspace || undefined
    const threadsForEngine = (threads: CodexThread[]) => threads.filter((thread) => (thread.engine ?? 'codex') === engine)
    const openTargetThread = remotes
      .map((remote) => remote.activeThread)
      .find((thread) => thread && (thread.engine ?? 'codex') === engine && (!cwd || thread.cwd === cwd))
    let targetThreads = threadsForEngine(remote0.threads)
    if (targetThreads.length === 0) {
      const refreshedThreads = await remote0.refreshThreads()
      targetThreads = threadsForEngine(refreshedThreads ?? remote0.threads)
    }
    const targetThread = openTargetThread ?? targetThreads.find((thread) => cwd && thread.cwd === cwd) ?? targetThreads[0]
    setSidebarOpen(false)
    if (targetThread) {
      const existingPane = paneIndexForThread(targetThread.id)
      if (existingPane !== undefined) {
        setSelectedPaneIndex(existingPane)
        return targetThread
      }
      activatePane(paneIndex)
      await targetRemote.selectThread(targetThread)
      return targetThread
    }
    activatePane(paneIndex)
    return createThreadForPane(paneIndex, cwd, engine)
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

  function openSystemNotificationThread(threadId: string) {
    if (!threadId) return
    if (settingsOpen) closeSettingsPanel()
    setWorkspaceOpen(false)
    const thread = remote0.threads.find((item) => item.id === threadId)
      ?? remotes.find((remote) => remote.activeThread?.id === threadId)?.activeThread
      ?? { id: threadId } as CodexThread
    void selectThread(thread)
  }

  systemThreadOpener.current = openSystemNotificationThread

  useEffect(() => {
    const openRequestedThread = (threadId: string) => systemThreadOpener.current(threadId)
    window.CodexRemoteOpenThread = openRequestedThread
    const pendingThreadId = window.__codexRemotePendingThreadId
      ?? window.CodexRemoteAndroid?.consumeNotificationThreadId?.()
    delete window.__codexRemotePendingThreadId
    if (pendingThreadId) openRequestedThread(pendingThreadId)
    return () => {
      if (window.CodexRemoteOpenThread === openRequestedThread) delete window.CodexRemoteOpenThread
    }
  }, [])

  async function openConcurrentThread(thread: CodexThread) {
    setThreadContextMenu(null)
    const existingPane = paneIndexForThread(thread.id)
    if (existingPane !== undefined) {
      setSelectedPaneIndex(existingPane)
      return
    }
    const paneLimit = concurrentPaneLimit()
    const freePane = Array.from({ length: paneLimit }, (_, index) => index).find((index) => !openPaneIndexes.includes(index))
    if (freePane === undefined) {
      showPaneNotice(`最多同时打开 ${paneLimit} 个对话窗口`)
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

  function findCompletedThread() {
    if (!completionToast) return undefined
    return remote0.threads.find((item) => item.id === completionToast.threadId)
      ?? remotes.find((remote) => remote.activeThread?.id === completionToast.threadId)?.activeThread
  }

  function openCompletedThread() {
    if (!completionToast) return
    const thread = findCompletedThread() ?? { id: completionToast.threadId }
    void selectThread(thread)
    setCompletionToast(null)
  }

  const copyMessage = useCallback(async (message: CodexMessage) => {
    const documentText = message.documents?.map((document) => document.sourceFileId
      ? `\n\n[原始 PDF 附件：${document.name}]`
      : '\n\n' + document.name + '\n' + document.content).join('') ?? ''
    const value = (message.text + documentText).trim()
    if (!value || !(await copyTextToClipboard(value))) return
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
        composerHandle.current?.adoptUnassignedDraft(thread.id, false)
        rememberThreadComposerPreferences(thread.id, preferences)
      },
    })
  }, [rememberThreadComposerPreferences, remote0, remote1, remote2, remote3, remote4, selectedPaneIndex])

  const activeWorkspaceCwd = activeRemote.activeThread?.cwd || activeRemote.runtime.workspace || undefined
  const insertWorkspacePath = useCallback((path: string, focus = true) => {
    composerHandle.current?.appendDraft(path, focus)
  }, [])
  const addWorkspaceDocument = useCallback((document: CodexDocumentAttachment, focus = true) => {
    composerHandle.current?.addDocumentAttachment(document, focus)
  }, [])

  function setWorkspaceExplorerWidthValue(value: number, persist = false) {
    const width = clampWorkspaceExplorerWidth(value)
    workspaceExplorerWidthRef.current = width
    remoteShell.current?.style.setProperty('--workspace-explorer-width', `${width}px`)
    if (!persist) return width
    setWorkspaceExplorerWidth(width)
    try {
      window.localStorage.setItem(workspaceExplorerWidthStorageKey, String(width))
    } catch {
      // The current tab still keeps the chosen width when storage is unavailable.
    }
    return width
  }

  const handleWorkspacePreviewStateChange = useCallback((open: boolean, closePreview?: () => void) => {
    if (open) {
      setWorkspacePreviewRequest(null)
      workspacePreviewModeRef.current = workspacePreviewModeRef.current ?? (desktopWorkspacePreviewAvailable() ? 'desktop' : 'mobile')
      workspacePreviewCloseRef.current = closePreview ?? null
      return
    }
    workspacePreviewModeRef.current = null
    workspacePreviewCloseRef.current = null
  }, [])

  function startWorkspaceResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    workspaceResizePointer.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: workspaceExplorerWidthRef.current,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setWorkspaceResizing(true)
  }

  function moveWorkspaceResize(event: ReactPointerEvent<HTMLDivElement>) {
    const current = workspaceResizePointer.current
    if (!current || current.pointerId !== event.pointerId) return
    const requestedWidth = current.startWidth + current.startX - event.clientX
    setWorkspaceExplorerWidthValue(requestedWidth)
  }

  function finishWorkspaceResize(event: ReactPointerEvent<HTMLDivElement>) {
    const current = workspaceResizePointer.current
    if (!current || current.pointerId !== event.pointerId) return
    workspaceResizePointer.current = null
    setWorkspaceExplorerWidthValue(workspaceExplorerWidthRef.current, true)
    setWorkspaceResizing(false)
  }

  useEffect(() => {
    workspaceExplorerWidthRef.current = workspaceExplorerWidth
  }, [workspaceExplorerWidth])

  useEffect(() => {
    const clampForViewport = () => {
      const width = clampWorkspaceExplorerWidth(workspaceExplorerWidthRef.current)
      if (width !== workspaceExplorerWidthRef.current) setWorkspaceExplorerWidthValue(width, true)
    }
    window.addEventListener('resize', clampForViewport)
    return () => window.removeEventListener('resize', clampForViewport)
  }, [])

  const activeTitle = activeRemote.activeThread ? titleOf(activeRemote.activeThread) : '新对话'
  const currentConnectionLabel = activeRemote.handedOff ? '已交还给本机' : isClaudeCodeThread
    ? activeRemote.connection === 'connected'
      ? claudeCodeAvailable === false ? 'Claude Code 不可用' : claudeCodeAvailable === null ? '正在检查 Claude Code' : 'Claude Code 就绪'
      : activeRemote.connection === 'connecting' ? '正在连接' : '连接已断开'
    : connectionLabel[activeRemote.connection]
  const androidEndpointBridgeAvailable = typeof window !== 'undefined' && typeof window.CodexRemoteAndroid?.changeEndpoint === 'function'
  const modelSupportsImages = isClaudeCodeThread || !chosenModel || !Array.isArray(chosenModel.inputModalities) || chosenModel.inputModalities.includes('image')
  const modelOptions = useMemo<ComposerMenuOption[]>(() => availableModels.flatMap((model) => {
    const id = modelIdOf(model)
    return id ? [{ value: id, label: modelLabelOf(model) }] : []
  }), [availableModels])
  const reasoningOptions = useMemo<ComposerMenuOption[]>(() => effortOptions.map((option) => ({
    value: option.reasoningEffort,
    label: effortLabelOf(option.reasoningEffort),
  })), [effortOptions])
  const sidebarThreads = useMemo(() => [...remote0.threads].sort((left, right) => {
    const leftPinned = pinnedThreadIds.has(left.id)
    const rightPinned = pinnedThreadIds.has(right.id)
    return Number(rightPinned) - Number(leftPinned)
  }), [pinnedThreadIds, remote0.threads])
  const completedThread = findCompletedThread()

  return (
    <div
      ref={remoteShell}
      className={'remote-shell remote-shell--theme-' + themePreferences.theme + (androidEndpointBridgeAvailable ? ' remote-shell--android' : '') + (sidebarCollapsed ? ' remote-shell--sidebar-collapsed' : '') + (workspaceResizing ? ' remote-shell--resizing' : '')}
      style={themeStyle}
      onTouchStartCapture={handleSidebarTouchStart}
      onTouchEndCapture={handleSidebarTouchEnd}
      onTouchCancelCapture={() => { sidebarTouchStart.current = null }}
    >
      {completionToast ? (
        <div className="thread-completion-toast" role="status" aria-live="polite">
          <button className="thread-completion-toast__open" type="button" onClick={openCompletedThread}>
            <span className="thread-completion-toast__icon"><Check size={15} strokeWidth={2.8} /></span>
            <span className="thread-completion-toast__copy"><strong>{completedThread ? `“${titleOf(completedThread)}”已完成回复` : '一条对话已完成回复'}</strong><small>点击查看这条对话</small></span>
          </button>
          <button className="thread-completion-toast__close" type="button" aria-label="关闭完成提示" onClick={() => setCompletionToast(null)}><X size={15} /></button>
        </div>
      ) : null}
      {paneNotice ? <div className="pane-limit-notice" role="status">{paneNotice}</div> : null}
      <aside className={'remote-sidebar' + (sidebarOpen ? ' remote-sidebar--open' : '')} aria-label="对话记录">
        <div className="remote-sidebar__heading">
          <div className="remote-brand"><img className="remote-brand__logo" src="/codex-remote.webp" alt="" /><span className="remote-brand__copy"><strong>Codex Remote</strong><small>Codex 远程工作台</small></span></div>
          <button className="icon-button remote-sidebar__collapse" type="button" aria-label={sidebarCollapsed ? '展开对话栏' : '收窄对话栏'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? '展开对话栏' : '收窄对话栏'} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>
            {sidebarCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </button>
          <button className="icon-button remote-sidebar__close" type="button" aria-label="关闭对话列表" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>
        <div className="new-thread-control">
          <button className="new-thread-button" type="button" onClick={() => void createThread()} disabled={activeRemote.handedOff || activeRemote.connection !== 'connected' || activeRemote.loadingHistory || (isClaudeCodeThread && claudeCodeAvailable === false)} title={isClaudeCodeThread && claudeCodeAvailable === false ? 'Claude Code 不可用' : `新建${isClaudeCodeThread ? ' Claude Code' : ' Codex'}对话`}><span className="new-thread-button__icon"><Plus size={16} /></span><span>新建对话</span></button>
        </div>
        <div className="thread-list-heading"><span>{sidebarCollapsed ? '对话记录' : '最近对话'}</span><button className="icon-button" type="button" aria-label="刷新对话记录" title="刷新对话记录" onClick={() => void remote0.refreshThreads()} disabled={remote0.handedOff}><RefreshCw size={14} /></button></div>
        <nav className="thread-list">
          {sidebarThreads.map((thread) => {
            const paneIndex = paneIndexForThread(thread.id)
            const isActive = paneIndex === selectedPaneIndex
            const isPinned = pinnedThreadIds.has(thread.id)
            return (
              <button className={'thread-row' + (isActive ? ' thread-row--active' : '') + (paneIndex !== undefined ? ' thread-row--open' : '')} type="button" key={thread.id} onClick={(event) => {
                const pending = threadLongPress.current
                if (pending?.threadId === thread.id && pending.triggered) {
                  event.preventDefault()
                  clearThreadLongPress()
                  return
                }
                clearThreadLongPress()
                void selectThread(thread)
              }} onContextMenu={(event) => { event.preventDefault(); openThreadContextMenu(thread, event.clientX, event.clientY) }} onTouchStart={(event) => handleThreadTouchStart(event, thread)} onTouchMove={handleThreadTouchMove} onTouchEnd={() => { if (!threadLongPress.current?.triggered) clearThreadLongPress() }} onTouchCancel={clearThreadLongPress} disabled={activeRemote.handedOff} aria-current={isActive ? 'page' : undefined}>
                <EngineBrandIcon engine={thread.engine === 'claude-code' ? 'claude-code' : 'codex'} size={15} />
                <span className="thread-row__copy"><strong>{titleOf(thread)}</strong><span className="thread-row__meta">{thread.engine === 'claude-code' ? <small className="thread-row__engine">Claude</small> : null}{isPinned ? <Pin className="thread-row__pin" size={12} aria-label="已置顶" /> : null}{remote0.completedThreadIds.includes(thread.id) ? <span className="thread-row__completion-dot" role="status" aria-label="回复已完成" title="回复已完成" /> : null}<small>{timeOf(thread)}</small></span></span>
                {paneIndex !== undefined ? <span className="thread-row__pane-dot" title="已打开" /> : null}
              </button>
            )
          })}
          {remote0.threads.length === 0 && !remote0.loadingHistory ? <p className="thread-list__empty">还没有对话</p> : null}
          {remote0.loadingHistory && remote0.threads.length === 0 ? <p className="thread-list__empty"><LoaderCircle className="spin" size={14} />读取对话中</p> : null}
        </nav>
        <div className="remote-sidebar__actions">
          {androidEndpointBridgeAvailable ? <button className="sidebar-settings sidebar-endpoint" type="button" aria-label="切换电脑地址" title="切换电脑地址" onClick={() => window.CodexRemoteAndroid?.changeEndpoint?.()}><Link2 size={16} /><span>切换电脑地址</span></button> : null}
          <button className={'sidebar-settings' + (settingsOpen ? ' sidebar-settings--active' : '')} type="button" aria-label="设置" title="设置" onClick={openSettingsPanel}><Settings2 size={16} /><span>设置</span></button>
        </div>
        <footer className="remote-sidebar__footer"><i className={'status-dot status-dot--' + (activeRemote.handedOff ? 'handoff' : activeRemote.connection)} role="img" aria-label={currentConnectionLabel} title={currentConnectionLabel} /><span>{currentConnectionLabel}</span><button type="button" aria-label="退出配对" title="退出配对" onClick={() => void onUnpair()}>退出</button></footer>
      </aside>

      {sidebarOpen ? <button className="sidebar-backdrop" type="button" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} /> : null}
      {workspaceOpen ? <button className="workspace-backdrop" type="button" aria-label="关闭文件树" onClick={() => setWorkspaceOpen(false)} /> : null}
      {threadContextMenu ? (
        <div className="thread-context-menu" style={{ left: threadContextMenu.x, top: threadContextMenu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => { const thread = threadContextMenu.thread; setThreadContextMenu(null); void openConcurrentThread(thread) }}><MessagesSquare size={14} />并发打开</button>
          <button type="button" role="menuitem" onClick={() => void toggleThreadPin(threadContextMenu.thread)}>{pinnedThreadIds.has(threadContextMenu.thread.id) ? <PinOff size={14} /> : <Pin size={14} />}{pinnedThreadIds.has(threadContextMenu.thread.id) ? '取消置顶' : '置顶'}</button>
          <button type="button" role="menuitem" disabled={threadContextAction !== null} onClick={() => void exportThread(threadContextMenu.thread)}>{threadContextAction?.threadId === threadContextMenu.thread.id && threadContextAction.type === 'export' ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}{threadContextAction?.threadId === threadContextMenu.thread.id && threadContextAction.type === 'export' ? '导出中…' : '导出'}</button>
          <button type="button" role="menuitem" disabled={threadContextAction !== null} onClick={() => void quoteThread(threadContextMenu.thread)}>{threadContextAction?.threadId === threadContextMenu.thread.id && threadContextAction.type === 'quote' ? <LoaderCircle className="spin" size={14} /> : <Quote size={14} />}{threadContextAction?.threadId === threadContextMenu.thread.id && threadContextAction.type === 'quote' ? '引用中…' : '引用'}</button>
          <button type="button" role="menuitem" onClick={() => startThreadRename(threadContextMenu.thread)}><Pencil size={14} />重命名</button>
          <button className="thread-context-menu__danger" type="button" role="menuitem" disabled={threadContextAction !== null} onClick={() => startThreadDelete(threadContextMenu.thread)}><Trash2 size={14} />删除聊天</button>
        </div>
      ) : null}

      {threadRenameTarget ? (
        <div className="thread-rename-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) closeThreadRename() }}>
          <form className="thread-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="thread-rename-title" onSubmit={(event) => { void submitThreadRename(event) }} onPointerDown={(event) => event.stopPropagation()}>
            <div className="thread-rename-dialog__heading">
              <h2 id="thread-rename-title">重命名对话</h2>
              <p>名称会同步到连接的设备和后续刷新。</p>
            </div>
            <label htmlFor="thread-rename-input">对话名称</label>
            <input id="thread-rename-input" type="text" value={threadRenameDraft} maxLength={72} autoComplete="off" autoFocus disabled={threadRenameSaving} aria-describedby={threadRenameError ? 'thread-rename-error' : undefined} onChange={(event) => { setThreadRenameDraft(event.target.value); setThreadRenameError(null) }} />
            {threadRenameError ? <p className="thread-rename-dialog__error" id="thread-rename-error" role="alert">{threadRenameError}</p> : null}
            <div className="thread-rename-dialog__actions">
              <button type="button" onClick={closeThreadRename} disabled={threadRenameSaving}>取消</button>
              <button type="submit" disabled={threadRenameSaving || !threadRenameDraft.trim()}>{threadRenameSaving ? <><LoaderCircle className="spin" size={14} />保存中</> : '确定'}</button>
            </div>
          </form>
        </div>
      ) : null}

      {threadDeleteTarget ? (
        <div className="thread-rename-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) closeThreadDelete() }}>
          <form className="thread-rename-dialog thread-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="thread-delete-title" aria-describedby="thread-delete-description" onSubmit={(event) => { void submitThreadDelete(event) }} onPointerDown={(event) => event.stopPropagation()}>
            <div className="thread-rename-dialog__heading">
              <div className="thread-delete-dialog__title"><AlertTriangle size={18} /><h2 id="thread-delete-title">删除聊天</h2></div>
              <p id="thread-delete-description">这会永久删除聊天记录，删除后无法恢复。</p>
            </div>
            <div className="thread-delete-dialog__thread" title={titleOf(threadDeleteTarget)}>{titleOf(threadDeleteTarget)}</div>
            {threadDeleteError ? <p className="thread-rename-dialog__error" role="alert">{threadDeleteError}</p> : null}
            <div className="thread-rename-dialog__actions thread-delete-dialog__actions">
              <button type="button" onClick={closeThreadDelete} disabled={threadDeleteSaving}>取消</button>
              <button type="submit" disabled={threadDeleteSaving}>{threadDeleteSaving ? <><LoaderCircle className="spin" size={14} />删除中</> : <><Trash2 size={14} />确认删除</>}</button>
            </div>
          </form>
        </div>
      ) : null}

      {settingsOpen ? (
        <ThemeSettingsPanel preferences={themePreferences} onChange={setThemePreferences} onClose={closeSettingsPanel} />
      ) : (
        <>
          <section className="remote-workspace">
            <div className="remote-pane-grid" ref={paneGrid} style={{ '--pane-count': openPaneIndexes.length } as CSSProperties}>
              {openPaneIndexes.map((paneIndex) => (
                <div className="remote-pane-slot" data-pane-index={paneIndex} key={paneIndex}>
                  <RemoteChatPane
                    token={token}
                    remote={remotes[paneIndex]}
                    active={paneIndex === selectedPaneIndex}
                    showActiveFrame={openPaneIndexes.length > 1}
                    showPaneClose={openPaneIndexes.length > 1}
                    onActivate={() => activatePane(paneIndex)}
                    onClose={() => closePane(paneIndex)}
                    onCreateThread={() => void createThreadForPane(paneIndex)}
                    claudeCodeAvailable={claudeCodeAvailable}
                    onSwitchEngine={(engine) => switchEngineForPane(paneIndex, engine)}
                    onOpenSidebar={openSidebarPanel}
                    onOpenWorkspace={openWorkspacePanel}
                    onOpenWorkspaceFile={(path, cwd, diff) => {
                      activatePane(paneIndex)
                      workspacePreviewSequence.current += 1
                      setWorkspacePreviewRequest({ id: workspacePreviewSequence.current, cwd, path, diff })
                    }}
                    onOpenWorkspaceImage={(path, cwd) => {
                      activatePane(paneIndex)
                      workspacePreviewSequence.current += 1
                      setWorkspacePreviewRequest({ id: workspacePreviewSequence.current, cwd, path, kind: 'image' })
                    }}
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
              onDraftChange={syncWorkspaceDraft}
              composerHeightMemory={composerHeightMemory}
              connection={activeRemote.handedOff ? 'disconnected' : activeRemote.connection}
              isRunning={activeRemote.isRunning}
              fileChangeSummary={runningFileChangeSummary}
              fileChangeSummaryKey={activeRemote.runningTurnId}
              reserveFileChangeSummarySpace={openPaneIndexes.length > 1 && Boolean(hasRunningFileChangesInOpenPanes)}
              reserveQueuedMessageSpace={openPaneIndexes.length > 1}
              showCodexPreferences={!isClaudeCodeThread}
              isInterrupting={activeRemote.isInterrupting}
              writerConflict={activeRemote.writerConflict}
              modelSupportsImages={modelSupportsImages}
              selectedModel={selectedModel}
              selectedEffort={selectedEffort}
              selectedApprovalPolicy={selectedApprovalPolicy}
              selectedClaudePermissionMode={selectedClaudePermissionMode}
              modelOptions={modelOptions}
              reasoningOptions={reasoningOptions}
              authorizationOptions={approvalPolicyOptions}
              claudeModelOptions={claudeModelOptions}
              claudeEffortOptions={claudeEffortOptions}
              claudePermissionModeOptions={claudePermissionModeOptions}
              onModelChange={changeModel}
              onEffortChange={changeEffort}
              onApprovalPolicyChange={changeApprovalPolicy}
              onClaudePermissionModeChange={changeClaudePermissionMode}
              approvalPolicyUpdating={activeRemote.updatingApprovalPolicy}
              onUploadPdf={activeRemote.uploadPdfAttachment}
              onSend={sendComposerMessage}
              queuedMessages={activeRemote.queuedMessages}
              onSendQueuedNow={activeRemote.sendQueuedMessageNow}
              onBeginQueuedEdit={activeRemote.beginEditQueuedMessage}
              onUpdateQueuedMessage={activeRemote.updateQueuedMessage}
              onEndQueuedEdit={activeRemote.endEditQueuedMessage}
              onRemoveQueued={activeRemote.removeQueuedMessage}
              onInterrupt={activeRemote.interrupt}
              onRefresh={activeRemote.refreshActiveThread}
            />
          </section>
          <div
            className="workspace-resize-handle"
            role="separator"
            aria-label="调整右侧文件区宽度"
            aria-orientation="vertical"
            aria-valuemin={workspaceExplorerMinimumWidth()}
            aria-valuemax={workspaceExplorerWidthLimit()}
            aria-valuenow={workspaceExplorerWidth}
            tabIndex={0}
            onPointerDown={startWorkspaceResize}
            onPointerMove={moveWorkspaceResize}
            onPointerUp={finishWorkspaceResize}
            onPointerCancel={finishWorkspaceResize}
            onLostPointerCapture={finishWorkspaceResize}
            onDoubleClick={() => setWorkspaceExplorerWidthValue(workspaceExplorerDefaultWidth, true)}
            onKeyDown={(event) => {
              const limits = workspaceExplorerWidthLimit()
              const nextWidth = event.key === 'ArrowLeft'
                ? workspaceExplorerWidthRef.current + 24
                : event.key === 'ArrowRight'
                  ? workspaceExplorerWidthRef.current - 24
                  : event.key === 'Home'
                    ? workspaceExplorerMinimumWidth()
                    : event.key === 'End'
                      ? limits
                      : null
              if (nextWidth === null) return
              event.preventDefault()
              setWorkspaceExplorerWidthValue(nextWidth, true)
            }}
          />
          <WorkspaceExplorer
            token={token}
            theme={themePreferences.theme}
            cwd={activeWorkspaceCwd}
            threadId={activeRemote.activeThread?.id}
            canBindThreadWorkspace={activeRemote.connection === 'connected' && !activeRemote.loadingHistory && !activeRemote.handedOff && Boolean(activeRemote.activeThread?.id)}
            onBindDirectory={async (cwd) => {
              const threadId = activeRemote.activeThread?.id
              if (!threadId) return false
              await activeRemote.bindThreadWorkspace(threadId, cwd)
              showPaneNotice('当前聊天已绑定；下一轮使用此目录')
              return true
            }}
            previewRequest={workspacePreviewRequest}
            previewContainerRef={paneGrid}
            onPreviewStateChange={handleWorkspacePreviewStateChange}
            draft={activeWorkspaceDraft}
            onInsertPath={insertWorkspacePath}
            onAddDocument={addWorkspaceDocument}
            mobileOpen={workspaceOpen}
            onCloseMobile={() => setWorkspaceOpen(false)}
          />
        </>
      )}
    </div>
  )
}

function ThemeSettingsPanel({ preferences, onChange, onClose }: { preferences: ThemePreferences; onChange: (next: ThemePreferences) => void; onClose: () => void }) {
  const [imageError, setImageError] = useState<string | null>(null)
  const [imageProcessing, setImageProcessing] = useState(false)
  const [notificationError, setNotificationError] = useState<string | null>(null)
  const [notificationRequestPending, setNotificationRequestPending] = useState(false)
  const fontSizeAdjustment = normalizeFontSizeAdjustment(preferences.fontSizeAdjustment)
  const themeOptions: Array<{ value: AppTheme; label: string; description: string; previewClass: string }> = [
    { value: 'light', label: '白色', description: '清爽明亮', previewClass: 'theme-option__preview--light' },
    { value: 'dark', label: '黑色', description: '低光阅读', previewClass: 'theme-option__preview--dark' },
    { value: 'warm', label: '暖色', description: '柔和纸感', previewClass: 'theme-option__preview--warm' },
    { value: 'custom', label: '自定义主题', description: '颜色、图片与透明度', previewClass: 'theme-option__preview--custom' },
  ]

  async function updateBackgroundImage(file: File | undefined) {
    setImageError(null)
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setImageError('请选择图片文件。')
      return
    }
    if (file.size > maxThemeImageUploadSize) {
      setImageError('背景原图不能超过 20 MB。')
      return
    }
    setImageProcessing(true)
    try {
      const customBackgroundImage = await optimizeThemeBackgroundImage(file)
      onChange({ ...preferences, customBackgroundImage })
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : '背景图片处理失败。')
    } finally {
      setImageProcessing(false)
    }
  }

  async function updateSystemNotifications(enabled: boolean) {
    setNotificationError(null)
    if (!enabled) {
      onChange({ ...preferences, systemNotificationsEnabled: false })
      return
    }
    if (!canRequestSystemNotifications()) {
      setNotificationError('系统通知需要安装 Android 应用，或通过 HTTPS 安全连接打开网页。')
      return
    }
    setNotificationRequestPending(true)
    try {
      const granted = await requestSystemNotificationPermission()
      if (granted) onChange({ ...preferences, systemNotificationsEnabled: true })
      else setNotificationError('没有获得通知权限。请在系统设置中允许 Codex Remote 发送通知后重试。')
    } catch {
      setNotificationError('请求通知权限失败，请重试。')
    } finally {
      setNotificationRequestPending(false)
    }
  }

  return (
    <main className="theme-settings-panel" aria-label="主题设置">
      <header className="theme-settings-panel__header">
        <div>
          <span className="theme-settings-panel__eyebrow">PREFERENCES</span>
          <h1>设置</h1>
          <p>界面和通知偏好保存在当前设备，不会影响 Codex 会话。</p>
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
                    opacity: (100 - preferences.customBackgroundTransparency) / 100,
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
                <span><strong>背景透明度</strong><small>数值越高，全局背景图片和底色越透明；界面面板不变。</small></span>
                <span className="theme-range-input"><input type="range" min="0" max="100" step="1" value={preferences.customBackgroundTransparency} onChange={(event) => onChange({ ...preferences, customBackgroundTransparency: normalizeTransparency(Number(event.target.value)) })} aria-label="自定义背景透明度" /><output>{preferences.customBackgroundTransparency}%</output></span>
              </label>
              <div className="theme-control-row theme-image-row">
                <span><strong>背景图片</strong><small>原图最大 20 MB，上传后自动压缩保存。</small></span>
                <span className="theme-image-input">
                  <span className={`theme-image-preview${preferences.customBackgroundImage ? '' : ' theme-image-preview--empty'}`}>
                    {preferences.customBackgroundImage ? <img src={preferences.customBackgroundImage} alt="当前背景图片预览" /> : <span>未设置</span>}
                  </span>
                  <span className="theme-image-actions">
                    <label className="theme-image-upload">
                      {imageProcessing ? <LoaderCircle className="spin" size={14} /> : <ImagePlus size={14} />}
                      <span>{imageProcessing ? '正在压缩…' : '选择图片'}</span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        disabled={imageProcessing}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0]
                          event.currentTarget.value = ''
                          void updateBackgroundImage(file)
                        }}
                        aria-label="上传背景图片"
                      />
                    </label>
                    {preferences.customBackgroundImage ? <button className="theme-image-clear" type="button" disabled={imageProcessing} onClick={() => { setImageError(null); onChange({ ...preferences, customBackgroundImage: undefined }) }}><X size={13} />清除</button> : null}
                  </span>
                </span>
              </div>
              {imageError ? <p className="theme-image-error" role="alert">{imageError}</p> : null}
            </div>
          ) : <p className="theme-settings-hint">切换主题后会立即应用到侧边栏、聊天区和输入框。</p>}
        </section>

        <section className="theme-settings-card">
          <div className="theme-settings-card__heading"><div><h2>显示</h2><p>调整当前浏览器中的界面阅读大小。</p></div><span className="theme-settings-card__badge">即时预览</span></div>
          <div className="theme-display-controls">
            <label className="theme-control-row theme-control-row--stacked">
              <span><strong>字体大小</strong><small>同时调整聊天、输入框、侧栏、文件区和设置页。</small></span>
              <span className="theme-range-input"><input type="range" min="-3" max="6" step="1" value={fontSizeAdjustment} onChange={(event) => onChange({ ...preferences, fontSizeAdjustment: normalizeFontSizeAdjustment(Number(event.target.value)) })} aria-label="全局字体大小" /><output>{fontSizeAdjustment === 0 ? '标准' : `${fontSizeAdjustment > 0 ? '+' : ''}${fontSizeAdjustment} px`}</output></span>
            </label>
          </div>
        </section>

        <section className="theme-settings-card">
          <div className="theme-settings-card__heading"><div><h2>系统通知</h2><p>应用在后台且连接在线时，提醒回复完成和待批准操作。</p></div></div>
          <div className="theme-display-controls">
            <div className="theme-control-row">
              <span><strong>回复与审批提醒</strong><small>通知不包含聊天正文或命令内容。</small></span>
              <button
                className={`theme-notification-toggle${preferences.systemNotificationsEnabled ? ' theme-notification-toggle--enabled' : ''}`}
                type="button"
                aria-pressed={preferences.systemNotificationsEnabled}
                disabled={notificationRequestPending}
                onClick={() => { void updateSystemNotifications(!preferences.systemNotificationsEnabled) }}
              >
                {notificationRequestPending ? <LoaderCircle className="spin" size={14} /> : preferences.systemNotificationsEnabled ? <Bell size={14} /> : <BellOff size={14} />}
                {notificationRequestPending ? '正在请求权限…' : preferences.systemNotificationsEnabled ? '已开启' : '开启通知'}
              </button>
            </div>
            {notificationError ? <p className="theme-notification-error" role="alert">{notificationError}</p> : null}
          </div>
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
    if (!(await copyTextToClipboard(value))) return
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

interface NumberedDiffLine {
  line: string
  kind: 'added' | 'deleted' | 'hunk' | 'context'
  oldLine: number | null
  newLine: number | null
}

function numberDiffLines(diff: string): NumberedDiffLine[] {
  let oldLine: number | null = null
  let newLine: number | null = null
  let oldRemaining = 0
  let newRemaining = 0

  return diff.split(/\r?\n/).map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLine = Number(hunk[3])
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4])
      return { line, kind: 'hunk', oldLine: null, newLine: null }
    }

    if (line.startsWith('\\')) return { line, kind: 'context', oldLine: null, newLine: null }
    if (oldRemaining > 0 || newRemaining > 0) {
      if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
        const numbered = { line, kind: 'context' as const, oldLine, newLine }
        oldLine = (oldLine ?? 0) + 1
        newLine = (newLine ?? 0) + 1
        oldRemaining -= 1
        newRemaining -= 1
        return numbered
      }
      if (line.startsWith('-') && oldRemaining > 0) {
        const numbered = { line, kind: 'deleted' as const, oldLine, newLine: null }
        oldLine = (oldLine ?? 0) + 1
        oldRemaining -= 1
        return numbered
      }
      if (line.startsWith('+') && newRemaining > 0) {
        const numbered = { line, kind: 'added' as const, oldLine: null, newLine }
        newLine = (newLine ?? 0) + 1
        newRemaining -= 1
        return numbered
      }
    }
    return { line, kind: 'context', oldLine: null, newLine: null }
  })
}

interface FileChangeSummary {
  files: CodexFileChange['changes'][number][]
  additions: number
  deletions: number
}

function summarizeFileChanges(changes: CodexFileChange[]): FileChangeSummary {
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
  return {
    files,
    additions: files.reduce((total, item) => total + item.additions, 0),
    deletions: files.reduce((total, item) => total + item.deletions, 0),
  }
}

const FileChangeCard = memo(function FileChangeCard({ changes, onInsertPath, onOpenFile }: { changes: CodexFileChange[]; onInsertPath: (path: string) => void; onOpenFile: (path: string, diff?: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const { files, additions, deletions } = summarizeFileChanges(changes)
  const hasLineStats = additions > 0 || deletions > 0
  const inProgress = changes.some((change) => change.status === 'inProgress')
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
    <article className={`file-change-card${showAll ? ' file-change-card--expanded' : ''}${reviewing ? ' file-change-card--reviewing' : ''}${inProgress ? ' file-change-card--inProgress' : ''}`}>
      <header className="file-change-card__heading">
        <span className="file-change-card__icon"><FileText size={15} /></span>
        <div className="file-change-card__summary">
          <strong>{inProgress ? `正在编辑 ${files.length} 个文件` : `本次已编辑 ${files.length} 个文件`}</strong>
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
              <button className="file-change-card__path-mobile" type="button" onClick={() => onOpenFile(item.path, item.diff)} title={`预览 ${item.path}`} aria-label={`预览文件 ${item.path}`}>{item.path}</button>
              <button className="file-change-card__path-desktop" type="button" onClick={() => onOpenFile(item.path, item.diff)} title={`预览 ${item.path}`} aria-label={`预览文件 ${item.path}`}>{item.path}</button>
              {item.additions > 0 || item.deletions > 0 ? <span className="file-change-card__file-stats"><i>+{item.additions}</i><em>-{item.deletions}</em></span> : null}
              <button className="file-change-card__insert" type="button" onClick={() => onInsertPath(item.path)} aria-label={`插入 ${item.path} 到对话`} title="插入对话"><MessagesSquare size={13} /><span>插入对话</span></button>
            </div>
            {reviewing ? (
              item.diff
                ? <pre>{numberDiffLines(item.diff).map((diffLine, index) => {
                  const lineClass = diffLine.kind === 'added'
                    ? 'file-change-card__diff-line file-change-card__diff-line--added'
                    : diffLine.kind === 'deleted'
                      ? 'file-change-card__diff-line file-change-card__diff-line--deleted'
                      : diffLine.kind === 'hunk'
                        ? 'file-change-card__diff-line file-change-card__diff-line--hunk'
                        : 'file-change-card__diff-line'
                  return (
                    <span className={lineClass} key={index}>
                      <span className="file-change-card__line-number">{diffLine.oldLine ?? ''}</span>
                      <span className="file-change-card__line-number">{diffLine.newLine ?? ''}</span>
                      <span className="file-change-card__diff-code">{diffLine.line || ' '}</span>
                    </span>
                  )
                })}</pre>
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

const OperationLog = memo(function OperationLog({
  operations,
  fileChanges = [],
  onOpenFile,
  onOpenImage,
  title = '操作记录',
}: {
  operations: CodexOperation[]
  fileChanges?: CodexFileChange[]
  onOpenFile: (path: string, diff?: string) => void
  onOpenImage: (path: string) => void
  title?: string
}) {
  const [expanded, setExpanded] = useState(false)
  if (operations.length === 0) return null
  const runningCount = operations.filter((operation) => operation.status === 'running').length
  const failedCount = operations.filter((operation) => operation.status === 'failed').length
  const stoppedCount = operations.filter((operation) => operation.status === 'stopped').length
  const completedCount = operations.filter((operation) => operation.status === 'completed').length
  const statusText = runningCount > 0
    ? `${runningCount} 项进行中`
    : failedCount > 0 ? `${failedCount} 项失败`
      : stoppedCount > 0 ? `${completedCount} 项完成 · ${stoppedCount} 项停止`
        : `${completedCount} 项完成`

  return (
    <details className="operation-log" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary><ChevronDown size={13} /><span>{title}</span><small>{statusText}</small></summary>
      <ul>
        {operations.map((operation) => {
          const fileChange = fileChanges.find((change) => change.id === operation.id)
          const linkedPaths = new Set([
            ...(fileChange?.changes.map((change) => change.path) ?? []),
            ...(operation.steps?.flatMap((step) => step.path ? [step.path] : []) ?? []),
          ])
          const additionalPaths = operation.paths?.filter((path) => !linkedPaths.has(path)) ?? []
          return (
          <li className={`operation-log__item operation-log__item--${operation.status}`} key={operation.id}>
            <span className="operation-log__status" aria-label={operation.status === 'running' ? '进行中' : operation.status === 'failed' ? '失败' : operation.status === 'stopped' ? '已停止' : '已完成'}>
              {operation.status === 'running' ? <LoaderCircle className="spin" size={12} /> : operation.status === 'completed' ? <Check size={12} /> : operation.status === 'failed' ? <AlertTriangle size={12} /> : <Square size={10} />}
            </span>
            <span className="operation-log__content">
              <strong>{operation.label}</strong>
              {operation.detail ? <code title={operation.detail}>{operation.detail}</code> : null}
              {operation.imagePath ? (
                <span className="operation-log__actions">
                  <button type="button" onClick={() => onOpenImage(operation.imagePath!)} title={operation.imagePath}><Eye size={12} />打开图片</button>
                </span>
              ) : null}
              {fileChange?.changes.map((change) => (
                <span className="operation-log__actions" key={`${operation.id}:${change.path}`}>
                  <button type="button" onClick={() => onOpenFile(change.path, change.diff)} title={change.path}><FileText size={12} />查看更改 · {change.path.split(/[\\/]/).at(-1) || change.path}</button>
                </span>
              ))}
              {additionalPaths.map((path) => (
                <span className="operation-log__actions" key={`${operation.id}:path:${path}`}>
                  <button type="button" onClick={() => onOpenFile(path)} title={path}><FileText size={12} />打开文件 · {path.split(/[\\/]/).at(-1) || path}</button>
                </span>
              ))}
              {operation.steps?.length ? (
                <span className="operation-log__steps">
                  {operation.steps.map((step, index) => (
                    <span className="operation-log__step" key={`${operation.id}-step-${index}`}>
                      <i aria-hidden="true">└</i>
                      {step.path
                        ? <button className="operation-log__step-action" type="button" onClick={() => onOpenFile(step.path!)} title={step.path}><Eye size={11} />{step.label} · {step.detail ?? step.path}</button>
                        : <><strong>{step.label}</strong>{step.detail ? <code title={step.detail}>{step.detail}</code> : null}</>}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
            <small>{operation.status === 'running' ? '进行中' : operation.status === 'failed' ? '失败' : operation.status === 'stopped' ? '已停止' : '完成'}</small>
          </li>
          )
        })}
      </ul>
    </details>
  )
})

const ActivityTimelineContent = memo(function ActivityTimelineContent({ text, timeline, operations, fileChanges = [], onOpenFile, onOpenImage, showCodeCopy = true }: {
  text: string
  timeline: CodexActivityTimelineEntry[]
  operations: CodexOperation[]
  fileChanges?: CodexFileChange[]
  onOpenFile: (path: string, diff?: string) => void
  onOpenImage: (path: string) => void
  showCodeCopy?: boolean
}) {
  const operationById = new Map(operations.map((operation) => [operation.id, operation]))
  const blocks: Array<{ type: 'message'; key: string; text: string } | { type: 'operations'; key: string; operations: CodexOperation[] }> = []
  let textOffset = 0
  let messageCount = 0
  let hasTextEntry = false

  for (const entry of timeline) {
    if (entry.type === 'message') {
      if (entry.length <= 0) continue
      hasTextEntry = true
      if (messageCount > 0 && text.slice(textOffset, textOffset + 2) === '\n\n') textOffset += 2
      const segment = text.slice(textOffset, textOffset + entry.length)
      textOffset += segment.length
      messageCount += 1
      if (!segment) continue
      blocks.push({ type: 'message', key: `message-${entry.itemId}`, text: segment })
      continue
    }

    const operation = operationById.get(entry.operationId)
    if (!operation) continue
    const lastBlock = blocks.at(-1)
    if (lastBlock?.type === 'operations') lastBlock.operations.push(operation)
    else blocks.push({ type: 'operations', key: `operation-${operation.id}`, operations: [operation] })
  }

  if (text && !hasTextEntry) blocks.unshift({ type: 'message', key: 'message-fallback', text })
  else if (textOffset < text.length) blocks.push({ type: 'message', key: 'message-trailing', text: text.slice(textOffset) })

  if (blocks.length === 0) return null

  return (
    <div className="activity-timeline">
      {blocks.map((block) => block.type === 'message'
        ? <MessageContent key={block.key} text={block.text} hideStandaloneSeparators showCodeCopy={showCodeCopy} />
        : <OperationLog
          key={block.key}
          operations={block.operations}
          fileChanges={fileChanges}
          onOpenFile={onOpenFile}
          onOpenImage={onOpenImage}
          title={block.operations.length === 1 ? block.operations[0].label : `${block.operations.length} 个连续操作`}
        />)}
    </div>
  )
})

function operationActivityDetail(operation: CodexOperation, activity: CodexActivity | null) {
  if (operation.kind === 'file' && operation.label === '查看文件' && operation.detail) {
    const paths = operation.detail.match(/(?:[A-Za-z]:)?(?:\.{1,2}[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)*\.[A-Za-z0-9_-]+/g)
    const path = paths?.at(-1)
    if (path) return path.split(/[\\/]/).at(-1)
  }
  return operation.kind === 'command' ? operation.detail : activity?.detail ?? operation.detail
}

const OperationActivityLine = memo(function OperationActivityLine({ className, operation, activity, iconSize }: {
  className: string
  operation: CodexOperation | null
  activity: CodexActivity | null
  iconSize: number
}) {
  const isReadingFile = operation?.kind === 'file' && operation.label === '查看文件'
  const label = isReadingFile
    ? '正在读取'
    : operation?.kind === 'command'
      ? '正在运行'
      : operation?.kind === 'search'
        ? '正在搜索文件'
        : activity?.label ?? '正在思考'
  const detail = operation ? operationActivityDetail(operation, activity) : activity?.detail
  const text = [label, detail].filter(Boolean).join(' ')

  return (
    <span className={`operation-activity ${className}`} aria-live="polite">
      {isReadingFile ? <BookOpen size={iconSize} /> : <LoaderCircle className="spin" size={iconSize} />}
      <span className="operation-activity__text" title={text}>{text}</span>
    </span>
  )
})

const TurnElapsed = memo(function TurnElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])

  return <time className="running-indicator__elapsed" aria-live="off">已用 {formatTurnDuration(now - startedAt)}</time>
})

const MessageBubble = memo(function MessageBubble({ message, operations, fileChanges, activityTimeline, showOperations, copied, onCopy, onOpenFile, onOpenImage }: {
  message: CodexMessage
  operations: CodexOperation[]
  fileChanges: CodexFileChange[]
  activityTimeline: CodexActivityTimelineEntry[]
  showOperations: boolean
  copied: boolean
  onCopy: (message: CodexMessage) => void | Promise<void>
  onOpenFile: (path: string, diff?: string) => void
  onOpenImage: (path: string) => void
}) {
  // A streaming answer is incomplete, so none of its copy controls should be
  // available until Codex has finished the turn.
  const showCopyAction = !message.streaming && Boolean(message.text || message.documents?.length)
  const copyAction = showCopyAction ? <div className="chat-message__actions"><button type="button" onClick={() => void onCopy(message)}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button></div> : null
  const sentAtLabel = formatMessageTimestamp(message.role === 'user' ? message.sentAt : undefined)
  const replyStartedAtLabel = formatMessageTimestamp(message.role === 'assistant' ? message.replyStartedAt : undefined)

  return (
    <article className={`chat-message chat-message--${message.role}`} data-message-id={message.id}>
      <span className="chat-message__avatar">{message.role === 'user' ? '你' : 'C'}</span>
      <div className="chat-message__body">
        <div className="chat-message__meta">
          {message.role === 'assistant' ? <strong>Codex</strong> : null}
          {replyStartedAtLabel ? <time className="chat-message__timing" aria-live="off" dateTime={message.replyStartedAt} title={message.replyStartedAt ? new Date(message.replyStartedAt).toLocaleString('zh-CN') : undefined}>开始 {replyStartedAtLabel}</time> : null}
          {!message.streaming && message.replyDurationMs !== undefined ? <time className="chat-message__timing" aria-live="off">用时 {formatTurnDuration(message.replyDurationMs)}</time> : null}
        </div>
        {message.images?.length ? <div className="chat-message__images">{message.images.map((image, index) => <img key={`${image.name}-${index}`} src={image.previewUrl} alt={image.name} />)}</div> : null}
        {message.documents?.map((document, index) => <div className="message-document" key={`${document.name}-${document.sourceFileId ?? index}`}><FileText size={15} /><span><strong>{document.name}</strong><small>{document.sourceFileId ? '原始文件 · Codex 读取原件' : `${document.charCount.toLocaleString()} 个字符`}</small></span></div>)}
        {message.role === 'assistant' && activityTimeline.length > 0
          ? <ActivityTimelineContent text={message.text} timeline={activityTimeline} operations={operations} fileChanges={fileChanges} onOpenFile={onOpenFile} onOpenImage={onOpenImage} showCodeCopy={!message.streaming} />
          : message.text ? <MessageContent text={message.text} hideStandaloneSeparators={message.role === 'assistant'} showCodeCopy={!message.streaming} /> : null}
        {message.role === 'assistant' ? copyAction : null}
        {showOperations && operations.length > 0 && activityTimeline.length === 0 ? <OperationLog operations={operations} fileChanges={fileChanges} onOpenFile={onOpenFile} onOpenImage={onOpenImage} /> : null}
      </div>
      {message.role === 'user' && (sentAtLabel || copyAction) ? (
        <div className="chat-message__footer">
          {sentAtLabel ? <time className="chat-message__sent-at" dateTime={message.sentAt} title={message.sentAt ? new Date(message.sentAt).toLocaleString('zh-CN') : undefined}>发送 {sentAtLabel}</time> : null}
          {copyAction}
        </div>
      ) : null}
    </article>
  )
})

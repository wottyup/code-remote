import { Fragment, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject, type ReactNode, type TouchEvent as ReactTouchEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  ArrowUp,
  BookOpen,
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
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react'
import { useCodexRemote, type CodexActivity, type CodexFileChange, type CodexOperation, type CodexRemoteController, type QueuedTurnMessage } from '../hooks/useCodexRemote'
import { codexRemoteClient, type CodexApprovalPolicy, type CodexDocumentAttachment, type CodexImageAttachment, type CodexMessage, type CodexModel, type CodexThread, type CodexWorkspaceEntry, type CodexWorkspaceFile, type CodexWorkspaceTree } from '../lib/codexRemoteClient'

interface Props {
  token: string
  onUnauthorized: () => void
  onUnpair: () => void | Promise<void>
  themePreferences: ThemePreferences
  onThemePreferencesChange: (next: ThemePreferences) => void
}

declare global {
  interface Window {
    CodexRemoteAndroid?: {
      changeEndpoint?: () => void
      copyToClipboard?: (text: string) => boolean
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
const messageTimestampFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
const imageTypes = new Set<CodexImageAttachment['mediaType']>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const maxImageSize = 8 * 1024 * 1024
const maxThemeImageUploadSize = 20 * 1024 * 1024
const maxThemeImageDataUrlLength = 1_450_000
const maxThemeImageEdge = 1_920
const maxImagesPerTurn = 4
const maxDocumentsPerTurn = 8
const longPasteThreshold = 4_000
const maxLongPasteChars = 24_000

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
const workspaceFilePreviewWidthStorageKey = 'codex-remote.workspace-file-preview-width'
const workspaceFilePreviewWidthRatioStorageKey = 'codex-remote.workspace-file-preview-width-ratio'
const settingsHistoryStateKey = '__codexRemoteSettingsOpen'
const workspaceExplorerDefaultWidth = 340
const workspaceExplorerMinWidth = 220
const workspaceExplorerMaxWidth = 2_400
const workspaceFilePreviewDefaultWidth = 360
const workspaceFilePreviewMinWidth = 160
const workspaceFilePreviewMaxWidth = 1_600
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
const newThreadComposerDraftScope = 'new'

function isSettingsHistoryEntry(state: unknown): boolean {
  return Boolean(state && typeof state === 'object' && (state as Record<string, unknown>)[settingsHistoryStateKey] === true)
}

interface ComposerPreferences {
  model?: string
  effort?: string
  approvalPolicy?: CodexApprovalPolicy
}

type ThreadComposerPreferences = Record<string, ComposerPreferences>

type AppTheme = 'light' | 'dark' | 'warm' | 'custom'

export interface ThemePreferences {
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

function workspacePanelsWidthLimit(previewOpen = false) {
  if (typeof window !== 'undefined' && window.matchMedia(mobileLayoutMediaQuery).matches) {
    return workspaceExplorerMaxWidth
  }
  const viewportWidth = typeof window === 'undefined' ? 1_400 : window.innerWidth
  const sidebarWidth = Math.round(Math.max(180, Math.min(284, viewportWidth * 0.22)))
  const separatorWidth = previewOpen ? 16 : 8
  const availableWorkspaceWidth = viewportWidth - sidebarWidth - separatorWidth
  const chatMinimumLimit = availableWorkspaceWidth - workspaceChatMinWidth
  return Math.max(0, Math.min(workspaceExplorerMaxWidth, chatMinimumLimit))
}

function workspaceExplorerMinimumWidth() {
  const viewportWidth = typeof window === 'undefined' ? 1_400 : window.innerWidth
  return viewportWidth <= 900 ? 160 : workspaceExplorerMinWidth
}

function workspaceExplorerWidthLimit(previewOpen = false, previewWidth = 0) {
  return Math.max(workspaceExplorerMinimumWidth(), Math.min(workspaceExplorerMaxWidth, workspacePanelsWidthLimit(previewOpen) - previewWidth))
}

function clampWorkspaceExplorerWidth(value: number, previewOpen = false, previewWidth = 0) {
  return Math.round(Math.max(workspaceExplorerMinimumWidth(), Math.min(workspaceExplorerWidthLimit(previewOpen, previewWidth), value)))
}

function workspaceFilePreviewWidthLimit(explorerWidth = workspaceExplorerMinimumWidth()) {
  return Math.max(0, Math.min(workspaceFilePreviewMaxWidth, workspacePanelsWidthLimit(true) - explorerWidth))
}

function workspaceFilePreviewMinimumWidth() {
  return Math.min(workspaceFilePreviewMinWidth, Math.max(0, workspacePanelsWidthLimit(true) - workspaceExplorerMinimumWidth()))
}

function fitWorkspacePreviewWidths(explorerWidth: number, previewWidth: number) {
  const totalLimit = workspacePanelsWidthLimit(true)
  const minimumExplorerWidth = workspaceExplorerMinimumWidth()
  const minimumPreviewWidth = workspaceFilePreviewMinimumWidth()
  const maximumExplorerWidth = Math.max(minimumExplorerWidth, Math.min(workspaceExplorerMaxWidth, totalLimit - minimumPreviewWidth))
  const nextExplorerWidth = Math.round(Math.max(minimumExplorerWidth, Math.min(maximumExplorerWidth, explorerWidth)))
  const maximumPreviewWidth = workspaceFilePreviewWidthLimit(nextExplorerWidth)
  const nextMinimumPreviewWidth = Math.min(workspaceFilePreviewMinWidth, maximumPreviewWidth)
  const nextPreviewWidth = Math.round(Math.max(nextMinimumPreviewWidth, Math.min(maximumPreviewWidth, previewWidth)))
  return { explorerWidth: nextExplorerWidth, previewWidth: nextPreviewWidth }
}

function workspaceFileSplitExplorerWidthRange(explorerWidth: number, previewWidth: number) {
  const combinedWidth = explorerWidth + previewWidth
  const minimumExplorerWidth = Math.max(workspaceExplorerMinimumWidth(), combinedWidth - workspaceFilePreviewMaxWidth)
  const maximumExplorerWidth = Math.min(
    workspaceExplorerWidthLimit(true, workspaceFilePreviewMinimumWidth()),
    combinedWidth - workspaceFilePreviewMinimumWidth(),
  )
  return { minimum: minimumExplorerWidth, maximum: Math.max(minimumExplorerWidth, maximumExplorerWidth) }
}

function readWorkspaceFilePreviewWidth() {
  if (typeof window === 'undefined') return workspaceFilePreviewDefaultWidth
  try {
    const stored = Number(window.localStorage.getItem(workspaceFilePreviewWidthStorageKey))
    return Math.round(Math.max(workspaceFilePreviewMinWidth, Math.min(workspaceFilePreviewMaxWidth, Number.isFinite(stored) && stored > 0 ? stored : workspaceFilePreviewDefaultWidth)))
  } catch {
    return workspaceFilePreviewDefaultWidth
  }
}

function workspaceFilePreviewWidthRatio(width: number) {
  const currentViewportWidth = typeof window === 'undefined' ? 1_400 : window.innerWidth
  const viewportWidth = currentViewportWidth <= 700 ? 1_400 : currentViewportWidth
  return Math.min(1, width / Math.max(1, viewportWidth))
}

function readWorkspaceFilePreviewWidthRatio() {
  if (typeof window === 'undefined') return workspaceFilePreviewWidthRatio(workspaceFilePreviewDefaultWidth)
  try {
    const storedRatio = Number(window.localStorage.getItem(workspaceFilePreviewWidthRatioStorageKey))
    if (Number.isFinite(storedRatio) && storedRatio > 0 && storedRatio <= 1) return storedRatio
    const legacyWidth = Math.min(readWorkspaceFilePreviewWidth(), workspaceFilePreviewWidthLimit())
    return workspaceFilePreviewWidthRatio(legacyWidth)
  } catch {
    return workspaceFilePreviewWidthRatio(workspaceFilePreviewDefaultWidth)
  }
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

function normalizeHexColor(value: unknown, fallback: string) {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toUpperCase() : fallback
}

function normalizeTransparency(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0
}

function normalizeThemeBackgroundImage(value: unknown) {
  if (typeof value !== 'string') return undefined
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : undefined
}

function isCompactThemeBackgroundImage(value: string) {
  return value.length <= maxThemeImageDataUrlLength && Boolean(normalizeThemeBackgroundImage(value))
}

export function readThemePreferences(): ThemePreferences {
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

export function saveThemePreferences(preferences: ThemePreferences) {
  try {
    window.localStorage.setItem(themePreferencesStorageKey, JSON.stringify(preferences))
  } catch {
    // Theme preferences still apply for the current session when storage is unavailable.
  }
}

export function themeRootStyle(preferences: ThemePreferences): CSSProperties {
  const customBackgroundOpacity = (100 - preferences.customBackgroundTransparency) / 100
  return {
    '--custom-theme-background': preferences.customBackgroundColor,
    '--custom-theme-background-opacity': customBackgroundOpacity,
    '--custom-theme-background-image': preferences.customBackgroundImage
      ? 'linear-gradient(rgba(0, 0, 0, .2), rgba(0, 0, 0, .2)), url("' + preferences.customBackgroundImage + '")'
      : 'none',
    '--custom-theme-text-color': preferences.customTextColor,
    '--custom-theme-surface': rgbaFromHex(preferences.customBackgroundColor, 0.38),
    '--custom-theme-control': rgbaFromHex('#ffffff', 0.72),
    '--custom-theme-active': rgbaFromHex(preferences.customBackgroundColor, 0.24),
    '--custom-theme-border': rgbaFromHex(preferences.customTextColor, 0.32),
    '--custom-theme-panel-blur': '8px',
  } as CSSProperties
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

async function copyText(value: string) {
  const androidBridge = window.CodexRemoteAndroid
  if (typeof androidBridge?.copyToClipboard === 'function') {
    try {
      if (androidBridge.copyToClipboard(value)) return true
    } catch {
      // Keep the browser clipboard path available if the native bridge fails.
    }
  }
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
  appendDraft(value: string, focus?: boolean): void
  adoptUnassignedDraft(threadId: string): void
  closeOpenMenu(): boolean
}

interface MessageComposerProps {
  draftScope: string
  onDraftChange: (draft: string) => void
  connection: RemoteConnection
  isRunning: boolean
  fileChangeSummary: FileChangeSummary | null
  fileChangeSummaryKey: string | null
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
  onBeginQueuedEdit: (messageId: string) => boolean
  onUpdateQueuedMessage: (messageId: string, input: Pick<ComposerSendInput, 'prompt' | 'images' | 'documents'>) => boolean
  onEndQueuedEdit: (messageId: string) => void
  onRemoveQueued: (messageId: string) => void
  onInterrupt: () => void
  onRefresh: () => void
}

const MessageComposer = memo(forwardRef<ComposerHandle, MessageComposerProps>(function MessageComposer({
  draftScope,
  onDraftChange,
  connection,
  isRunning,
  fileChangeSummary,
  fileChangeSummaryKey,
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
  onBeginQueuedEdit,
  onUpdateQueuedMessage,
  onEndQueuedEdit,
  onRemoveQueued,
  onInterrupt,
  onRefresh,
}, ref) {
  const [draft, setDraft] = useState(() => readComposerDraft(draftScope))
  const [sending, setSending] = useState(false)
  const [attachedImages, setAttachedImages] = useState<CodexImageAttachment[]>([])
  const [attachedDocuments, setAttachedDocuments] = useState<CodexDocumentAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [compactLandscape, setCompactLandscape] = useState(() => typeof window !== 'undefined' && window.matchMedia(compactLandscapeMediaQuery).matches)
  const [mobileLayout, setMobileLayout] = useState(() => typeof window !== 'undefined' && (
    window.matchMedia(mobileLayoutMediaQuery).matches || Boolean(window.CodexRemoteAndroid?.changeEndpoint)
  ))
  const [expandedFileChangesKey, setExpandedFileChangesKey] = useState<string | null>(null)
  const [composerHeight, setComposerHeight] = useState(() => {
    if (typeof window === 'undefined') return defaultComposerHeight
    return window.matchMedia(compactLandscapeMediaQuery).matches ? compactLandscapeComposerHeight : defaultComposerHeight
  })
  const [queuedMessagesExpanded, setQueuedMessagesExpanded] = useState(false)
  const [sendingQueuedId, setSendingQueuedId] = useState<string | null>(null)
  const [editingQueuedMessageId, setEditingQueuedMessageId] = useState<string | null>(null)
  const [openMenu, setOpenMenu] = useState<'model' | 'effort' | 'approval' | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const draftRef = useRef(draft)
  const editingQueuedMessageIdRef = useRef<string | null>(null)
  const openMenuRef = useRef<'model' | 'effort' | 'approval' | null>(null)
  const draftSaveTimer = useRef<number | undefined>(undefined)
  const focusRestoreAttempted = useRef(false)
  const resizeState = useRef<{ startY: number; startHeight: number } | null>(null)
  const composerHeightWasResized = useRef(false)
  const inputIsComposing = useRef(false)
  const editingDraftSnapshot = useRef<{
    draft: string
    images: CodexImageAttachment[]
    documents: CodexDocumentAttachment[]
    attachmentError: string | null
  } | null>(null)

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
    && (editingQueuedMessageId ? !sending : canCompose)
  const canAttachImages = (editingQueuedMessageId ? !sending : canCompose) && modelSupportsImages
  const stopWithSendButton = mobileLayout && isRunning && !writerConflict && !editingQueuedMessageId
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
    if (editingQueuedMessageId) {
      confirmQueuedEdit()
      return
    }
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

  function restoreDraftAfterQueuedEdit() {
    const snapshot = editingDraftSnapshot.current
    editingDraftSnapshot.current = null
    if (!snapshot) return
    updateDraft(snapshot.draft)
    setAttachedImages(snapshot.images)
    setAttachedDocuments(snapshot.documents)
    setAttachmentError(snapshot.attachmentError)
  }

  function beginQueuedEdit(message: QueuedTurnMessage) {
    if (editingQueuedMessageId || sending || sendingQueuedId) return
    if (!onBeginQueuedEdit(message.id)) {
      setAttachmentError('这条排队消息正在处理中，请稍后再试。')
      return
    }
    editingDraftSnapshot.current = {
      draft: draftRef.current,
      images: attachedImages,
      documents: attachedDocuments,
      attachmentError,
    }
    editingQueuedMessageIdRef.current = message.id
    setEditingQueuedMessageId(message.id)
    updateDraft(message.text)
    setAttachedImages(message.images)
    setAttachedDocuments(message.documents ?? [])
    setAttachmentError(null)
    window.requestAnimationFrame(() => composer.current?.focus())
  }

  function finishQueuedEdit() {
    const messageId = editingQueuedMessageIdRef.current
    if (messageId) onEndQueuedEdit(messageId)
    editingQueuedMessageIdRef.current = null
    setEditingQueuedMessageId(null)
    restoreDraftAfterQueuedEdit()
  }

  function confirmQueuedEdit() {
    const messageId = editingQueuedMessageIdRef.current
    if (!messageId || sending) return
    const prompt = draftRef.current.trim()
    if (!prompt && attachedImages.length === 0 && attachedDocuments.length === 0) {
      setAttachmentError('消息内容和附件不能同时为空。')
      return
    }
    if (!onUpdateQueuedMessage(messageId, {
      prompt,
      images: attachedImages,
      documents: attachedDocuments,
    })) {
      setAttachmentError('排队消息更新失败，请取消后重试。')
      return
    }
    finishQueuedEdit()
  }

  function cancelQueuedEdit() {
    if (!editingQueuedMessageIdRef.current) return
    finishQueuedEdit()
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
    composerHeightWasResized.current = true
    resizeState.current = { startY: event.clientY, startHeight: composerHeight }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  function appendDocument(document: CodexDocumentAttachment) {
    setAttachedDocuments((current) => {
      if (current.some((item) => item.name === document.name && item.content === document.content)) return current
      return [...current, document].slice(0, maxDocumentsPerTurn)
    })
    setAttachmentError(null)
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
      <form
        className={`message-composer${isRunning ? ' message-composer--running' : ''}`}
        onSubmit={(event) => void send(event)}
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
            {queuedMessagesExpanded ? <small>{editingQueuedMessageId ? '编辑期间暂停 · 结束后继续队列' : sendingQueuedId ? '正在插入当前回复' : isRunning ? '当前回复结束后会依次发送' : '点击立即发送可重试'}</small> : null}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          <div id="composer-queue-list" className="composer-queue__list" hidden={!queuedMessagesExpanded}>
            {queuedMessages.map((message, index) => {
              const sendingNow = sendingQueuedId === message.id
              const isEditing = editingQueuedMessageId === message.id
              const queueLocked = Boolean(editingQueuedMessageId) || Boolean(sendingQueuedId)
              const summary = message.text || (message.documents?.length
                ? `附件文档：${message.documents.length} 个文件`
                : `${message.images.length} 张图片`)
              return (
                <div className={`composer-queue__item${isEditing ? ' composer-queue__item--editing' : ''}`} key={message.id}>
                  <span className="composer-queue__index">{index + 1}</span>
                  <span className="composer-queue__copy"><strong>{summary}</strong><small>{isEditing ? '正在输入框中编辑' : sendingNow ? '已插入对话 · 正在确认送达' : isRunning ? (index === 0 ? '下一条待发送' : '等待前面的消息完成') : '等待手动发送'}</small></span>
                  <button className="composer-queue__edit" type="button" disabled={queueLocked} onClick={() => beginQueuedEdit(message)} title={isEditing ? '正在编辑此消息' : '在输入框中编辑排队消息'}>
                    <Pencil size={11} /><span>{isEditing ? '编辑中' : '编辑'}</span>
                  </button>
                  <button className="composer-queue__send" type="button" disabled={queueLocked || sendingNow} onClick={() => void sendQueuedNow(message.id)} title="立即发送给当前 Codex 回复">
                    {sendingNow ? <LoaderCircle className="spin" size={12} /> : <Send size={12} />}<span>立即发送</span>
                  </button>
                  <button className="composer-queue__remove" type="button" disabled={queueLocked || sendingNow} onClick={() => onRemoveQueued(message.id)} aria-label="移除排队消息" title="移除排队消息"><X size={13} /></button>
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
          placeholder={editingQueuedMessageId ? '编辑排队消息…' : '给 Codex 发送消息…'}
          aria-label={editingQueuedMessageId ? '编辑排队消息' : '发送消息给 Codex'}
          inputMode="text"
          enterKeyHint="send"
        />
      </div>
      <div className="message-composer__footer">
        <div className="composer-preferences">
          <ComposerMenu label="模型" value={selectedModel} options={modelOptions} emptyLabel="读取模型…" disabled={!canConfigure || modelOptions.length === 0} open={openMenu === 'model'} onOpenChange={(open) => changeOpenMenu(open ? 'model' : null)} onChange={onModelChange} />
          <ComposerMenu label="思考" value={selectedEffort} options={reasoningOptions} emptyLabel="默认" disabled={!canConfigure || reasoningOptions.length === 0} open={openMenu === 'effort'} onOpenChange={(open) => changeOpenMenu(open ? 'effort' : null)} onChange={onEffortChange} />
          <ComposerMenu label="授权" value={selectedApprovalPolicy} options={authorizationOptions} emptyLabel="请求批准" disabled={!canConfigure} open={openMenu === 'approval'} onOpenChange={(open) => changeOpenMenu(open ? 'approval' : null)} onChange={(approvalPolicy) => onApprovalPolicyChange(approvalPolicy as CodexApprovalPolicy)} />
          <span className="composer-hint"><ShieldCheck size={14} />{editingQueuedMessageId ? 'Enter 确定 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行'}</span>
        </div>
        <div className="composer-actions">
          <span className={`attach-button attach-button--native${canAttachImages ? '' : ' attach-button--disabled'}`} title={modelSupportsImages ? '附加图片' : '当前模型不支持图片输入'}>
            <ImagePlus size={16} />
            <input className="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={!canAttachImages} onChange={(event) => { void attachImages(Array.from(event.target.files ?? [])); event.currentTarget.value = '' }} aria-label="附加图片" />
          </span>
          {writerConflict
            ? <button className="stop-button" type="button" onClick={onRefresh}><RefreshCw size={13} />刷新状态</button>
            : isRunning && !stopWithSendButton ? <button className="stop-button" type="button" onClick={onInterrupt} disabled={isInterrupting}>{isInterrupting ? <LoaderCircle className="spin" size={13} /> : <Square size={13} fill="currentColor" />}{isInterrupting ? '停止中' : '停止'}</button> : null}
          {editingQueuedMessageId ? <button className="composer-edit-cancel" type="button" onClick={cancelQueuedEdit} disabled={sending}>取消</button> : null}
          {(!writerConflict || editingQueuedMessageId) ? (
            <button
              className={`send-button${isRunning && !stopWithSendButton ? ' send-button--queue' : ''}${editingQueuedMessageId ? ' send-button--confirm' : ''}${stopWithSendButton ? ' send-button--interrupt' : ''}`}
              type={stopWithSendButton ? 'button' : 'submit'}
              onClick={stopWithSendButton ? onInterrupt : undefined}
              disabled={stopWithSendButton ? isInterrupting : !canSend}
              aria-label={stopWithSendButton ? (isInterrupting ? '正在停止回复' : '停止回复') : editingQueuedMessageId ? '确定编辑消息' : isRunning ? '将消息加入发送队列' : '发送消息'}
              title={stopWithSendButton ? (isInterrupting ? '正在停止回复' : '停止回复') : editingQueuedMessageId ? '确定编辑消息' : isRunning ? '加入发送队列' : '发送消息'}
            >
              {sending || (stopWithSendButton && isInterrupting)
                ? <LoaderCircle className="spin" size={16} />
                : editingQueuedMessageId ? <Check size={13} /> : stopWithSendButton ? <Square size={14} fill="currentColor" /> : <Send size={16} />}
              {editingQueuedMessageId ? <span>确定</span> : null}
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
  cwd?: string
  threadId?: string
  previewRequest: { id: number; cwd?: string; path: string; diff?: string } | null
  onPreviewStateChange: (open: boolean, closePreview?: () => void) => void
  draft: string
  onInsertPath: (path: string, focus?: boolean) => void
  mobileOpen: boolean
  onCloseMobile: () => void
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

const WorkspaceExplorer = memo(function WorkspaceExplorer({ token, cwd, threadId, previewRequest, onPreviewStateChange, draft, onInsertPath, mobileOpen, onCloseMobile }: WorkspaceExplorerProps) {
  const [manualRoot, setManualRoot] = useState<string | null>(readWorkspaceExplorerRoot)
  const [rootInput, setRootInput] = useState(() => readWorkspaceExplorerRoot() ?? cwd ?? '')
  const [directories, setDirectories] = useState<Record<string, CodexWorkspaceTree>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({})
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [contextMenu, setContextMenu] = useState<{ entry: CodexWorkspaceEntry; paths: string[]; x: number; y: number } | null>(null)
  const [mobilePanelHeight, setMobilePanelHeight] = useState(280)
  const [error, setError] = useState<string | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewCwd, setPreviewCwd] = useState<string | undefined>(undefined)
  const [previewDiff, setPreviewDiff] = useState<string | null>(null)
  const [mobilePreviewDialog, setMobilePreviewDialog] = useState(false)
  const [previewFile, setPreviewFile] = useState<CodexWorkspaceFile | null>(null)
  const [highlightedPreview, setHighlightedPreview] = useState<{ file: CodexWorkspaceFile; lines: Array<Array<{ text: string; className: string }>> } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewCopied, setPreviewCopied] = useState(false)
  const previewCloseButton = useRef<HTMLButtonElement>(null)
  const requestGeneration = useRef(0)
  const previewRequestGeneration = useRef(0)
  const handledPreviewRequest = useRef(0)
  const browsingRoot = manualRoot || cwd
  const scopeKey = `${threadId ?? 'new'}:${cwd ?? ''}:${browsingRoot ?? ''}`

  const directoryKey = (path: string) => path || '.'
  const closePreview = useCallback(() => {
    previewRequestGeneration.current += 1
    setPreviewPath(null)
    setPreviewCwd(undefined)
    setPreviewDiff(null)
    setMobilePreviewDialog(false)
    setPreviewLoading(false)
    setPreviewError(null)
    setPreviewCopied(false)
    onPreviewStateChange(false)
  }, [onPreviewStateChange])

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

  const loadPreview = useCallback(async (path: string, requestedCwd: string | undefined, diff?: string) => {
    const generation = ++previewRequestGeneration.current
    const mobileDialog = !desktopWorkspacePreviewAvailable()
    onPreviewStateChange(true, closePreview)
    setPreviewPath(path)
    setPreviewCwd(requestedCwd)
    setPreviewDiff(diff ?? null)
    setMobilePreviewDialog(mobileDialog)
    setPreviewFile(null)
    setPreviewError(null)
    setPreviewCopied(false)
    setPreviewLoading(true)
    try {
      const file = await codexRemoteClient.workspaceFile(token, requestedCwd, path)
      if (generation !== previewRequestGeneration.current) return
      setPreviewFile(file)
    } catch (reason) {
      if (generation !== previewRequestGeneration.current) return
      if (!diff) setPreviewError(reason instanceof Error ? reason.message : '无法读取文件')
    } finally {
      if (generation === previewRequestGeneration.current) setPreviewLoading(false)
    }
  }, [closePreview, onPreviewStateChange, token])

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

  function followChatDirectory() {
    setManualRoot(null)
    setRootInput(cwd ?? '')
    try {
      window.localStorage.removeItem(workspaceExplorerRootStorageKey)
    } catch {
      // The current page can still return to the chat directory.
    }
  }

  useEffect(() => {
    requestGeneration.current += 1
    previewRequestGeneration.current += 1
    setDirectories({})
    setExpanded({})
    setLoadingPaths({})
    setSelectedPaths([])
    setContextMenu(null)
    setError(null)
    setPreviewPath(null)
    setPreviewCwd(undefined)
    setPreviewDiff(null)
    setMobilePreviewDialog(false)
    setPreviewFile(null)
    setPreviewLoading(false)
    setPreviewError(null)
    setPreviewCopied(false)
    onPreviewStateChange(false)
    if (browsingRoot) void loadDirectory('')
  }, [browsingRoot, cwd, loadDirectory, onPreviewStateChange, scopeKey])

  useEffect(() => {
    if (!manualRoot) setRootInput(cwd ?? '')
  }, [cwd, manualRoot])

  useEffect(() => {
    if (!previewRequest || previewRequest.id === handledPreviewRequest.current) return
    if ((previewRequest.cwd ?? '') !== (cwd ?? '')) return
    handledPreviewRequest.current = previewRequest.id
    void loadPreview(previewRequest.path, previewRequest.cwd, previewRequest.diff)
  }, [cwd, loadPreview, previewRequest])

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

  useLayoutEffect(() => {
    if (!mobileOpen || typeof window === 'undefined') return
    const composer = document.querySelector<HTMLElement>('.message-composer')
    const updatePanelHeight = () => {
      const rect = composer?.getBoundingClientRect()
      const composerTop = rect?.top ?? Math.max(56, window.innerHeight - 128)
      const availableHeight = Math.max(0, composerTop - 56 - 8)
      setMobilePanelHeight(Math.round(availableHeight * 0.75))
    }
    updatePanelHeight()
    window.addEventListener('resize', updatePanelHeight)
    let observer: ResizeObserver | null = null
    if (composer && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updatePanelHeight)
      observer.observe(composer)
    }
    return () => {
      window.removeEventListener('resize', updatePanelHeight)
      observer?.disconnect()
    }
  }, [mobileOpen])

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
    const paths = (selectedPaths.includes(entry.path) ? selectedPaths : [entry.path])
      .filter((path) => !draftContainsWorkspacePath(draft, workspaceAbsolutePath(browsingRoot, path)))
    if (paths.length === 0) return
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
    else void loadPreview(entry.path, browsingRoot)
  }

  async function copyPreview() {
    if (!previewFile) return
    setPreviewCopied(await copyText(previewFile.content))
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
    if (!mobilePreviewDialog || !previewPath) return
    const frame = window.requestAnimationFrame(() => previewCloseButton.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [mobilePreviewDialog, previewPath])
  return (
    <>
      <aside className={`workspace-explorer${mobileOpen ? ' workspace-explorer--mobile-open' : ''}`} style={{ '--workspace-mobile-height': `${mobilePanelHeight}px` } as CSSProperties} aria-label="工作区文件资源管理器">
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
            <button type="button" onClick={followChatDirectory} disabled={!manualRoot} title="恢复跟随当前聊天的工作目录"><RotateCcw size={12} />跟随聊天</button>
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
      {previewPath ? (
        <>
        {mobilePreviewDialog ? <button className="workspace-file-preview-backdrop workspace-file-preview-backdrop--open" type="button" aria-label="关闭文件预览" onClick={closePreview} /> : null}
        <aside
          className={`workspace-file-preview-panel${mobilePreviewDialog ? ' workspace-file-preview-panel--mobile-open' : ''}`}
          role={mobilePreviewDialog ? 'dialog' : undefined}
          aria-modal={mobilePreviewDialog || undefined}
          aria-label="工作区文件预览"
          onKeyDown={(event) => {
            if (!mobilePreviewDialog || event.key !== 'Tab') return
            const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
            const first = buttons.item(0)
            const last = buttons.item(buttons.length - 1)
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }}
        >
          <header className="workspace-explorer__header workspace-file-preview-panel__header">
            <div>
              <span className="workspace-explorer__eyebrow">只读预览</span>
              <strong title={previewFile?.path ?? previewPath}>{(previewFile?.path ?? previewPath).split(/[\\/]/).at(-1) || previewPath}</strong>
            </div>
            <button ref={previewCloseButton} className="icon-button" type="button" onClick={closePreview} aria-label="关闭文件预览" title="关闭文件预览"><X size={15} /></button>
          </header>
          <section className="workspace-file-preview">
            <div className="workspace-file-preview__toolbar">
              <code title={previewFile?.path ?? previewPath}>{previewFile?.path ?? previewPath}</code>
              <div>
                <button className="workspace-file-preview__copy" type="button" onClick={() => void copyPreview()} disabled={!previewFile} title="复制文件内容"><Copy size={13} />{previewCopied ? '已复制' : '复制'}</button>
                <button className="icon-button" type="button" onClick={() => void loadPreview(previewPath, previewCwd, previewDiff ?? undefined)} disabled={previewLoading} aria-label="重新读取文件" title="重新读取文件"><RefreshCw className={previewLoading ? 'spin' : undefined} size={14} /></button>
              </div>
            </div>
            {previewLoading ? <div className="workspace-explorer__loading"><LoaderCircle className="spin" size={13} />读取文件内容…</div> : null}
            {previewError ? <p className="workspace-explorer__error" role="alert">{previewError}</p> : null}
            {previewFile || previewDiffLines ? (
              <pre className="workspace-file-preview__code"><code>{previewDiffLines
                ? previewDiffLines.map((diffLine, index) => {
                  const content = diffLine.kind === 'added' || diffLine.kind === 'deleted'
                    ? diffLine.line.slice(1)
                    : diffLine.kind === 'context' && diffLine.line.startsWith(' ')
                      ? diffLine.line.slice(1)
                      : diffLine.line
                  const highlightedLine = diffLine.newLine === null ? undefined : highlightedPreviewLines[diffLine.newLine - 1]
                  return (
                    <span className={`workspace-file-preview__line workspace-file-preview__line--${diffLine.kind}`} key={`diff-${index}`}>
                      <span className="workspace-file-preview__line-number" aria-hidden="true">{diffLine.newLine ?? diffLine.oldLine ?? ''}</span>
                      <span className="workspace-file-preview__line-content">{diffLine.kind !== 'deleted' && highlightedLine?.length
                        ? highlightedLine.map((segment, segmentIndex) => <span className={segment.className || undefined} key={segmentIndex}>{segment.text}</span>)
                        : content || ' '}</span>
                    </span>
                  )
                })
                : previewLines.map((line, index) => (
                  <span className="workspace-file-preview__line" key={`file-${index}`}><span className="workspace-file-preview__line-number" aria-hidden="true">{index + 1}</span><span className="workspace-file-preview__line-content">{highlightedPreviewLines[index]?.length
                    ? highlightedPreviewLines[index].map((segment, segmentIndex) => <span className={segment.className || undefined} key={segmentIndex}>{segment.text}</span>)
                    : line || ' '}</span></span>
                ))}</code></pre>
            ) : null}
          </section>
          <footer className="workspace-explorer__footer workspace-file-preview-panel__footer">只读预览 · {previewDiffStats ? `新增 ${previewDiffStats.additions} 行 · 删除 ${previewDiffStats.deletions} 行` : previewFile ? `${previewLines.length} 行` : 'UTF-8 文本'}</footer>
        </aside>
        </>
      ) : null}
      {contextMenu && typeof document !== 'undefined' ? createPortal(
        <div className="thread-context-menu workspace-file-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
          <div className="workspace-file-context-menu__name" title={contextMenu.entry.path}>{contextMenu.entry.name}{contextMenu.paths.length > 1 ? ` · 已选 ${contextMenu.paths.length} 项` : ''}</div>
          {workspacePathsMissingFromDraft(draft, contextMenu.paths.map((path) => workspaceAbsolutePath(browsingRoot, path))).length > 0 ? <button type="button" role="menuitem" onClick={() => { const paths = workspacePathsMissingFromDraft(draft, contextMenu.paths.map((path) => workspaceAbsolutePath(browsingRoot, path))).join('\n'); setContextMenu(null); onInsertPath(paths, !mobileOpen) }}><Link2 size={14} />加入输入框</button> : null}
        </div>,
        document.body,
      ) : null}
    </>
  )
})

interface RemoteChatPaneProps {
  remote: CodexRemoteController
  marqueeColor: string
  active: boolean
  showActiveFrame: boolean
  canClose: boolean
  onActivate: () => void
  onClose: () => void
  onCreateThread: () => void
  onHandoff: () => void
  onReclaim: () => void
  onOpenSidebar: () => void
  onOpenWorkspace: () => void
  onOpenWorkspaceFile: (path: string, cwd?: string, diff?: string) => void
  composerHandle: RefObject<ComposerHandle | null>
  copiedMessageId: string | null
  onCopy: (message: CodexMessage) => void | Promise<void>
}

function RemoteChatPane({
  remote,
  marqueeColor,
  active,
  showActiveFrame,
  canClose,
  onActivate,
  onClose,
  onCreateThread,
  onHandoff,
  onReclaim,
  onOpenSidebar,
  onOpenWorkspace,
  onOpenWorkspaceFile,
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
  const lastObservedUserMessage = useRef<{ threadId: string | null; messageId: string | null }>({ threadId: null, messageId: null })
  const followMessageStream = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const activeThreadId = remote.activeThread?.id
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
  const runningOperations = remote.runningTurnId ? remote.operationsByTurn[remote.runningTurnId] ?? [] : []
  const currentRunningOperation = [...runningOperations].reverse().find((operation) => operation.status === 'running') ?? null
  const lastMessageIndexByTurn = useMemo(() => {
    const indexes = new Map<string, number>()
    remote.messages.forEach((message, index) => {
      if (message.turnId) indexes.set(message.turnId, index)
    })
    return indexes
  }, [remote.messages])
  const unplacedFileChanges = useMemo(() => Object.entries(remote.fileChangesByTurn)
    .filter(([turnId, changes]) => !lastMessageIndexByTurn.has(turnId) && turnId !== remote.runningTurnId && changes.length > 0), [lastMessageIndexByTurn, remote.fileChangesByTurn, remote.runningTurnId])

  return (
    <main className={`remote-chat conversation-pane${active ? ' conversation-pane--selected' : ''}${active && showActiveFrame ? ' conversation-pane--active' : ''}`} style={{ '--marquee-color': marqueeColor, '--pane-marquee-color': marqueeColor } as CSSProperties} onPointerDown={onActivate}>
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
          <button className="icon-button mobile-workspace-button" type="button" aria-label="打开文件窗口" title="打开文件窗口" onClick={(event) => { event.stopPropagation(); onOpenWorkspace() }}><Folder size={17} /></button>
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
            const turnComplete = !message.streaming && message.turnId !== remote.runningTurnId
            const changes = turnComplete && message.turnId && lastMessageIndexByTurn.get(message.turnId) === index
              ? remote.fileChangesByTurn[message.turnId]
              : undefined
            const operations = message.role === 'assistant' && message.turnId
              ? remote.operationsByTurn[message.turnId] ?? []
              : []
            return (
              <Fragment key={message.id}>
                <MessageBubble message={message} operations={operations} copied={copiedMessageId === message.id} onCopy={onCopy} />
                {changes?.length ? <FileChangeCard changes={changes} onInsertPath={insertChangedFileIntoConversation} onOpenFile={openChangedFilePreview} /> : null}
              </Fragment>
            )
          })}
          {unplacedFileChanges.map(([turnId, changes]) => <FileChangeCard key={`unplaced-file-changes-${turnId}`} changes={changes} onInsertPath={insertChangedFileIntoConversation} onOpenFile={openChangedFilePreview} />)}
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
          {remote.isRunning ? (
            <div className="running-indicator" role="status" aria-live="polite">
              <div className="running-indicator__row">
                <OperationActivityLine className="running-indicator__activity" operation={currentRunningOperation} activity={remote.activity} iconSize={15} />
                {!hasStreamingAssistant && remote.turnStartedAt !== null ? <TurnElapsed startedAt={remote.turnStartedAt} /> : null}
              </div>
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

export function CodexRemotePage({ token, onUnauthorized, onUnpair, themePreferences, onThemePreferencesChange: setThemePreferences }: Props) {
  const [openPaneIndexes, setOpenPaneIndexes] = useState<number[]>([0])
  const [selectedPaneIndex, setSelectedPaneIndex] = useState(0)
  const remote0 = useCodexRemote(token, onUnauthorized, { persistActiveThread: true, enabled: true })
  const remote1 = useCodexRemote(token, onUnauthorized, { persistActiveThread: false, enabled: openPaneIndexes.includes(1), loadThreads: false, loadModels: false, prefetchHistory: false })
  const remote2 = useCodexRemote(token, onUnauthorized, { persistActiveThread: false, enabled: openPaneIndexes.includes(2), loadThreads: false, loadModels: false, prefetchHistory: false })
  const remote3 = useCodexRemote(token, onUnauthorized, { persistActiveThread: false, enabled: openPaneIndexes.includes(3), loadThreads: false, loadModels: false, prefetchHistory: false })
  const remote4 = useCodexRemote(token, onUnauthorized, { persistActiveThread: false, enabled: openPaneIndexes.includes(4), loadThreads: false, loadModels: false, prefetchHistory: false })
  const remotes = [remote0, remote1, remote2, remote3, remote4]
  const activeRemote = remotes[selectedPaneIndex] ?? remote0
  const runningFileChangeSummary = useMemo(() => {
    if (!activeRemote.isRunning || !activeRemote.runningTurnId) return null
    return summarizeFileChanges(activeRemote.fileChangesByTurn[activeRemote.runningTurnId] ?? [])
  }, [activeRemote.fileChangesByTurn, activeRemote.isRunning, activeRemote.runningTurnId])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [workspaceExplorerWidth, setWorkspaceExplorerWidth] = useState(readWorkspaceExplorerWidth)
  const [workspaceFilePreviewWidth, setWorkspaceFilePreviewWidth] = useState(readWorkspaceFilePreviewWidth)
  const [workspaceFilePreviewOpen, setWorkspaceFilePreviewOpen] = useState(false)
  const [workspaceResizing, setWorkspaceResizing] = useState(false)
  const [workspacePreviewRequest, setWorkspacePreviewRequest] = useState<{ id: number; cwd?: string; path: string; diff?: string } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(() => isSettingsHistoryEntry(window.history.state))
  const [defaultComposerPreferences, setDefaultComposerPreferences] = useState<ComposerPreferences>(readComposerPreferences)
  const [threadComposerPreferences, setThreadComposerPreferences] = useState<ThreadComposerPreferences>(readThreadComposerPreferences)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [completionToast, setCompletionToast] = useState<{ threadId: string; completedAt: number } | null>(null)
  const [paneNotice, setPaneNotice] = useState<string | null>(null)
  const [threadContextMenu, setThreadContextMenu] = useState<{ thread: CodexThread; x: number; y: number } | null>(null)
  const [workspaceDraftSnapshot, setWorkspaceDraftSnapshot] = useState<{ scope: string; draft: string } | null>(null)
  const openSettingsPanel = useCallback(() => {
    const currentState = window.history.state
    if (!isSettingsHistoryEntry(currentState)) {
      const previousState = currentState && typeof currentState === 'object' && !Array.isArray(currentState)
        ? currentState as Record<string, unknown>
        : {}
      window.history.pushState({ ...previousState, [settingsHistoryStateKey]: true }, '')
    }
    setSettingsOpen(true)
    setSidebarOpen(false)
  }, [])
  const closeSettingsPanel = useCallback(() => {
    setSettingsOpen(false)
    if (isSettingsHistoryEntry(window.history.state)) window.history.back()
  }, [])
  const composerHandle = useRef<ComposerHandle>(null)
  const sidebarTouchStart = useRef<{ x: number; y: number; sidebarWasOpen: boolean } | null>(null)
  const copyResetTimer = useRef<number | undefined>(undefined)
  const paneNoticeTimer = useRef<number | undefined>(undefined)
  const paneGrid = useRef<HTMLDivElement>(null)
  const paneRects = useRef(new Map<number, DOMRect>())
  const remoteShell = useRef<HTMLDivElement>(null)
  const workspaceExplorerWidthRef = useRef(workspaceExplorerWidth)
  const workspaceResizePointer = useRef<{ pointerId: number; startX: number; startWidth: number; startPreviewWidth: number } | null>(null)
  const workspaceFilePreviewWidthRef = useRef(workspaceFilePreviewWidth)
  const workspaceFilePreviewPreferredWidthRatioRef = useRef(0)
  if (workspaceFilePreviewPreferredWidthRatioRef.current === 0) {
    workspaceFilePreviewPreferredWidthRatioRef.current = readWorkspaceFilePreviewWidthRatio()
  }
  const workspaceFilePreviewOpenRef = useRef(false)
  const workspaceExplorerWidthBeforePreviewRef = useRef<number | null>(null)
  const workspaceFilePreviewResizePointer = useRef<{ pointerId: number; startX: number; startExplorerWidth: number; startPreviewWidth: number } | null>(null)
  const workspacePreviewSequence = useRef(0)
  const workspacePreviewModeRef = useRef<'desktop' | 'mobile' | null>(null)
  const workspacePreviewCloseRef = useRef<(() => void) | null>(null)

  function handleSidebarTouchStart(event: ReactTouchEvent<HTMLDivElement>) {
    if (!window.matchMedia('(max-width: 700px)').matches || event.touches.length !== 1) {
      sidebarTouchStart.current = null
      return
    }
    const touch = event.touches[0]
    if (!touch) return
    const target = event.target
    const sidebar = remoteShell.current?.querySelector('.remote-sidebar')
    const startedInsideSidebar = sidebarOpen && target instanceof Node && Boolean(sidebar?.contains(target))
    const targetElement = target instanceof Element ? target : null
    const startedOnBackdrop = sidebarOpen && Boolean(targetElement?.closest('.sidebar-backdrop'))
    const startedOnControl = Boolean(targetElement?.closest('button, input, textarea, select, [contenteditable="true"], [role="button"]'))
    const canOpenFromContent = !sidebarOpen && !startedOnControl
    sidebarTouchStart.current = startedInsideSidebar || startedOnBackdrop || canOpenFromContent
      ? { x: touch.clientX, y: touch.clientY, sidebarWasOpen: sidebarOpen }
      : null
  }

  function handleSidebarTouchEnd(event: ReactTouchEvent<HTMLDivElement>) {
    const start = sidebarTouchStart.current
    sidebarTouchStart.current = null
    const touch = event.changedTouches[0]
    if (!start || !touch) return
    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (Math.abs(deltaX) < 64 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return
    if (!start.sidebarWasOpen && deltaX > 0) setSidebarOpen(true)
    else if (start.sidebarWasOpen && deltaX < 0) setSidebarOpen(false)
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
  const selectedModel = activeComposerPreferences.model ?? ''
  const selectedEffort = activeComposerPreferences.effort ?? ''
  const selectedApprovalPolicy = activeComposerPreferences.approvalPolicy ?? 'on-request'
  const availableModels = useMemo(() => {
    const source = remotes.find((remote) => remote.models.length > 0)
    return source?.models ?? []
  }, [remote0.models, remote1.models, remote2.models, remote3.models, remote4.models])
  const chosenModel = availableModels.find((model) => modelIdOf(model) === selectedModel)
  const effortOptions = useMemo(() => chosenModel?.supportedReasoningEfforts ?? [], [chosenModel])
  const marqueeColor = themePreferences.theme === 'dark'
    ? '#ffffff'
    : themePreferences.theme === 'light'
      ? '#171717'
      : themePreferences.theme === 'warm'
        ? '#5a3b27'
        : themePreferences.customTextColor
  const themeStyle = {
    ...themeRootStyle(themePreferences),
    '--marquee-color': marqueeColor,
    '--workspace-explorer-width': `${workspaceExplorerWidth}px`,
    '--workspace-file-preview-handle-width': workspaceFilePreviewOpen ? '8px' : '0px',
    '--workspace-file-preview-width': workspaceFilePreviewOpen ? `${workspaceFilePreviewWidth}px` : '0px',
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

  useLayoutEffect(() => {
    const handleBack = () => {
      if (settingsOpen) {
        closeSettingsPanel()
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
  }, [closeSettingsPanel, settingsOpen, sidebarOpen, threadContextMenu, workspaceOpen])

  useEffect(() => {
    const interruptOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      if (workspacePreviewModeRef.current === 'mobile') {
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
  }, [remote0.latestThreadCompletion, remote1.latestThreadCompletion, remote2.latestThreadCompletion, remote3.latestThreadCompletion, remote4.latestThreadCompletion])

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
  }, [rememberThreadComposerPreferences, remote0, remote1, remote2, remote3, remote4, selectedPaneIndex])

  const activeWorkspaceCwd = activeRemote.activeThread?.cwd || activeRemote.runtime.workspace || undefined
  const insertWorkspacePath = useCallback((path: string, focus = true) => {
    composerHandle.current?.appendDraft(path, focus)
  }, [])

  function setWorkspaceExplorerWidthValue(value: number, persist = false, commit = false) {
    const previewOpen = workspaceFilePreviewOpenRef.current
    const currentWidth = workspaceExplorerWidthRef.current
    let width: number
    let previewWidth = workspaceFilePreviewWidthRef.current
    if (previewOpen && value > currentWidth) {
      // When the explorer divider is dragged wider, let the preview yield
      // space instead of locking the explorer at the combined-width limit.
      const fitted = fitWorkspacePreviewWidths(value, previewWidth)
      width = fitted.explorerWidth
      previewWidth = fitted.previewWidth
      workspaceFilePreviewWidthRef.current = previewWidth
      remoteShell.current?.style.setProperty('--workspace-file-preview-width', `${previewWidth}px`)
    } else {
      width = clampWorkspaceExplorerWidth(value, previewOpen, previewOpen ? previewWidth : 0)
    }
    workspaceExplorerWidthRef.current = width
    remoteShell.current?.style.setProperty('--workspace-explorer-width', `${width}px`)
    if (!persist && !commit) return width
    setWorkspaceExplorerWidth(width)
    if (previewOpen) setWorkspaceFilePreviewWidth(previewWidth)
    if (!persist) return width
    try {
      window.localStorage.setItem(workspaceExplorerWidthStorageKey, String(width))
      if (previewOpen) {
        const ratio = workspaceFilePreviewWidthRatio(previewWidth)
        workspaceFilePreviewPreferredWidthRatioRef.current = ratio
        window.localStorage.setItem(workspaceFilePreviewWidthStorageKey, String(previewWidth))
        window.localStorage.setItem(workspaceFilePreviewWidthRatioStorageKey, String(ratio))
      }
    } catch {
      // The current tab still keeps the chosen width when storage is unavailable.
    }
    return width
  }

  function setWorkspaceFilePreviewSplitWidths(explorerWidth: number, previewWidth: number, persist = false) {
    const fitted = fitWorkspacePreviewWidths(explorerWidth, previewWidth)
    workspaceExplorerWidthRef.current = fitted.explorerWidth
    workspaceFilePreviewWidthRef.current = fitted.previewWidth
    remoteShell.current?.style.setProperty('--workspace-explorer-width', `${fitted.explorerWidth}px`)
    remoteShell.current?.style.setProperty('--workspace-file-preview-width', `${fitted.previewWidth}px`)
    if (!persist) return fitted
    setWorkspaceExplorerWidth(fitted.explorerWidth)
    setWorkspaceFilePreviewWidth(fitted.previewWidth)
    const ratio = workspaceFilePreviewWidthRatio(fitted.previewWidth)
    workspaceFilePreviewPreferredWidthRatioRef.current = ratio
    try {
      window.localStorage.setItem(workspaceExplorerWidthStorageKey, String(fitted.explorerWidth))
      window.localStorage.setItem(workspaceFilePreviewWidthStorageKey, String(fitted.previewWidth))
      window.localStorage.setItem(workspaceFilePreviewWidthRatioStorageKey, String(ratio))
    } catch {
      // The current tab still keeps the chosen width when storage is unavailable.
    }
    return fitted
  }

  const handleWorkspacePreviewStateChange = useCallback((open: boolean, closePreview?: () => void) => {
    if (open) {
      const mode = workspacePreviewModeRef.current ?? (desktopWorkspacePreviewAvailable() ? 'desktop' : 'mobile')
      workspacePreviewModeRef.current = mode
      workspacePreviewCloseRef.current = closePreview ?? null
      if (mode === 'mobile' || workspaceFilePreviewOpenRef.current) return
      const currentExplorerWidth = workspaceExplorerWidthRef.current
      const desiredPreviewWidth = window.innerWidth * workspaceFilePreviewPreferredWidthRatioRef.current
      const fitted = fitWorkspacePreviewWidths(currentExplorerWidth, desiredPreviewWidth)
      if (fitted.explorerWidth < currentExplorerWidth && workspaceExplorerWidthBeforePreviewRef.current === null) {
        workspaceExplorerWidthBeforePreviewRef.current = currentExplorerWidth
      }
      workspaceFilePreviewOpenRef.current = true
      setWorkspaceFilePreviewOpen(true)
      workspaceFilePreviewWidthRef.current = fitted.previewWidth
      setWorkspaceFilePreviewWidth(fitted.previewWidth)
      remoteShell.current?.style.setProperty('--workspace-file-preview-width', `${fitted.previewWidth}px`)
      setWorkspaceExplorerWidthValue(fitted.explorerWidth, false, true)
      return
    }
    const mode = workspacePreviewModeRef.current
    workspacePreviewModeRef.current = null
    workspacePreviewCloseRef.current = null
    if (mode === 'mobile' || !workspaceFilePreviewOpenRef.current) return
    workspaceFilePreviewOpenRef.current = false
    setWorkspaceFilePreviewOpen(false)
    remoteShell.current?.style.setProperty('--workspace-file-preview-handle-width', '0px')
    remoteShell.current?.style.setProperty('--workspace-file-preview-width', '0px')
    const previousExplorerWidth = workspaceExplorerWidthBeforePreviewRef.current
    workspaceExplorerWidthBeforePreviewRef.current = null
    if (previousExplorerWidth !== null) setWorkspaceExplorerWidthValue(previousExplorerWidth, false, true)
  }, [])

  function startWorkspaceResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    workspaceExplorerWidthBeforePreviewRef.current = null
    workspaceResizePointer.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: workspaceExplorerWidthRef.current,
      startPreviewWidth: workspaceFilePreviewWidthRef.current,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setWorkspaceResizing(true)
  }

  function moveWorkspaceResize(event: ReactPointerEvent<HTMLDivElement>) {
    const current = workspaceResizePointer.current
    if (!current || current.pointerId !== event.pointerId) return
    const requestedWidth = current.startWidth + current.startX - event.clientX
    if (workspaceFilePreviewOpenRef.current) {
      const fitted = requestedWidth > current.startWidth
        ? fitWorkspacePreviewWidths(requestedWidth, current.startPreviewWidth)
        : {
          explorerWidth: clampWorkspaceExplorerWidth(requestedWidth, true, current.startPreviewWidth),
          previewWidth: current.startPreviewWidth,
        }
      workspaceExplorerWidthRef.current = fitted.explorerWidth
      workspaceFilePreviewWidthRef.current = fitted.previewWidth
      remoteShell.current?.style.setProperty('--workspace-explorer-width', `${fitted.explorerWidth}px`)
      remoteShell.current?.style.setProperty('--workspace-file-preview-width', `${fitted.previewWidth}px`)
      return
    }
    setWorkspaceExplorerWidthValue(requestedWidth)
  }

  function finishWorkspaceResize(event: ReactPointerEvent<HTMLDivElement>) {
    const current = workspaceResizePointer.current
    if (!current || current.pointerId !== event.pointerId) return
    workspaceResizePointer.current = null
    setWorkspaceExplorerWidthValue(workspaceExplorerWidthRef.current, true)
    setWorkspaceResizing(false)
  }

  function startWorkspaceFilePreviewResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    workspaceExplorerWidthBeforePreviewRef.current = null
    workspaceFilePreviewResizePointer.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startExplorerWidth: workspaceExplorerWidthRef.current,
      startPreviewWidth: workspaceFilePreviewWidthRef.current,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setWorkspaceResizing(true)
  }

  function moveWorkspaceFilePreviewResize(event: ReactPointerEvent<HTMLDivElement>) {
    const current = workspaceFilePreviewResizePointer.current
    if (!current || current.pointerId !== event.pointerId) return
    const delta = event.clientX - current.startX
    setWorkspaceFilePreviewSplitWidths(current.startExplorerWidth + delta, current.startPreviewWidth - delta)
  }

  function finishWorkspaceFilePreviewResize(event: ReactPointerEvent<HTMLDivElement>) {
    const current = workspaceFilePreviewResizePointer.current
    if (!current || current.pointerId !== event.pointerId) return
    workspaceFilePreviewResizePointer.current = null
    setWorkspaceFilePreviewSplitWidths(workspaceExplorerWidthRef.current, workspaceFilePreviewWidthRef.current, true)
    setWorkspaceResizing(false)
  }

  useEffect(() => {
    workspaceExplorerWidthRef.current = workspaceExplorerWidth
  }, [workspaceExplorerWidth])

  useEffect(() => {
    workspaceFilePreviewWidthRef.current = workspaceFilePreviewWidth
  }, [workspaceFilePreviewWidth])

  useEffect(() => {
    const clampForViewport = () => {
      if (workspaceFilePreviewOpenRef.current) {
        const desiredExplorerWidth = workspaceExplorerWidthBeforePreviewRef.current ?? workspaceExplorerWidthRef.current
        const desiredPreviewWidth = window.innerWidth * workspaceFilePreviewPreferredWidthRatioRef.current
        const fitted = fitWorkspacePreviewWidths(desiredExplorerWidth, desiredPreviewWidth)
        if (fitted.explorerWidth < desiredExplorerWidth && workspaceExplorerWidthBeforePreviewRef.current === null) {
          workspaceExplorerWidthBeforePreviewRef.current = desiredExplorerWidth
        }
        workspaceFilePreviewWidthRef.current = fitted.previewWidth
        setWorkspaceFilePreviewWidth(fitted.previewWidth)
        remoteShell.current?.style.setProperty('--workspace-file-preview-width', `${fitted.previewWidth}px`)
        setWorkspaceExplorerWidthValue(fitted.explorerWidth, false, true)
        return
      }
      const width = clampWorkspaceExplorerWidth(workspaceExplorerWidthRef.current)
      if (width !== workspaceExplorerWidthRef.current) setWorkspaceExplorerWidthValue(width, true)
    }
    window.addEventListener('resize', clampForViewport)
    return () => window.removeEventListener('resize', clampForViewport)
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
    <div
      ref={remoteShell}
      className={'remote-shell remote-shell--theme-' + themePreferences.theme + (androidEndpointBridgeAvailable ? ' remote-shell--android' : '') + (workspaceResizing ? ' remote-shell--resizing' : '')}
      style={themeStyle}
      onTouchStartCapture={handleSidebarTouchStart}
      onTouchEndCapture={handleSidebarTouchEnd}
      onTouchCancelCapture={() => { sidebarTouchStart.current = null }}
    >
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
          <div className="remote-brand"><img className="remote-brand__logo" src="/codex-remote.webp" alt="" /><span className="remote-brand__copy"><strong>Codex Remote</strong><small>Codex 远程工作台</small></span></div>
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
        <div className="remote-sidebar__actions">
          {androidEndpointBridgeAvailable ? <button className="sidebar-settings sidebar-endpoint" type="button" onClick={() => window.CodexRemoteAndroid?.changeEndpoint?.()}><Link2 size={16} /><span>切换电脑地址</span></button> : null}
          <button className={'sidebar-settings' + (settingsOpen ? ' sidebar-settings--active' : '')} type="button" onClick={openSettingsPanel}><Settings2 size={16} /><span>设置</span></button>
        </div>
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
        <ThemeSettingsPanel preferences={themePreferences} onChange={setThemePreferences} onClose={closeSettingsPanel} />
      ) : (
        <>
          <section className="remote-workspace">
            <div className="remote-pane-grid" ref={paneGrid} style={{ '--pane-count': openPaneIndexes.length } as CSSProperties}>
              {openPaneIndexes.map((paneIndex) => (
                <div className="remote-pane-slot" data-pane-index={paneIndex} key={paneIndex}>
                  <RemoteChatPane
                    remote={remotes[paneIndex]}
                    marqueeColor={marqueeColor}
                    active={paneIndex === selectedPaneIndex}
                    showActiveFrame={openPaneIndexes.length > 1}
                    canClose={openPaneIndexes.length > 1}
                    onActivate={() => activatePane(paneIndex)}
                    onClose={() => closePane(paneIndex)}
                    onCreateThread={() => void createThreadForPane(paneIndex)}
                    onHandoff={() => void handoffToLocalCodex(paneIndex)}
                    onReclaim={() => void reclaimForRemote(paneIndex)}
                    onOpenSidebar={() => setSidebarOpen(true)}
                    onOpenWorkspace={() => setWorkspaceOpen(true)}
                    onOpenWorkspaceFile={(path, cwd, diff) => {
                      activatePane(paneIndex)
                      workspacePreviewSequence.current += 1
                      setWorkspacePreviewRequest({ id: workspacePreviewSequence.current, cwd, path, diff })
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
              connection={activeRemote.handedOff ? 'disconnected' : activeRemote.connection}
              isRunning={activeRemote.isRunning}
              fileChangeSummary={runningFileChangeSummary}
              fileChangeSummaryKey={activeRemote.runningTurnId}
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
            aria-valuemax={workspaceExplorerWidthLimit(workspaceFilePreviewOpen, workspaceFilePreviewOpen ? workspaceFilePreviewMinimumWidth() : 0)}
            aria-valuenow={workspaceExplorerWidth}
            tabIndex={0}
            onPointerDown={startWorkspaceResize}
            onPointerMove={moveWorkspaceResize}
            onPointerUp={finishWorkspaceResize}
            onPointerCancel={finishWorkspaceResize}
            onLostPointerCapture={finishWorkspaceResize}
            onDoubleClick={() => setWorkspaceExplorerWidthValue(workspaceExplorerDefaultWidth, true)}
            onKeyDown={(event) => {
              const limits = workspaceExplorerWidthLimit(workspaceFilePreviewOpen, workspaceFilePreviewOpen ? workspaceFilePreviewMinimumWidth() : 0)
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
          {workspaceFilePreviewOpen ? (
            <div
              className="workspace-file-preview-resize-handle"
              role="separator"
              aria-label="调整文件树与预览区域宽度"
              aria-orientation="vertical"
              aria-valuemin={workspaceFileSplitExplorerWidthRange(workspaceExplorerWidth, workspaceFilePreviewWidth).minimum}
              aria-valuemax={workspaceFileSplitExplorerWidthRange(workspaceExplorerWidth, workspaceFilePreviewWidth).maximum}
              aria-valuenow={workspaceExplorerWidth}
              tabIndex={0}
              onPointerDown={startWorkspaceFilePreviewResize}
              onPointerMove={moveWorkspaceFilePreviewResize}
              onPointerUp={finishWorkspaceFilePreviewResize}
              onPointerCancel={finishWorkspaceFilePreviewResize}
              onLostPointerCapture={finishWorkspaceFilePreviewResize}
              onDoubleClick={() => {
                workspaceExplorerWidthBeforePreviewRef.current = null
                const combinedWidth = workspaceExplorerWidthRef.current + workspaceFilePreviewWidthRef.current
                const resetPreviewWidth = Math.min(workspaceFilePreviewDefaultWidth, combinedWidth - workspaceExplorerMinimumWidth())
                setWorkspaceFilePreviewSplitWidths(combinedWidth - resetPreviewWidth, resetPreviewWidth, true)
              }}
              onKeyDown={(event) => {
                const explorerWidth = workspaceExplorerWidthRef.current
                const previewWidth = workspaceFilePreviewWidthRef.current
                const combinedWidth = explorerWidth + previewWidth
                const limits = workspaceFileSplitExplorerWidthRange(explorerWidth, previewWidth)
                const nextExplorerWidth = event.key === 'ArrowLeft'
                  ? explorerWidth - 24
                  : event.key === 'ArrowRight'
                    ? explorerWidth + 24
                    : event.key === 'Home'
                      ? limits.minimum
                      : event.key === 'End'
                        ? limits.maximum
                        : null
                if (nextExplorerWidth === null) return
                event.preventDefault()
                workspaceExplorerWidthBeforePreviewRef.current = null
                setWorkspaceFilePreviewSplitWidths(nextExplorerWidth, combinedWidth - nextExplorerWidth, true)
              }}
            />
          ) : null}
          <WorkspaceExplorer
            token={token}
            cwd={activeWorkspaceCwd}
            threadId={activeRemote.activeThread?.id}
            previewRequest={workspacePreviewRequest}
            onPreviewStateChange={handleWorkspacePreviewStateChange}
            draft={activeWorkspaceDraft}
            onInsertPath={insertWorkspacePath}
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
    <article className={`file-change-card${reviewing ? ' file-change-card--reviewing' : ''}${inProgress ? ' file-change-card--inProgress' : ''}`}>
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

const OperationLog = memo(function OperationLog({ operations, initiallyOpen = false }: { operations: CodexOperation[]; initiallyOpen?: boolean }) {
  const [expanded, setExpanded] = useState(initiallyOpen)
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
      <summary><ChevronDown size={13} /><span>操作记录</span><small>{statusText}</small></summary>
      <ul>
        {operations.map((operation) => (
          <li className={`operation-log__item operation-log__item--${operation.status}`} key={operation.id}>
            <span className="operation-log__status" aria-label={operation.status === 'running' ? '进行中' : operation.status === 'failed' ? '失败' : operation.status === 'stopped' ? '已停止' : '已完成'}>
              {operation.status === 'running' ? <LoaderCircle className="spin" size={12} /> : operation.status === 'completed' ? <Check size={12} /> : operation.status === 'failed' ? <AlertTriangle size={12} /> : <Square size={10} />}
            </span>
            <span className="operation-log__content"><strong>{operation.label}</strong>{operation.detail ? <code title={operation.detail}>{operation.detail}</code> : null}</span>
            <small>{operation.status === 'running' ? '进行中' : operation.status === 'failed' ? '失败' : operation.status === 'stopped' ? '已停止' : '完成'}</small>
          </li>
        ))}
      </ul>
    </details>
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

const MessageBubble = memo(function MessageBubble({ message, operations, copied, onCopy }: { message: CodexMessage; operations: CodexOperation[]; copied: boolean; onCopy: (message: CodexMessage) => void | Promise<void> }) {
  // A streaming answer is incomplete, so none of its copy controls should be
  // available until Codex has finished the turn.
  const showCopyAction = !message.streaming && Boolean(message.text || message.documents?.length)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const replyStartedAt = message.replyStartedAt ? Date.parse(message.replyStartedAt) : Number.NaN
  const sentAtLabel = formatMessageTimestamp(message.role === 'user' ? message.sentAt : undefined)
  const replyStartedAtLabel = formatMessageTimestamp(message.role === 'assistant' ? message.replyStartedAt : undefined)
  const elapsedDurationMs = message.replyDurationMs
    ?? (message.streaming && !Number.isNaN(replyStartedAt) ? Math.max(0, clockNow - replyStartedAt) : undefined)

  useEffect(() => {
    if (!message.streaming || Number.isNaN(replyStartedAt)) return
    setClockNow(Date.now())
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [message.streaming, replyStartedAt])

  return (
    <article className={`chat-message chat-message--${message.role}`}>
      <span className="chat-message__avatar">{message.role === 'user' ? '你' : 'C'}</span>
      <div className={`chat-message__body${message.role === 'user' && showCopyAction ? ' chat-message__body--copy-outside' : ''}`}>
        <div className="chat-message__meta">
          {message.role === 'assistant' ? <strong>Codex</strong> : null}
          {replyStartedAtLabel ? <time className="chat-message__timing" aria-live="off" dateTime={message.replyStartedAt} title={message.replyStartedAt ? new Date(message.replyStartedAt).toLocaleString('zh-CN') : undefined}>开始 {replyStartedAtLabel}</time> : null}
          {elapsedDurationMs !== undefined ? <time className="chat-message__timing" aria-live="off">{message.streaming ? '已用' : '用时'} {formatTurnDuration(elapsedDurationMs)}</time> : null}
        </div>
        {message.images?.length ? <div className="chat-message__images">{message.images.map((image, index) => <img key={`${image.name}-${index}`} src={image.previewUrl} alt={image.name} />)}</div> : null}
        {message.documents?.map((document) => <div className="message-document" key={document.name}><FileText size={15} /><span><strong>{document.name}</strong><small>{document.charCount.toLocaleString()} 个字符</small></span></div>)}
        {message.text ? <MessageContent text={message.text} hideStandaloneSeparators={message.role === 'assistant'} showCodeCopy={!message.streaming} /> : null}
        {sentAtLabel ? <time className="chat-message__sent-at" dateTime={message.sentAt} title={message.sentAt ? new Date(message.sentAt).toLocaleString('zh-CN') : undefined}>发送 {sentAtLabel}</time> : null}
        {message.role === 'assistant' && !message.streaming ? <OperationLog operations={operations} /> : null}
        {showCopyAction ? <div className="chat-message__actions"><button type="button" onClick={() => void onCopy(message)}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button></div> : null}
      </div>
    </article>
  )
})

import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
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
  { value: 'onRequest', label: '请求批准' },
  { value: 'unlessTrusted', label: '帮我批准' },
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
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedEffort, setSelectedEffort] = useState('')
  const [selectedApprovalPolicy, setSelectedApprovalPolicy] = useState<CodexApprovalPolicy>('onRequest')
  const [attachedImages, setAttachedImages] = useState<CodexImageAttachment[]>([])
  const [attachedDocument, setAttachedDocument] = useState<CodexDocumentAttachment | null>(null)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [composerHeight, setComposerHeight] = useState(72)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const messageContainer = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const resizeState = useRef<{ startY: number; startHeight: number } | null>(null)
  const copyResetTimer = useRef<number | undefined>(undefined)

  const chosenModel = remote.models.find((model) => modelIdOf(model) === selectedModel)
  const effortOptions = chosenModel?.supportedReasoningEfforts ?? []

  useEffect(() => {
    const container = messageContainer.current
    if (container) container.scrollTop = container.scrollHeight
  }, [remote.messages, remote.isRunning, remote.activity])

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
    if (effortOptions.length === 0) {
      setSelectedEffort('')
      return
    }
    if (selectedEffort && effortOptions.some((option) => option.reasoningEffort === selectedEffort)) return
    setSelectedEffort(chosenModel?.defaultReasoningEffort ?? effortOptions[0].reasoningEffort)
  }, [chosenModel, effortOptions, selectedEffort])

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
    setSending(true)
    if (await remote.sendMessage({
      prompt,
      images: attachedImages,
      document: attachedDocument || undefined,
      model: selectedModel || undefined,
      effort: selectedEffort || undefined,
      approvalPolicy: selectedApprovalPolicy,
    })) {
      setDraft('')
      setAttachedImages([])
      setAttachedDocument(null)
      setAttachmentError(null)
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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
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
    <div className="remote-shell">
      <aside className={`remote-sidebar${sidebarOpen ? ' remote-sidebar--open' : ''}`} aria-label="Codex 对话记录">
        <div className="remote-sidebar__heading">
          <div className="remote-brand"><span className="remote-brand__mark">C</span><span>Codex Remote</span></div>
          <button className="icon-button remote-sidebar__close" type="button" aria-label="关闭对话列表" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>
        <button className="new-thread-button" type="button" onClick={() => void createThread()} disabled={remote.connection !== 'connected' || remote.loadingHistory}><Plus size={17} /><span>新建对话</span></button>
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
        <footer className="remote-sidebar__footer">
          <i className={`status-dot status-dot--${remote.connection}`} />
          <span>{connectionLabel[remote.connection]}</span>
          <button type="button" onClick={() => void onUnpair()}>退出</button>
        </footer>
      </aside>

      {sidebarOpen ? <button className="sidebar-backdrop" type="button" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} /> : null}

      <main className="remote-chat">
        <header className="remote-chat__header">
          <div className="remote-chat__title-wrap">
            <button className="icon-button menu-button" type="button" aria-label="打开对话列表" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
            <div className="remote-chat__title"><strong>{activeTitle}</strong><span title={remote.activeThread?.cwd || remote.runtime.workspace}>{remote.activeThread?.cwd || remote.runtime.workspace || '本机项目'}</span></div>
          </div>
          <div className="remote-chat__controls">
            <div className={`connection-label connection-label--${remote.connection}`}><i className={`status-dot status-dot--${remote.connection}`} /><span>{connectionLabel[remote.connection]}</span></div>
          </div>
        </header>

        <section className="message-stream" ref={messageContainer} aria-live="polite" aria-label="Codex 对话">
          {remote.messages.length === 0 && !remote.loadingHistory ? (
            <div className="welcome-state">
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
          {remote.fileChanges.map((change) => <FileChangeCard key={change.id} change={change} />)}
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
          <input ref={imageInput} className="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void attachImages(Array.from(event.target.files ?? [])); event.currentTarget.value = '' }} />
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
            <textarea ref={composer} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleInputKey} onPaste={handlePaste} disabled={remote.connection !== 'connected' || remote.loadingHistory || remote.isRunning || sending} placeholder={remote.loadingHistory ? '正在恢复对话…' : remote.connection === 'connected' ? '给 Codex 发送消息…' : '等待本机 Codex 连接…'} aria-label="发送消息给 Codex" />
          </div>
          <div className="message-composer__footer">
            <div className="composer-preferences">
              <ComposerMenu label="模型" value={selectedModel} options={modelOptions} emptyLabel="读取模型…" disabled={!canCompose || remote.models.length === 0} onChange={setSelectedModel} />
              <ComposerMenu label="思考" value={selectedEffort} options={reasoningOptions} emptyLabel="默认" disabled={!canCompose || effortOptions.length === 0} onChange={setSelectedEffort} />
              <ComposerMenu label="授权" value={selectedApprovalPolicy} options={authorizationOptions} emptyLabel="请求批准" disabled={!canCompose} onChange={(value) => setSelectedApprovalPolicy(value as CodexApprovalPolicy)} />
              <span className="composer-hint"><ShieldCheck size={14} />Enter 发送 · Shift+Enter 换行</span>
            </div>
            <div className="composer-actions">
              <button className="attach-button" type="button" onClick={() => imageInput.current?.click()} disabled={!canCompose || !modelSupportsImages} title={modelSupportsImages ? '附加图片' : '当前模型不支持图片输入'} aria-label="附加图片"><ImagePlus size={16} /></button>
              {remote.writerConflict ? (
                <button className="stop-button" type="button" onClick={remote.refreshActiveThread}><RefreshCw size={13} />刷新状态</button>
              ) : remote.isRunning ? (
                <button className="stop-button" type="button" onClick={() => void remote.interrupt()}><Square size={13} fill="currentColor" />停止</button>
              ) : (
                <button className="send-button" type="submit" disabled={!canSend} aria-label="发送消息">{sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button>
              )}
            </div>
          </div>
        </form>
      </main>
    </div>
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
        ? <pre className="chat-message__code" key={`code-${index}`}><code data-language={block.language}>{block.value}</code></pre>
        : <div className="chat-message__text" key={`text-${index}`}>{block.value}</div>)}
    </div>
  )
}

function FileChangeCard({ change }: { change: CodexFileChange }) {
  const additions = change.changes.reduce((total, item) => total + item.additions, 0)
  const deletions = change.changes.reduce((total, item) => total + item.deletions, 0)
  return (
    <article className={`file-change-card file-change-card--${change.status}`}>
      <div className="file-change-card__heading">
        <FileText size={16} />
        <div><strong>{change.changes.length === 1 ? change.changes[0].path : `${change.changes.length} 个文件已编辑`}</strong><small>{change.status === 'inProgress' ? '正在修改' : '已完成修改'}</small></div>
        <span className="file-change-card__stats"><i>+{additions}</i><em>-{deletions}</em></span>
      </div>
      <details className="file-change-card__details" open={change.status === 'inProgress'}>
        <summary>查看更改内容</summary>
        <div className="file-change-card__files">
          {change.changes.map((item) => (
            <div className="file-change-card__file" key={item.path}>
              <span>{item.path}</span>
              {item.diff ? <pre>{item.diff}</pre> : <small>{item.kind === 'add' ? '新增文件' : item.kind === 'delete' ? '删除文件' : '文件已更新'}</small>}
            </div>
          ))}
        </div>
      </details>
    </article>
  )
}

function MessageBubble({ message, activity, copied, onCopy }: { message: CodexMessage; activity: CodexActivity | null; copied: boolean; onCopy: () => void }) {
  return (
    <article className={`chat-message chat-message--${message.role}`}>
      <span className="chat-message__avatar">{message.role === 'user' ? '你' : 'C'}</span>
      <div className="chat-message__body">
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
        {message.text || message.documents?.length ? <div className="chat-message__actions"><button type="button" onClick={onCopy}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button></div> : null}
      </div>
    </article>
  )
}

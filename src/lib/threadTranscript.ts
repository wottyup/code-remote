import type { CodexMessage, CodexThread } from './codexRemoteClient'

export const threadTranscriptTruncationMarker = '\n\n---\n\n> 对话记录过长，已截断；这里保留了开头和结尾。\n\n---\n\n'

function threadTitle(thread: CodexThread) {
  return (thread.name || thread.preview || '未命名对话').replace(/\s+/g, ' ').trim() || '未命名对话'
}

function inlineCode(value: string) {
  return `\`${value.replace(/`/g, '\\`').replace(/[\r\n]+/g, ' ')}\``
}

function safeHeading(value: string) {
  return value.replace(/[\r\n]+/g, ' ').replace(/^\s*#+\s*/, '').trim() || '未命名对话'
}

function codeFence(value: string) {
  const longestBacktickRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longestBacktickRun + 1))
}

function displayTime(value: string | undefined) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

function messageTime(message: CodexMessage) {
  return displayTime(message.role === 'user'
    ? message.sentAt ?? message.createdAt
    : message.replyStartedAt ?? message.createdAt)
}

function appendDocument(lines: string[], name: string, content: string) {
  lines.push(`#### ${inlineCode(name)}`, '')
  if (!content) {
    lines.push('（空文档）', '')
    return
  }
  const fence = codeFence(content)
  lines.push(`${fence}text`, content, fence, '')
}

export interface ThreadTranscriptOptions {
  generatedAt?: string | Date
  heading?: string
}

/**
 * Produces a portable Markdown record of a thread. Source PDF ids and image
 * data are deliberately not included: the original files may be ephemeral,
 * and embedding image data would make an otherwise useful transcript huge.
 */
export function createThreadTranscript(
  thread: CodexThread,
  messages: readonly CodexMessage[],
  options: ThreadTranscriptOptions = {},
) {
  const generatedAt = options.generatedAt instanceof Date
    ? options.generatedAt.toISOString()
    : displayTime(options.generatedAt) || new Date().toISOString()
  const title = threadTitle(thread)
  const lines = [
    `# ${options.heading ?? '对话记录'}`,
    '',
    `> 来源对话：${safeHeading(title)}`,
    '',
    '## 对话信息',
    '',
    `- 对话名称：${inlineCode(title)}`,
    `- 对话 ID：${inlineCode(thread.id)}`,
    ...(thread.cwd ? [`- 工作目录：${inlineCode(thread.cwd)}`] : []),
    `- 整理时间：${inlineCode(generatedAt)}`,
    '',
    '## 对话内容',
  ]

  if (messages.length === 0) {
    lines.push('', '（这条对话还没有可导出的消息。）')
  }

  messages.forEach((message, index) => {
    const label = message.role === 'user' ? '用户' : 'Codex'
    lines.push('', '---', '', `### ${index + 1}. ${label}`)
    const time = messageTime(message)
    if (time) lines.push('', `- 时间：${inlineCode(time)}`)
    if (message.replyDurationMs !== undefined) lines.push(`- 回复用时：${inlineCode(`${Math.max(0, message.replyDurationMs)} ms`)}`)
    if (message.text) lines.push('', message.text)
    else if (!message.images?.length && !message.documents?.length) lines.push('', '（无文字内容）')

    if (message.images?.length) {
      lines.push('', '#### 图片附件', '')
      for (const image of message.images) lines.push(`- ${inlineCode(image.name)}（图片内容未嵌入本次对话记录）`)
    }

    const textDocuments = message.documents?.filter((document) => !document.sourceFileId) ?? []
    if (textDocuments.length) {
      lines.push('', '#### 文档附件', '')
      for (const document of textDocuments) appendDocument(lines, document.name, document.content)
    }

    const originalPdfs = message.documents?.filter((document) => document.sourceFileId) ?? []
    if (originalPdfs.length) {
      lines.push('', '#### 原始 PDF 附件', '')
      for (const document of originalPdfs) {
        lines.push(`- ${inlineCode(document.name)}（本次只保留附件名称；原始 PDF 文件不会随引用传递，需要时请重新上传。）`)
      }
    }
  })

  return `${lines.join('\n').trim()}\n`
}

export function threadTranscriptFilename(thread: CodexThread, prefix = '对话记录') {
  const name = threadTitle(thread)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 64) || '未命名对话'
  return `${prefix}-${name}.md`
}

export function truncateThreadTranscriptForAttachment(value: string, limit: number) {
  const maxLength = Math.max(0, Math.floor(limit))
  if (value.length <= maxLength) return { content: value, truncated: false }
  if (maxLength <= threadTranscriptTruncationMarker.length) {
    return { content: threadTranscriptTruncationMarker.slice(0, maxLength), truncated: true }
  }
  const remaining = maxLength - threadTranscriptTruncationMarker.length
  const openingLength = Math.ceil(remaining / 2)
  const closingLength = remaining - openingLength
  return {
    content: `${value.slice(0, openingLength)}${threadTranscriptTruncationMarker}${value.slice(value.length - closingLength)}`,
    truncated: true,
  }
}

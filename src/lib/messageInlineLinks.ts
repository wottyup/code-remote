export type MessageInlineLinkPart =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string }

const messageInlineLinkPattern = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|www\.)(?:[^\s()]|\([^()\s]*\))+)\)|((?:https?:\/\/|mailto:|www\.)[^\s<>\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uff65]+)/giu

function safeMessageLinkHref(value: string) {
  const candidate = /^www\./i.test(value) ? `https://${value}` : value
  try {
    const parsed = new URL(candidate)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

function trimMessageLinkPunctuation(value: string, textBeforeUrl: string) {
  let result = value.replace(/[.,!?;:，。！？；：、"'`“”‘’]+$/u, '')
  for (const delimiter of ['***', '**', '__', '~~', '*', '_']) {
    if (result.endsWith(delimiter) && textBeforeUrl.endsWith(delimiter)) {
      result = result.slice(0, -delimiter.length)
      break
    }
  }
  for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    while (result.endsWith(closing)
      && [...result].filter((character) => character === closing).length > [...result].filter((character) => character === opening).length) {
      result = result.slice(0, -1)
    }
  }
  return result
}

export function splitMessageInlineLinks(value: string): MessageInlineLinkPart[] {
  const parts: MessageInlineLinkPart[] = []
  const linkPattern = new RegExp(messageInlineLinkPattern.source, messageInlineLinkPattern.flags)
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = linkPattern.exec(value)) !== null) {
    const markdownLabel = match[1]
    const isMarkdownLink = markdownLabel !== undefined
    const rawUrl = isMarkdownLink ? match[2] : match[3]
    if (!rawUrl) continue

    const visibleUrl = isMarkdownLink ? rawUrl : trimMessageLinkPunctuation(rawUrl, value.slice(0, match.index))
    const href = safeMessageLinkHref(visibleUrl)
    if (!href || !visibleUrl) continue

    const linkStart = match.index
    const linkEnd = isMarkdownLink ? match.index + match[0].length : match.index + visibleUrl.length
    if (linkStart > cursor) parts.push({ type: 'text', value: value.slice(cursor, linkStart) })
    parts.push({ type: 'link', value: markdownLabel ?? visibleUrl, href })
    cursor = linkEnd
  }
  if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) })
  return parts.length > 0 ? parts : [{ type: 'text', value }]
}

export function httpMessageLinks(value: string): string[] {
  if (!/(?:https?:\/\/|www\.)/i.test(value)) return []
  const links: string[] = []
  const codePattern = /```[^\n]*(?:\n[\s\S]*?(?:```|$)|$)/g
  let cursor = 0
  let match: RegExpExecArray | null
  const collect = (plainText: string) => {
    for (const part of splitMessageInlineLinks(plainText)) {
      if (part.type === 'link' && /^https?:\/\//i.test(part.href)) {
        links.push(part.href)
      }
    }
  }
  while ((match = codePattern.exec(value)) !== null) {
    collect(value.slice(cursor, match.index))
    cursor = match.index + match[0].length
  }
  collect(value.slice(cursor))
  return links
}

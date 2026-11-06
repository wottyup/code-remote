import { Fragment, type ReactNode } from 'react'
import { splitMessageInlineLinks } from '../lib/messageInlineLinks'

function inline(text: string, depth = 0): ReactNode {
  if (depth > 8) return text
  const pattern = /(`+)([^`\n]+?)\1|\*\*([^\n]+?)\*\*|__([^\n]+?)__/g
  const parts: ReactNode[] = []
  const plain = (value: string) => splitMessageInlineLinks(value).map((part, i) => part.type === 'link'
    ? <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">{part.value}</a> : part.value)
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    parts.push(<Fragment key={`p${cursor}`}>{plain(text.slice(cursor, match.index))}</Fragment>)
    parts.push(match[1]
      ? <code key={`m${match.index}`}>{match[2]}</code>
      : <strong key={`m${match.index}`}>{inline(match[3] ?? match[4], depth + 1)}</strong>)
    cursor = match.index! + match[0].length
  }
  parts.push(<Fragment key={`p${cursor}`}>{plain(text.slice(cursor))}</Fragment>)
  return parts
}

export function ClaudeReplyText({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  const listItem = (line: string) => /^(\s*)(?:([-+*])|([0-9]+)[.)])\s+(.+)$/.exec(line)
  while (index < lines.length) {
    const start = index
    if (!lines[index].trim()) { index++; continue }
    const item = listItem(lines[index])
    if (item) {
      const ordered = Boolean(item[3])
      const entries: ReactNode[] = []
      while (index < lines.length) {
        const next = listItem(lines[index])
        if (!next || Boolean(next[3]) !== ordered) break
        let value = next[4]
        index++
        while (index < lines.length && /^\s+\S/.test(lines[index]) && !listItem(lines[index])) {
          value += '\n' + lines[index++].trimStart()
        }
        entries.push(<li key={index}>{inline(value)}</li>)
      }
      blocks.push(ordered ? <ol key={start} start={Number(item[3])}>{entries}</ol> : <ul key={start}>{entries}</ul>)
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[index])
    if (heading) {
      blocks.push(<div key={start} className="claude-reply__heading" role="heading" aria-level={heading[1].length}>{inline(heading[2])}</div>)
      index++; continue
    }
    if (/^>\s?/.test(lines[index])) {
      blocks.push(<blockquote key={start}>{inline(lines[index++].replace(/^>\s?/, ''))}</blockquote>)
      continue
    }
    const paragraph = [lines[index++]]
    while (index < lines.length && lines[index].trim() && !listItem(lines[index]) && !/^(#{1,6}\s|>)/.test(lines[index])) paragraph.push(lines[index++])
    blocks.push(<p key={start}>{inline(paragraph.join('\n'))}</p>)
  }
  return <div className="claude-reply">{blocks}</div>
}

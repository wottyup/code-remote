export interface WorkspaceTextLineRange {
  startLine: number
  endLine: number
}

export function workspaceTextSelectionLineRange(text: string, selectionStart: number, selectionEnd: number): WorkspaceTextLineRange | null {
  const start = Math.max(0, Math.min(text.length, Math.trunc(selectionStart)))
  const end = Math.max(start, Math.min(text.length, Math.trunc(selectionEnd)))
  if (start === end) return null

  const startLine = (text.slice(0, start).match(/\r\n|\r|\n/g)?.length ?? 0) + 1
  const lastCharacterOffset = Math.max(start, end - 1)
  const endPrefixOffset = text[lastCharacterOffset] === '\n' && text[lastCharacterOffset - 1] === '\r'
    ? lastCharacterOffset - 1
    : lastCharacterOffset
  const endLine = (text.slice(0, endPrefixOffset).match(/\r\n|\r|\n/g)?.length ?? 0) + 1
  return { startLine, endLine: Math.max(startLine, endLine) }
}

function markdownInlineCode(value: string) {
  const longestBacktickRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), ([run]) => run.length))
  const delimiter = '`'.repeat(longestBacktickRun + 1)
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${delimiter}${padding}${value}${padding}${delimiter}`
}

export function formatWorkspaceSelectionReference(path: string, startLine: number, endLine: number, selectedText: string) {
  const lineRange = startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}–${endLine} 行`
  const snippet = selectedText.replace(/\r\n?/g, '\n')
  const longestBacktickRun = Math.max(0, ...Array.from(snippet.matchAll(/`+/g), ([run]) => run.length))
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
  const trailingNewline = snippet.endsWith('\n') ? '' : '\n'
  return `文件：${markdownInlineCode(path)}（${lineRange}）\n${fence}\n${snippet}${trailingNewline}${fence}`
}

export interface WorkspaceTextLineRange {
  startLine: number
  endLine: number
}

export interface WorkspaceSelectionBounds {
  top: number
  bottom: number
}

export interface WorkspaceSelectionMenuPositionInput {
  anchorX: number
  anchorY: number
  viewportWidth: number
  viewportHeight: number
  menuWidth: number
  menuHeight: number
  selectionBounds?: WorkspaceSelectionBounds | null
}

export interface WorkspaceSelectionDocument {
  name: string
  content: string
}

const numberedSelectionNamePattern = /^【代码选区 #(\d+)】\s*/
const numberedSelectionContentPattern = /^代码选区 #(\d+)\n\n/

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

export function workspaceSelectionMenuPosition({ anchorX, anchorY, viewportWidth, viewportHeight, menuWidth, menuHeight, selectionBounds }: WorkspaceSelectionMenuPositionInput) {
  const margin = 8
  const maxX = Math.max(margin, viewportWidth - menuWidth - margin)
  const maxY = Math.max(margin, viewportHeight - menuHeight - margin)
  const x = Math.max(margin, Math.min(anchorX, maxX))
  let y = Math.max(margin, Math.min(anchorY, maxY))

  if (selectionBounds) {
    const below = selectionBounds.bottom + margin
    const above = selectionBounds.top - menuHeight - margin
    if (below >= margin && below <= maxY) y = below
    else if (above >= margin && above <= maxY) y = above
    else {
      const freeBelow = viewportHeight - margin - selectionBounds.bottom - margin
      const freeAbove = selectionBounds.top - margin * 2
      y = freeBelow >= freeAbove
        ? Math.max(margin, Math.min(below, maxY))
        : Math.max(margin, Math.min(above, maxY))
    }
  }

  return { x, y }
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

export function createWorkspaceSelectionDocument(path: string, startLine: number, endLine: number, selectedText: string, note = ''): WorkspaceSelectionDocument {
  const basename = path.split(/[\\/]/).at(-1)?.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim().slice(0, 96) || 'selected-code'
  const lineSuffix = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`
  const normalizedNote = note.trim()
  return {
    name: `${basename}-L${lineSuffix}-selection.md`,
    content: `${normalizedNote ? `备注：\n${normalizedNote}\n\n` : ''}${formatWorkspaceSelectionReference(path, startLine, endLine, selectedText)}`,
  }
}

function isUnnumberedWorkspaceSelectionDocument(document: Pick<WorkspaceSelectionDocument, 'name' | 'content'>) {
  return /-L\d+(?:-\d+)?-selection\.md$/i.test(document.name)
    && /(?:^|\n)文件：.+（第 \d+(?:–\d+)? 行）\n/.test(document.content)
}

export function isWorkspaceSelectionDocument(document: Pick<WorkspaceSelectionDocument, 'name' | 'content'>) {
  return numberedSelectionNamePattern.test(document.name)
    || numberedSelectionContentPattern.test(document.content)
    || isUnnumberedWorkspaceSelectionDocument(document)
}

export function workspaceSelectionNumber(document: Pick<WorkspaceSelectionDocument, 'name' | 'content'>) {
  const nameMatch = numberedSelectionNamePattern.exec(document.name)
  if (nameMatch) return Number(nameMatch[1])
  const contentMatch = numberedSelectionContentPattern.exec(document.content)
  return contentMatch ? Number(contentMatch[1]) : null
}

function unnumberWorkspaceSelectionDocument(document: WorkspaceSelectionDocument): WorkspaceSelectionDocument {
  return {
    name: document.name.replace(numberedSelectionNamePattern, ''),
    content: document.content.replace(numberedSelectionContentPattern, ''),
  }
}

export function sameWorkspaceSelectionDocument(left: Pick<WorkspaceSelectionDocument, 'name' | 'content'>, right: Pick<WorkspaceSelectionDocument, 'name' | 'content'>) {
  if (!isWorkspaceSelectionDocument(left) || !isWorkspaceSelectionDocument(right)) return false
  const normalizedLeft = unnumberWorkspaceSelectionDocument(left as WorkspaceSelectionDocument)
  const normalizedRight = unnumberWorkspaceSelectionDocument(right as WorkspaceSelectionDocument)
  return normalizedLeft.name === normalizedRight.name && normalizedLeft.content === normalizedRight.content
}

export function numberWorkspaceSelectionDocument<T extends WorkspaceSelectionDocument>(document: T, attachedDocuments: readonly Pick<WorkspaceSelectionDocument, 'name' | 'content'>[]): T {
  if (!isWorkspaceSelectionDocument(document) || workspaceSelectionNumber(document) !== null) return document
  const unnumberedDocument = unnumberWorkspaceSelectionDocument(document)
  const { lastNumber, unnumberedCount } = attachedDocuments.reduce((result, attachedDocument) => {
    if (!isWorkspaceSelectionDocument(attachedDocument)) return result
    const number = workspaceSelectionNumber(attachedDocument)
    if (number === null) return { ...result, unnumberedCount: result.unnumberedCount + 1 }
    return { ...result, lastNumber: Math.max(result.lastNumber, number) }
  }, { lastNumber: 0, unnumberedCount: 0 })
  const number = lastNumber + unnumberedCount + 1
  return {
    ...document,
    name: `【代码选区 #${number}】 ${unnumberedDocument.name}`,
    content: `代码选区 #${number}\n\n${unnumberedDocument.content}`,
  }
}

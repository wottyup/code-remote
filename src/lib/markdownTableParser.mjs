function isEscapedAt(value, index) {
  let backslashCount = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1
  }
  return backslashCount % 2 === 1
}

function splitMarkdownTableRow(line) {
  let source = line.trim()
  if (!source.includes('|')) return null

  if (source.startsWith('|')) source = source.slice(1)
  const lastIndex = source.length - 1
  if (source[lastIndex] === '|' && !isEscapedAt(source, lastIndex)) source = source.slice(0, -1)

  const cells = []
  let cell = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const nextCharacter = source[index + 1]
    if (character === '\\' && (nextCharacter === '\\' || nextCharacter === '|')) {
      cell += nextCharacter
      index += 1
    } else if (character === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
  }
  cells.push(cell.trim())
  return cells.length >= 2 ? cells : null
}

export function parseMarkdownTableBlock(lines, startIndex) {
  const headers = splitMarkdownTableRow(lines[startIndex] ?? '')
  const separator = splitMarkdownTableRow(lines[startIndex + 1] ?? '')
  if (!headers || !separator || headers.length !== separator.length) return null

  const alignments = []
  for (const cell of separator) {
    if (!/^:?-{3,}:?$/.test(cell)) return null
    const startsWithColon = cell.startsWith(':')
    const endsWithColon = cell.endsWith(':')
    alignments.push(startsWithColon && endsWithColon ? 'center' : endsWithColon ? 'right' : 'left')
  }

  const rows = []
  let nextLine = startIndex + 2
  while (nextLine < lines.length && lines[nextLine].trim()) {
    const row = splitMarkdownTableRow(lines[nextLine])
    if (!row || row.length !== headers.length) break
    rows.push(row)
    nextLine += 1
  }

  return { headers, alignments, rows, nextLine }
}

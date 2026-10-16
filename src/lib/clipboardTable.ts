function escapeMarkdownCell(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n\t\u00a0]+/g, ' ')
    .trim()
}

function toMarkdownTable(rows: string[][]) {
  const columnCount = Math.max(0, ...rows.map((row) => row.length))
  if (rows.length < 2 || columnCount < 2) return null

  const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => escapeMarkdownCell(row[index] ?? '')))
  const header = normalizedRows[0]
  const separator = Array.from({ length: columnCount }, () => '---')
  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...normalizedRows.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

function tableRowsFromHtml(html: string) {
  if (!html.toLowerCase().includes('<table')) return []

  try {
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    return Array.from(parsed.querySelectorAll('table')).flatMap((table) => {
      const rows = Array.from(table.rows)
        .map((row) => Array.from(row.cells).map((cell) => cell.textContent?.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() ?? ''))
        .filter((row) => row.some((cell) => cell.length > 0))
      return rows.length >= 2 && Math.max(0, ...rows.map((row) => row.length)) >= 2 ? [rows] : []
    })
  } catch {
    return []
  }
}

function tableRowsFromPlainText(text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim().length > 0)
  if (lines.length < 2 || !lines.some((line) => line.includes('\t'))) return null

  const rows = lines.map((line) => line.split('\t'))
  const columnCount = rows[0]?.length ?? 0
  if (columnCount < 2 || rows.some((row) => row.length !== columnCount)) return null
  return rows
}

export function clipboardTableToMarkdown(html: string, plainText: string) {
  const htmlTables = tableRowsFromHtml(html)
  if (htmlTables.length > 0) {
    const markdownTables = htmlTables
      .map((rows) => toMarkdownTable(rows))
      .filter((markdown): markdown is string => markdown !== null)
    if (markdownTables.length > 0) return markdownTables.join('\n\n')
  }

  const plainRows = tableRowsFromPlainText(plainText)
  return plainRows ? toMarkdownTable(plainRows) : null
}

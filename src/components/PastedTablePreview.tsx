import { ui, uiFormat, useUiLanguage } from '../lib/uiLanguage'
import { memo, useMemo, useState } from 'react'
import { Pencil, Table2, X } from 'lucide-react'
import { parseMarkdownTableBlock, type MarkdownTableBlock } from '../lib/markdownTableParser.mjs'

const maxPreviewRows = 200
const maxPreviewCells = 2_000

function readTables(content: string): MarkdownTableBlock[] | null {
  const lines = content.replace(/\r\n?/g, '\n').trim().split('\n')
  const tables: MarkdownTableBlock[] = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1
      continue
    }
    const table = parseMarkdownTableBlock(lines, index)
    if (!table) return null
    tables.push(table)
    index = table.nextLine
  }
  return tables.length > 0 ? tables : null
}

function escapeMarkdownCell(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n\t\u00a0]+/g, ' ')
    .trim()
}

function serializeTables(tables: MarkdownTableBlock[]) {
  return tables.map((table) => {
    const header = `| ${table.headers.map(escapeMarkdownCell).join(' | ')} |`
    const separator = `| ${table.alignments.map((alignment) => alignment === 'center' ? ':---:' : alignment === 'right' ? '---:' : '---').join(' | ')} |`
    const rows = table.rows.map((row) => `| ${row.map(escapeMarkdownCell).join(' | ')} |`)
    return [header, separator, ...rows].join('\n')
  }).join('\n\n')
}

interface PastedTablePreviewProps {
  content: string
  onChange?: (content: string) => void
  onRemove?: () => void
  disabled?: boolean
  maxRows?: number
}

export const PastedTablePreview = memo(function PastedTablePreview({ content, onChange, onRemove, disabled = false, maxRows = maxPreviewRows }: PastedTablePreviewProps) {
  useUiLanguage()
  const [editing, setEditing] = useState(false)
  const tables = useMemo(() => readTables(content), [content])
  const rowCount = tables?.reduce((total, table) => total + table.rows.length, 0) ?? 0
  const columnCount = tables?.reduce((maximum, table) => Math.max(maximum, table.headers.length), 0) ?? 0
  const previewRowLimit = Math.min(maxRows, Math.max(1, Math.floor(maxPreviewCells / Math.max(1, columnCount))))
  let visibleRows = 0

  const updateCell = (tableIndex: number, rowIndex: number, columnIndex: number, value: string) => {
    if (!tables || !onChange) return
    const nextTables = tables.map((table, currentTableIndex) => {
      if (currentTableIndex !== tableIndex) return table
      if (rowIndex < 0) {
        return { ...table, headers: table.headers.map((cell, currentColumnIndex) => currentColumnIndex === columnIndex ? value : cell) }
      }
      return {
        ...table,
        rows: table.rows.map((row, currentRowIndex) => currentRowIndex === rowIndex
          ? row.map((cell, currentColumnIndex) => currentColumnIndex === columnIndex ? value : cell)
          : row),
      }
    })
    onChange(serializeTables(nextTables))
  }

  return <section className="pasted-table-preview" aria-label={ui("粘贴表格")}>
    <div className="pasted-table-preview__heading">
      <Table2 size={16} aria-hidden="true" />
      <span className="pasted-table-preview__title">
        <strong>{ui("粘贴表格")}</strong>
        <small>{tables ? uiFormat("{0} 行 · {1} 列{2} · 左右滑动查看", rowCount.toLocaleString(), columnCount, tables.length > 1 ? uiFormat(' · {0} 张表', tables.length) : '') : ui('Markdown 原文')}</small>
      </span>
      {onChange ? <button className="pasted-table-preview__action" type="button" disabled={disabled} onClick={() => setEditing((current) => !current)} aria-label={editing ? ui('完成表格编辑') : tables ? ui('编辑表格') : ui('编辑表格原文')}>{editing ? ui('完成') : <><Pencil size={13} aria-hidden="true" />{tables ? ui('编辑表格') : ui('编辑原文')}</>}</button> : null}
      {onRemove ? <button className="pasted-table-preview__remove" type="button" disabled={disabled} onClick={onRemove} aria-label={ui("移除粘贴表格")} title={ui("移除粘贴表格")}><X size={15} /></button> : null}
    </div>
    {editing && onChange
      ? tables
        ? <div className="pasted-table-preview__scroll" role="region" aria-label={ui("编辑粘贴表格")} tabIndex={0} onKeyDownCapture={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setEditing(false)
          }
        }}>
          {tables.map((table, tableIndex) => <table className="pasted-table-preview__table" key={tableIndex} style={{ width: `max(100%, ${table.headers.length * 210}px)` }}>
            <thead><tr>{table.headers.map((cell, columnIndex) => <th className="pasted-table-preview__edit-cell" key={columnIndex} scope="col" style={{ textAlign: table.alignments[columnIndex] }}>
              <input className="pasted-table-preview__cell-input pasted-table-preview__cell-input--header" type="text" value={cell} onChange={(event) => updateCell(tableIndex, -1, columnIndex, event.currentTarget.value)} aria-label={uiFormat("第 {0} 张表第 {1} 列标题", tableIndex + 1, columnIndex + 1)} spellCheck={false} />
            </th>)}</tr></thead>
            <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td className="pasted-table-preview__edit-cell" key={columnIndex} style={{ textAlign: table.alignments[columnIndex] }}>
              <input className="pasted-table-preview__cell-input" type="text" value={cell} onChange={(event) => updateCell(tableIndex, rowIndex, columnIndex, event.currentTarget.value)} aria-label={uiFormat("第 {0} 张表第 {1} 行第 {2} 列", tableIndex + 1, rowIndex + 1, columnIndex + 1)} spellCheck={false} />
            </td>)}</tr>)}</tbody>
          </table>)}
        </div>
        : <textarea className="pasted-table-preview__source" autoFocus value={content} onChange={(event) => onChange(event.currentTarget.value)} onKeyDownCapture={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setEditing(false)
          }
        }} aria-label={ui("编辑表格 Markdown 原文")} spellCheck={false} />
      : tables
        ? <div className="pasted-table-preview__scroll" role="region" aria-label={ui("可左右滑动的粘贴表格")} tabIndex={0}>
          {tables.map((table, tableIndex) => {
            const remaining = Math.max(0, previewRowLimit - visibleRows)
            const rows = table.rows.slice(0, remaining)
            visibleRows += rows.length
            if (tableIndex > 0 && remaining === 0) return null
            return <table className="pasted-table-preview__table" key={tableIndex} style={{ width: `max(100%, ${table.headers.length * 210}px)` }}>
              <thead><tr>{table.headers.map((cell, columnIndex) => <th key={columnIndex} scope="col" style={{ textAlign: table.alignments[columnIndex] }}>{cell}</th>)}</tr></thead>
              <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex} style={{ textAlign: table.alignments[columnIndex] }}>{cell}</td>)}</tr>)}</tbody>
            </table>
          })}
        </div>
        : <pre className="pasted-table-preview__fallback">{content}</pre>}
    {!editing && rowCount > previewRowLimit ? <p className="pasted-table-preview__note">{ui("仅预览前")} {previewRowLimit} {ui("行，发送时包含全部内容。")}</p> : null}
  </section>
}, (previous, next) => previous.content === next.content
  && previous.disabled === next.disabled
  && previous.maxRows === next.maxRows
  && Boolean(previous.onChange) === Boolean(next.onChange)
  && Boolean(previous.onRemove) === Boolean(next.onRemove))

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

interface PastedTablePreviewProps {
  content: string
  onChange?: (content: string) => void
  onRemove?: () => void
  disabled?: boolean
  maxRows?: number
}

export const PastedTablePreview = memo(function PastedTablePreview({ content, onChange, onRemove, disabled = false, maxRows = maxPreviewRows }: PastedTablePreviewProps) {
  const [editing, setEditing] = useState(false)
  const tables = useMemo(() => editing ? null : readTables(content), [content, editing])
  const rowCount = tables?.reduce((total, table) => total + table.rows.length, 0) ?? 0
  const columnCount = tables?.reduce((maximum, table) => Math.max(maximum, table.headers.length), 0) ?? 0
  const previewRowLimit = Math.min(maxRows, Math.max(1, Math.floor(maxPreviewCells / Math.max(1, columnCount))))
  let visibleRows = 0

  return <section className="pasted-table-preview" aria-label="粘贴表格">
    <div className="pasted-table-preview__heading">
      <Table2 size={16} aria-hidden="true" />
      <span className="pasted-table-preview__title">
        <strong>粘贴表格</strong>
        <small>{tables ? `${rowCount.toLocaleString()} 行 · ${columnCount} 列${tables.length > 1 ? ` · ${tables.length} 张表` : ''} · 左右滑动查看` : 'Markdown 原文'}</small>
      </span>
      {onChange ? <button className="pasted-table-preview__action" type="button" disabled={disabled} onClick={() => setEditing((current) => !current)} aria-label={editing ? '完成表格原文编辑' : '编辑表格原文'}>{editing ? '完成' : <><Pencil size={13} aria-hidden="true" />编辑原文</>}</button> : null}
      {onRemove ? <button className="pasted-table-preview__remove" type="button" disabled={disabled} onClick={onRemove} aria-label="移除粘贴表格" title="移除粘贴表格"><X size={15} /></button> : null}
    </div>
    {editing && onChange
      ? <textarea className="pasted-table-preview__source" autoFocus value={content} onChange={(event) => onChange(event.currentTarget.value)} onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          setEditing(false)
        }
      }} aria-label="编辑表格 Markdown 原文" spellCheck={false} />
      : tables
        ? <div className="pasted-table-preview__scroll" role="region" aria-label="可左右滑动的粘贴表格" tabIndex={0}>
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
    {!editing && rowCount > previewRowLimit ? <p className="pasted-table-preview__note">仅预览前 {previewRowLimit} 行，发送时包含全部内容。</p> : null}
  </section>
}, (previous, next) => previous.content === next.content
  && previous.disabled === next.disabled
  && previous.maxRows === next.maxRows
  && Boolean(previous.onChange) === Boolean(next.onChange)
  && Boolean(previous.onRemove) === Boolean(next.onRemove))

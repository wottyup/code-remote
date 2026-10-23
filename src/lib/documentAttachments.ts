import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
import { documentExtensionOf, isPlainTextDocumentExtension, isSpecialTextDocumentName, isSupportedDocumentFile, isSvgDocumentFile, maxDocumentFileSize } from './documentAttachmentRules'

const zipExpandedSizeLimit = 40 * 1024 * 1024
const builderTruncationMarker = '\n\n[[CODEX_REMOTE_TRUNCATED]]'

export interface ParsedDocumentAttachment {
  name: string
  content: string
  truncated: boolean
}

class DocumentTextBuilder {
  text = ''
  truncated = false

  append(value: string) {
    if (!value || this.truncated) return false
    this.text += value
    return true
  }

  line(value = '') {
    if (this.text && !this.append('\n')) return false
    return this.append(value)
  }

  finish() {
    if (!this.truncated) return this.text.trim()
    return `${this.text}${builderTruncationMarker}`.trim()
  }
}

function fileExtension(name: string) {
  return documentExtensionOf(name)
}

function decodeText(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  return new TextDecoder('utf-8').decode(bytes)
}

function decodeRtf(source: string) {
  const windows1252 = new TextDecoder('windows-1252')
  return source
    .replace(/\\'[\da-f]{2}/gi, (escape) => windows1252.decode(Uint8Array.of(Number.parseInt(escape.slice(2), 16))))
    .replace(/\\u(-?\d+)\??/g, (_match, value: string) => String.fromCharCode((Number(value) + 65_536) % 65_536))
    .replace(/\\(?:par|line|row|page)\b\s?/gi, '\n')
    .replace(/\\tab\b\s?/gi, '\t')
    .replace(/\\'[\da-f]{2}/gi, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/\\([\\{}])/g, '$1')
    .replace(/\\~/g, ' ')
    .replace(/\\-/g, '')
    .replace(/[{}]/g, '')
}

function xmlText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) return node.nodeValue ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const element = node as Element
  if (element.localName === 'tab') return '\t'
  if (element.localName === 'line-break' || element.localName === 'br') return '\n'
  if (element.localName === 's') {
    const count = Number(element.getAttribute('text:c') ?? element.getAttribute('c') ?? '1')
    return ' '.repeat(Math.max(1, Math.min(100, Number.isFinite(count) ? count : 1)))
  }
  return Array.from(element.childNodes, xmlText).join('')
}

function parseXml(source: string) {
  const document = new DOMParser().parseFromString(source, 'application/xml')
  if (document.getElementsByTagName('parsererror').length > 0) throw new Error('文档内部 XML 格式损坏。')
  return document
}

function zipXmlEntries(buffer: ArrayBuffer, include: (path: string) => boolean) {
  const result = new Map<string, string>()
  let expandedBytes = 0
  let failure: Error | null = null
  const archive = new Unzip((entry) => {
    if (!include(entry.name) || entry.name.endsWith('/')) return
    if ((entry.originalSize ?? 0) > zipExpandedSizeLimit - expandedBytes) {
      failure = new Error('文档解压后的内容过大，无法安全读取。')
      return
    }
    const chunks: Uint8Array[] = []
    let entryBytes = 0
    entry.ondata = (error, chunk, final) => {
      if (error) {
        failure = new Error('Office 文档压缩内容损坏。')
        return
      }
      entryBytes += chunk.length
      expandedBytes += chunk.length
      if (entryBytes > zipExpandedSizeLimit || expandedBytes > zipExpandedSizeLimit) {
        failure = new Error('文档解压后的内容过大，无法安全读取。')
        void entry.terminate()
        return
      }
      chunks.push(chunk)
      if (final) {
        const bytes = new Uint8Array(entryBytes)
        let offset = 0
        for (const part of chunks) {
          bytes.set(part, offset)
          offset += part.length
        }
        result.set(entry.name, new TextDecoder('utf-8').decode(bytes))
      }
    }
    try {
      entry.start()
    } catch {
      failure = new Error('无法解压该 Office 文档，文件可能已损坏或使用了不支持的压缩方式。')
    }
  })
  archive.register(UnzipInflate)
  archive.register(UnzipPassThrough)
  try {
    archive.push(new Uint8Array(buffer), true)
  } catch {
    failure = new Error('文件不是有效的 Office/OpenDocument 文档，或文档已损坏。')
  }
  if (failure) throw failure
  return result
}

function officeParagraphs(source: string) {
  const document = parseXml(source)
  return Array.from(document.getElementsByTagNameNS('*', 'p'), (paragraph) => xmlText(paragraph).trim()).filter(Boolean)
}

function parseWord(buffer: ArrayBuffer) {
  const entries = zipXmlEntries(buffer, (path) => path === 'word/document.xml')
  const body = entries.get('word/document.xml')
  if (!body) throw new Error('DOCX 文件中找不到正文内容。')
  return officeParagraphs(body).join('\n')
}

function parsePresentation(buffer: ArrayBuffer) {
  const entries = zipXmlEntries(buffer, (path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
  const slides = [...entries.entries()].sort((left, right) => {
    const leftIndex = Number(left[0].match(/slide(\d+)\.xml$/i)?.[1] ?? 0)
    const rightIndex = Number(right[0].match(/slide(\d+)\.xml$/i)?.[1] ?? 0)
    return leftIndex - rightIndex
  })
  if (!slides.length) throw new Error('PPTX 文件中找不到幻灯片文字。')
  const output = new DocumentTextBuilder()
  for (const [path, xml] of slides) {
    if (!output.line(`[${path.split('/').at(-1)}]`)) break
    for (const paragraph of officeParagraphs(xml)) if (!output.line(paragraph)) break
    if (output.truncated) break
  }
  return output.finish()
}

function parseOpenDocumentXml(source: string, spreadsheet: boolean) {
  const document = parseXml(source)
  if (!spreadsheet) return Array.from(document.getElementsByTagNameNS('*', 'p'), (paragraph) => xmlText(paragraph).trim()).filter(Boolean).join('\n')

  const output = new DocumentTextBuilder()
  const rows = Array.from(document.getElementsByTagNameNS('*', 'table-row'))
  for (const row of rows) {
    const cells = Array.from(row.children).filter((cell) => cell.localName === 'table-cell' || cell.localName === 'covered-table-cell')
    const values: string[] = []
    for (const cell of cells) {
      const text = xmlText(cell).replace(/\s+/g, ' ').trim()
      const repeated = Number(cell.getAttribute('table:number-columns-repeated') ?? '1')
      const count = Math.max(1, Math.min(100, Number.isFinite(repeated) ? repeated : 1))
      values.push(text, ...Array(Math.max(0, count - 1)).fill(''))
    }
    if (!output.line(values.join('\t'))) break
  }
  return output.finish()
}

function parseOpenDocument(buffer: ArrayBuffer, spreadsheet: boolean) {
  const entries = zipXmlEntries(buffer, (path) => path === 'content.xml')
  const source = entries.get('content.xml')
  if (!source) throw new Error('OpenDocument 文件中找不到正文内容。')
  return parseOpenDocumentXml(source, spreadsheet)
}

function validateZipExpandedSize(buffer: ArrayBuffer) {
  if (buffer.byteLength < 22) throw new Error('Excel 文件压缩目录缺失或格式不正确。')
  const view = new DataView(buffer)
  const earliestEndRecord = Math.max(0, buffer.byteLength - 65_557)
  let endRecord = -1
  for (let offset = buffer.byteLength - 22; offset >= earliestEndRecord; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endRecord = offset
      break
    }
  }
  if (endRecord < 0) throw new Error('Excel 文件压缩目录缺失或格式不正确。')

  const entryCount = view.getUint16(endRecord + 10, true)
  const directorySize = view.getUint32(endRecord + 12, true)
  let offset = view.getUint32(endRecord + 16, true)
  if (offset + directorySize > endRecord) throw new Error('Excel 文件压缩目录损坏。')
  let expandedBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Excel 文件压缩目录损坏。')
    const uncompressedSize = view.getUint32(offset + 24, true)
    if (uncompressedSize === 0xffffffff) throw new Error('暂不支持使用 ZIP64 超大压缩格式的 Excel 文件。')
    expandedBytes += uncompressedSize
    if (expandedBytes > zipExpandedSizeLimit) throw new Error('Excel 文件解压后的内容过大，无法安全读取。')
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
  }
}

async function parseSpreadsheet(buffer: ArrayBuffer) {
  const XLSX = await import('@e965/xlsx')
  const spreadsheetSheetLimit = 30
  const spreadsheetRowLimit = 5_000
  const spreadsheetColumnLimit = 100
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) validateZipExpandedSize(buffer)
  let workbook: import('@e965/xlsx').WorkBook
  try {
    workbook = XLSX.read(buffer, { type: 'array', cellDates: true, WTF: false })
  } catch {
    throw new Error('无法读取 Excel 文件；文件可能已损坏或设有打开密码。')
  }
  if (!workbook.SheetNames.length) throw new Error('Excel 文件中没有工作表。')
  const output = new DocumentTextBuilder()
  const includedSheets = workbook.SheetNames.slice(0, spreadsheetSheetLimit)
  for (const sheetName of includedSheets) {
    if (!output.line(`[工作表：${sheetName}]`)) break
    const sheet = workbook.Sheets[sheetName]
    if (!sheet?.['!ref']) continue
    const range = XLSX.utils.decode_range(sheet['!ref'])
    const endRow = Math.min(range.e.r, range.s.r + spreadsheetRowLimit - 1)
    const endColumn = Math.min(range.e.c, range.s.c + spreadsheetColumnLimit - 1)
    const rangeTruncated = endRow < range.e.r || endColumn < range.e.c
    for (let row = range.s.r; row <= endRow; row += 1) {
      const values: string[] = []
      for (let column = range.s.c; column <= endColumn; column += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
        const value = cell?.w ?? (cell?.v === undefined || cell?.v === null ? '' : String(cell.v))
        values.push(String(value))
      }
      if (!output.line(values.join('\t'))) break
    }
    if (rangeTruncated && !output.truncated) output.truncated = true
    if (output.truncated) break
  }
  if (workbook.SheetNames.length > spreadsheetSheetLimit) output.truncated = true
  return output.finish()
}

async function parsePdf(buffer: ArrayBuffer) {
  const pdfjs = await import('pdfjs-dist')
  const pdfPageLimit = 120
  let loading: ReturnType<typeof pdfjs.getDocument> | undefined
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
    loading = pdfjs.getDocument({ data: new Uint8Array(buffer) })
    const document = await loading.promise
    const output = new DocumentTextBuilder()
    const lastPage = Math.min(document.numPages, pdfPageLimit)
    for (let pageNumber = 1; pageNumber <= lastPage; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const text = await page.getTextContent()
      for (const item of text.items) {
        if (!('str' in item)) continue
        const separator = item.hasEOL ? '\n' : ' '
        if (!output.append(`${item.str}${separator}`)) break
      }
      if (output.truncated) break
    }
    if (document.numPages > pdfPageLimit) output.truncated = true
    return output.finish()
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : '未知解析错误'
    throw new Error(`PDF 解析失败：${detail}`)
  } finally {
    try {
      await loading?.destroy()
    } catch {
      // Ignore worker cleanup failures after the attachment result is already available.
    }
  }
}

export async function readDocumentAttachment(file: File): Promise<ParsedDocumentAttachment> {
  if (file.size > maxDocumentFileSize) throw new Error('单个文档不能超过 20 MB。')
  if (!isSupportedDocumentFile(file)) throw new Error('暂不支持这个文件格式；请附加常见文档、表格、文本或源码文件。')
  if (file.size === 0) throw new Error('文件是空的。')

  const extension = fileExtension(file.name)
  if (extension === 'doc') throw new Error('旧版 .doc 二进制格式暂不支持，请另存为 .docx 后重试。')
  if (extension === 'ppt') throw new Error('旧版 .ppt 二进制格式暂不支持，请另存为 .pptx 后重试。')

  const buffer = await file.arrayBuffer()
  let content: string
  if (extension === 'pdf') content = await parsePdf(buffer)
  else if (['docx', 'docm', 'dotx', 'dotm'].includes(extension)) content = parseWord(buffer)
  else if (['xlsx', 'xls', 'xlsm', 'xlt', 'xltx', 'xltm'].includes(extension)) content = await parseSpreadsheet(buffer)
  else if (['pptx', 'pptm', 'potx', 'potm'].includes(extension)) content = parsePresentation(buffer)
  else if (extension === 'odt' || extension === 'odp' || extension === 'ods') content = parseOpenDocument(buffer, extension === 'ods')
  else if (extension === 'fodt' || extension === 'fodp' || extension === 'fods') content = parseOpenDocumentXml(decodeText(buffer), extension === 'fods')
  else if (extension === 'rtf') content = decodeRtf(decodeText(buffer))
  else if (isPlainTextDocumentExtension(extension) || isSpecialTextDocumentName(file.name) || file.type.startsWith('text/') || isSvgDocumentFile(file)) content = decodeText(buffer)
  else throw new Error('暂不支持这个文件格式。')

  if (content.includes('\u0000')) throw new Error('文件内容不是可读取的文本。')
  if (!content.trim()) throw new Error('没有提取到可读取的文字（扫描版 PDF 暂不支持 OCR）。')
  const parserTruncated = content.includes(builderTruncationMarker.trim())
  if (parserTruncated) content = content.replace(builderTruncationMarker.trim(), '')
  return {
    name: file.name || 'document',
    content,
    truncated: parserTruncated,
  }
}

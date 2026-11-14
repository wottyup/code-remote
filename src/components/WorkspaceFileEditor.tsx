import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from 'lucide-react'
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import type { HighlightedCodeSegment } from '../lib/codeHighlight'
import { fileMatchIndexAt, findFileTextMatches, replaceFileTextMatches, type FileSearchMatch } from '../lib/workspaceFileSearch'
import { ui, uiFormat, useUiLanguage } from '../lib/uiLanguage'

export interface WorkspaceFileEditorSearchHandle {
  open: (replace?: boolean) => void
  close: () => boolean
  reveal: (query: string, position: number) => void
}

interface Props {
  path: string
  value: string
  disabled: boolean
  editorRef: RefObject<HTMLTextAreaElement | null>
  searchRef: RefObject<WorkspaceFileEditorSearchHandle | null>
  onChange: (value: string) => void
  onSave: () => void | Promise<void>
  onContextMenu: (event: MouseEvent<HTMLTextAreaElement>) => void
}

function highlightedEditorContent(text: string, lines: HighlightedCodeSegment[][] | null, matches: FileSearchMatch[], current: FileSearchMatch | undefined): ReactNode[] {
  const segments = lines
    ? lines.flatMap((line, index) => [...(index > 0 ? [{ text: '\n', className: '' }] : []), ...line])
    : [{ text, className: '' }]
  if (lines && text.endsWith('\n')) segments.push({ text: '\n', className: '' })
  // Very common queries should not create hundreds of thousands of DOM nodes.
  const highlights = matches.length <= 2000 ? matches : current ? [current] : []
  const nodes: ReactNode[] = []
  let offset = 0
  let matchIndex = 0
  for (const segment of segments) {
    const end = offset + segment.text.length
    let position = offset
    while (position < end) {
      while (matchIndex < highlights.length && highlights[matchIndex].end <= position) matchIndex += 1
      const match = highlights[matchIndex]
      const inside = match && match.start <= position
      const boundary = Math.min(end, match ? inside ? match.end : match.start : end)
      const fragment = <span className={segment.className || undefined}>{segment.text.slice(position - offset, boundary - offset)}</span>
      nodes.push(inside
        ? <mark key={position} className={`workspace-file-search__match${match === current ? ' workspace-file-search__match--current' : ''}`} data-file-search-current={match === current ? '' : undefined}>{fragment}</mark>
        : <span key={position} className={segment.className || undefined}>{segment.text.slice(position - offset, boundary - offset)}</span>)
      position = boundary
    }
    offset = end
  }
  // Give the last empty line a measurable box without changing the textarea value.
  if (!text || text.endsWith('\n')) nodes.push(<span key="last-line">{'\u200b'}</span>)
  return nodes
}

export function WorkspaceFileEditor({ path, value, disabled, editorRef, searchRef, onChange, onSave, onContextMenu }: Props) {
  useUiLanguage()
  const content = useMemo(() => value.replace(/\r\n?/g, '\n'), [value])
  const highlightRef = useRef<HTMLPreElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const [highlighted, setHighlighted] = useState<{ text: string; lines: HighlightedCodeSegment[][] } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [anchor, setAnchor] = useState(0)
  const [revealRevision, setRevealRevision] = useState(0)
  const [notice, setNotice] = useState('')
  const matches = useMemo(() => searchOpen ? findFileTextMatches(content, query, matchCase) : [], [content, query, matchCase, searchOpen])
  const activeIndex = fileMatchIndexAt(matches, anchor)
  const currentMatch = matches[activeIndex]

  function openSearch(replace = false) {
    const editor = editorRef.current
    const selected = editor?.value.slice(editor.selectionStart, editor.selectionEnd) ?? ''
    if (selected && selected.length <= 1000 && !/[\r\n]/.test(selected)) setQuery(selected)
    setAnchor(editor?.selectionStart ?? 0)
    setSearchOpen(true)
    setReplaceOpen(replace)
    setNotice('')
    setRevealRevision((current) => current + 1)
    window.requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select() })
  }

  function closeSearch() {
    if (!searchOpen) return false
    setSearchOpen(false)
    editorRef.current?.focus({ preventScroll: true })
    return true
  }

  useImperativeHandle(searchRef, () => ({
    open: openSearch,
    close: closeSearch,
    reveal: (text, position) => {
      setQuery(text)
      setMatchCase(true)
      setSearchOpen(true)
      setReplaceOpen(false)
      setAnchor(position)
      setNotice('')
      setRevealRevision((current) => current + 1)
    },
  }))

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      void import('../lib/codeHighlight').then(({ highlightCodeLines }) => highlightCodeLines(path, content)).then((lines) => {
        if (!cancelled) setHighlighted({ text: content, lines })
      }).catch(() => { if (!cancelled) setHighlighted(null) })
    }, 120)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [path, content])

  const syncHighlightScroll = useCallback(() => {
    const editor = editorRef.current
    const highlight = highlightRef.current
    if (!editor || !highlight) return
    highlight.scrollTop = editor.scrollTop
    highlight.scrollLeft = editor.scrollLeft
    highlight.style.right = `${editor.offsetWidth - editor.clientWidth}px`
    highlight.style.bottom = `${editor.offsetHeight - editor.clientHeight}px`
  }, [editorRef])

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    syncHighlightScroll()
    const observer = new ResizeObserver(syncHighlightScroll)
    observer.observe(editor)
    return () => observer.disconnect()
  }, [editorRef, syncHighlightScroll])

  useLayoutEffect(syncHighlightScroll, [content, highlighted, searchOpen, replaceOpen, syncHighlightScroll])

  // Only explicit search actions move the selection; ordinary typing keeps its caret.
  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!searchOpen || !editor || !currentMatch) return
    editor.setSelectionRange(currentMatch.start, currentMatch.end)
    const marker = highlightRef.current?.querySelector<HTMLElement>('[data-file-search-current]')
    if (!marker) return
    const bounds = editor.getBoundingClientRect()
    const target = marker.getClientRects()[0] ?? marker.getBoundingClientRect()
    if (target.top < bounds.top + 9 || target.bottom > bounds.top + editor.clientHeight - 9) {
      editor.scrollTop += target.top - bounds.top - editor.clientHeight / 2 + target.height / 2
    }
    if (target.left < bounds.left + 12 || target.right > bounds.left + editor.clientWidth - 12) {
      editor.scrollLeft += target.left - bounds.left - 12
    }
    syncHighlightScroll()
  }, [revealRevision, searchOpen])

  function navigate(backwards = false) {
    if (!matches.length) return
    const editor = editorRef.current
    const currentSelected = currentMatch && editor?.selectionStart === currentMatch.start && editor.selectionEnd === currentMatch.end
    const position = editor?.selectionStart ?? anchor
    const index = currentSelected
      ? (activeIndex + (backwards ? -1 : 1) + matches.length) % matches.length
      : fileMatchIndexAt(matches, backwards ? position - 1 : position, backwards)
    setAnchor(matches[index].start)
    setRevealRevision((current) => current + 1)
  }

  function replaceCurrent() {
    if (disabled || !currentMatch) return
    onChange(replaceFileTextMatches(content, [currentMatch], replacement))
    setAnchor(currentMatch.start + replacement.length)
    setNotice(uiFormat('已替换 {0} 处，保存后生效', 1))
    setRevealRevision((current) => current + 1)
  }

  function replaceAll() {
    if (disabled || !matches.length) return
    onChange(replaceFileTextMatches(content, matches, replacement))
    setAnchor(0)
    setNotice(uiFormat('已替换 {0} 处，保存后生效', matches.length))
    setRevealRevision((current) => current + 1)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    const key = event.key.toLowerCase()
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'f' || key === 'h' || key === 's')) {
      event.preventDefault()
      event.stopPropagation()
      if (key === 's') void onSave()
      else openSearch(key === 'h')
    } else if (event.key === 'F3' && searchOpen) {
      event.preventDefault()
      event.stopPropagation()
      navigate(event.shiftKey)
    }
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Tab' || event.nativeEvent.isComposing || disabled) return
    event.preventDefault()
    const { selectionStart: start, selectionEnd: end } = event.currentTarget
    onChange(`${content.slice(0, start)}  ${content.slice(end)}`)
    window.requestAnimationFrame(() => editorRef.current?.setSelectionRange(start + 2, start + 2))
  }

  const highlightedContent = useMemo(() => highlightedEditorContent(content, highlighted?.text === content ? highlighted.lines : null, matches, currentMatch), [content, highlighted, matches, currentMatch])
  const matchLabel = query ? matches.length ? uiFormat('第 {0} 项，共 {1} 项', activeIndex + 1, matches.length) : ui('未找到匹配项') : ui('输入要查找的内容')

  return <div className="workspace-file-editor" onKeyDown={handleKeyDown}>
    {searchOpen ? <div className="workspace-file-search" role="search" aria-label={ui('文件内查找和替换')}>
      <div className="workspace-file-search__row">
        <button className="workspace-file-search__icon" type="button" onClick={() => setReplaceOpen((current) => !current)} aria-expanded={replaceOpen} aria-label={replaceOpen ? ui('隐藏替换') : ui('显示替换')} title={replaceOpen ? ui('隐藏替换') : ui('显示替换')}>{replaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        <input ref={findInput} type="text" value={query} placeholder={ui('查找')} aria-label={ui('查找内容')} spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off" onChange={(event) => { setQuery(event.currentTarget.value); setAnchor(editorRef.current?.selectionStart ?? 0); setNotice(''); setRevealRevision((current) => current + 1) }} onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault()
          navigate(event.shiftKey)
        }} />
        <button className="workspace-file-search__icon" type="button" onClick={() => { setMatchCase((current) => !current); setNotice(''); setRevealRevision((current) => current + 1) }} aria-label={ui('区分大小写')} title={ui('区分大小写')} aria-pressed={matchCase}>Aa</button>
        <small className="workspace-file-search__count" role="status" aria-live="polite">{matchLabel}</small>
        <div className="workspace-file-search__navigation">
          <button className="workspace-file-search__icon" type="button" disabled={!matches.length} onClick={() => navigate(true)} aria-label={ui('上一个匹配项')} title={ui('上一个匹配项（Shift+Enter）')}><ArrowUp size={14} /></button>
          <button className="workspace-file-search__icon" type="button" disabled={!matches.length} onClick={() => navigate()} aria-label={ui('下一个匹配项')} title={ui('下一个匹配项（Enter）')}><ArrowDown size={14} /></button>
          <button className="workspace-file-search__icon" type="button" onClick={closeSearch} aria-label={ui('关闭查找')} title={ui('关闭查找（Esc）')}><X size={14} /></button>
        </div>
      </div>
      {replaceOpen ? <div className="workspace-file-search__row workspace-file-search__row--replace">
        <input type="text" value={replacement} placeholder={ui('替换为')} aria-label={ui('替换内容')} disabled={disabled} spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off" onChange={(event) => { setReplacement(event.currentTarget.value); setNotice('') }} onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault()
          replaceCurrent()
        }} />
        <button className="workspace-file-preview__copy" type="button" disabled={disabled || !matches.length} onClick={replaceCurrent}>{ui('替换')}</button>
        <button className="workspace-file-preview__copy" type="button" disabled={disabled || !matches.length} onClick={replaceAll}>{ui('全部替换')}</button>
      </div> : null}
      {notice ? <small className="workspace-file-search__notice" role="status">{notice}</small> : null}
    </div> : null}
    <div className="workspace-file-preview__editor-wrap">
      <pre ref={highlightRef} className="workspace-file-preview__editor-highlight workspace-file-preview__line-content" aria-hidden="true"><code>{highlightedContent}</code></pre>
      <textarea ref={editorRef} className="workspace-file-preview__editor" aria-label={uiFormat('编辑文件 {0}', path)} value={content} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" disabled={disabled} onChange={(event) => { onChange(event.currentTarget.value); setAnchor(event.currentTarget.selectionStart); setNotice('') }} onSelect={(event) => { if (searchOpen && document.activeElement === event.currentTarget) setAnchor(event.currentTarget.selectionStart) }} onScroll={syncHighlightScroll} onKeyDown={handleEditorKeyDown} onContextMenu={onContextMenu} />
    </div>
  </div>
}

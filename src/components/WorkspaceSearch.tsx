import { ChevronDown, ChevronRight, FileText, LoaderCircle, ReplaceAll, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { devwispClient, type WorkspaceSearchFile, type WorkspaceSearchMatch, type WorkspaceSearchResult, type WorkspaceReplaceResult } from '../lib/devwispClient'
import { ui, uiFormat, uiMessage, useUiLanguage } from '../lib/uiLanguage'

export type WorkspaceSearchMode = 'find' | 'replace' | null

interface Props {
  token: string
  root: string | undefined
  mode: WorkspaceSearchMode
  onModeChange: (mode: WorkspaceSearchMode) => void
  onOpenResult: (file: WorkspaceSearchFile, match: WorkspaceSearchMatch) => void | Promise<void>
  beforeReplace: (paths: string[] | null) => string | null
  onReplaced: (paths: string[]) => void | Promise<void>
  onBusyChange: (busy: boolean) => void
}

export function WorkspaceSearch({ token, root, mode, onModeChange, onOpenResult, beforeReplace, onReplaced, onBusyChange }: Props) {
  useUiLanguage()
  const input = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const replacingRef = useRef(false)
  const searchImmediately = useRef(false)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [loading, setLoading] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<{ root: string; query: string; matchCase: boolean; result: WorkspaceSearchResult } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [replaced, setReplaced] = useState<WorkspaceReplaceResult | null>(null)
  const enabled = mode !== null
  const result = snapshot && snapshot.root === root && snapshot.query === query && snapshot.matchCase === matchCase ? snapshot.result : null

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!enabled || !root || !query) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    const timer = window.setTimeout(() => {
      void devwispClient.searchWorkspace(token, root, query, matchCase, controller.signal).then((data) => {
        if (!controller.signal.aborted) { setSnapshot({ root, query, matchCase, result: data }); setSearchError(null) }
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) { setSnapshot(null); setSearchError(reason instanceof Error ? reason.message : '目录查找失败') }
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, searchImmediately.current ? 0 : 300)
    searchImmediately.current = false
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [enabled, root, query, matchCase, revision, token])

  useEffect(() => {
    if (mode) window.requestAnimationFrame(() => input.current?.focus())
  }, [mode])

  async function replace(files?: WorkspaceSearchFile[]) {
    if (!root || !result || loading || replacingRef.current) return
    const replaceAll = files === undefined
    const targets = files ?? []
    if (replaceAll ? result.truncated || !result.matchCount : !targets.length || targets.some((file) => !file.complete)) return
    const paths = replaceAll ? null : targets.map((file) => file.path)
    const blocked = beforeReplace(paths)
    if (blocked) { setError(blocked); return }
    const count = replaceAll ? result.matchCount : targets.reduce((sum, file) => sum + file.matchCount, 0)
    const fileCount = replaceAll ? result.fileCount : targets.length
    if (!window.confirm(uiFormat('将在目录 {0} 的 {1} 个文件中替换 {2} 处匹配，并直接保存。继续吗？', root, fileCount, count))) return
    replacingRef.current = true
    setReplacing(true)
    onBusyChange(true)
    setError(null)
    setReplaced(null)
    try {
      const outcome = await devwispClient.replaceWorkspace(token, root, query, replacement, matchCase, files)
      if (mounted.current) { setReplaced(outcome); setSnapshot(null) }
      await onReplaced(outcome.paths)
    } catch (reason) {
      if (mounted.current) { setError(reason instanceof Error ? reason.message : '目录替换失败'); setSnapshot(null) }
    } finally {
      replacingRef.current = false
      onBusyChange(false)
      if (mounted.current) { setReplacing(false); searchImmediately.current = true; setRevision((current) => current + 1) }
    }
  }

  function clearFeedback() { setError(null); setSearchError(null); setReplaced(null) }

  return <section className="workspace-search" hidden={!enabled} aria-label={ui('目录查找和替换')} onKeyDown={(event) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && !replacing) { event.preventDefault(); event.stopPropagation(); onModeChange(null) }
  }}>
    <div className="workspace-search__controls">
      <form className="workspace-file-search__row" onSubmit={(event) => { event.preventDefault(); searchImmediately.current = true; setRevision((current) => current + 1) }}>
        <button className="workspace-file-search__icon" type="button" disabled={replacing} onClick={() => onModeChange(mode === 'replace' ? 'find' : 'replace')} aria-expanded={mode === 'replace'} aria-label={mode === 'replace' ? ui('隐藏替换') : ui('显示替换')} title={mode === 'replace' ? ui('隐藏替换') : ui('显示替换')}>{mode === 'replace' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        <input ref={input} value={query} maxLength={1000} disabled={!root || replacing} placeholder={ui('在目录中查找')} aria-label={ui('目录查找内容')} spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off" onChange={(event) => { setQuery(event.currentTarget.value); clearFeedback() }} />
        <button className="workspace-file-search__icon" type="button" disabled={replacing} onClick={() => { setMatchCase((current) => !current); clearFeedback() }} aria-pressed={matchCase} aria-label={ui('区分大小写')} title={ui('区分大小写')}>Aa</button>
        <button className="workspace-file-search__icon" type="button" disabled={replacing} onClick={() => onModeChange(null)} aria-label={ui('关闭目录查找')} title={ui('关闭目录查找')}><X size={14} /></button>
      </form>
      {mode === 'replace' ? <div className="workspace-file-search__row workspace-search__replace">
        <input value={replacement} disabled={replacing} placeholder={ui('替换为')} aria-label={ui('目录替换内容')} spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off" onChange={(event) => { setReplacement(event.currentTarget.value); clearFeedback() }} />
        <button className="workspace-file-preview__copy" type="button" disabled={replacing || loading || !result?.matchCount || result.truncated} onClick={() => void replace()} title={ui('替换全部搜索结果并保存')}><ReplaceAll size={14} />{ui('全部替换')}</button>
      </div> : null}
      <div className="workspace-search__status" role="status" aria-live="polite">{replacing ? <><LoaderCircle className="spin" size={13} />{ui('正在替换文件…')}</> : loading ? <><LoaderCircle className="spin" size={13} />{ui('正在查找…')}</> : result ? result.truncated ? uiFormat('扫描已达到安全上限，至少在 {0} 个文件中找到 {1} 处匹配', result.fileCount, result.matchCount) : uiFormat('{0} 个文件中找到 {1} 处匹配', result.fileCount, result.matchCount) : ui('在当前目录的文件内容中查找')}</div>
      <small className="workspace-search__hint">{ui('默认跳过依赖、缓存和构建目录')}</small>
      {result?.displayTruncated ? <p className="workspace-search__warning" role="status">{ui('列表只显示部分匹配；全部替换会处理本次扫描到的全部匹配。')}</p> : null}
      {result?.truncated ? <p className="workspace-search__warning" role="status">{ui('扫描已达到安全上限，结果不完整；缩小目录范围后才能全部替换。')}</p> : null}
      {result?.skippedFiles ? <p className="workspace-search__warning" role="status">{uiFormat('已跳过 {0} 个不支持预览、无法读取或超过 1 MiB 的文件。', result.skippedFiles)}</p> : null}
      {error ? <p className="workspace-explorer__error" role="alert">{uiMessage(error)}</p> : null}
      {searchError ? <p className="workspace-explorer__error" role="alert">{uiMessage(searchError)}</p> : null}
      {replaced ? <div className="workspace-search__feedback" role="status">
        <span>{uiFormat('已在 {0} 个文件中替换 {1} 处', replaced.paths.length, replaced.matchCount)}</span>
        {replaced.errors.map((item) => <p className="workspace-explorer__error" key={item.path}>{item.path}: {uiMessage(item.message)}</p>)}
      </div> : null}
    </div>
    <div className="workspace-search__results">
      {!query ? <div className="workspace-search__empty"><Search size={22} /><span>{ui('输入文字，查找当前目录及子目录')}</span></div> : null}
      {query && result && !result.files.length && !loading ? <p className="workspace-explorer__empty">{ui('未找到匹配项')}</p> : null}
      {result?.files.map((file) => <details className="workspace-search__file" key={file.path} open>
        <summary title={file.path}><FileText size={14} /><span className="workspace-search__path">{file.path}</span><small>{file.matchCount}{!file.complete || file.matches.length < file.matchCount ? '+' : ''}</small>
          {mode === 'replace' ? <button className="workspace-file-search__icon" type="button" disabled={replacing || loading || !file.complete} aria-label={uiFormat('替换文件 {0} 中的匹配项', file.path)} title={ui('替换此文件中的匹配项并保存')} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void replace([file]) }}><ReplaceAll size={13} /></button> : null}
        </summary>
        {file.matches.map((match) => <button className="workspace-search__match" type="button" key={`${match.line}:${match.column}`} disabled={replacing} title={uiFormat('打开 {0} 第 {1} 行', file.path, match.line)} onClick={() => { void Promise.resolve(onOpenResult(file, match)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '无法读取文件')) }}>
          <span className="workspace-search__location">{match.line}:{match.column}</span><span className="workspace-search__snippet"><span className="workspace-search__before">{Array.from(match.before).slice(-16).join('')}</span><mark>{match.text}</mark><span className="workspace-search__after">{match.after}</span></span>
        </button>)}
      </details>)}
    </div>
  </section>
}

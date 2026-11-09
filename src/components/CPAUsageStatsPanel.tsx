import { getUiLanguage, ui, uiFormat, uiMessage, useUiLanguage } from '../lib/uiLanguage'
import { useEffect, useMemo, useState } from 'react'
import { Activity, ChartColumnIncreasing, Database, DollarSign, Filter, RefreshCw, Settings2, X } from 'lucide-react'
import {
  fetchCodexProxyUsageAnalytics,
  fetchCodexProxyClientKeys,
  fetchCPAUsageAnalytics,
  fetchNewAPIUsageAnalytics,
  type CPAUsageAccountStat,
  type CPAUsageAnalyticsSummary,
  type CPAUsageAnalyticsResponse,
  type CPAUsageModelStat,
  type CPAUsageRange,
  type CPAUsageSettings,
  type CPAUsageSource,
  type CPAUsageTimelinePoint,
  type CodexProxyClientKeyStat,
} from '../lib/cpaUsageStats'

const numberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
const moneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const percentFormatter = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 })
const dateTimeFormatters = {
  'zh-CN': new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  en: new Intl.DateTimeFormat('en', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
}

function count(value: number | undefined) {
  return numberFormatter.format(Number.isFinite(value) ? Math.max(0, value ?? 0) : 0)
}

function cachedTokenTotal(summary: CPAUsageAnalyticsSummary | undefined) {
  const cacheFields = [summary?.cached_tokens, summary?.cache_read_tokens, summary?.cache_creation_tokens]
  return cacheFields.reduce<number>(
    (total, value) => total + (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0),
    0,
  )
}

function accountLabel(account: CPAUsageAccountStat) {
  return account.auth_label_snapshot || account.account_snapshot || account.id || ui('未命名账号')
}

function timelineTokens(point: CPAUsageTimelinePoint) {
  return point.total_tokens ?? point.tokens ?? 0
}

function clientKeyLastUsed(value: string | null) {
  if (!value) return '—'
  const time = Date.parse(value)
  return Number.isFinite(time) ? dateTimeFormatters[getUiLanguage()].format(new Date(time)) : '—'
}

function UsageTimeline({ points }: { points: CPAUsageTimelinePoint[] }) {
  useUiLanguage()
  const maxTokens = Math.max(1, ...points.map(timelineTokens))
  if (!points.length) return <div className="cpa-usage-empty">{ui("所选时间段暂无趋势数据。")}</div>

  return (
    <div className="cpa-usage-timeline" role="img" aria-label={ui("Token 用量趋势图")}>
      {points.map((point, index) => {
        const tokens = timelineTokens(point)
        const ratio = Math.max(tokens > 0 ? 3 : 0, (tokens / maxTokens) * 100)
        const label = point.label || dateTimeFormatters[getUiLanguage()].format(new Date(point.bucket_ms))
        return (
          <div className="cpa-usage-timeline__item" key={`${point.bucket_ms}-${index}`} title={`${label}：${count(tokens)} tokens`}>
            <div className="cpa-usage-timeline__bar-wrap"><span className="cpa-usage-timeline__bar" style={{ height: `${ratio}%` }} /></div>
            <small>{label}</small>
          </div>
        )
      })}
    </div>
  )
}

export function CPAUsageStatsPanel({
  settings,
  token,
  onSourceChange,
  onOpenSettings,
  onClose,
}: {
  settings: CPAUsageSettings
  token: string
  onSourceChange: (source: CPAUsageSource) => void
  onOpenSettings: () => void
  onClose: () => void
}) {
  useUiLanguage()
  const [range, setRange] = useState<CPAUsageRange>('today')
  const [selectedApiKeyHash, setSelectedApiKeyHash] = useState('')
  const [apiKeyHashes, setApiKeyHashes] = useState<string[]>([])
  const [filterLoading, setFilterLoading] = useState(false)
  const [filterError, setFilterError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [data, setData] = useState<CPAUsageAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKeys, setClientKeys] = useState<CodexProxyClientKeyStat[] | null>(null)
  const [clientKeysLoading, setClientKeysLoading] = useState(false)
  const [clientKeysError, setClientKeysError] = useState<string | null>(null)

  useEffect(() => {
    setSelectedApiKeyHash('')
    setApiKeyHashes([])
  }, [settings.source, settings.baseUrl, settings.managementKey, settings.codexProxyBaseUrl, settings.codexProxyApiKey, settings.newAPIBaseUrl, settings.newAPIAccessToken, settings.newAPIUserId])

  useEffect(() => {
    if (settings.source !== 'codex-proxy' || !settings.codexProxyBaseUrl.trim() || !settings.codexProxyApiKey.trim()) {
      setClientKeys(null)
      setClientKeysLoading(false)
      setClientKeysError(null)
      return
    }
    const controller = new AbortController()
    setClientKeys(null)
    setClientKeysLoading(true)
    setClientKeysError(null)
    fetchCodexProxyClientKeys(settings, token, controller.signal)
      .then(setClientKeys)
      .catch((reason) => {
        if (!controller.signal.aborted) setClientKeysError(reason instanceof Error ? reason.message : '读取 Client Key 用量失败。')
      })
      .finally(() => {
        if (!controller.signal.aborted) setClientKeysLoading(false)
      })
    return () => controller.abort()
  }, [settings.source, settings.codexProxyBaseUrl, settings.codexProxyApiKey, token, refreshKey])

  useEffect(() => {
    if (settings.source !== 'cpamp' || !settings.baseUrl.trim() || !settings.managementKey.trim()) {
      setApiKeyHashes([])
      setFilterLoading(false)
      setFilterError(null)
      return
    }
    const controller = new AbortController()
    setFilterLoading(true)
    setFilterError(null)
    fetchCPAUsageAnalytics(settings, range, controller.signal, { filterSelectorsOnly: true })
      .then((response) => {
        const hashes = response.filter_options?.api_key_hashes ?? []
        setApiKeyHashes([...new Set(hashes.filter((hash) => typeof hash === 'string' && hash.trim()).map((hash) => hash.trim()))])
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setFilterError(reason instanceof Error ? reason.message : '读取调用方密钥筛选项失败。')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setFilterLoading(false)
      })
    return () => controller.abort()
  }, [range, refreshKey, settings.source, settings.baseUrl, settings.managementKey])

  useEffect(() => {
    const configured = settings.source === 'cpamp'
      ? Boolean(settings.baseUrl.trim() && settings.managementKey.trim())
      : settings.source === 'codex-proxy'
        ? Boolean(settings.codexProxyBaseUrl.trim() && settings.codexProxyApiKey.trim())
        : Boolean(settings.newAPIBaseUrl.trim() && settings.newAPIAccessToken.trim())
    if (!configured) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }
    const controller = new AbortController()
    setData(null)
    setLoading(true)
    setError(null)
    const request = settings.source === 'codex-proxy'
      ? fetchCodexProxyUsageAnalytics(settings, token, range, controller.signal)
      : settings.source === 'new-api'
        ? fetchNewAPIUsageAnalytics(settings, token, range, controller.signal)
      : fetchCPAUsageAnalytics(settings, range, controller.signal, {
        apiKeyHashes: selectedApiKeyHash ? [selectedApiKeyHash] : undefined,
      })
    request
      .then(setData)
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : '读取用量统计失败。')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [range, refreshKey, selectedApiKeyHash, settings.source, settings.baseUrl, settings.managementKey, settings.codexProxyBaseUrl, settings.codexProxyApiKey, settings.newAPIBaseUrl, settings.newAPIAccessToken, settings.newAPIUserId, token])

  const models = useMemo(
    () => [...(data?.model_stats ?? [])].sort((a, b) => b.total_tokens - a.total_tokens),
    [data?.model_stats],
  )
  const accounts = useMemo(
    () => [...(data?.account_stats ?? [])].sort((a, b) => b.total_tokens - a.total_tokens),
    [data?.account_stats],
  )
  const sortedClientKeys = useMemo(() => [...(clientKeys ?? [])].sort((a, b) => b.used_tokens - a.used_tokens), [clientKeys])
  const clientKeyTotals = useMemo(() => (clientKeys ?? []).reduce(
    (total, key) => ({ requests: total.requests + key.request_count, tokens: total.tokens + key.used_tokens, cost: total.cost + key.used_cost_usd }),
    { requests: 0, tokens: 0, cost: 0 },
  ), [clientKeys])
  const summary = data?.summary
  const isCodexProxy = settings.source === 'codex-proxy'
  const isNewAPI = settings.source === 'new-api'
  const hasNewAPICacheBreakdown = typeof summary?.cache_read_tokens === 'number' && typeof summary?.cache_creation_tokens === 'number'
  const isCPAMP = settings.source === 'cpamp'
  const sourceName = isCodexProxy ? 'Codex Proxy' : isNewAPI ? 'New API' : 'CPA-Manager-Plus'
  const configured = isCodexProxy
    ? Boolean(settings.codexProxyBaseUrl.trim() && settings.codexProxyApiKey.trim())
    : isNewAPI
      ? Boolean(settings.newAPIBaseUrl.trim() && settings.newAPIAccessToken.trim())
      : Boolean(settings.baseUrl.trim() && settings.managementKey.trim())
  const hasStats = Boolean(summary?.total_calls || summary?.total_tokens || summary?.total_cost || models.length || accounts.length)
  const visibleApiKeyHashes = selectedApiKeyHash && !apiKeyHashes.includes(selectedApiKeyHash)
    ? [selectedApiKeyHash, ...apiKeyHashes]
    : apiKeyHashes

  return (
    <main className="theme-settings-panel cpa-usage-panel" aria-label={ui("Token 用量统计")}>
      <header className="theme-settings-panel__header">
        <div>
          <span className="theme-settings-panel__eyebrow">TOKEN USAGE</span>
          <h1>{ui("Token 用量统计")}</h1>
          <p>{ui("数据来自你在设置中选择的")} {sourceName}。</p>
        </div>
        <div className="cpa-usage-panel__header-actions">
          <button className="icon-button theme-settings-panel__close" type="button" aria-label={ui("刷新统计")} title={ui("刷新统计")} disabled={!configured || loading || clientKeysLoading} onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={16} className={loading || clientKeysLoading ? 'spin' : undefined} /></button>
          <button className="icon-button theme-settings-panel__close" type="button" aria-label={ui("返回对话")} onClick={onClose}><X size={18} /></button>
        </div>
      </header>
      <div className="theme-settings-panel__content cpa-usage-panel__content">
        <div className="cpa-usage-range-tabs cpa-usage-source-tabs cpa-usage-panel__sources" role="group" aria-label={ui("Token 用量数据源")}>
          <button type="button" className={isCPAMP ? 'cpa-usage-range-tabs__active' : ''} aria-pressed={isCPAMP} onClick={() => onSourceChange('cpamp')}>CPA-Manager-Plus</button>
          <button type="button" className={isCodexProxy ? 'cpa-usage-range-tabs__active' : ''} aria-pressed={isCodexProxy} onClick={() => onSourceChange('codex-proxy')}>Codex Proxy</button>
          <button type="button" className={isNewAPI ? 'cpa-usage-range-tabs__active' : ''} aria-pressed={isNewAPI} onClick={() => onSourceChange('new-api')}>New API</button>
        </div>
        {!configured ? (
          <section className="theme-settings-card cpa-usage-connect-prompt">
            <Database size={25} />
            <h2>{ui("先连接你的")} {isCPAMP ? 'Manager Server' : sourceName}</h2>
            <p>{ui("在设置中填写服务地址和")}{isCodexProxy ? ui('控制面板登录密码') : isNewAPI ? ui('面板访问令牌（旧版还需用户 ID）') : ui('Manager 密钥')}{ui("后，这里会显示记录到的 Token 用量。")}</p>
            <button className="theme-notification-toggle theme-notification-toggle--enabled" type="button" onClick={onOpenSettings}><Settings2 size={14} />{ui("前往设置")}</button>
          </section>
        ) : (
          <>
            <section className="cpa-usage-toolbar">
              <div className="cpa-usage-toolbar__controls">
                <div className="cpa-usage-range-tabs" role="group" aria-label={ui("统计时间范围")}>
                  {([
                    ['today', '今天'],
                    ['yesterday', '昨天'],
                    ['7d', '近 7 天'],
                    ['30d', '近 30 天'],
                  ] as const).map(([value, label]) => (
                    <button className={range === value ? 'cpa-usage-range-tabs__active' : ''} key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>{ui(label)}</button>
                  ))}
                </div>
                {isCPAMP ? <label className="cpa-usage-key-filter">
                  <Filter size={14} aria-hidden="true" />
                  <span>{ui("调用方密钥")}</span>
                  <select value={selectedApiKeyHash} aria-label={ui("按调用方密钥筛选")} onChange={(event) => setSelectedApiKeyHash(event.target.value)}>
                    <option value="">{ui("全部调用方密钥")}</option>
                    {visibleApiKeyHashes.map((hash) => <option value={hash} key={hash}>{ui("密钥 ·")} {hash.slice(0, 8)}</option>)}
                  </select>
                </label> : null}
                {isCPAMP && filterLoading && !apiKeyHashes.length ? <span className="cpa-usage-filter-status">{ui("正在读取密钥…")}</span> : null}
                {isCPAMP && filterError ? <span className="cpa-usage-filter-status cpa-usage-filter-status--error" title={uiMessage(filterError)}>{ui("密钥筛选项加载失败")}</span> : null}
              </div>
              {data?.generated_at_ms ? <span>{ui("更新于")} {dateTimeFormatters[getUiLanguage()].format(new Date(data.generated_at_ms))}</span> : null}
            </section>
            {error ? <div className="cpa-usage-error" role="alert"><strong>{ui("读取失败")}</strong><span>{uiMessage(error)}</span><button type="button" onClick={() => setRefreshKey((value) => value + 1)}>{ui("重试")}</button></div> : null}
            {loading && !data ? <div className="cpa-usage-loading"><RefreshCw size={16} className="spin" />{ui("正在读取统计…")}</div> : null}
            {!error && !loading && !hasStats ? <div className="cpa-usage-empty">{isCodexProxy ? ui('这个时间段还没有历史用量。Codex Proxy 只能统计启用快照记录后的请求。') : isNewAPI ? ui('这个时间段还没有用量。New API 按小时汇总，当前小时可能延后写入。') : ui('这个时间段还没有统计数据。确认 CPAMP Full Mode 已开启 usage collector，并且已有请求经过 CLIProxyAPI。')}</div> : null}
            {summary ? (
              <>
                <section className="cpa-usage-summary-grid" aria-label={ui("Token 用量概览")}>
                  <article className="theme-settings-card cpa-usage-summary-card cpa-usage-summary-card--primary"><span><Activity size={14} />{isCodexProxy ? ui('总 Token（含图片）') : ui('总 Token')}</span><strong>{count(summary.total_tokens)}</strong><small>{count(summary.total_calls)} {ui("次请求")}</small></article>
                  <article className="theme-settings-card cpa-usage-summary-card cpa-usage-summary-card--cost"><span><DollarSign size={14} />{isCodexProxy ? ui('估算金额') : ui('金额')}</span><strong>{moneyFormatter.format(Number.isFinite(summary.total_cost) ? summary.total_cost : 0)}</strong><small>{isCodexProxy ? ui('Codex Proxy 估算值') : isNewAPI ? ui('按 New API 额度换算') : ui('已配置单价模型')}</small></article>
                  {isNewAPI ? <article className="theme-settings-card cpa-usage-summary-card"><span>{ui("请求数")}</span><strong>{count(summary.total_calls)}</strong><small>{ui("New API 记录的调用次数")}</small></article> : <>
                    <article className="theme-settings-card cpa-usage-summary-card"><span>{isCodexProxy ? ui('文本输入') : ui('输入')}</span><strong>{count(summary.input_tokens)}</strong><small>input tokens</small></article>
                    <article className="theme-settings-card cpa-usage-summary-card"><span>{isCodexProxy ? ui('文本输出') : ui('输出')}</span><strong>{count(summary.output_tokens)}</strong><small>output tokens</small></article>
                  </>}
                  <article className="theme-settings-card cpa-usage-summary-card">
                    <span>{ui("缓存")}</span>
                    <strong>{isNewAPI && !hasNewAPICacheBreakdown ? '—' : count(cachedTokenTotal(summary))}</strong>
                    <small>
                      {typeof summary.cache_hit_rate === 'number' && Number.isFinite(summary.cache_hit_rate)
                        ? uiFormat("命中率 {0}", percentFormatter.format(Math.max(0, Math.min(1, summary.cache_hit_rate))))
                        : isNewAPI ? hasNewAPICacheBreakdown ? ui('读取 + 创建 Token，已包含在总量') : ui('上游未提供完整缓存明细') : ui('缓存 Token')}
                    </small>
                  </article>
                  {isCodexProxy ? <>
                    <article className="theme-settings-card cpa-usage-summary-card"><span>{ui("图片 Token")}</span><strong>{count((data?.proxy_image_stats?.input_tokens ?? 0) + (data?.proxy_image_stats?.output_tokens ?? 0))}</strong><small>{ui("图片请求：成功")} {count(data?.proxy_image_stats?.success_requests)} {ui("· 失败")} {count(data?.proxy_image_stats?.failed_requests)}</small></article>
                    <article className="theme-settings-card cpa-usage-summary-card"><span>{ui("活跃账号")}</span><strong>{count(data?.proxy_account_summary?.active_accounts)} / {count(data?.proxy_account_summary?.total_accounts)}</strong><small>{ui("当前状态，不受时间筛选影响")}</small></article>
                  </> : !isNewAPI ? <>
                    <article className="theme-settings-card cpa-usage-summary-card"><span>{ui("推理")}</span><strong>{count(summary.reasoning_tokens)}</strong><small>reasoning tokens</small></article>
                    <article className="theme-settings-card cpa-usage-summary-card"><span>{ui("失败请求")}</span><strong>{count(summary.failure_calls)}</strong><small>{ui("共")} {count(summary.success_calls)} {ui("次成功")}</small></article>
                  </> : null}
                </section>
                <section className="theme-settings-card cpa-usage-section">
                  <div className="theme-settings-card__heading"><div><h2><ChartColumnIncreasing size={16} />{ui("Token 趋势")}</h2><p>{ui("按小时或天汇总，时间范围使用当前设备时区。")}</p></div></div>
                  <div className="cpa-usage-section__body"><UsageTimeline points={data?.timeline ?? []} /></div>
                </section>
                {!isCodexProxy ? <div className={'cpa-usage-breakdown-grid' + (isNewAPI ? ' cpa-usage-breakdown-grid--single' : '')}>
                  <section className="theme-settings-card cpa-usage-section">
                    <div className="theme-settings-card__heading"><div><h2>{ui("按模型")}</h2><p>{models.length} {ui("个模型")}</p></div></div>
                    {models.length ? <div className="cpa-usage-table-wrap"><table className="cpa-usage-table"><thead><tr><th>{ui("模型")}</th><th>{ui("请求")}</th><th>{ui("金额")}</th><th>Token</th></tr></thead><tbody>{models.map((model) => <tr key={model.model}><td title={model.model}>{model.model || ui('未知模型')}</td><td>{count(model.calls)}</td><td>{typeof model.cost === 'number' && Number.isFinite(model.cost) ? moneyFormatter.format(model.cost) : '—'}</td><td>{count(model.total_tokens)}</td></tr>)}</tbody></table></div> : <div className="cpa-usage-empty">{ui("暂无模型数据。")}</div>}
                  </section>
                  {!isNewAPI ? <section className="theme-settings-card cpa-usage-section">
                    <div className="theme-settings-card__heading"><div><h2>{ui("按账号")}</h2><p>{accounts.length} {ui("个接入账号")}</p></div></div>
                    {accounts.length ? <div className="cpa-usage-table-wrap"><table className="cpa-usage-table"><thead><tr><th>{ui("账号")}</th><th>{ui("请求")}</th><th>Token</th></tr></thead><tbody>{accounts.map((account) => <tr key={account.id}><td title={accountLabel(account)}><span>{accountLabel(account)}</span>{account.auth_provider_snapshot ? <small>{account.auth_provider_snapshot}</small> : null}</td><td>{count(account.calls)}</td><td>{count(account.total_tokens)}</td></tr>)}</tbody></table></div> : <div className="cpa-usage-empty">{ui("暂无账号数据。")}</div>}
                  </section> : null}
                </div> : null}
              </>
            ) : null}
            {isCodexProxy ? <section className="theme-settings-card cpa-usage-section" aria-label={ui("各 Client Key 累计用量")}>
              <div className="theme-settings-card__heading"><div><h2>{ui("各 Client Key 用量")}</h2><p>{ui("当前 Key 自创建或上次重置以来的累计，不随上方时间范围变化；不包含主 Key 和已删除的 Key。")}</p></div></div>
              <div className="cpa-usage-section__body">
                {clientKeysLoading ? <div className="cpa-usage-loading"><RefreshCw size={16} className="spin" />{ui("正在读取各 Key 用量…")}</div> : null}
                {clientKeysError ? <div className="cpa-usage-error" role="alert"><strong>{ui("读取 Key 用量失败")}</strong><span>{uiMessage(clientKeysError)}</span><button type="button" onClick={() => setRefreshKey((value) => value + 1)}>{ui("重试")}</button></div> : null}
                {clientKeys && !clientKeysError ? <>
                  <p>{ui("当前")} {count(clientKeys.length)} {ui("个 Key 合计：")}{count(clientKeyTotals.tokens)} Token · {count(clientKeyTotals.requests)} {ui("次请求 · 估算")} {moneyFormatter.format(clientKeyTotals.cost)}</p>
                  {clientKeys.length ? <div className="cpa-usage-table-wrap"><table className="cpa-usage-table"><thead><tr><th>{ui("Key 名称")}</th><th>{ui("累计请求")}</th><th>{ui("累计 Token")}</th><th>{ui("估算金额")}</th><th>{ui("最近使用")}</th></tr></thead><tbody>{sortedClientKeys.map((key) => <tr key={key.id}><td><strong>{key.name || ui('未命名')}</strong><small>{key.id}</small></td><td>{count(key.request_count)}</td><td>{count(key.used_tokens)}</td><td>{moneyFormatter.format(key.used_cost_usd)}</td><td>{clientKeyLastUsed(key.last_used_at)}</td></tr>)}</tbody></table></div> : <div className="cpa-usage-empty">{ui("当前没有 Client Key。")}</div>}
                </> : null}
              </div>
            </section> : null}
            <p className="theme-settings-hint cpa-usage-disclaimer">{isCodexProxy
              ? ui('时间段汇总来自 Codex Proxy 的历史快照；各 Client Key 显示上游累计值。上游未提供按 Key 的时间段明细，已删除或重置前的 Key 用量无法在列表中恢复。')
              : isNewAPI
                ? ui('总 Token、请求数和模型明细来自 New API 的小时汇总；缓存明细在接口提供时显示，金额按额度单位换算成美元。当前小时可能延后写入；该接口不提供输入、输出及失败请求明细。')
              : ui('Token 数量直接显示 CPAMP 收到的用量统计，不在 Code Remote 中推算；金额按 Manager 中已配置的模型单价统计。若上游没有回报 Token 字段，或统计服务启用前的请求，不会出现在结果里。')}</p>
          </>
        )}
      </div>
    </main>
  )
}

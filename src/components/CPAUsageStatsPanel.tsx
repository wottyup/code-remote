import { useEffect, useMemo, useState } from 'react'
import { Activity, ChartColumnIncreasing, Database, RefreshCw, Settings2, X } from 'lucide-react'
import {
  fetchCPAUsageAnalytics,
  type CPAUsageAccountStat,
  type CPAUsageAnalyticsResponse,
  type CPAUsageModelStat,
  type CPAUsageRange,
  type CPAUsageSettings,
  type CPAUsageTimelinePoint,
} from '../lib/cpaUsageStats'

const numberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function count(value: number | undefined) {
  return numberFormatter.format(Number.isFinite(value) ? Math.max(0, value ?? 0) : 0)
}

function accountLabel(account: CPAUsageAccountStat) {
  return account.auth_label_snapshot || account.account_snapshot || account.id || '未命名账号'
}

function timelineTokens(point: CPAUsageTimelinePoint) {
  return point.total_tokens ?? point.tokens ?? 0
}

function UsageTimeline({ points }: { points: CPAUsageTimelinePoint[] }) {
  const maxTokens = Math.max(1, ...points.map(timelineTokens))
  if (!points.length) return <div className="cpa-usage-empty">所选时间段暂无趋势数据。</div>

  return (
    <div className="cpa-usage-timeline" role="img" aria-label="Token 用量趋势图">
      {points.map((point, index) => {
        const tokens = timelineTokens(point)
        const ratio = Math.max(tokens > 0 ? 3 : 0, (tokens / maxTokens) * 100)
        const label = point.label || dateTimeFormatter.format(new Date(point.bucket_ms))
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
  onOpenSettings,
  onClose,
}: {
  settings: CPAUsageSettings
  onOpenSettings: () => void
  onClose: () => void
}) {
  const [range, setRange] = useState<CPAUsageRange>('today')
  const [refreshKey, setRefreshKey] = useState(0)
  const [data, setData] = useState<CPAUsageAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!settings.baseUrl.trim() || !settings.managementKey.trim()) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }
    const controller = new AbortController()
    setData(null)
    setLoading(true)
    setError(null)
    fetchCPAUsageAnalytics(settings, range, controller.signal)
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
  }, [range, refreshKey, settings.baseUrl, settings.managementKey])

  const models = useMemo(
    () => [...(data?.model_stats ?? [])].sort((a, b) => b.total_tokens - a.total_tokens),
    [data?.model_stats],
  )
  const accounts = useMemo(
    () => [...(data?.account_stats ?? [])].sort((a, b) => b.total_tokens - a.total_tokens),
    [data?.account_stats],
  )
  const summary = data?.summary
  const configured = Boolean(settings.baseUrl.trim() && settings.managementKey.trim())
  const hasStats = Boolean(summary?.total_calls || summary?.total_tokens || models.length || accounts.length)

  return (
    <main className="theme-settings-panel cpa-usage-panel" aria-label="Token 用量统计">
      <header className="theme-settings-panel__header">
        <div>
          <span className="theme-settings-panel__eyebrow">TOKEN USAGE</span>
          <h1>Token 用量统计</h1>
          <p>数据来自你部署的 CPA-Manager-Plus Manager Server。</p>
        </div>
        <div className="cpa-usage-panel__header-actions">
          <button className="icon-button theme-settings-panel__close" type="button" aria-label="刷新统计" title="刷新统计" disabled={!configured || loading} onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={16} className={loading ? 'spin' : undefined} /></button>
          <button className="icon-button theme-settings-panel__close" type="button" aria-label="返回对话" onClick={onClose}><X size={18} /></button>
        </div>
      </header>
      <div className="theme-settings-panel__content cpa-usage-panel__content">
        {!configured ? (
          <section className="theme-settings-card cpa-usage-connect-prompt">
            <Database size={25} />
            <h2>先连接你的 Manager Server</h2>
            <p>填写部署域名和 Manager 密钥后，这里会显示该服务记录到的 Token 用量。</p>
            <button className="theme-notification-toggle theme-notification-toggle--enabled" type="button" onClick={onOpenSettings}><Settings2 size={14} />前往设置</button>
          </section>
        ) : (
          <>
            <section className="cpa-usage-toolbar">
              <div className="cpa-usage-range-tabs" role="group" aria-label="统计时间范围">
                {([
                  ['today', '今天'],
                  ['7d', '近 7 天'],
                  ['30d', '近 30 天'],
                ] as const).map(([value, label]) => (
                  <button className={range === value ? 'cpa-usage-range-tabs__active' : ''} key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>
                ))}
              </div>
              {data?.generated_at_ms ? <span>更新于 {dateTimeFormatter.format(new Date(data.generated_at_ms))}</span> : null}
            </section>
            {error ? <div className="cpa-usage-error" role="alert"><strong>读取失败</strong><span>{error}</span><button type="button" onClick={() => setRefreshKey((value) => value + 1)}>重试</button></div> : null}
            {loading && !data ? <div className="cpa-usage-loading"><RefreshCw size={16} className="spin" />正在读取统计…</div> : null}
            {!error && !loading && !hasStats ? <div className="cpa-usage-empty">这个时间段还没有统计数据。确认 CPAMP Full Mode 已开启 usage collector，并且已有请求经过 CLIProxyAPI。</div> : null}
            {summary ? (
              <>
                <section className="cpa-usage-summary-grid" aria-label="Token 用量概览">
                  <article className="theme-settings-card cpa-usage-summary-card cpa-usage-summary-card--primary"><span><Activity size={14} />总 Token</span><strong>{count(summary.total_tokens)}</strong><small>{count(summary.total_calls)} 次请求</small></article>
                  <article className="theme-settings-card cpa-usage-summary-card"><span>输入</span><strong>{count(summary.input_tokens)}</strong><small>input tokens</small></article>
                  <article className="theme-settings-card cpa-usage-summary-card"><span>输出</span><strong>{count(summary.output_tokens)}</strong><small>output tokens</small></article>
                  <article className="theme-settings-card cpa-usage-summary-card"><span>缓存命中</span><strong>{count(summary.cached_tokens)}</strong><small>cached tokens</small></article>
                  <article className="theme-settings-card cpa-usage-summary-card"><span>推理</span><strong>{count(summary.reasoning_tokens)}</strong><small>reasoning tokens</small></article>
                  <article className="theme-settings-card cpa-usage-summary-card"><span>失败请求</span><strong>{count(summary.failure_calls)}</strong><small>共 {count(summary.success_calls)} 次成功</small></article>
                </section>
                <section className="theme-settings-card cpa-usage-section">
                  <div className="theme-settings-card__heading"><div><h2><ChartColumnIncreasing size={16} />Token 趋势</h2><p>按小时或天汇总，时间范围使用当前设备时区。</p></div></div>
                  <div className="cpa-usage-section__body"><UsageTimeline points={data?.timeline ?? []} /></div>
                </section>
                <div className="cpa-usage-breakdown-grid">
                  <section className="theme-settings-card cpa-usage-section">
                    <div className="theme-settings-card__heading"><div><h2>按模型</h2><p>{models.length} 个模型</p></div></div>
                    {models.length ? <div className="cpa-usage-table-wrap"><table className="cpa-usage-table"><thead><tr><th>模型</th><th>请求</th><th>Token</th></tr></thead><tbody>{models.map((model) => <tr key={model.model}><td title={model.model}>{model.model || '未知模型'}</td><td>{count(model.calls)}</td><td>{count(model.total_tokens)}</td></tr>)}</tbody></table></div> : <div className="cpa-usage-empty">暂无模型数据。</div>}
                  </section>
                  <section className="theme-settings-card cpa-usage-section">
                    <div className="theme-settings-card__heading"><div><h2>按账号</h2><p>{accounts.length} 个接入账号</p></div></div>
                    {accounts.length ? <div className="cpa-usage-table-wrap"><table className="cpa-usage-table"><thead><tr><th>账号</th><th>请求</th><th>Token</th></tr></thead><tbody>{accounts.map((account) => <tr key={account.id}><td title={accountLabel(account)}><span>{accountLabel(account)}</span>{account.auth_provider_snapshot ? <small>{account.auth_provider_snapshot}</small> : null}</td><td>{count(account.calls)}</td><td>{count(account.total_tokens)}</td></tr>)}</tbody></table></div> : <div className="cpa-usage-empty">暂无账号数据。</div>}
                  </section>
                </div>
              </>
            ) : null}
            <p className="theme-settings-hint cpa-usage-disclaimer">Token 数量直接显示 CPAMP 收到的用量统计，不在 Codex Remote 中推算。若上游没有回报 Token 字段，或统计服务启用前的请求，不会出现在结果里。</p>
          </>
        )}
      </div>
    </main>
  )
}

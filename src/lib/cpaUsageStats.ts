import { codexRemoteClient } from './codexRemoteClient'

export type CPAUsageSource = 'cpamp' | 'codex-proxy' | 'new-api'

export interface CPAUsageSettings {
  source: CPAUsageSource
  baseUrl: string
  managementKey: string
  codexProxyBaseUrl: string
  codexProxyApiKey: string
  newAPIBaseUrl: string
  newAPIAccessToken: string
  newAPIUserId: string
}

export type CPAUsageRange = 'today' | 'yesterday' | '7d' | '30d'

export interface CPAUsageAnalyticsSummary {
  total_calls: number
  success_calls: number
  failure_calls: number
  input_tokens: number
  output_tokens: number
  cached_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
  cache_hit_rate?: number
  reasoning_tokens: number
  total_tokens: number
  total_cost: number
  success_rate: number
}

export interface CPAUsageTimelinePoint {
  bucket_ms: number
  label?: string
  calls: number
  tokens: number
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  cached_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

export interface CPAUsageModelStat {
  model: string
  calls: number
  total_tokens: number
  input_tokens?: number
  output_tokens?: number
  cost?: number
}

export interface CPAUsageAccountStat {
  id: string
  account_snapshot?: string
  auth_label_snapshot?: string
  auth_provider_snapshot?: string
  calls: number
  total_tokens: number
  input_tokens?: number
  output_tokens?: number
  cached_tokens?: number
  cost?: number
}

export interface CPAUsageAnalyticsResponse {
  generated_at_ms: number
  granularity?: string
  summary?: CPAUsageAnalyticsSummary
  timeline?: CPAUsageTimelinePoint[]
  model_stats?: CPAUsageModelStat[]
  account_stats?: CPAUsageAccountStat[]
  filter_options?: {
    api_key_hashes?: string[]
  }
  proxy_account_summary?: { total_accounts: number; active_accounts: number }
  proxy_image_stats?: { input_tokens: number; output_tokens: number; success_requests: number; failed_requests: number }
}

export interface CPAUsageAnalyticsRequestOptions {
  apiKeyHashes?: string[]
  filterSelectorsOnly?: boolean
}

interface CPAUsageRequestOptions extends CPAUsageAnalyticsRequestOptions {
  connectionProbe?: boolean
}

const settingsStorageKey = 'codex-remote.cpa-usage-settings'
const analyticsPath = '/v0/management/monitoring/analytics'

export const emptyCPAUsageSettings: CPAUsageSettings = {
  source: 'cpamp',
  baseUrl: '',
  managementKey: '',
  codexProxyBaseUrl: '',
  codexProxyApiKey: '',
  newAPIBaseUrl: '',
  newAPIAccessToken: '',
  newAPIUserId: '',
}

export function normalizeCPAUsageBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('地址格式无效，请填写 Manager Server 的 http(s) 地址。')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('地址必须以 http:// 或 https:// 开头。')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('地址中不能包含账号、密码、查询参数或片段。')
  }
  return trimmed
}

export function normalizeCodexProxyBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Codex Proxy 地址格式无效。')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || /\s/.test(trimmed)) {
    throw new Error('请填写 Codex Proxy 的 http(s) 服务地址，不包含账号、查询参数或片段。')
  }
  return trimmed
}

export function normalizeNewAPIBaseUrl(value: string) {
  try {
    return normalizeCodexProxyBaseUrl(value)
  } catch (reason) {
    throw new Error(reason instanceof Error ? reason.message.replaceAll('Codex Proxy', 'New API') : 'New API 地址格式无效。')
  }
}

export function normalizeNewAPIUserId(value: string) {
  const userId = value.trim()
  if (userId && !/^[1-9]\d{0,17}$/.test(userId)) throw new Error('New API 用户 ID 应为正整数。')
  return userId
}

export function readCPAUsageSettings(): CPAUsageSettings {
  if (typeof window === 'undefined') return emptyCPAUsageSettings
  try {
    const raw = window.localStorage.getItem(settingsStorageKey)
    if (!raw) return emptyCPAUsageSettings
    const value = JSON.parse(raw) as Record<string, unknown>
    return {
      source: value.source === 'codex-proxy' || value.source === 'new-api' ? value.source : 'cpamp',
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
      managementKey: typeof value.managementKey === 'string' ? value.managementKey : '',
      codexProxyBaseUrl: typeof value.codexProxyBaseUrl === 'string' ? value.codexProxyBaseUrl : '',
      codexProxyApiKey: typeof value.codexProxyApiKey === 'string' ? value.codexProxyApiKey : '',
      newAPIBaseUrl: typeof value.newAPIBaseUrl === 'string' ? value.newAPIBaseUrl : '',
      newAPIAccessToken: typeof value.newAPIAccessToken === 'string' ? value.newAPIAccessToken : '',
      newAPIUserId: typeof value.newAPIUserId === 'string' ? value.newAPIUserId : '',
    }
  } catch {
    return emptyCPAUsageSettings
  }
}

export function saveCPAUsageSettings(settings: CPAUsageSettings) {
  try {
    window.localStorage.setItem(settingsStorageKey, JSON.stringify(settings))
  } catch {
    // Settings still work for the current page when browser storage is unavailable.
  }
}

export function analyticsRangeBounds(range: CPAUsageRange, now = new Date()) {
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  if (range === 'yesterday') {
    from.setDate(from.getDate() - 1)
    const to = new Date(from)
    to.setDate(to.getDate() + 1)
    to.setTime(to.getTime() - 1)
    return { fromMs: from.getTime(), toMs: to.getTime() }
  }
  if (range === '7d') from.setDate(from.getDate() - 6)
  if (range === '30d') from.setDate(from.getDate() - 29)
  return { fromMs: from.getTime(), toMs: now.getTime() }
}

function requestError(status: number) {
  if (status === 401 || status === 403) return 'Manager 管理密钥无效，或没有读取用量统计的权限。'
  if (status === 404) return '没有找到用量分析接口。请确认填写的是 CPA-Manager-Plus Full Mode 的服务地址和反向代理路径。'
  if (status === 502 || status === 503 || status === 504) return `Manager Server 暂时不可用（HTTP ${status}）。`
  return `Manager Server 请求失败（HTTP ${status}）。`
}

export async function fetchCPAUsageAnalytics(
  settings: CPAUsageSettings,
  range: CPAUsageRange,
  signal?: AbortSignal,
  options: CPAUsageRequestOptions = {},
): Promise<CPAUsageAnalyticsResponse> {
  const baseUrl = normalizeCPAUsageBaseUrl(settings.baseUrl)
  const managementKey = settings.managementKey.trim()
  if (!baseUrl) throw new Error('请先在设置中填写 Manager Server 地址。')
  if (!managementKey) throw new Error('请先在设置中填写 Manager 管理密钥。')

  const nowMs = Date.now()
  const { fromMs, toMs } = options.connectionProbe
    ? { fromMs: Math.max(0, nowMs - 60_000), toMs: nowMs }
    : analyticsRangeBounds(range)
  const filterSelectorsOnly = options.connectionProbe || options.filterSelectorsOnly
  const timeoutMs = options.connectionProbe ? 20_000 : filterSelectorsOnly ? 45_000 : 90_000
  const timeout = new AbortController()
  const timeoutId = window.setTimeout(() => timeout.abort(), timeoutMs)
  const abortFromCaller = () => timeout.abort(signal?.reason)
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const response = await fetch(`${baseUrl}${analyticsPath}`, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managementKey}`,
      },
      body: JSON.stringify({
        from_ms: fromMs,
        to_ms: toMs,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        ...(options.apiKeyHashes?.length ? { filters: { api_key_hashes: options.apiKeyHashes } } : {}),
        include: filterSelectorsOnly
          ? { filter_options: true, filter_selectors: true }
          : {
              summary: true,
              summary_profile: 'compact',
              timeline: true,
              model_stats: true,
              account_stats: true,
              granularity: range === 'today' ? 'hour' : 'day',
            },
      }),
      signal: timeout.signal,
    })

    if (!response.ok) throw new Error(requestError(response.status))
    const payload = await response.json() as CPAUsageAnalyticsResponse
    if (!payload || typeof payload !== 'object') throw new Error('Manager Server 返回了无法识别的数据。')
    return payload
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith('Manager Server')) throw reason
    if (reason instanceof Error && (reason.name === 'AbortError' || reason.name === 'TimeoutError')) {
      if (signal?.aborted) throw reason
      throw new Error(options.connectionProbe
        ? '连接 Manager Server 超时。'
        : filterSelectorsOnly
          ? '读取 Manager 密钥筛选项超时，请稍后重试。'
          : '读取 Manager 用量统计超时，请缩短时间范围或稍后重试。')
    }
    if (reason instanceof TypeError || (reason instanceof Error && /fetch|network|load failed/i.test(reason.message))) {
      throw new Error('无法连接 Manager Server。请检查地址、HTTPS 和该服务的 CORS 来源设置。')
    }
    throw reason instanceof Error ? reason : new Error('读取用量统计失败。')
  } finally {
    window.clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function probeCPAUsageConnection(settings: CPAUsageSettings): Promise<void> {
  await fetchCPAUsageAnalytics(settings, 'today', undefined, { connectionProbe: true })
}

interface CodexProxySummary {
  total_request_count: number
  total_accounts: number
  active_accounts: number
}

interface CodexProxyHistoryPoint {
  timestamp: string
  input_tokens: number
  output_tokens: number
  cached_tokens?: number
  image_input_tokens?: number
  image_output_tokens?: number
  image_request_count?: number
  image_request_failed_count?: number
  estimated_cost_usd?: number
  request_count: number
}

interface CodexProxyHistory { data_points: CodexProxyHistoryPoint[] }

function finiteUsageNumber(value: unknown, label: string, optional = false): number {
  if (optional && value === undefined) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Codex Proxy 返回了无效的${label}数据。`)
  }
  return value
}

function codexProxyCredentials(settings: CPAUsageSettings) {
  const baseUrl = normalizeCodexProxyBaseUrl(settings.codexProxyBaseUrl)
  const apiKey = settings.codexProxyApiKey.trim()
  if (!baseUrl) throw new Error('请先在设置中填写 Codex Proxy 地址。')
  if (!apiKey) throw new Error('请先在设置中填写主 Proxy API Key。')
  return { baseUrl, apiKey }
}

export async function probeCodexProxyUsageConnection(settings: CPAUsageSettings, token: string): Promise<void> {
  const summary = await codexRemoteClient.codexProxyUsage<CodexProxySummary>(token, 'summary', codexProxyCredentials(settings))
  finiteUsageNumber(summary?.total_request_count, '累计请求')
}

export async function fetchCodexProxyUsageAnalytics(
  settings: CPAUsageSettings,
  token: string,
  range: CPAUsageRange,
  signal?: AbortSignal,
): Promise<CPAUsageAnalyticsResponse> {
  const credentials = codexProxyCredentials(settings)
  const now = new Date()
  const { fromMs, toMs } = analyticsRangeBounds(range, now)
  const hours = Math.min(744, Math.max(2, Math.ceil((now.getTime() - fromMs) / 3_600_000) + 2))
  const [summary, history] = await Promise.all([
    codexRemoteClient.codexProxyUsage<CodexProxySummary>(token, 'summary', credentials, signal),
    codexRemoteClient.codexProxyUsage<CodexProxyHistory>(token, 'history', { ...credentials, hours }, signal),
  ])
  finiteUsageNumber(summary?.total_request_count, '累计请求')
  const totalAccounts = finiteUsageNumber(summary.total_accounts, '账号总数')
  const activeAccounts = finiteUsageNumber(summary.active_accounts, '活跃账号数')
  if (!Array.isArray(history?.data_points)) throw new Error('Codex Proxy 返回了无效的历史数据。')

  const daily = range === '7d' || range === '30d'
  const buckets = new Map<number, CPAUsageTimelinePoint>()
  const totals = { input: 0, output: 0, cached: 0, imageInput: 0, imageOutput: 0, imageRequests: 0, imageFailed: 0, calls: 0, cost: 0 }
  for (const point of history.data_points) {
    const timestamp = Date.parse(point.timestamp)
    if (!Number.isFinite(timestamp)) throw new Error('Codex Proxy 返回了无效的统计时间。')
    if (timestamp < fromMs || timestamp > toMs) continue
    const input = finiteUsageNumber(point.input_tokens, '输入 Token')
    const output = finiteUsageNumber(point.output_tokens, '输出 Token')
    const cached = finiteUsageNumber(point.cached_tokens, '缓存 Token', true)
    const imageInput = finiteUsageNumber(point.image_input_tokens, '图片输入 Token', true)
    const imageOutput = finiteUsageNumber(point.image_output_tokens, '图片输出 Token', true)
    const imageRequests = finiteUsageNumber(point.image_request_count, '图片请求', true)
    const imageFailed = finiteUsageNumber(point.image_request_failed_count, '图片失败请求', true)
    const calls = finiteUsageNumber(point.request_count, '请求数')
    const cost = finiteUsageNumber(point.estimated_cost_usd, '估算金额', true)
    totals.input += input
    totals.output += output
    totals.cached += cached
    totals.imageInput += imageInput
    totals.imageOutput += imageOutput
    totals.imageRequests += imageRequests
    totals.imageFailed += imageFailed
    totals.calls += calls
    totals.cost += cost
    const date = new Date(timestamp)
    if (daily) date.setHours(0, 0, 0, 0)
    const bucketMs = daily ? date.getTime() : timestamp
    const existing = buckets.get(bucketMs)
    const tokens = input + output + imageInput + imageOutput
    if (existing) {
      existing.calls += calls
      existing.tokens += tokens
    } else {
      buckets.set(bucketMs, {
        bucket_ms: bucketMs, calls, tokens,
        label: daily ? `${date.getMonth() + 1}/${date.getDate()}` : undefined,
      })
    }
  }
  return {
    generated_at_ms: now.getTime(),
    granularity: daily ? 'day' : 'hour',
    summary: {
      total_calls: totals.calls, success_calls: 0, failure_calls: 0,
      input_tokens: totals.input, output_tokens: totals.output, cached_tokens: totals.cached,
      cache_hit_rate: totals.input > 0 ? totals.cached / totals.input : 0,
      reasoning_tokens: 0,
      total_tokens: totals.input + totals.output + totals.imageInput + totals.imageOutput,
      total_cost: totals.cost, success_rate: 0,
    },
    timeline: [...buckets.values()].sort((a, b) => a.bucket_ms - b.bucket_ms),
    proxy_account_summary: { total_accounts: totalAccounts, active_accounts: activeAccounts },
    proxy_image_stats: {
      input_tokens: totals.imageInput, output_tokens: totals.imageOutput,
      success_requests: totals.imageRequests, failed_requests: totals.imageFailed,
    },
  }
}

interface NewAPIUsageRow {
  created_at: number
  model_name?: string
  count: number
  token_used: number
  quota: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

interface NewAPIUsageData {
  rows: NewAPIUsageRow[]
  quota_per_unit: number
}

function newAPICredentials(settings: CPAUsageSettings) {
  const baseUrl = normalizeNewAPIBaseUrl(settings.newAPIBaseUrl)
  const accessToken = settings.newAPIAccessToken.trim()
  if (!baseUrl) throw new Error('请先在设置中填写 New API 地址。')
  if (!accessToken) throw new Error('请先在设置中填写 New API 面板访问令牌。')
  return { baseUrl, accessToken, userId: normalizeNewAPIUserId(settings.newAPIUserId) }
}

function newAPIUsageNumber(value: unknown, label: string, optional = false): number {
  if (optional && value === undefined) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`New API 返回了无效的${label}数据。`)
  }
  return value
}

export async function fetchNewAPIUsageAnalytics(
  settings: CPAUsageSettings,
  token: string,
  range: CPAUsageRange,
  signal?: AbortSignal,
): Promise<CPAUsageAnalyticsResponse> {
  const now = new Date()
  const { fromMs, toMs } = analyticsRangeBounds(range, now)
  const response = await codexRemoteClient.newAPIUsage<NewAPIUsageData>(token, {
    ...newAPICredentials(settings),
    startTimestamp: Math.floor(fromMs / 1000),
    endTimestamp: Math.floor(toMs / 1000),
  }, signal)
  if (!Array.isArray(response?.rows)) throw new Error('New API 未返回有效的用量列表。')
  const quotaPerUnit = newAPIUsageNumber(response.quota_per_unit, '额度换算')
  if (!quotaPerUnit) throw new Error('New API 返回了无效的额度换算设置。')

  const daily = range === '7d' || range === '30d'
  const buckets = new Map<number, CPAUsageTimelinePoint>()
  const models = new Map<string, CPAUsageModelStat>()
  const summary = {
    total_calls: 0, success_calls: 0, failure_calls: 0,
    input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
    total_tokens: 0, total_cost: 0, success_rate: 0,
  }
  let cacheReadTotal = 0
  let cacheCreationTotal = 0
  let cacheBreakdownComplete = true
  let includedRows = 0
  for (const row of response.rows) {
    const timestamp = newAPIUsageNumber(row?.created_at, '统计时间') * 1000
    if (timestamp < fromMs || timestamp > toMs) continue
    includedRows += 1
    const calls = newAPIUsageNumber(row.count, '请求数')
    const tokens = newAPIUsageNumber(row.token_used, 'Token')
    const quota = newAPIUsageNumber(row.quota, '额度')
    const cacheRead = newAPIUsageNumber(row.cache_read_tokens, '缓存读取 Token', true)
    const cacheCreation = newAPIUsageNumber(row.cache_creation_tokens, '缓存创建 Token', true)
    const cost = quota / quotaPerUnit
    const modelName = typeof row.model_name === 'string' && row.model_name.trim() ? row.model_name.trim() : '未知模型'
    summary.total_calls += calls
    summary.total_tokens += tokens
    summary.total_cost += cost
    cacheReadTotal += cacheRead
    cacheCreationTotal += cacheCreation
    if (row.cache_read_tokens === undefined || row.cache_creation_tokens === undefined) cacheBreakdownComplete = false

    const date = new Date(timestamp)
    if (daily) date.setHours(0, 0, 0, 0)
    const bucketMs = date.getTime()
    const bucket = buckets.get(bucketMs)
    if (bucket) {
      bucket.calls += calls
      bucket.tokens += tokens
    } else {
      buckets.set(bucketMs, {
        bucket_ms: bucketMs, calls, tokens,
        label: daily ? `${date.getMonth() + 1}/${date.getDate()}` : undefined,
      })
    }
    const model = models.get(modelName)
    if (model) {
      model.calls += calls
      model.total_tokens += tokens
      model.cost = (model.cost ?? 0) + cost
    } else {
      models.set(modelName, { model: modelName, calls, total_tokens: tokens, cost })
    }
  }
  return {
    generated_at_ms: now.getTime(),
    granularity: daily ? 'day' : 'hour',
    summary: {
      ...summary,
      ...(includedRows > 0 && cacheBreakdownComplete ? { cache_read_tokens: cacheReadTotal, cache_creation_tokens: cacheCreationTotal } : {}),
    },
    timeline: [...buckets.values()].sort((a, b) => a.bucket_ms - b.bucket_ms),
    model_stats: [...models.values()],
  }
}

export async function probeNewAPIUsageConnection(settings: CPAUsageSettings, token: string): Promise<void> {
  await fetchNewAPIUsageAnalytics(settings, token, 'today')
}

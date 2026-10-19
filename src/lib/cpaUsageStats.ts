export interface CPAUsageSettings {
  baseUrl: string
  managementKey: string
}

export type CPAUsageRange = 'today' | '7d' | '30d'

export interface CPAUsageAnalyticsSummary {
  total_calls: number
  success_calls: number
  failure_calls: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
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
}

const settingsStorageKey = 'codex-remote.cpa-usage-settings'
const analyticsPath = '/v0/management/monitoring/analytics'

export const emptyCPAUsageSettings: CPAUsageSettings = {
  baseUrl: '',
  managementKey: '',
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

export function readCPAUsageSettings(): CPAUsageSettings {
  if (typeof window === 'undefined') return emptyCPAUsageSettings
  try {
    const raw = window.localStorage.getItem(settingsStorageKey)
    if (!raw) return emptyCPAUsageSettings
    const value = JSON.parse(raw) as Record<string, unknown>
    return {
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
      managementKey: typeof value.managementKey === 'string' ? value.managementKey : '',
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
  if (range === '7d') from.setDate(from.getDate() - 6)
  if (range === '30d') from.setDate(from.getDate() - 29)
  return { fromMs: from.getTime(), toMs: now.getTime() }
}

function requestError(status: number) {
  if (status === 401 || status === 403) return 'Manager 密钥无效，或没有读取用量统计的权限。'
  if (status === 404) return '没有找到用量分析接口。请确认填写的是 CPA-Manager-Plus Full Mode 的服务地址和反向代理路径。'
  if (status === 502 || status === 503 || status === 504) return `Manager Server 暂时不可用（HTTP ${status}）。`
  return `Manager Server 请求失败（HTTP ${status}）。`
}

export async function fetchCPAUsageAnalytics(
  settings: CPAUsageSettings,
  range: CPAUsageRange,
  signal?: AbortSignal,
): Promise<CPAUsageAnalyticsResponse> {
  const baseUrl = normalizeCPAUsageBaseUrl(settings.baseUrl)
  const managementKey = settings.managementKey.trim()
  if (!baseUrl) throw new Error('请先在设置中填写 Manager Server 地址。')
  if (!managementKey) throw new Error('请先在设置中填写 Manager 密钥。')

  const { fromMs, toMs } = analyticsRangeBounds(range)
  const timeout = new AbortController()
  const timeoutId = window.setTimeout(() => timeout.abort(), 20_000)
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
        include: {
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
      throw new Error('连接 Manager Server 超时。')
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

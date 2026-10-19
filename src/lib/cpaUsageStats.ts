import { codexRemoteClient } from './codexRemoteClient'

export interface CPAUsageSettings {
  baseUrl: string
  configured: boolean
}

export interface LegacyCPAUsageCredentials {
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
}

export interface CPAUsageAnalyticsRequestOptions {
  apiKeyHashes?: string[]
  filterSelectorsOnly?: boolean
}

const settingsStorageKey = 'codex-remote.cpa-usage-settings'

export const emptyCPAUsageSettings: CPAUsageSettings = {
  baseUrl: '',
  configured: false,
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

export function readLegacyCPAUsageCredentials(): LegacyCPAUsageCredentials | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(settingsStorageKey)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl : ''
    const managementKey = typeof value.managementKey === 'string' ? value.managementKey : ''
    if (!baseUrl || !managementKey) return null
    return {
      baseUrl,
      managementKey,
    }
  } catch {
    return null
  }
}

export function clearLegacyCPAUsageCredentials() {
  try {
    window.localStorage.removeItem(settingsStorageKey)
  } catch {
    // The server-side settings remain authoritative if browser storage is unavailable.
  }
}

export function analyticsRangeBounds(range: CPAUsageRange, now = new Date()) {
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  if (range === '7d') from.setDate(from.getDate() - 6)
  if (range === '30d') from.setDate(from.getDate() - 29)
  return { fromMs: from.getTime(), toMs: now.getTime() }
}

export async function fetchCPAUsageAnalytics(
  token: string,
  range: CPAUsageRange,
  signal?: AbortSignal,
  options: CPAUsageAnalyticsRequestOptions = {},
): Promise<CPAUsageAnalyticsResponse> {
  const { fromMs, toMs } = analyticsRangeBounds(range)
  return codexRemoteClient.cpaUsageAnalytics<CPAUsageAnalyticsResponse>(token, {
    from_ms: fromMs,
    to_ms: toMs,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    ...(options.apiKeyHashes?.length ? { filters: { api_key_hashes: options.apiKeyHashes } } : {}),
    include: options.filterSelectorsOnly
      ? { filter_options: true, filter_selectors: true }
      : {
          summary: true,
          summary_profile: 'compact',
          timeline: true,
          model_stats: true,
          account_stats: true,
          granularity: range === 'today' ? 'hour' : 'day',
        },
  }, signal)
}

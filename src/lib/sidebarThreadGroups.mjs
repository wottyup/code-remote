export const sidebarThreadSectionOrder = ['置顶', '今天', '最近 7 天', '15 天内', '30 天内', '更早']

function threadDate(thread) {
  const value = thread.updatedAt ?? thread.createdAt
  if (typeof value === 'number') return new Date(value > 10_000_000_000 ? value : value * 1000)
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (value.trim() && Number.isFinite(numeric)) return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    return new Date(value)
  }
  return new Date(NaN)
}

function localCalendarDay(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000
}

export function sidebarThreadSection(thread, pinnedThreadIds, now = new Date()) {
  if (pinnedThreadIds.has(thread.id)) return '置顶'
  const updated = threadDate(thread)
  if (Number.isNaN(updated.getTime())) return '更早'
  const days = Math.max(0, localCalendarDay(now) - localCalendarDay(updated))
  if (days === 0) return '今天'
  if (days < 7) return '最近 7 天'
  if (days < 15) return '15 天内'
  if (days < 30) return '30 天内'
  return '更早'
}

export function groupSidebarThreads(threads, pinnedThreadIds, now = new Date()) {
  const sections = new Map(sidebarThreadSectionOrder.map((label) => [label, []]))
  for (const thread of threads) {
    sections.get(sidebarThreadSection(thread, pinnedThreadIds, now)).push(thread)
  }
  return sidebarThreadSectionOrder
    .map((label) => ({ label, threads: sections.get(label) }))
    .filter((section) => section.threads.length > 0)
}

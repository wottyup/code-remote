export const messageWindowBatchSize = 80

export interface MessageWindow {
  threadId: string | null
  start: number
  anchoredToLatest: boolean
}

export function recentMessageWindow(threadId: string | null, total: number): MessageWindow {
  return { threadId, start: Math.max(0, total - messageWindowBatchSize), anchoredToLatest: true }
}

export function visibleMessageStart(window: MessageWindow, threadId: string | null, total: number): number {
  if (window.threadId !== threadId || window.anchoredToLatest || window.start >= total) return recentMessageWindow(threadId, total).start
  return Math.max(0, window.start)
}

export function earlierMessageWindow(window: MessageWindow, threadId: string | null, total: number): MessageWindow {
  return { threadId, start: Math.max(0, visibleMessageStart(window, threadId, total) - messageWindowBatchSize), anchoredToLatest: false }
}

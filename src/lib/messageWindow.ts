export const messageWindowBatchSize = 80
export const messageTurnWindowBatchSize = 10

type ConversationMessage = { role: 'user' | 'assistant' }

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

function recentTurnStart(messages: readonly ConversationMessage[], before: number): number {
  let userTurns = 0
  for (let index = before - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user') continue
    userTurns += 1
    if (userTurns === messageTurnWindowBatchSize) return index
  }
  return 0
}

export function recentTurnMessageWindow(threadId: string | null, messages: readonly ConversationMessage[]): MessageWindow {
  return { threadId, start: recentTurnStart(messages, messages.length), anchoredToLatest: true }
}

export function visibleTurnMessageStart(window: MessageWindow, threadId: string | null, messages: readonly ConversationMessage[]): number {
  if (window.threadId !== threadId || window.anchoredToLatest || window.start >= messages.length) {
    return recentTurnStart(messages, messages.length)
  }
  return Math.max(0, window.start)
}

export function earlierTurnMessageWindow(window: MessageWindow, threadId: string | null, messages: readonly ConversationMessage[]): MessageWindow {
  const start = visibleTurnMessageStart(window, threadId, messages)
  return { threadId, start: recentTurnStart(messages, start), anchoredToLatest: false }
}

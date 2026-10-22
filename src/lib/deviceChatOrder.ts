import type { DeviceChatMessage } from './codexRemoteClient'

const mirroredTurnId = /^(thread:[0-9a-f]{40}):(user|assistant)$/

/** Keep a mirrored ordinary turn together even if its user item arrived late. */
export function orderDeviceChatMessages(messages: DeviceChatMessage[]): DeviceChatMessage[] {
  const firstSequenceByTurn = new Map<string, number>()
  for (const message of messages) {
    const match = mirroredTurnId.exec(message.id)
    if (!match || message.sequence < 0) continue
    firstSequenceByTurn.set(match[1], Math.min(firstSequenceByTurn.get(match[1]) ?? message.sequence, message.sequence))
  }
  const position = (message: DeviceChatMessage) => {
    const match = mirroredTurnId.exec(message.id)
    const first = match ? firstSequenceByTurn.get(match[1]) : undefined
    return first === undefined ? message.sequence : first + (match?.[2] === 'assistant' ? 0.25 : 0)
  }
  return [...messages].sort((left, right) => {
    if (left.sequence < 0) return right.sequence < 0 ? 0 : 1
    if (right.sequence < 0) return -1
    return position(left) - position(right) || left.sequence - right.sequence
  })
}

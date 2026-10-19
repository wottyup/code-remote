import type { AIGroupEngine } from './aiGroupChats'

export type AIGroupRecipient = {
  engine: AIGroupEngine
  matchedName: string
  remainder: string
}

export function findGroupRecipient(
  prompt: string,
  group: { codexName: string; claudeName: string },
): AIGroupRecipient | { ambiguous: true } | null

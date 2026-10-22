export interface MessageChoiceGroup {
  question: string
  options: string[]
}

const optionLine = /^\s*(?:[-*]\s+|\d{1,2}[.)、]\s+)(.+?)\s*$/u
const fenceLine = /^\s{0,3}(?:```|~~~)/u

function plainQuestionLine(value: string) {
  return value.trim()
    .replace(/^(?:>\s*)+/u, '')
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^\d{1,2}[.)、]\s+/u, '')
    .replace(/^\*\*(.+)\*\*$/u, '$1')
    .replace(/^__(.+)__$/u, '$1')
    .trim()
}

export function parseAssistantChoiceGroups(value: string): MessageChoiceGroup[] {
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  const candidates: Array<{ group: MessageChoiceGroup; start: number; end: number }> = []
  let inCodeFence = false

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index].trim()
    if (fenceLine.test(rawLine)) {
      inCodeFence = !inCodeFence
      continue
    }
    const question = plainQuestionLine(rawLine)
    if (inCodeFence || question.length < 4 || question.length > 220
      || !/[?？]$/u.test(question)) continue

    let cursor = index + 1
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1
    const options: string[] = []
    while (cursor < lines.length) {
      const option = optionLine.exec(lines[cursor])?.[1]?.trim()
      if (!option) break
      options.push(option)
      cursor += 1
    }
    if (options.length < 2 || options.length > 6 || options.some((option) => option.length > 180)) continue
    candidates.push({ group: { question, options }, start: index, end: cursor - 1 })
    index = cursor - 1
  }

  // A question followed by more prose may be an explanation, not a request
  // for an answer. Only surface choices when the reply ends with the list.
  let lastContentLine = lines.length - 1
  while (lastContentLine >= 0 && !lines[lastContentLine].trim()) lastContentLine -= 1
  const groups: MessageChoiceGroup[] = []
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]
    if (candidate.end !== lastContentLine) break
    groups.unshift(candidate.group)
    if (groups.length > 3) return []
    lastContentLine = candidate.start - 1
    while (lastContentLine >= 0 && !lines[lastContentLine].trim()) lastContentLine -= 1
  }
  return groups
}

export function formatAssistantChoiceReply(groups: MessageChoiceGroup[], selected: number[]) {
  return groups.map((group, index) => `${index + 1}. ${group.question}\n答：${group.options[selected[index]]}`).join('\n\n')
}

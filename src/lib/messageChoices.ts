export interface MessageChoiceGroup {
  question: string
  options: string[]
  descriptions?: string[]
}

export interface MessageChoiceContent {
  groups: MessageChoiceGroup[]
  onlyChoices: boolean
}

const optionLine = /^\s*([-*+]|\d{1,2}[.)、])\s+(.+?)\s*$/u
const fenceLine = /^\s{0,3}(?:```|~~~)/u

export function parseStructuredAssistantQuestions(value: unknown): MessageChoiceGroup[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) return []
  const groups = value.map((entry): MessageChoiceGroup | null => {
    if (!entry || typeof entry !== 'object') return null
    const question = entry as Record<string, unknown>
    const title = typeof question.title === 'string' && question.title.trim()
      ? question.title.trim()
      : typeof question.question === 'string' ? question.question.trim() : ''
    const rawOptions = question.options == null ? [] : question.options
    if (!title || title.length > 1000 || !Array.isArray(rawOptions) || rawOptions.length > 12) return null
    const options: string[] = []
    const descriptions: string[] = []
    for (const rawOption of rawOptions) {
      const option = rawOption && typeof rawOption === 'object' ? rawOption as Record<string, unknown> : null
      const rawLabel = typeof rawOption === 'string' ? rawOption : option?.label
      const label = typeof rawLabel === 'string' ? rawLabel.trim() : ''
      if (!label || label.length > 500) return null
      options.push(label)
      descriptions.push(typeof option?.description === 'string' ? option.description.trim() : '')
    }
    return { question: title, options, ...(descriptions.some(Boolean) ? { descriptions } : {}) }
  })
  return groups.every((group): group is MessageChoiceGroup => group !== null) ? groups : []
}

function plainQuestionLine(value: string) {
  return value.trim()
    .replace(/^(?:>\s*)+/u, '')
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^\d{1,2}[.)、]\s+/u, '')
    .replace(/^\*\*(.+)\*\*$/u, '$1')
    .replace(/^__(.+)__$/u, '$1')
    .trim()
}

export function parseAssistantChoiceContent(value: string): MessageChoiceContent {
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
      || !/[?？]/u.test(question.replace(/`[^`]*`|https?:\/\/\S+/gu, ''))) continue

    let cursor = index + 1
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1
    const options: string[] = []
    let numberedOptions: boolean | null = null
    let end = cursor - 1
    while (cursor < lines.length) {
      if (!lines[cursor].trim()) {
        cursor += 1
        continue
      }
      const option = optionLine.exec(lines[cursor])
      if (!option) break
      const numbered = /^\d/u.test(option[1])
      // A numbered heading after bullet options starts the next question.
      if (numberedOptions !== null && numberedOptions !== numbered) break
      numberedOptions = numbered
      options.push(option[2].trim())
      end = cursor
      cursor += 1
    }
    if (options.length < 2 || options.length > 6 || options.some((option) => option.length > 180)) continue
    candidates.push({ group: { question, options }, start: index, end })
    index = end
  }

  // Direct questions stay answerable when the assistant adds progress text.
  // Other question-shaped lists must still end the reply to avoid promoting
  // ordinary explanations into interactive questions.
  let lastContentLine = lines.length - 1
  while (lastContentLine >= 0 && !lines[lastContentLine].trim()) lastContentLine -= 1
  const selected: typeof candidates = []
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]
    const atEnd = candidate.end === lastContentLine
    const question = candidate.group.question.split(/[?？]/u)[0]
    const asksReader = /你|您|请选择|选择|选哪|哪(?:个|种|一)|希望|偏好|倾向|还是|或者|或是|\b(?:you|your|which|choose|prefer)\b/iu.test(question)
    if (!atEnd && !asksReader) continue
    selected.unshift(candidate)
    if (selected.length > 3) return { groups: [], onlyChoices: false }
    if (atEnd) {
      lastContentLine = candidate.start - 1
      while (lastContentLine >= 0 && !lines[lastContentLine].trim()) lastContentLine -= 1
    }
  }
  return {
    groups: selected.map(({ group }) => group),
    onlyChoices: selected.length > 0 && lines.every((line, index) => !line.trim()
      || selected.some(({ start, end }) => start <= index && index <= end)),
  }
}

export function parseAssistantChoiceGroups(value: string): MessageChoiceGroup[] {
  return parseAssistantChoiceContent(value).groups
}

export function assistantChoiceStartIndex(messages: readonly { role: 'user' | 'assistant' }[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return index + 1
  }
  return 0
}

export function formatAssistantChoiceReply(groups: MessageChoiceGroup[], selected: number[], customAnswers: string[] = []) {
  return groups.map((group, index) => `${index + 1}. ${group.question}\n答：${selected[index] === -2 ? customAnswers[index].trim() : group.options[selected[index]]}`).join('\n\n')
}

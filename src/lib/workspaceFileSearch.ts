export interface FileSearchMatch {
  start: number
  end: number
}

/** Literal, non-overlapping matches; regexp folding preserves UTF-16 selection offsets. */
export function findFileTextMatches(text: string, query: string, matchCase = false): FileSearchMatch[] {
  if (!query) return []
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(escaped, matchCase ? 'gu' : 'giu')
  return Array.from(text.matchAll(pattern), (match) => ({ start: match.index, end: match.index + match[0].length }))
}

/** Find from a caret offset and wrap at either end of the file. */
export function fileMatchIndexAt(matches: readonly FileSearchMatch[], position: number, backwards = false): number {
  if (!matches.length) return -1
  if (backwards) {
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      if (matches[index].start <= position) return index
    }
    return matches.length - 1
  }
  const index = matches.findIndex((match) => match.start >= position)
  return index < 0 ? 0 : index
}

/** Replacement is literal, including dollar signs, and inserted text is never matched again. */
export function replaceFileTextMatches(text: string, matches: readonly FileSearchMatch[], replacement: string): string {
  const parts: string[] = []
  let offset = 0
  for (const match of matches) {
    parts.push(text.slice(offset, match.start), replacement)
    offset = match.end
  }
  parts.push(text.slice(offset))
  return parts.join('')
}

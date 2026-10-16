export type MarkdownTableAlignment = 'left' | 'center' | 'right'

export interface MarkdownTableBlock {
  headers: string[]
  alignments: MarkdownTableAlignment[]
  rows: string[][]
  nextLine: number
}

export function parseMarkdownTableBlock(lines: string[], startIndex: number): MarkdownTableBlock | null

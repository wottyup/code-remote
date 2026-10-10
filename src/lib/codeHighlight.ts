import hljs from 'highlight.js/lib/core'
import type { AutoHighlightResult, LanguageFn } from 'highlight.js'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import cmake from 'highlight.js/lib/languages/cmake'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import dos from 'highlight.js/lib/languages/dos'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import gradle from 'highlight.js/lib/languages/gradle'
import groovy from 'highlight.js/lib/languages/groovy'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const batchWithStrings: LanguageFn = (highlighter) => {
  const language = dos(highlighter)
  return {
    ...language,
    contains: [highlighter.QUOTE_STRING_MODE, ...(language.contains ?? [])],
  }
}

const languages = {
  bash,
  c,
  cpp,
  cmake,
  csharp,
  css,
  dos: batchWithStrings,
  dockerfile,
  go,
  gradle,
  groovy,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  php,
  powershell,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
} as const

for (const [name, language] of Object.entries(languages)) {
  hljs.registerLanguage(name, language)
}

export interface HighlightedCodeSegment {
  text: string
  className: string
}

const languageByExtension: Record<string, string> = {
  bash: 'bash',
  bat: 'dos',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cmd: 'dos',
  cpp: 'cpp',
  cs: 'csharp',
  csh: 'bash',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  dockerfile: 'dockerfile',
  go: 'go',
  gradle: 'gradle',
  groovy: 'groovy',
  h: 'c',
  hpp: 'cpp',
  hxx: 'cpp',
  htm: 'xml',
  html: 'xml',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'css',
  md: 'markdown',
  markdown: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  php: 'php',
  ps1: 'powershell',
  psd1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  pyw: 'python',
  rs: 'rust',
  sass: 'css',
  scss: 'css',
  sh: 'bash',
  sql: 'sql',
  svg: 'xml',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

const plainTextExtensions = new Set(['csv', 'log', 'text', 'tsv', 'txt'])
const autoDetectionSampleLength = 16 * 1024

const escapedEntities: Record<string, string> = {
  amp: '&',
  gt: '>',
  lt: '<',
  quot: '"',
  '#x27': "'",
}

function decodeHighlightedText(value: string) {
  return value.replace(/&(?:amp|lt|gt|quot|#x27);/gi, (entity) => escapedEntities[entity.slice(1, -1).toLowerCase()] ?? entity)
}

function appendSegment(line: HighlightedCodeSegment[], text: string, scopes: string[]) {
  if (!text) return
  const className = scopes.join(' ')
  const previous = line.at(-1)
  if (previous?.className === className) {
    previous.text += text
    return
  }
  line.push({ text, className })
}

function splitHighlightedMarkup(markup: string): HighlightedCodeSegment[][] {
  const lines: HighlightedCodeSegment[][] = [[]]
  const scopes: string[] = []
  const markupToken = /<span class="([^"]+)">|<\/span>|[^<]+|</g
  let match: RegExpExecArray | null

  while ((match = markupToken.exec(markup)) !== null) {
    if (match[1]) {
      scopes.push(match[1])
      continue
    }
    if (match[0] === '</span>') {
      scopes.pop()
      continue
    }

    const chunks = match[0].split(/(\r\n|\n|\r)/)
    for (const chunk of chunks) {
      if (/^(\r\n|\n|\r)$/.test(chunk)) {
        lines.push([])
        continue
      }
      appendSegment(lines.at(-1)!, decodeHighlightedText(chunk), scopes)
    }
  }
  return lines
}

function plainTextLines(content: string): HighlightedCodeSegment[][] {
  const lines = content.split(/\r\n|\n|\r/)
  if (lines.length > 1 && lines.at(-1) === '' && /(?:\r\n|\n|\r)$/.test(content)) lines.pop()
  return lines.map((text) => text ? [{ text, className: '' }] : [])
}

function languageForPath(path: string) {
  const filename = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  if (filename === 'dockerfile' || filename.startsWith('dockerfile.')) return 'dockerfile'
  if (filename === 'makefile' || filename === 'gnumakefile') return 'makefile'
  if (filename === 'cmakelists.txt') return 'cmake'
  if (filename === 'jenkinsfile') return 'groovy'
  if (filename === 'gradlew') return 'bash'

  const extension = filename.split('.').at(-1) ?? ''
  return languageByExtension[extension] ?? null
}

function isConfidentAutoDetection(result: AutoHighlightResult, content: string) {
  if (!result.language || result.relevance < 3) return false

  const hasStructuralSyntax = /[{}()\[\];=<>]|=>|::|:=/.test(content)
  const hasMarkdownSyntax = /^\s{0,3}(?:#{1,6}\s|>\s|[-+*]\s|\d+\.\s)|\[[^\]]+\]\([^)]+\)/m.test(content)
  const hasLanguageKeywords = /\b(?:function|const|let|var|def|class|struct|enum|fn|func|return|package|import|export|select|create|update|insert|from|where|puts|write-host)\b/i.test(content)
  const hasConfigSyntax = /^\s*[\w.-]+\s*:\s+\S/m.test(content)
  const secondBestRelevance = result.secondBest?.relevance ?? 0

  // Syntax markers let short but structured files pass even when related
  // languages (for example JavaScript and TypeScript) have similar scores.
  if (hasStructuralSyntax || hasMarkdownSyntax || hasLanguageKeywords || hasConfigSyntax) return true

  // For less structured formats, require a clear lead over other candidates.
  return result.relevance >= 6 && result.relevance - secondBestRelevance >= 2
}

function highlightedLines(markup: string, content: string): HighlightedCodeSegment[][] {
  const lines = splitHighlightedMarkup(markup)
  if (lines.length > 1 && lines.at(-1)?.length === 0 && /(?:\r\n|\n|\r)$/.test(content)) lines.pop()
  return lines
}

export async function highlightCodeLines(path: string, content: string): Promise<HighlightedCodeSegment[][]> {
  const language = languageForPath(path)
  if (language) {
    try {
      const result = hljs.highlight(content, { language, ignoreIllegals: true })
      return highlightedLines(result.value, content)
    } catch {
      return plainTextLines(content)
    }
  }

  const filename = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  const extension = filename.split('.').at(-1) ?? ''
  if (!content.trim() || plainTextExtensions.has(extension)) return plainTextLines(content)

  try {
    // Keep the full language bundle out of the normal preview path; it is
    // fetched only when an extension has no explicit grammar mapping.
    const { default: autoHighlighter } = await import('highlight.js')
    const detectionSample = content.slice(0, autoDetectionSampleLength)
    const result = autoHighlighter.highlightAuto(detectionSample)
    if (!result.language || !isConfidentAutoDetection(result, detectionSample)) return plainTextLines(content)
    const highlighted = autoHighlighter.highlight(content, { language: result.language, ignoreIllegals: true })
    return highlightedLines(highlighted.value, content)
  } catch {
    return plainTextLines(content)
  }
}

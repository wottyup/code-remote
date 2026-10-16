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
import { workspaceFileType } from './workspaceFileTypes'

const batchWithStrings: LanguageFn = (highlighter) => {
  const language = dos(highlighter)
  return {
    ...language,
    contains: [highlighter.QUOTE_STRING_MODE, ...(language.contains ?? [])],
  }
}

const jsonWithComments: LanguageFn = (highlighter) => ({
  name: 'JSON with comments and JSON5',
  contains: [
    highlighter.C_LINE_COMMENT_MODE,
    highlighter.C_BLOCK_COMMENT_MODE,
    {
      className: 'attr',
      begin: /(?:[A-Za-z_$][\w$-]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(?=\s*:)/,
      relevance: 0,
    },
    {
      className: 'string',
      begin: /"/,
      end: /"/,
      contains: [highlighter.BACKSLASH_ESCAPE],
      relevance: 0,
    },
    {
      className: 'string',
      begin: /'/,
      end: /'/,
      contains: [highlighter.BACKSLASH_ESCAPE],
      relevance: 0,
    },
    {
      className: 'literal',
      begin: /\b(?:true|false|null|undefined)\b/,
      relevance: 0,
    },
    {
      className: 'number',
      begin: /[+-]?(?:0[xX][\da-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|Infinity|NaN)\b/,
      relevance: 0,
    },
    { className: 'punctuation', begin: /[{}\[\],:]/, relevance: 0 },
  ],
})

const toml: LanguageFn = (highlighter) => ({
  name: 'TOML',
  contains: [
    highlighter.HASH_COMMENT_MODE,
    { className: 'section', begin: /^\s*\[\[/, end: /\]\]/, relevance: 0 },
    { className: 'section', begin: /^\s*\[/, end: /\]/, relevance: 0 },
    {
      className: 'attr',
      begin: /^[\t ]*(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*|"(?:\\.|[^"\\])*"|'[^']*')(?=[\t ]*=)/,
      relevance: 0,
    },
    { className: 'string', begin: /"""/, end: /"""/, contains: [highlighter.BACKSLASH_ESCAPE], relevance: 0 },
    { className: 'string', begin: /'''/, end: /'''/, relevance: 0 },
    { className: 'string', begin: /"/, end: /"/, contains: [highlighter.BACKSLASH_ESCAPE], relevance: 0 },
    { className: 'string', begin: /'/, end: /'/, relevance: 0 },
    { className: 'literal', begin: /\b(?:true|false)\b/, relevance: 0 },
    {
      className: 'number',
      begin: /\b\d{4}-\d\d-\d\d(?:[Tt ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?)?\b/,
      relevance: 0,
    },
    highlighter.C_NUMBER_MODE,
    { className: 'punctuation', begin: /[=,.{}\[\]]/, relevance: 0 },
  ],
})

const proguard: LanguageFn = (highlighter) => ({
  name: 'ProGuard',
  case_insensitive: true,
  contains: [
    highlighter.HASH_COMMENT_MODE,
    highlighter.QUOTE_STRING_MODE,
    { className: 'meta-keyword', begin: /^\s*-[A-Za-z][\w-]*/, relevance: 0 },
    {
      className: 'keyword',
      begin: /\b(?:class|interface|enum|extends|implements|public|protected|private|static|final|abstract|native|synchronized|volatile|transient|strictfp|annotation)\b/,
      relevance: 0,
    },
    { className: 'built_in', begin: /\b(?:void|boolean|byte|char|short|int|long|float|double)\b/, relevance: 0 },
    { className: 'title', begin: /(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?=\s*(?:\(|\{|;))/, relevance: 0 },
    highlighter.C_NUMBER_MODE,
    { className: 'punctuation', begin: /[{}()[\],;:*?=]/, relevance: 0 },
  ],
})

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
  json5: jsonWithComments,
  jsonc: jsonWithComments,
  kotlin,
  makefile,
  markdown,
  php,
  powershell,
  python,
  proguard,
  rust,
  sql,
  toml,
  typescript,
  xml,
  yaml,
} as const

for (const [name, language] of Object.entries(languages)) {
  hljs.registerLanguage(name, language)
}

const lazyLanguages: Record<string, () => Promise<{ default: LanguageFn }>> = {
  '1c': () => import('highlight.js/lib/languages/1c'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  dart: () => import('highlight.js/lib/languages/dart'),
  diff: () => import('highlight.js/lib/languages/diff'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erb: () => import('highlight.js/lib/languages/erb'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  fsharp: () => import('highlight.js/lib/languages/fsharp'),
  glsl: () => import('highlight.js/lib/languages/glsl'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  handlebars: () => import('highlight.js/lib/languages/handlebars'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  ini: () => import('highlight.js/lib/languages/ini'),
  latex: () => import('highlight.js/lib/languages/latex'),
  less: () => import('highlight.js/lib/languages/less'),
  lisp: () => import('highlight.js/lib/languages/lisp'),
  lua: () => import('highlight.js/lib/languages/lua'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  nix: () => import('highlight.js/lib/languages/nix'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  perl: () => import('highlight.js/lib/languages/perl'),
  properties: () => import('highlight.js/lib/languages/properties'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scheme: () => import('highlight.js/lib/languages/scheme'),
  scss: () => import('highlight.js/lib/languages/scss'),
  swift: () => import('highlight.js/lib/languages/swift'),
  tcl: () => import('highlight.js/lib/languages/tcl'),
  vbnet: () => import('highlight.js/lib/languages/vbnet'),
  vbscript: () => import('highlight.js/lib/languages/vbscript'),
  vim: () => import('highlight.js/lib/languages/vim'),
  wasm: () => import('highlight.js/lib/languages/wasm'),
  x86asm: () => import('highlight.js/lib/languages/x86asm'),
}

const languageAliases: Record<string, string> = {
  asm: 'x86asm',
  batch: 'dos',
  bat: 'dos',
  csharp: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cxx: 'cpp',
  fish: 'bash',
  gql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  html: 'xml',
  htm: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  javascriptreact: 'javascript',
  jsonl: 'json',
  ndjson: 'json',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  mdx: 'markdown',
  objc: 'objectivec',
  'objective-c': 'objectivec',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  tsx: 'typescript',
  typescriptreact: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
}

const plainLanguageHints = new Set(['plain', 'plaintext', 'text', 'txt', 'none'])

function normalizeLanguageHint(languageHint: string | undefined): { language: string | null; plainText: boolean } | null {
  if (!languageHint) return null
  const name = languageHint.trim().toLowerCase().replace(/^language-/, '').split(/[\s,]+/, 1)[0]
  if (!name) return null
  if (plainLanguageHints.has(name)) return { language: null, plainText: true }
  return { language: languageAliases[name] ?? name, plainText: false }
}

async function ensureLanguage(language: string) {
  if (hljs.getLanguage(language)) return true
  const loader = lazyLanguages[language]
  if (!loader) return false
  try {
    hljs.registerLanguage(language, (await loader()).default)
    return true
  } catch {
    return false
  }
}

export interface HighlightedCodeSegment {
  text: string
  className: string
}

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

export async function highlightCodeLines(path: string, content: string, languageHint?: string, allowAutoDetection = true): Promise<HighlightedCodeSegment[][]> {
  const fileType = workspaceFileType(path)
  const normalizedHint = normalizeLanguageHint(languageHint)
  if (normalizedHint?.plainText) return plainTextLines(content)
  const language = normalizedHint?.language ?? fileType.language
  if (language && await ensureLanguage(language)) {
    try {
      const result = hljs.highlight(content, { language, ignoreIllegals: true })
      return highlightedLines(result.value, content)
    } catch {
      return plainTextLines(content)
    }
  }

  if (!allowAutoDetection) return plainTextLines(content)
  if (!content.trim() || fileType.plainText) return plainTextLines(content)

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

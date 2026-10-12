export const maxDocumentFileSize = 20 * 1024 * 1024
export const maxDocumentTextLength = 40_000
export const maxDocumentsPerTurn = 8
export const maxDocumentTextPerTurn = 120_000

const documentExtensions = new Set([
  'pdf', 'doc', 'docx', 'docm', 'dotx', 'dotm', 'xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'xltm', 'ppt', 'pptx', 'pptm', 'potx', 'potm',
  'odt', 'ods', 'odp', 'fodt', 'fods', 'fodp', 'rtf',
  'txt', 'text', 'md', 'markdown', 'mdx', 'mdc', 'rst', 'adoc', 'textile', 'prompt', 'tex', 'csv', 'tsv',
  'json', 'json5', 'jsonc', 'jsonl', 'ndjson', 'xml', 'xsd', 'xsl', 'xslt', 'html', 'htm', 'xhtml', 'svg',
  'css', 'scss', 'sass', 'less', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config', 'properties', 'env', 'log', 'lock',
  'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx', 'm', 'mm',
  'cs', 'csx', 'csproj', 'sln', 'fs', 'fsx', 'vb', 'java', 'kt', 'kts', 'scala', 'gradle', 'groovy', 'go', 'rs', 'py', 'pyi', 'ipynb', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  'vue', 'svelte', 'php', 'rb', 'r', 'swift', 'dart', 'lua', 'pl', 'pm', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'edn',
  'hs', 'lhs', 'elm', 'graphql', 'gql', 'proto', 'diff', 'patch', 'tf', 'tfvars', 'hcl', 'nix', 'cmake', 'makefile', 'dockerfile', 'eml', 'ics', 'vcf',
])

const specialTextNames = new Set([
  'dockerfile', 'makefile', 'cmakelists.txt', 'gemfile', 'procfile', 'license', 'readme',
  '.gitignore', '.gitattributes', '.editorconfig', '.env', '.env.local', '.env.example',
])

export const documentAttachmentAccept = [
  ...[...documentExtensions].map((extension) => `.${extension}`),
  'text/*',
  'application/pdf',
  'application/rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
].join(',')

export function documentExtensionOf(name: string) {
  const lowerName = name.toLowerCase()
  if (lowerName.startsWith('.env')) return 'env'
  if (specialTextNames.has(lowerName)) return lowerName
  return lowerName.split('.').at(-1) ?? ''
}

export function isSupportedDocumentFile(file: Pick<File, 'name' | 'type'>) {
  return specialTextNames.has(file.name.toLowerCase())
    || documentExtensions.has(documentExtensionOf(file.name))
    || file.type.startsWith('text/')
    || file.type === 'application/json'
    || file.type === 'application/xml'
}

export function isPlainTextDocumentExtension(extension: string) {
  return documentExtensions.has(extension) && ![
  'pdf', 'doc', 'docx', 'docm', 'dotx', 'dotm', 'xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'xltm', 'ppt', 'pptx', 'pptm', 'potx', 'potm',
  'odt', 'ods', 'odp', 'fodt', 'fods', 'fodp', 'rtf',
  ].includes(extension)
}

export function isSpecialTextDocumentName(name: string) {
  return specialTextNames.has(name.toLowerCase())
}

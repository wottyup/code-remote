export type WorkspaceFileTone =
  | 'archive'
  | 'compiled'
  | 'config'
  | 'data'
  | 'document'
  | 'generic'
  | 'image'
  | 'javascript'
  | 'markup'
  | 'python'
  | 'shell'
  | 'style'
  | 'typescript'

export interface WorkspaceFileType {
  label: string
  tone: WorkspaceFileTone
  language: string | null
  plainText?: boolean
}

const type = (label: string, tone: WorkspaceFileTone, language: string | null = null, plainText = false): WorkspaceFileType => ({
  label,
  tone,
  language,
  plainText,
})

const typesByExtension: Record<string, WorkspaceFileType> = {
  '1c': type('1C', 'compiled', '1c'),
  asm: type('ASM', 'compiled', 'x86asm'),
  bash: type('$', 'shell', 'bash'),
  bat: type('BAT', 'shell', 'dos'),
  c: type('C', 'compiled', 'c'),
  cc: type('C++', 'compiled', 'cpp'),
  cjs: type('JS', 'javascript', 'javascript'),
  clj: type('CLJ', 'compiled', 'clojure'),
  cljc: type('CLJ', 'compiled', 'clojure'),
  cljs: type('CLJ', 'compiled', 'clojure'),
  cmake: type('CM', 'config', 'cmake'),
  cmd: type('CMD', 'shell', 'dos'),
  conf: type('CFG', 'config', 'ini'),
  config: type('CFG', 'config', 'ini'),
  cpp: type('C++', 'compiled', 'cpp'),
  cs: type('C#', 'compiled', 'csharp'),
  csh: type('$', 'shell', 'bash'),
  css: type('CSS', 'style', 'css'),
  csv: type('CSV', 'data', null, true),
  cts: type('TS', 'typescript', 'typescript'),
  cxx: type('C++', 'compiled', 'cpp'),
  dart: type('DA', 'compiled', 'dart'),
  diff: type('±', 'data', 'diff'),
  edn: type('EDN', 'data', 'clojure'),
  ejs: type('EJS', 'markup', 'xml'),
  el: type('EL', 'compiled', 'lisp'),
  erb: type('ERB', 'markup', 'erb'),
  erl: type('ERL', 'compiled', 'erlang'),
  ex: type('EX', 'compiled', 'elixir'),
  exs: type('EX', 'compiled', 'elixir'),
  fish: type('$', 'shell', 'bash'),
  fs: type('F#', 'compiled', 'fsharp'),
  fsi: type('F#', 'compiled', 'fsharp'),
  fsx: type('F#', 'compiled', 'fsharp'),
  gemspec: type('RB', 'compiled', 'ruby'),
  geojson: type('{}', 'data', 'json'),
  glsl: type('GL', 'compiled', 'glsl'),
  go: type('GO', 'compiled', 'go'),
  gql: type('GQL', 'data', 'graphql'),
  gradle: type('GR', 'config', 'gradle'),
  graphql: type('GQL', 'data', 'graphql'),
  groovy: type('GR', 'compiled', 'groovy'),
  h: type('C', 'compiled', 'c'),
  handlebars: type('HBS', 'markup', 'handlebars'),
  hbs: type('HBS', 'markup', 'handlebars'),
  hh: type('C++', 'compiled', 'cpp'),
  hpp: type('C++', 'compiled', 'cpp'),
  hrl: type('ERL', 'compiled', 'erlang'),
  hs: type('HS', 'compiled', 'haskell'),
  htm: type('<>', 'markup', 'xml'),
  html: type('<>', 'markup', 'xml'),
  hxx: type('C++', 'compiled', 'cpp'),
  ini: type('INI', 'config', 'ini'),
  ipynb: type('{}', 'data', 'json'),
  java: type('JV', 'compiled', 'java'),
  js: type('JS', 'javascript', 'javascript'),
  json: type('{}', 'data', 'json'),
  json5: type('{}', 'data', 'json5'),
  jsonc: type('{}', 'data', 'jsonc'),
  jsonl: type('{}', 'data', 'json'),
  jsx: type('JSX', 'javascript', 'javascript'),
  kt: type('KT', 'compiled', 'kotlin'),
  kts: type('KT', 'compiled', 'kotlin'),
  latex: type('TX', 'document', 'latex'),
  less: type('CSS', 'style', 'less'),
  lhs: type('HS', 'compiled', 'haskell'),
  lisp: type('LSP', 'compiled', 'lisp'),
  log: type('LOG', 'document', null, true),
  lua: type('LUA', 'compiled', 'lua'),
  m: type('OC', 'compiled', 'objectivec'),
  make: type('MK', 'config', 'makefile'),
  markdown: type('MD', 'document', 'markdown'),
  md: type('MD', 'document', 'markdown'),
  mdx: type('MDX', 'document', 'markdown'),
  mjs: type('JS', 'javascript', 'javascript'),
  mm: type('OC', 'compiled', 'objectivec'),
  mts: type('TS', 'typescript', 'typescript'),
  ndjson: type('{}', 'data', 'json'),
  nginx: type('NGX', 'config', 'nginx'),
  nix: type('NIX', 'config', 'nix'),
  patch: type('±', 'data', 'diff'),
  pdf: type('PDF', 'document'),
  perl: type('PL', 'compiled', 'perl'),
  php: type('PHP', 'compiled', 'php'),
  plist: type('<>', 'config', 'xml'),
  pl: type('PL', 'compiled', 'perl'),
  pm: type('PL', 'compiled', 'perl'),
  properties: type('CFG', 'config', 'properties'),
  proto: type('PB', 'data', 'protobuf'),
  ps1: type('PS', 'shell', 'powershell'),
  psd1: type('PS', 'shell', 'powershell'),
  psm1: type('PS', 'shell', 'powershell'),
  py: type('PY', 'python', 'python'),
  pxd: type('PY', 'python', 'python'),
  pxi: type('PY', 'python', 'python'),
  pyx: type('PY', 'python', 'python'),
  pyi: type('PY', 'python', 'python'),
  pyw: type('PY', 'python', 'python'),
  qmd: type('MD', 'document', 'markdown'),
  r: type('R', 'compiled', 'r'),
  rake: type('RB', 'compiled', 'ruby'),
  rb: type('RB', 'compiled', 'ruby'),
  rs: type('RS', 'compiled', 'rust'),
  sass: type('CSS', 'style', 'scss'),
  scala: type('SC', 'compiled', 'scala'),
  sc: type('SC', 'compiled', 'scala'),
  scm: type('SCM', 'compiled', 'scheme'),
  scss: type('CSS', 'style', 'scss'),
  service: type('SVC', 'config', 'ini'),
  sh: type('$', 'shell', 'bash'),
  sql: type('SQL', 'data', 'sql'),
  svelte: type('SV', 'markup', 'xml'),
  svg: type('SVG', 'image', 'xml'),
  swift: type('SW', 'compiled', 'swift'),
  tcl: type('TCL', 'compiled', 'tcl'),
  tex: type('TX', 'document', 'latex'),
  text: type('TXT', 'document', null, true),
  toml: type('TOML', 'config', 'toml'),
  ts: type('TS', 'typescript', 'typescript'),
  tsv: type('TSV', 'data', null, true),
  tsx: type('TSX', 'typescript', 'typescript'),
  txt: type('TXT', 'document', null, true),
  vb: type('VB', 'compiled', 'vbnet'),
  vbs: type('VBS', 'shell', 'vbscript'),
  vim: type('VIM', 'config', 'vim'),
  vue: type('VUE', 'markup', 'xml'),
  wasm: type('WA', 'compiled', 'wasm'),
  wat: type('WA', 'compiled', 'wasm'),
  xml: type('<>', 'markup', 'xml'),
  xsd: type('<>', 'markup', 'xml'),
  xsl: type('<>', 'markup', 'xml'),
  yaml: type('YML', 'config', 'yaml'),
  yml: type('YML', 'config', 'yaml'),
  zsh: type('$', 'shell', 'bash'),
}

const specialNames: Record<string, WorkspaceFileType> = {
  '.bash_aliases': type('$', 'shell', 'bash'),
  '.bash_profile': type('$', 'shell', 'bash'),
  '.bashrc': type('$', 'shell', 'bash'),
  '.editorconfig': type('CFG', 'config', 'ini'),
  '.gitattributes': type('GIT', 'config', 'properties'),
  '.gitconfig': type('GIT', 'config', 'ini'),
  '.gitignore': type('GIT', 'config', 'properties'),
  '.npmrc': type('NPM', 'config', 'properties'),
  '.profile': type('$', 'shell', 'bash'),
  '.yarnrc': type('YRN', 'config', 'yaml'),
  '.zprofile': type('$', 'shell', 'bash'),
  '.zshrc': type('$', 'shell', 'bash'),
  'cargo.lock': type('RS', 'config', 'toml'),
  'cmakelists.txt': type('CM', 'config', 'cmake'),
  'gemfile': type('RB', 'config', 'ruby'),
  'gnumakefile': type('MK', 'config', 'makefile'),
  'gradlew': type('$', 'shell', 'bash'),
  'jenkinsfile': type('CI', 'config', 'groovy'),
  'makefile': type('MK', 'config', 'makefile'),
  'nginx.conf': type('NGX', 'config', 'nginx'),
  'package-lock.json': type('NPM', 'data', 'json'),
  'pnpm-lock.yaml': type('PN', 'config', 'yaml'),
  'proguard-rules.pro': type('PRG', 'config', 'proguard'),
  'podfile': type('RB', 'config', 'ruby'),
  'rakefile': type('RB', 'config', 'ruby'),
  'yarn.lock': type('YRN', 'config', 'yaml'),
}

const imageExtensions = new Set(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'webp'])
const archiveExtensions = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip'])

const iconsByLanguage: Record<string, string> = {
  bash: 'file-type-shell',
  c: 'file-type-c',
  clojure: 'file-type-clojure',
  cmake: 'file-type-cmake',
  cpp: 'file-type-cpp',
  csharp: 'file-type-csharp',
  css: 'file-type-css',
  dart: 'file-type-dartlang',
  diff: 'file-type-diff',
  dockerfile: 'file-type-docker',
  dos: 'file-type-bat',
  elixir: 'file-type-elixir',
  erb: 'file-type-erb',
  erlang: 'file-type-erlang',
  fsharp: 'file-type-fsharp',
  glsl: 'file-type-glsl',
  go: 'file-type-go',
  gradle: 'file-type-gradle',
  graphql: 'file-type-graphql',
  groovy: 'file-type-groovy',
  handlebars: 'file-type-handlebars',
  haskell: 'file-type-haskell',
  ini: 'file-type-ini',
  java: 'file-type-java',
  javascript: 'file-type-js-official',
  json: 'file-type-json-official',
  kotlin: 'file-type-kotlin',
  latex: 'file-type-tex',
  less: 'file-type-less',
  lisp: 'file-type-lisp',
  lua: 'file-type-lua',
  makefile: 'file-type-gnu',
  markdown: 'file-type-markdown',
  nginx: 'file-type-nginx',
  nix: 'file-type-nix',
  objectivec: 'file-type-objectivecpp',
  perl: 'file-type-perl',
  php: 'file-type-php',
  powershell: 'file-type-powershell',
  properties: 'file-type-config',
  protobuf: 'file-type-protobuf',
  python: 'file-type-python',
  r: 'file-type-r',
  ruby: 'file-type-ruby',
  rust: 'file-type-rust',
  scala: 'file-type-scala',
  scheme: 'file-type-lisp',
  scss: 'file-type-scss',
  sql: 'file-type-sql',
  swift: 'file-type-swift',
  tcl: 'file-type-tcl',
  typescript: 'file-type-typescript-official',
  vbnet: 'file-type-vb',
  vbscript: 'file-type-vb',
  vim: 'file-type-vim',
  wasm: 'file-type-wasm',
  x86asm: 'file-type-assembly',
  xml: 'file-type-xml',
  yaml: 'file-type-yaml-official',
}

const iconsByExtension: Record<string, string> = {
  bat: 'file-type-bat',
  csv: 'file-type-csv',
  json5: 'file-type-json5',
  pdf: 'file-type-pdf',
  svg: 'file-type-svg',
  toml: 'file-type-toml',
  txt: 'file-type-text',
}

const iconsByFilename: Record<string, string> = {
  '.editorconfig': 'file-type-editorconfig',
  '.gitattributes': 'file-type-git',
  '.gitconfig': 'file-type-git',
  '.gitignore': 'file-type-git',
  '.npmrc': 'file-type-npm',
  '.yarnrc': 'file-type-yarn',
  'cargo.lock': 'file-type-cargo',
  'cmakelists.txt': 'file-type-cmake',
  'gradle.properties': 'file-type-gradle',
  'gradle-wrapper.properties': 'file-type-gradle',
  'gradlew': 'file-type-gradle',
  'gradlew.bat': 'file-type-gradle',
  'gnumakefile': 'file-type-gnu',
  'makefile': 'file-type-gnu',
  'package-lock.json': 'file-type-npm',
  'package.json': 'file-type-npm',
  'pnpm-lock.yaml': 'file-type-pnpm',
  'yarn.lock': 'file-type-yarn',
}

const iconsByTone: Record<WorkspaceFileTone, string> = {
  archive: 'file-type-zip',
  compiled: 'default-file',
  config: 'file-type-config',
  data: 'file-type-json-official',
  document: 'file-type-text',
  generic: 'default-file',
  image: 'file-type-image',
  javascript: 'file-type-js-official',
  markup: 'file-type-html',
  python: 'file-type-python',
  shell: 'file-type-shell',
  style: 'file-type-css',
  typescript: 'file-type-typescript-official',
}

export function workspaceFileIcon(path: string): string {
  const filename = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  const namedIcon = iconsByFilename[filename]
  if (namedIcon) return namedIcon
  if (filename === 'agents.md') return 'file-type-agents'
  if (filename === 'readme' || filename.startsWith('readme.')) return 'file-type-markdown'
  if (filename.startsWith('tsconfig.') || filename === 'tsconfig') return 'file-type-tsconfig'
  if (filename.startsWith('vite.config.')) return 'file-type-vite'
  if (/^(build|settings)\.gradle(\.kts)?$/.test(filename)) return 'file-type-gradle'
  if (filename === 'proguard-rules.pro') return 'file-type-java'
  if (filename === 'dockerfile' || filename.startsWith('dockerfile.')) return 'file-type-docker'
  if (filename.startsWith('.env')) return 'file-type-dotenv'
  if (filename.startsWith('changelog') || filename.startsWith('license')) return 'file-type-markdown'

  const extension = filename.includes('.') ? filename.split('.').at(-1) ?? '' : ''
  const extensionIcon = iconsByExtension[extension]
  if (extensionIcon) return extensionIcon

  const known = typesByExtension[extension]
  if (known?.language) {
    const languageIcon = iconsByLanguage[known.language]
    if (languageIcon) return languageIcon
  }
  if (known) return iconsByTone[known.tone]
  if (imageExtensions.has(extension)) return 'file-type-image'
  if (archiveExtensions.has(extension)) return 'file-type-zip'
  return 'default-file'
}

export function workspaceFileType(path: string): WorkspaceFileType {
  const filename = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  const special = specialNames[filename]
  if (special) return special
  if (filename === 'dockerfile' || filename.startsWith('dockerfile.')) return type('DK', 'config', 'dockerfile')
  if (filename.startsWith('.env')) return type('ENV', 'config', 'bash')

  const extension = filename.includes('.') ? filename.split('.').at(-1) ?? '' : ''
  const known = typesByExtension[extension]
  if (known) return known
  if (imageExtensions.has(extension)) return type('IMG', 'image')
  if (archiveExtensions.has(extension)) return type('ZIP', 'archive')
  if (extension) return type(extension.slice(0, 3).toUpperCase(), 'generic')
  return type('FILE', 'generic')
}

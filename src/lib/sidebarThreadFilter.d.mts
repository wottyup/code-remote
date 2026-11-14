import type { CodexThread } from './devwispClient'

export type SidebarThreadEngineFilter = 'codex' | 'claude-code' | null

export function filterSidebarThreads(threads: CodexThread[], engineFilter?: SidebarThreadEngineFilter, search?: string): CodexThread[]

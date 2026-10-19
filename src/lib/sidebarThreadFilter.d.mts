import type { CodexThread } from './codexRemoteClient'

export type SidebarThreadEngineFilter = 'codex' | 'claude-code' | null

export function filterSidebarThreads(threads: CodexThread[], engineFilter?: SidebarThreadEngineFilter, search?: string): CodexThread[]

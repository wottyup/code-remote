import type { CodexThread } from './codexRemoteClient'

export type SidebarThreadSection = '置顶' | '今天' | '最近 7 天' | '15 天内' | '30 天内' | '更早'

export const sidebarThreadSectionOrder: SidebarThreadSection[]
export function sidebarThreadSection(thread: CodexThread, pinnedThreadIds: ReadonlySet<string>, now?: Date): SidebarThreadSection
export function groupSidebarThreads(threads: CodexThread[], pinnedThreadIds: ReadonlySet<string>, now?: Date): Array<{ label: SidebarThreadSection; threads: CodexThread[] }>

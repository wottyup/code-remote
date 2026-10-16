import { gzip, gunzip, strFromU8, strToU8 } from 'fflate'
import type { CodexThreadDetails } from './codexRemoteClient'
import { deleteThreadHistoryCache, readThreadHistoryCache, writeThreadHistoryCache } from './threadHistoryStorage'

export interface ThreadTransportSnapshot {
  thread: CodexThreadDetails
  revision: string
}

// Keep compressed bases separate from rendered UI snapshots. Large conversations
// must not lose incremental sync merely because their JSON exceeds the RAM cap.
const memoryMaxBytes = 8 * 1024 * 1024
const memory = new Map<string, Uint8Array>()

function remember(key: string, data: Uint8Array) {
  memory.delete(key)
  if (data.byteLength > memoryMaxBytes) return
  memory.set(key, data)
  let bytes = [...memory.values()].reduce((sum, value) => sum + value.byteLength, 0)
  while (memory.size > 5 || bytes > memoryMaxBytes) {
    const oldest = memory.entries().next().value
    if (!oldest) break
    memory.delete(oldest[0])
    bytes -= oldest[1].byteLength
  }
}

export async function readThreadTransportCache(key: string, threadId: string): Promise<ThreadTransportSnapshot | undefined> {
  try {
    // Only use a persisted base to merge an authenticated network response;
    // never expose it as a successful server read on its own.
    const data = memory.get(key) ?? await readThreadHistoryCache<Uint8Array>(threadId, 'transport')
    if (!(data instanceof Uint8Array)) return undefined
    const decoded = await new Promise<Uint8Array>((resolve, reject) => {
      gunzip(data, (error, result) => error ? reject(error) : resolve(result))
    })
    const snapshot = JSON.parse(strFromU8(decoded)) as ThreadTransportSnapshot
    if (!snapshot || typeof snapshot.revision !== 'string' || !snapshot.revision
      || snapshot.thread?.id !== threadId || !Array.isArray(snapshot.thread.turns)) return undefined
    remember(key, data)
    return snapshot
  } catch {
    await deleteThreadTransportCache(key, threadId)
    return undefined
  }
}

export async function writeThreadTransportCache(key: string, snapshot: ThreadTransportSnapshot) {
  try {
    const encoded = strToU8(JSON.stringify(snapshot))
    const data = await new Promise<Uint8Array>((resolve, reject) => {
      gzip(encoded, { level: 1, consume: true }, (error, result) => error ? reject(error) : resolve(result))
    })
    remember(key, data)
    // IndexedDB has its own 50 MiB / 5 entry budget. Compression runs in a
    // worker and the raw second copy is released after the request completes.
    await writeThreadHistoryCache(snapshot.thread.id, data, data.byteLength, 'transport')
  } catch {
    // Storage/worker availability must never turn a delivered history into an
    // error. An older valid base remains usable on the next request.
  }
}

export async function deleteThreadTransportCache(key: string, threadId: string) {
  memory.delete(key)
  await deleteThreadHistoryCache(threadId, 'transport')
}

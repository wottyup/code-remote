const databaseName = 'codex-remote-thread-history'
const databaseVersion = 1
const objectStoreName = 'threads'

export const threadHistoryCacheMaxEntries = 5
export const threadHistoryCacheMaxBytes = 50 * 1024 * 1024

export function serializedCacheSizeBytes(value: unknown) {
  try {
    const serialized = JSON.stringify(value)
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(serialized).byteLength
    return serialized.length * 2
  } catch {
    return 0
  }
}

export interface ThreadHistoryCacheRecord<T> {
  threadId: string
  lastAccessedAt: number
  sizeBytes: number
  snapshot: T
}

let databasePromise: Promise<IDBDatabase | null> | null = null
const pendingWrites = new Map<string, Promise<boolean>>()

export function retainThreadHistoryCacheRecords<T>(records: ThreadHistoryCacheRecord<T>[]) {
  const retained: ThreadHistoryCacheRecord<T>[] = []
  const evicted: ThreadHistoryCacheRecord<T>[] = []
  let totalBytes = 0

  for (const record of [...records].sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)) {
    if (retained.length < threadHistoryCacheMaxEntries
      && record.sizeBytes > 0
      && record.sizeBytes <= threadHistoryCacheMaxBytes
      && totalBytes + record.sizeBytes <= threadHistoryCacheMaxBytes) {
      retained.push(record)
      totalBytes += record.sizeBytes
    } else {
      evicted.push(record)
    }
  }

  return { retained, evicted }
}

function openDatabase() {
  if (databasePromise) return databasePromise
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)

  databasePromise = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(databaseName, databaseVersion)
    } catch {
      resolve(null)
      return
    }

    let settled = false
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        database?.close()
        return
      }
      settled = true
      resolve(database)
    }

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(objectStoreName)) {
        database.createObjectStore(objectStoreName, { keyPath: 'threadId' })
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        databasePromise = null
      }
      finish(database)
    }
    request.onerror = () => finish(null)
    request.onblocked = () => finish(null)
  }).catch(() => {
    databasePromise = null
    return null
  })

  return databasePromise
}

function validRecord<T>(value: unknown): value is ThreadHistoryCacheRecord<T> {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.threadId === 'string'
    && typeof record.lastAccessedAt === 'number'
    && Number.isFinite(record.lastAccessedAt)
    && typeof record.sizeBytes === 'number'
    && Number.isFinite(record.sizeBytes)
    && record.sizeBytes > 0
    && 'snapshot' in record
}

async function writeRecord<T>(threadId: string, snapshot: T, sizeBytes: number) {
  if (!threadId || !Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > threadHistoryCacheMaxBytes) return false
  const database = await openDatabase()
  if (!database) return false

  return new Promise<boolean>((resolve) => {
    let stored = false
    let transaction: IDBTransaction
    try {
      transaction = database.transaction(objectStoreName, 'readwrite')
    } catch {
      resolve(false)
      return
    }
    const store = transaction.objectStore(objectStoreName)
    const readAll = store.getAll()
    readAll.onsuccess = () => {
      const existing = Array.isArray(readAll.result)
        ? readAll.result.filter((record): record is ThreadHistoryCacheRecord<T> => validRecord<T>(record))
        : []
      const incoming: ThreadHistoryCacheRecord<T> = {
        threadId,
        lastAccessedAt: Date.now(),
        sizeBytes,
        snapshot,
      }
      const next = [
        ...existing.filter((record) => record.threadId !== threadId),
        incoming,
      ]
      const { retained, evicted } = retainThreadHistoryCacheRecords(next)
      stored = retained.some((record) => record.threadId === threadId)
      try {
        if (stored) store.put(incoming)
        else store.delete(threadId)
        for (const record of evicted) store.delete(record.threadId)
      } catch {
        stored = false
        transaction.abort()
      }
    }
    readAll.onerror = () => transaction.abort()
    transaction.oncomplete = () => resolve(stored)
    transaction.onerror = () => resolve(false)
    transaction.onabort = () => resolve(false)
  })
}

export function writeThreadHistoryCache<T>(threadId: string, snapshot: T, sizeBytes: number) {
  const previous = pendingWrites.get(threadId) ?? Promise.resolve(true)
  const next = previous
    .catch(() => false)
    .then(() => writeRecord(threadId, snapshot, sizeBytes))
    .catch(() => false)
  pendingWrites.set(threadId, next)
  void next.then(() => {
    if (pendingWrites.get(threadId) === next) pendingWrites.delete(threadId)
  })
  return next
}

export async function readThreadHistoryCache<T>(threadId: string): Promise<T | null> {
  await pendingWrites.get(threadId)?.catch(() => false)
  const database = await openDatabase()
  if (!database) return null

  return new Promise<T | null>((resolve) => {
    let snapshot: T | null = null
    let transaction: IDBTransaction
    try {
      transaction = database.transaction(objectStoreName, 'readwrite')
    } catch {
      resolve(null)
      return
    }
    const store = transaction.objectStore(objectStoreName)
    const request = store.get(threadId)
    request.onsuccess = () => {
      if (!validRecord<T>(request.result)) return
      snapshot = request.result.snapshot
      try {
        store.put({ ...request.result, lastAccessedAt: Date.now() })
      } catch {
        // A cache read still succeeds if refreshing its LRU timestamp fails.
      }
    }
    request.onerror = () => transaction.abort()
    transaction.oncomplete = () => resolve(snapshot)
    transaction.onerror = () => resolve(null)
    transaction.onabort = () => resolve(null)
  })
}

export async function deleteThreadHistoryCache(threadId: string): Promise<boolean> {
  await pendingWrites.get(threadId)?.catch(() => false)
  const database = await openDatabase()
  if (!database) return false

  return new Promise<boolean>((resolve) => {
    let transaction: IDBTransaction
    try {
      transaction = database.transaction(objectStoreName, 'readwrite')
      transaction.objectStore(objectStoreName).delete(threadId)
    } catch {
      resolve(false)
      return
    }
    transaction.oncomplete = () => resolve(true)
    transaction.onerror = () => resolve(false)
    transaction.onabort = () => resolve(false)
  })
}

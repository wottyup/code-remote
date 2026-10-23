import type { CodexImageAttachment } from './codexRemoteClient'
import { maxImagesPerTurn } from './imageAttachmentRules'

const databaseName = 'codex-remote-composer-drafts'
const storeName = 'image-drafts'
const maxEncodedImageLength = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 8
const supportedImageTypes = new Set<CodexImageAttachment['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

interface ComposerImageDraftRecord {
  scope: string
  images: CodexImageAttachment[]
}

let databasePromise: Promise<IDBDatabase> | null = null
let imageDraftWriteQueue: Promise<void> = Promise.resolve()
const pendingImageDraftMoves = new Map<string, Promise<CodexImageAttachment[]>>()
const imageDraftSubscribers = new Map<string, Set<(images: CodexImageAttachment[]) => void>>()
const pendingImageDraftTargets = new Map<string, string>()

function publishImageDraft(scope: string, images: CodexImageAttachment[]) {
  for (const listener of imageDraftSubscribers.get(scope) ?? []) listener(images)
}

export function subscribeToComposerImageDraft(scope: string, listener: (images: CodexImageAttachment[]) => void) {
  const listeners = imageDraftSubscribers.get(scope) ?? new Set<(images: CodexImageAttachment[]) => void>()
  listeners.add(listener)
  imageDraftSubscribers.set(scope, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) imageDraftSubscribers.delete(scope)
  }
}

export function rememberComposerImageDraftTarget(sourceScope: string, targetScope: string) {
  pendingImageDraftTargets.set(sourceScope, targetScope)
}

export function pendingComposerImageDraftTarget(sourceScope: string) {
  return pendingImageDraftTargets.get(sourceScope) ?? null
}

export function forgetComposerImageDraftTarget(sourceScope: string) {
  pendingImageDraftTargets.delete(sourceScope)
}

function openDatabase() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('当前浏览器不支持 IndexedDB。'))
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName, { keyPath: 'scope' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('无法打开图片草稿存储。'))
      request.onblocked = () => reject(new Error('图片草稿存储正在升级，请关闭其他应用页面后重试。'))
    }).catch((reason: unknown) => {
      databasePromise = null
      throw reason
    })
  }
  return databasePromise
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('保存图片草稿失败。'))
    transaction.onabort = () => reject(transaction.error ?? new Error('图片草稿保存已取消。'))
  })
}

function validImages(value: unknown): CodexImageAttachment[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, maxImagesPerTurn).filter((image): image is CodexImageAttachment => {
    if (!image || typeof image !== 'object') return false
    const candidate = image as Partial<CodexImageAttachment>
    return typeof candidate.name === 'string'
      && candidate.name.length <= 512
      && typeof candidate.mediaType === 'string'
      && supportedImageTypes.has(candidate.mediaType as CodexImageAttachment['mediaType'])
      && typeof candidate.data === 'string'
      && candidate.data.length > 0
      && candidate.data.length <= maxEncodedImageLength
  })
}

async function readRecord(scope: string) {
  await imageDraftWriteQueue
  const database = await openDatabase()
  const transaction = database.transaction(storeName, 'readonly')
  const request = transaction.objectStore(storeName).get(scope) as IDBRequest<ComposerImageDraftRecord | undefined>
  return new Promise<CodexImageAttachment[]>((resolve, reject) => {
    request.onsuccess = () => resolve(validImages(request.result?.images))
    request.onerror = () => reject(request.error ?? new Error('读取图片草稿失败。'))
    transaction.onabort = () => reject(transaction.error ?? new Error('读取图片草稿失败。'))
  })
}

export async function readComposerImageDraft(scope: string) {
  const pendingMove = pendingImageDraftMoves.get(scope)
  if (pendingMove) await pendingMove
  return readRecord(scope)
}

export function saveComposerImageDraft(scope: string, value: CodexImageAttachment[]) {
  const images = validImages(value)
  const write = imageDraftWriteQueue.then(async () => {
    const database = await openDatabase()
    const transaction = database.transaction(storeName, 'readwrite')
    const completed = transactionComplete(transaction)
    const store = transaction.objectStore(storeName)
    if (images.length > 0) store.put({ scope, images } satisfies ComposerImageDraftRecord)
    else store.delete(scope)
    await completed
  })
  imageDraftWriteQueue = write.catch(() => undefined)
  return write
}

export function moveComposerImageDraft(sourceScope: string, targetScope: string) {
  if (sourceScope === targetScope) return readComposerImageDraft(sourceScope)
  const move = (async () => {
    const images = await readRecord(sourceScope)
    const existingTargetImages = await readRecord(targetScope)
    const mergedImages = [...images, ...existingTargetImages]
      .filter((image, index, all) => all.findIndex((candidate) => candidate.name === image.name && candidate.data === image.data) === index)
      .slice(0, maxImagesPerTurn)
    await saveComposerImageDraft(targetScope, mergedImages)
    await saveComposerImageDraft(sourceScope, [])
    publishImageDraft(targetScope, mergedImages)
    return mergedImages
  })()
  pendingImageDraftMoves.set(targetScope, move)
  void move.finally(() => {
    if (pendingImageDraftMoves.get(targetScope) === move) pendingImageDraftMoves.delete(targetScope)
  }).catch(() => undefined)
  return move
}

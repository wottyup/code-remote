import type { CodexDocumentAttachment } from './devwispClient'

export interface ComposerDraftRecovery {
  draft: string
  documents: CodexDocumentAttachment[]
  attachmentError: string | null
}

interface ComposerDraftRecoveryStorage {
  readDraft(scope: string): string
  saveDraft(scope: string, draft: string): boolean
  readTables(scope: string): CodexDocumentAttachment[]
  saveTables(scope: string, documents: CodexDocumentAttachment[]): boolean
}

export function prependComposerDraft(previous: string, current: string) {
  return !current ? previous : !previous ? current : `${previous}${previous.endsWith('\n') ? '' : '\n'}${current}`
}

export function mergeComposerDocuments(previous: CodexDocumentAttachment[], current: CodexDocumentAttachment[]) {
  return [...previous, ...current].filter((document, index, documents) => documents.findIndex((candidate) => (
    candidate.name === document.name && candidate.content === document.content && candidate.sourceFileId === document.sourceFileId
  )) === index)
}

/** Keep a failed send attached to its chat when the composer is remounted. */
export class ComposerDraftRecoveries {
  private readonly pending = new Map<string, ComposerDraftRecovery>()
  private readonly listeners = new Map<string, Set<(recovery: ComposerDraftRecovery) => void>>()

  constructor(private readonly storage: ComposerDraftRecoveryStorage) {}

  subscribe(scope: string, listener: (recovery: ComposerDraftRecovery) => void) {
    const listeners = this.listeners.get(scope) ?? new Set()
    listeners.add(listener)
    this.listeners.set(scope, listeners)
    const pending = this.pending.get(scope)
    if (pending) {
      this.pending.delete(scope)
      listener(pending)
    }
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(scope)
    }
  }

  recover(scope: string, recovery: ComposerDraftRecovery) {
    const listener = this.listeners.get(scope)?.values().next().value
    if (listener) {
      listener(recovery)
      return
    }
    const pending = this.pending.get(scope)
    const unsavedDraft = prependComposerDraft(recovery.draft, pending?.draft ?? '')
    const restoredDraft = prependComposerDraft(unsavedDraft, this.storage.readDraft(scope))
    const saved = this.storage.saveDraft(scope, restoredDraft)
    const documents = mergeComposerDocuments(recovery.documents, pending?.documents ?? [])
    this.storage.saveTables(scope, mergeComposerDocuments(documents, this.storage.readTables(scope)))
    this.pending.set(scope, {
      draft: saved ? '' : unsavedDraft,
      documents,
      attachmentError: recovery.attachmentError ?? pending?.attachmentError ?? null,
    })
  }
}

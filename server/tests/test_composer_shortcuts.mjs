import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScript(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const { composerKeyAction } = await loadTypeScript('../../src/lib/composerShortcuts.ts')
const { isReservedSidebarChatShortcut } = await loadTypeScript('../../src/lib/sidebarChatShortcuts.ts')
const { ComposerDraftRecoveries, mergeComposerDocuments, prependComposerDraft } = await loadTypeScript('../../src/lib/composerDraftRecovery.ts')
const enter = { key: 'Enter', keyCode: 13, isComposing: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false }

test('Ctrl+Enter sends directly once and is reserved from sidebar shortcuts', () => {
  const shortcut = { ...enter, ctrlKey: true }
  assert.equal(composerKeyAction(shortcut, false), 'direct')
  assert.equal(composerKeyAction({ ...shortcut, repeat: true }, false), 'repeat-direct')
  assert.equal(isReservedSidebarChatShortcut(shortcut), true)
})

test('ordinary Enter sends, while modified Enter can keep its usual behavior', () => {
  assert.equal(composerKeyAction(enter, false), 'send')
  for (const modifier of ['shiftKey', 'altKey', 'metaKey']) {
    assert.equal(composerKeyAction({ ...enter, [modifier]: true }, false), null)
    assert.equal(composerKeyAction({ ...enter, ctrlKey: true, [modifier]: true }, false), null)
  }
})

test('IME candidate confirmation never triggers a send', () => {
  const shortcut = { ...enter, ctrlKey: true }
  assert.equal(composerKeyAction(shortcut, true), null)
  assert.equal(composerKeyAction({ ...shortcut, isComposing: true }, false), null)
  assert.equal(composerKeyAction({ ...shortcut, keyCode: 229 }, false), null)
})

test('a failed send restores its draft and documents to the correct remounted chat', () => {
  const drafts = new Map([['thread:new', 'new text']])
  const tables = new Map()
  const recoveries = new ComposerDraftRecoveries({
    readDraft: (scope) => drafts.get(scope) ?? '',
    saveDraft: (scope, draft) => { drafts.set(scope, draft); return true },
    readTables: (scope) => tables.get(scope) ?? [],
    saveTables: (scope, documents) => { tables.set(scope, documents); return true },
  })
  const document = { name: 'pasted-table.md', content: '| 1 | 2 |' }
  recoveries.recover('thread:new', { draft: 'failed message', documents: [document], attachmentError: null })
  assert.equal(drafts.get('thread:new'), 'failed message\nnew text')
  assert.deepEqual(tables.get('thread:new'), [document])
  let received
  recoveries.subscribe('thread:other', () => assert.fail('restored to the wrong chat'))
  recoveries.subscribe('thread:new', (draft) => { received = draft })
  assert.deepEqual(received, { draft: '', documents: [document], attachmentError: null })
  assert.deepEqual(mergeComposerDocuments(received.documents, [document]), [document])
})

test('a failed send still recovers when browser storage is unavailable', () => {
  const recoveries = new ComposerDraftRecoveries({
    readDraft: () => '',
    saveDraft: () => false,
    readTables: () => [],
    saveTables: () => false,
  })
  recoveries.recover('thread:new', { draft: 'original message', documents: [], attachmentError: null })
  let received
  recoveries.subscribe('thread:new', (draft) => { received = draft })
  assert.equal(prependComposerDraft(received.draft, 'new typing'), 'original message\nnew typing')
})

type ComposerKeyEvent = Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'repeat'>

export function composerKeyAction(event: ComposerKeyEvent, composing: boolean): 'send' | 'direct' | 'repeat-direct' | null {
  if (composing || event.isComposing || event.keyCode === 229) return null
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey) return null
  if (event.ctrlKey) return event.repeat ? 'repeat-direct' : 'direct'
  return 'send'
}

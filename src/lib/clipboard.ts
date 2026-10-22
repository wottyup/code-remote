interface ClipboardBridgeWindow extends Window {
  CodexRemoteAndroid?: {
    copyToClipboard?: (text: string) => boolean
    readClipboardText?: () => string | null
  }
}

export async function readTextFromClipboard(): Promise<string | null> {
  const androidBridge = (window as ClipboardBridgeWindow).CodexRemoteAndroid
  if (typeof androidBridge?.readClipboardText === 'function') {
    try {
      const value = androidBridge.readClipboardText()
      if (typeof value === 'string') return value
    } catch {
      // Keep the browser clipboard path available if the native bridge fails.
    }
  }

  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText()
  } catch {
    // LAN HTTP pages and denied clipboard permissions use the manual paste fallback.
  }
  return null
}

export async function copyTextToClipboard(value: string): Promise<boolean> {
  const androidBridge = (window as ClipboardBridgeWindow).CodexRemoteAndroid
  if (typeof androidBridge?.copyToClipboard === 'function') {
    try {
      if (androidBridge.copyToClipboard(value)) return true
    } catch {
      // Keep the browser clipboard path available if the native bridge fails.
    }
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the legacy clipboard path for LAN HTTP pages.
  }
  const helper = document.createElement('textarea')
  helper.value = value
  helper.style.position = 'fixed'
  helper.style.opacity = '0'
  document.body.appendChild(helper)
  helper.focus()
  helper.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    helper.remove()
  }
}

export interface ClipboardImageContent {
  name: string
  previewUrl: string
}

function escapeClipboardHtml(value: string) {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character)
}

function imageAsPngBlob(source: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) {
        reject(new Error('Could not create a canvas context'))
        return
      }
      context.drawImage(image, 0, 0)
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode the image')), 'image/png')
    }
    image.onerror = () => reject(new Error('Could not load the image'))
    image.src = source
  })
}

function copyRichClipboardContent(plainText: string, html: string) {
  const selection = window.getSelection()
  const savedRanges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const target = document.createElement('div')
  target.contentEditable = 'true'
  target.setAttribute('aria-hidden', 'true')
  target.style.position = 'fixed'
  target.style.left = '-10000px'
  target.style.top = '0'
  target.innerHTML = html
  document.body.appendChild(target)

  let clipboardDataWritten = false
  const writeRichData = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', plainText)
    event.clipboardData.setData('text/html', html)
    clipboardDataWritten = true
  }
  document.addEventListener('copy', writeRichData, true)

  let succeeded = false
  try {
    target.focus({ preventScroll: true })
    const range = document.createRange()
    range.selectNodeContents(target)
    selection?.removeAllRanges()
    selection?.addRange(range)
    succeeded = document.execCommand('copy') && clipboardDataWritten
  } catch {
    succeeded = false
  } finally {
    document.removeEventListener('copy', writeRichData, true)
    target.remove()
    selection?.removeAllRanges()
    for (const range of savedRanges) selection?.addRange(range)
    focusedElement?.focus({ preventScroll: true })
  }

  return succeeded
}

export async function copyTextAndImagesToClipboard(text: string, images: readonly ClipboardImageContent[]): Promise<boolean> {
  if (images.length === 0) return copyTextToClipboard(text)

  const trimmedText = text.trim()
  const plainText = [trimmedText, ...images.map((image) => `[图片：${image.name || '未命名'}]`)].filter(Boolean).join('\n\n')
  const textHtml = trimmedText
    ? trimmedText.split(/\n{2,}/).map((paragraph) => `<p>${escapeClipboardHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('')
    : ''
  const imageHtml = images.map((image) => `<p><img src="${escapeClipboardHtml(image.previewUrl)}" alt="${escapeClipboardHtml(image.name)}"></p>`).join('')
  const html = `<div>${textHtml}${imageHtml}</div>`

  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    const pngPromise = imageAsPngBlob(images[0].previewUrl)
    void pngPromise.catch(() => undefined)
    try {
      const clipboardItem = new ClipboardItem({
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
        'image/png': pngPromise,
      })
      await navigator.clipboard.write([clipboardItem])
      return true
    } catch {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })])
        return true
      } catch {
        // Fall through to the legacy rich clipboard path used on LAN HTTP pages.
      }
    }
  }

  return copyRichClipboardContent(plainText, html)
}

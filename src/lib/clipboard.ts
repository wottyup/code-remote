import { maxImagesPerTurn } from './imageAttachmentRules'

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
  lastCopiedRichMessage = null
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

export interface ClipboardImageCopyResult {
  copied: boolean
  imageCount: number
}

interface CopiedRichMessage {
  text: string
  imageNames: string[]
  copiedAt: number
}

let lastCopiedRichMessage: CopiedRichMessage | null = null
const copiedRichMessageMaxAgeMs = 5 * 60 * 1000
const messageTextAttribute = 'data-code-remote-message-text'

const embeddedImagePattern = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i
const maxEmbeddedImageBytes = 8 * 1024 * 1024
const imageExtension: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

function embeddedImageFile(source: string, name: string): File | null {
  const match = embeddedImagePattern.exec(source)
  if (!match || match[2].length > Math.ceil(maxEmbeddedImageBytes / 3) * 4) return null
  try {
    const binary = atob(match[2])
    if (binary.length > maxEmbeddedImageBytes) return null
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const type = match[1].toLowerCase()
    const filename = name || `image.${imageExtension[type]}`
    return new File([bytes], filename, { type })
  } catch {
    return null
  }
}

export function richMessageContentFromClipboardHtml(html: string): { text: string | null; images: File[] } {
  if (!html.includes('data:image/') && !html.includes(messageTextAttribute)) return { text: null, images: [] }
  try {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const text = document.querySelector(`[${messageTextAttribute}]`)?.getAttribute(messageTextAttribute) ?? null
    const images = Array.from(document.querySelectorAll('img[src^="data:image/"]')).slice(0, maxImagesPerTurn)
      .flatMap((image, index) => {
        const file = embeddedImageFile(image.getAttribute('src') ?? '', image.getAttribute('alt') || `image-${index + 1}`)
        return file ? [file] : []
      })
    return { text, images }
  } catch {
    return { text: null, images: [] }
  }
}

export function embeddedImageFilesFromClipboardHtml(html: string): File[] {
  return richMessageContentFromClipboardHtml(html).images
}

export function recoverCopiedMessageTextFromImagePaste(plainText: string, images: readonly File[]): string | null {
  const copied = lastCopiedRichMessage
  if (!copied || images.length === 0 || Date.now() - copied.copiedAt > copiedRichMessageMaxAgeMs) return null
  if (!images.some((image) => copied.imageNames.includes(image.name))) return null
  const pasted = plainText.trim()
  if (pasted && !copied.imageNames.some((name) => pasted === name || pasted === `[图片：${name}]`)) return null
  return copied.text
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

function copyRichClipboardContent(plainText: string, html: string, images: readonly ClipboardImageContent[]): ClipboardImageCopyResult {
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
  let imageCount = 0
  const imageFiles = images.flatMap((image) => {
    const file = embeddedImageFile(image.previewUrl, image.name)
    return file ? [file] : []
  })
  const writeRichData = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', plainText)
    event.clipboardData.setData('text/html', html)
    for (const file of imageFiles) {
      try {
        if (event.clipboardData.items.add(file)?.kind === 'file') imageCount += 1
      } catch {
        // Some browsers only allow text formats in a synchronous copy event.
      }
    }
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

  return { copied: succeeded, imageCount: succeeded ? imageCount : 0 }
}

export async function copyTextAndImagesToClipboard(text: string, images: readonly ClipboardImageContent[]): Promise<ClipboardImageCopyResult> {
  if (images.length === 0) return { copied: await copyTextToClipboard(text), imageCount: 0 }

  lastCopiedRichMessage = null
  const trimmedText = text.trim()
  const plainText = [trimmedText, ...images.map((image) => `[图片：${image.name || '未命名'}]`)].filter(Boolean).join('\n\n')
  const textHtml = trimmedText
    ? trimmedText.split(/\n{2,}/).map((paragraph) => `<p>${escapeClipboardHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('')
    : ''
  const imageHtml = images.map((image) => `<p><img src="${escapeClipboardHtml(image.previewUrl)}" alt="${escapeClipboardHtml(image.name)}"></p>`).join('')
  const html = `<div ${messageTextAttribute}="${escapeClipboardHtml(trimmedText)}">${textHtml}${imageHtml}</div>`
  const rememberCopy = (result: ClipboardImageCopyResult) => {
    if (result.copied) lastCopiedRichMessage = {
      text: trimmedText,
      imageNames: images.map((image) => image.name).filter(Boolean),
      copiedAt: Date.now(),
    }
    return result
  }

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
      return rememberCopy({ copied: true, imageCount: 1 })
    } catch {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'image/png': pngPromise,
        })])
        return rememberCopy({ copied: true, imageCount: 1 })
      } catch {
        // Keep the text and HTML path available if this browser rejects PNG.
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })])
        return rememberCopy({ copied: true, imageCount: 0 })
      } catch {
        // Fall through to the legacy rich clipboard path used on LAN HTTP pages.
      }
    }
  }

  return rememberCopy(copyRichClipboardContent(plainText, html, images))
}

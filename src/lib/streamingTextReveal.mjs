export const streamingRevealFrameMs = 24
export const streamingRevealSmallChunkLimit = 12

export function streamingRevealDurationMs(pendingLength) {
  if (pendingLength <= streamingRevealSmallChunkLimit) return 0
  return Math.min(360, Math.max(140, pendingLength * 3))
}

export function nextStreamingRevealLength(text, visibleLength, framesRemaining) {
  if (visibleLength >= text.length) return text.length
  const remaining = text.length - visibleLength
  const step = Math.max(1, Math.ceil(remaining / Math.max(1, framesRemaining)))
  let end = Math.min(text.length, visibleLength + step)
  // Never expose half of a UTF-16 surrogate pair as a replacement glyph.
  if (end < text.length && end > 0) {
    const previous = text.charCodeAt(end - 1)
    const next = text.charCodeAt(end)
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end += 1
  }
  return end
}

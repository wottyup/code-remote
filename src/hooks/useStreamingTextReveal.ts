import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { nextStreamingRevealLength, streamingRevealDurationMs, streamingRevealFrameMs, streamingRevealSmallChunkLimit } from '../lib/streamingTextReveal.mjs'

export function useStreamingTextReveal(text: string, streaming: boolean): string {
  // A cached in-progress reply can mount after the user returns to its thread.
  // Treat text already present at mount as seen; only animate future deltas.
  const [visibleText, setVisibleText] = useState(() => streaming ? text : '')
  const visibleTextRef = useRef(streaming ? text : '')
  const targetTextRef = useRef('')
  const streamingRef = useRef(false)
  const deadlineRef = useRef(0)
  const lastRevealAtRef = useRef(0)
  const frameRef = useRef<number | undefined>(undefined)

  const show = useCallback((next: string) => {
    if (visibleTextRef.current === next) return
    visibleTextRef.current = next
    setVisibleText(next)
  }, [])

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
    frameRef.current = undefined
  }, [])

  const revealFrame = useCallback((now: number) => {
    frameRef.current = undefined
    if (!streamingRef.current) return
    const target = targetTextRef.current
    const current = visibleTextRef.current
    if (document.hidden || !target.startsWith(current)) {
      show(target)
      return
    }
    if (current.length >= target.length) return
    if (now - lastRevealAtRef.current < streamingRevealFrameMs && now < deadlineRef.current) {
      frameRef.current = window.requestAnimationFrame(revealFrame)
      return
    }
    const framesRemaining = Math.max(1, Math.ceil((deadlineRef.current - now) / streamingRevealFrameMs))
    const nextLength = nextStreamingRevealLength(target, current.length, framesRemaining)
    lastRevealAtRef.current = now
    show(target.slice(0, nextLength))
    if (nextLength < target.length) frameRef.current = window.requestAnimationFrame(revealFrame)
  }, [show])

  useLayoutEffect(() => {
    streamingRef.current = streaming
    if (!streaming) {
      cancelFrame()
      targetTextRef.current = text
      lastRevealAtRef.current = 0
      show(text)
      return
    }
    targetTextRef.current = text
    const current = visibleTextRef.current
    if (document.hidden || !text.startsWith(current) || text.length - current.length <= streamingRevealSmallChunkLimit) {
      cancelFrame()
      show(text)
      return
    }
    deadlineRef.current = performance.now() + streamingRevealDurationMs(text.length - current.length)
    if (frameRef.current === undefined) frameRef.current = window.requestAnimationFrame(revealFrame)
  }, [cancelFrame, revealFrame, show, streaming, text])

  useEffect(() => {
    if (!streaming) return
    const flushWhenHidden = () => {
      if (!document.hidden) return
      cancelFrame()
      show(targetTextRef.current)
    }
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => document.removeEventListener('visibilitychange', flushWhenHidden)
  }, [cancelFrame, show, streaming])

  useEffect(() => () => cancelFrame(), [cancelFrame])

  return streaming ? visibleText || text.slice(0, nextStreamingRevealLength(text, 0, Math.max(1, Math.ceil(streamingRevealDurationMs(text.length) / streamingRevealFrameMs)))) : text
}

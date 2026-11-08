export const streamingRevealFrameMs: number
export const streamingRevealSmallChunkLimit: number
export function streamingRevealDurationMs(pendingLength: number): number
export function nextStreamingRevealLength(text: string, visibleLength: number, framesRemaining: number): number

import { version as appVersion } from '../../package.json'

export type VoiceInputState = 'idle' | 'connecting' | 'recording' | 'transcribing'

export interface BailianVoiceInputCallbacks {
  onState: (state: VoiceInputState) => void
  onPartial: (text: string) => void
  onTranscript: (text: string) => void
  onError: (message: string) => void
}

function messageFromPayload(value: unknown, fallback: string) {
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') {
    return value.message
  }
  return fallback
}

export class BailianVoiceInputController {
  private callbacks: BailianVoiceInputCallbacks | null = null
  private socket: WebSocket | null = null
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: AudioWorkletNode | null = null
  private silentGain: GainNode | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((reason: Error) => void) | null = null
  private readyTimer: number | null = null
  private flushTimer: number | null = null
  private started = false
  private ready = false
  private committed = false
  private ended = false

  async start(token: string, callbacks: BailianVoiceInputCallbacks) {
    this.callbacks = callbacks
    callbacks.onState('connecting')
    try {
      if (!window.isSecureContext) {
        throw new Error('语音输入需要 HTTPS 安全连接，或在本机使用 localhost 打开。')
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
        throw new Error('当前浏览器不支持网页麦克风录音，请升级浏览器后重试。')
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      if (this.ended) throw new Error('语音输入已取消。')

      this.context = new AudioContext()
      await this.context.resume()
      await this.connect(token)
      if (this.ended) throw new Error('语音输入已取消。')

      const workletUrl = new URL('/pcm16-capture-worklet.js', window.location.origin)
      workletUrl.searchParams.set('v', appVersion)
      await this.context.audioWorklet.addModule(workletUrl)
      this.source = this.context.createMediaStreamSource(this.stream)
      this.processor = new AudioWorkletNode(this.context, 'pcm16-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetSampleRate: 16000, packetSamples: 320 },
      })
      this.silentGain = this.context.createGain()
      this.silentGain.gain.value = 0
      this.processor.port.onmessage = (event: MessageEvent<{ type?: string; buffer?: ArrayBuffer }>) => {
        if (event.data?.type === 'audio' && event.data.buffer) {
          if (this.socket?.readyState === WebSocket.OPEN && !this.committed) this.socket.send(event.data.buffer)
        } else if (event.data?.type === 'flushed') {
          this.commitAfterFlush()
        }
      }
      this.source.connect(this.processor)
      this.processor.connect(this.silentGain)
      this.silentGain.connect(this.context.destination)

      if (this.ended) throw new Error('语音输入已取消。')
      this.started = true
      callbacks.onState('recording')
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error('无法启动语音输入。')
      const cancelled = this.ended
      await this.cleanup()
      if (!cancelled) {
        callbacks.onState('idle')
        throw error
      }
    }
  }

  stop() {
    if (!this.started || this.ended || this.committed) return
    this.callbacks?.onState('transcribing')
    this.flushTimer = window.setTimeout(() => {
      this.fail('停止录音失败，请重试。')
    }, 3000)
    if (this.processor) this.processor.port.postMessage({ type: 'flush' })
    else this.commitAfterFlush()
  }

  cancel() {
    if (this.ended) return
    this.ended = true
    this.rejectPendingReady()
    if (this.socket?.readyState === WebSocket.OPEN && this.ready) {
      this.socket.send(JSON.stringify({ type: 'voice.transcription.cancel' }))
    }
    this.callbacks?.onState('idle')
    this.callbacks?.onPartial('')
    void this.cleanup()
  }

  dispose() {
    if (this.ended) return
    this.ended = true
    this.rejectPendingReady()
    if (this.socket?.readyState === WebSocket.OPEN && this.ready) {
      this.socket.send(JSON.stringify({ type: 'voice.transcription.cancel' }))
    }
    void this.cleanup()
  }

  private connect(token: string) {
    const url = new URL('/api/v1/codex/voice-transcription', window.location.origin)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.socket = new WebSocket(url)
    this.socket.binaryType = 'arraybuffer'

    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.readyTimer = window.setTimeout(() => this.fail('连接百炼语音识别超时，请重试。'), 20_000)
    })
    this.socket.onopen = () => {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      this.socket.send(JSON.stringify({
        type: 'voice.transcription.hello',
        protocol_version: 1,
        token,
      }))
    }
    this.socket.onmessage = (event) => this.handleMessage(event)
    this.socket.onerror = () => this.fail('语音识别连接失败，请检查网络后重试。')
    this.socket.onclose = () => {
      if (!this.ended) this.fail('语音识别连接已断开，请重试。')
    }
    return ready
  }

  private handleMessage(event: MessageEvent) {
    if (this.ended) return
    if (typeof event.data !== 'string') return
    let payload: unknown
    try {
      payload = JSON.parse(event.data)
    } catch {
      this.fail('语音识别服务返回了无效数据。')
      return
    }
    if (!payload || typeof payload !== 'object' || !('type' in payload) || typeof payload.type !== 'string') return
    const message = payload as { type: string; text?: unknown; message?: unknown }
    if (message.type === 'voice.transcription.ready') {
      this.ready = true
      if (this.readyTimer !== null) window.clearTimeout(this.readyTimer)
      this.readyTimer = null
      this.readyResolve?.()
      this.readyResolve = null
      this.readyReject = null
    } else if (message.type === 'voice.transcription.partial') {
      this.callbacks?.onPartial(typeof message.text === 'string' ? message.text : '')
    } else if (message.type === 'voice.transcription.completed') {
      const transcript = typeof message.text === 'string' ? message.text.trim() : ''
      this.ended = true
      this.started = false
      this.callbacks?.onTranscript(transcript)
      this.callbacks?.onState('idle')
      this.callbacks?.onPartial('')
      void this.cleanup()
    } else if (message.type === 'voice.transcription.cancelled') {
      this.ended = true
      this.callbacks?.onState('idle')
      this.callbacks?.onPartial('')
      void this.cleanup()
    } else if (message.type === 'voice.transcription.error') {
      this.fail(messageFromPayload(message, '百炼语音识别失败，请重试。'))
    }
  }

  private commitAfterFlush() {
    if (this.ended || this.committed) return
    this.committed = true
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.stopCapture()
    if (this.socket?.readyState !== WebSocket.OPEN || !this.ready) {
      this.fail('语音识别连接已断开，请重试。')
      return
    }
    this.socket.send(JSON.stringify({ type: 'voice.transcription.commit' }))
  }

  private stopCapture() {
    this.source?.disconnect()
    this.processor?.disconnect()
    this.silentGain?.disconnect()
    this.source = null
    this.processor = null
    this.silentGain = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    const context = this.context
    this.context = null
    if (context && context.state !== 'closed') void context.close()
  }

  private fail(message: string) {
    if (this.ended) return
    this.ended = true
    this.started = false
    this.rejectPendingReady(message)
    this.callbacks?.onError(message)
    this.callbacks?.onState('idle')
    this.callbacks?.onPartial('')
    void this.cleanup()
  }

  private rejectPendingReady(message = '语音输入已取消。') {
    this.readyReject?.(new Error(message))
    this.readyReject = null
    this.readyResolve = null
  }

  private async cleanup() {
    if (this.readyTimer !== null) window.clearTimeout(this.readyTimer)
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer)
    this.readyTimer = null
    this.flushTimer = null
    this.stopCapture()
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
  }
}

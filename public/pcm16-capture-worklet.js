class PCM16CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const processorOptions = options.processorOptions || {}
    this.targetSampleRate = processorOptions.targetSampleRate || 16000
    this.packetSamples = processorOptions.packetSamples || 320
    this.step = sampleRate / this.targetSampleRate
    this.tail = new Float32Array(0)
    this.phase = 0
    this.packet = []
    this.port.onmessage = (event) => {
      if (event.data?.type === 'flush') {
        this.flush()
        this.port.postMessage({ type: 'flushed' })
      }
    }
  }

  process(inputs, outputs) {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0)
    }
    const channels = inputs[0]
    if (!channels?.length || !channels[0]?.length) return true

    const frameCount = channels[0].length
    const combined = new Float32Array(this.tail.length + frameCount)
    combined.set(this.tail)
    for (let frame = 0; frame < frameCount; frame += 1) {
      let sample = 0
      for (const channel of channels) sample += channel[frame] || 0
      combined[this.tail.length + frame] = sample / channels.length
    }

    let position = this.phase
    while (position + 1 < combined.length) {
      const left = Math.floor(position)
      const fraction = position - left
      const sample = combined[left] * (1 - fraction) + combined[left + 1] * fraction
      this.packet.push(sample)
      if (this.packet.length >= this.packetSamples) this.postPacket(this.packetSamples)
      position += this.step
    }
    this.phase = position - (combined.length - 1)
    this.tail = combined.slice(-1)
    return true
  }

  postPacket(sampleCount) {
    if (sampleCount <= 0) return
    const pcm = new Int16Array(sampleCount)
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = Math.max(-1, Math.min(1, this.packet[index]))
      pcm[index] = sample < 0 ? sample * 32768 : sample * 32767
    }
    this.packet.splice(0, sampleCount)
    this.port.postMessage({ type: 'audio', buffer: pcm.buffer }, [pcm.buffer])
  }

  flush() {
    this.postPacket(this.packet.length)
  }
}

registerProcessor('pcm16-capture', PCM16CaptureProcessor)

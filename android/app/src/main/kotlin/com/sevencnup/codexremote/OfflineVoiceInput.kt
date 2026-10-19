package com.sevencnup.codexremote

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import kotlin.concurrent.thread

/**
 * Streams microphone audio into sherpa-onnx on the device.
 *
 * The recognizer is created lazily on first use and kept for later sessions.
 * Recording and decoding happen on a dedicated thread; callbacks are posted to
 * the main thread.
 */
class OfflineVoiceInput(
    context: Context,
    private val onState: (State) -> Unit,
    private val onPartial: (String) -> Unit,
    private val onFinal: (String) -> Unit,
    private val onError: (String) -> Unit,
) {
    enum class State { IDLE, LOADING, LISTENING }

    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()

    @Volatile private var recognizer: OnlineRecognizer? = null
    @Volatile private var released = false
    @Volatile private var loading = false
    @Volatile private var recording = false
    @Volatile private var wantListening = false
    @Volatile private var activeStream: OnlineStream? = null
    @Volatile private var audioRecord: AudioRecord? = null
    private var loadThread: Thread? = null
    private var recordThread: Thread? = null

    fun start() {
        if (released || recording || loading) return
        wantListening = true
        val existing = recognizer
        if (existing != null) {
            startRecording(existing)
            return
        }
        loading = true
        postState(State.LOADING)
        loadThread = thread(name = "offline-asr-load") {
            try {
                val created = OnlineRecognizer(
                    appContext.assets,
                    OnlineRecognizerConfig(
                        featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
                        modelConfig = OnlineModelConfig(
                            transducer = OnlineTransducerModelConfig(
                                encoder = "$MODEL_DIR/encoder-epoch-99-avg-1.int8.onnx",
                                decoder = "$MODEL_DIR/decoder-epoch-99-avg-1.int8.onnx",
                                joiner = "$MODEL_DIR/joiner-epoch-99-avg-1.int8.onnx",
                            ),
                            tokens = "$MODEL_DIR/tokens.txt",
                            numThreads = 2,
                            provider = "cpu",
                            modelType = "zipformer",
                            debug = false,
                        ),
                        decodingMethod = "greedy_search",
                        enableEndpoint = true,
                        endpointConfig = EndpointConfig(
                            rule1 = EndpointRule(false, 2.4f, 0f),
                            rule2 = EndpointRule(true, 1.4f, 0f),
                            rule3 = EndpointRule(false, 0f, 20f),
                        ),
                    ),
                )
                synchronized(lock) {
                    if (released) {
                        created.release()
                        loading = false
                        return@thread
                    }
                    recognizer = created
                }
                loading = false
                if (released || !wantListening) {
                    // The user stopped voice input while the model was loading.
                    postState(State.IDLE)
                } else {
                    startRecording(created)
                }
            } catch (error: Throwable) {
                loading = false
                wantListening = false
                if (!released) {
                    postError("离线语音模型加载失败：${error.message ?: "未知错误"}")
                    postState(State.IDLE)
                }
            }
        }
    }

    fun stop() {
        wantListening = false
        if (!recording) return
        recording = false
        runCatching { audioRecord?.stop() }
    }

    fun release() {
        released = true
        loading = false
        stop()
        val worker = recordThread
        runCatching { worker?.join(1500) }
        val current = synchronized(lock) {
            recognizer.also { recognizer = null }
        }
        // Never free the native recognizer while the decode thread may still use it.
        if (worker?.isAlive != true) current?.release()
    }

    private fun startRecording(current: OnlineRecognizer) {
        if (released || recording || !wantListening) return
        val record = createAudioRecord()
        if (record == null) {
            wantListening = false
            postState(State.IDLE)
            return
        }
        val stream = try {
            current.createStream()
        } catch (error: Throwable) {
            runCatching { record.release() }
            wantListening = false
            postError("语音识别初始化失败：${error.message ?: "未知错误"}")
            postState(State.IDLE)
            return
        }
        audioRecord = record
        activeStream = stream
        recording = true
        postState(State.LISTENING)
        recordThread = thread(name = "offline-asr-record") {
            runRecognition(current, record, stream)
        }
    }

    private fun runRecognition(current: OnlineRecognizer, record: AudioRecord, stream: OnlineStream) {
        val buffer = ShortArray(READ_SAMPLES)
        var lastPartial = ""
        try {
            record.startRecording()
            if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                throw IllegalStateException("录音设备没有进入工作状态")
            }
            while (recording) {
                val count = record.read(buffer, 0, buffer.size)
                if (count < 0) {
                    if (recording) throw IllegalStateException("读取麦克风失败（$count）")
                    break
                }
                if (count == 0) continue
                val samples = FloatArray(count) { buffer[it] / 32768.0f }
                stream.acceptWaveform(samples, SAMPLE_RATE)
                while (current.isReady(stream)) current.decode(stream)
                val text = current.getResult(stream).text
                if (text != lastPartial) {
                    lastPartial = text
                    postPartial(text)
                }
                if (current.isEndpoint(stream)) {
                    if (text.isNotBlank()) postFinal(text)
                    current.reset(stream)
                    lastPartial = ""
                    postPartial("")
                }
            }
            // Feed silence so the decoder emits the tail of the last utterance.
            stream.acceptWaveform(FloatArray(FLUSH_SAMPLES), SAMPLE_RATE)
            while (current.isReady(stream)) current.decode(stream)
            val tail = current.getResult(stream).text
            if (tail.isNotBlank()) postFinal(tail)
        } catch (error: Throwable) {
            if (recording && !released) postError("语音识别失败：${error.message ?: "未知错误"}")
        } finally {
            recording = false
            wantListening = false
            activeStream = null
            audioRecord = null
            runCatching { stream.release() }
            runCatching { record.release() }
            if (!released) postState(State.IDLE)
        }
    }

    private fun createAudioRecord(): AudioRecord? {
        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuffer <= 0) {
            postError("设备不支持 16kHz 录音")
            return null
        }
        val bufferSize = maxOf(minBuffer * 2, READ_SAMPLES * 2 * 2)
        val format = AudioFormat.Builder()
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .build()
        for (source in intArrayOf(MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC)) {
            val created = runCatching {
                AudioRecord.Builder()
                    .setAudioSource(source)
                    .setAudioFormat(format)
                    .setBufferSizeInBytes(bufferSize)
                    .build()
            }.getOrNull()
            if (created == null) continue
            if (created.state == AudioRecord.STATE_INITIALIZED) return created
            runCatching { created.release() }
        }
        postError("系统录音设备未能初始化")
        return null
    }

    private fun postState(state: State) {
        mainHandler.post { if (!released) onState(state) }
    }

    private fun postPartial(text: String) {
        mainHandler.post { if (!released) onPartial(text) }
    }

    private fun postFinal(text: String) {
        mainHandler.post { if (!released) onFinal(text) }
    }

    private fun postError(message: String) {
        mainHandler.post { if (!released) onError(message) }
    }

    companion object {
        const val SAMPLE_RATE = 16000
        private const val MODEL_DIR = "offline-asr"
        private const val READ_SAMPLES = 1600 // 100 ms
        private const val FLUSH_SAMPLES = SAMPLE_RATE * 3 / 5 // 600 ms
    }
}

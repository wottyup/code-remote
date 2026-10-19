package com.sevencnup.codexremote

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
 * The recognizer is preloaded when the composer is created and kept for later
 * sessions. Recording and decoding happen on a dedicated thread; callbacks are
 * posted to the main thread.
 */
class OfflineVoiceInput(
    context: Context,
    private val onState: (State) -> Unit,
    private val onPartial: (String) -> Unit,
    private val onFinal: (String) -> Unit,
    private val onError: (String) -> Unit,
) {
    enum class State { IDLE, LOADING, LISTENING, FINISHING }

    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()

    @Volatile private var recognizer: OnlineRecognizer? = null
    @Volatile private var released = false
    @Volatile private var loading = false
    @Volatile private var loadingAnnounced = false
    @Volatile private var recording = false
    @Volatile private var wantListening = false
    @Volatile private var activeStream: OnlineStream? = null
    @Volatile private var audioRecord: AudioRecord? = null
    private var loadThread: Thread? = null
    private var recordThread: Thread? = null

    /**
     * Loads the recognizer while the composer is idle so the first microphone
     * tap does not wait for the model. This never asks for microphone access.
     */
    fun preload() {
        if (released || recording || loading || recognizer != null) return
        loadRecognizer()
    }

    fun start() {
        if (released || recording) return
        wantListening = true
        val existing = recognizer
        if (existing != null) {
            startRecording(existing)
            return
        }
        // If a preload is already in flight, remember the tap and show progress.
        postState(State.LOADING)
        loadingAnnounced = true
        if (loading) return
        loadRecognizer()
    }

    private fun loadRecognizer() {
        if (loading || released || recognizer != null) return
        loading = true
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
                            rule1 = EndpointRule(false, 1.2f, 0f),
                            rule2 = EndpointRule(true, 0.8f, 0f),
                            rule3 = EndpointRule(false, 0f, 20f),
                        ),
                    ),
                )
                warmUp(created)
                synchronized(lock) {
                    if (released) {
                        created.release()
                        loading = false
                        loadingAnnounced = false
                        return@thread
                    }
                    recognizer = created
                }
                loading = false
                val announced = loadingAnnounced
                loadingAnnounced = false
                if (released) return@thread
                if (wantListening) {
                    startRecording(created)
                } else if (announced) {
                    // The user stopped voice input while the model was loading.
                    postState(State.IDLE)
                }
            } catch (error: Throwable) {
                loading = false
                val announced = loadingAnnounced
                val wanted = wantListening
                loadingAnnounced = false
                wantListening = false
                // A preload failure stays quiet; the next tap reports it.
                if (!released && (announced || wanted)) {
                    postError("离线语音模型加载失败：${error.message ?: "未知错误"}")
                    postState(State.IDLE)
                }
            }
        }
    }

    /**
     * Runs one silent inference so the first real utterance does not pay the
     * ONNX Runtime graph warm-up cost.
     */
    private fun warmUp(recognizer: OnlineRecognizer) {
        val stream = recognizer.createStream()
        try {
            stream.acceptWaveform(FloatArray(SAMPLE_RATE / 2), SAMPLE_RATE)
            while (recognizer.isReady(stream)) recognizer.decode(stream)
        } finally {
            runCatching { stream.release() }
        }
    }

    fun stop() {
        wantListening = false
        if (!recording) return
        recording = false
        // Acknowledge the tap immediately; the worker reports IDLE after the tail.
        postState(State.FINISHING)
        runCatching { audioRecord?.stop() }
    }

    fun release() {
        released = true
        loading = false
        stop()
        val current: OnlineRecognizer?
        val worker: Thread?
        synchronized(lock) {
            current = recognizer
            recognizer = null
            worker = recordThread
        }
        if (worker != null && worker !== Thread.currentThread()) {
            runCatching { worker.join(1500) }
        }
        // Never free the native recognizer while the decode thread may still use it.
        if (worker?.isAlive != true) current?.release()
    }

    private fun startRecording(current: OnlineRecognizer) {
        // Claim the session before touching AudioRecord, so stop() and
        // release() can cancel a start that is still being set up.
        synchronized(lock) {
            if (released || recording || recordThread?.isAlive == true || !wantListening) return
            recording = true
        }
        val record = createAudioRecord()
        if (record == null) {
            recording = false
            wantListening = false
            postState(State.IDLE)
            return
        }
        val stream = try {
            synchronized(lock) {
                // Keep the recognizer alive while creating the stream; release()
                // takes the same lock before freeing the native object.
                if (released || !recording) {
                    runCatching { record.release() }
                    if (!released) postState(State.IDLE)
                    return
                }
                current.createStream()
            }
        } catch (error: Throwable) {
            runCatching { record.release() }
            recording = false
            wantListening = false
            postError("语音识别初始化失败：${error.message ?: "未知错误"}")
            postState(State.IDLE)
            return
        }
        synchronized(lock) {
            if (released || !recording) {
                runCatching { stream.release() }
                runCatching { record.release() }
                // stop() may have arrived while the recorder was being set up.
                if (!released) postState(State.IDLE)
                return
            }
            audioRecord = record
            activeStream = stream
            recordThread = thread(name = "offline-asr-record") {
                runRecognition(current, record, stream)
            }
        }
    }

    private fun runRecognition(current: OnlineRecognizer, record: AudioRecord, stream: OnlineStream) {
        runCatching {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)
        }
        val buffer = ShortArray(READ_SAMPLES)
        var lastPostedPartial = ""
        var lastPartialPostAt = 0L
        try {
            if (!recording) return
            record.startRecording()
            if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                throw IllegalStateException("录音设备没有进入工作状态")
            }
            // Only claim to be listening once the microphone is actually live.
            if (recording) postState(State.LISTENING)
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
                val now = SystemClock.uptimeMillis()
                if (text != lastPostedPartial &&
                    (text.isEmpty() || now - lastPartialPostAt >= PARTIAL_POST_INTERVAL_MS)
                ) {
                    lastPostedPartial = text
                    lastPartialPostAt = now
                    postPartial(text)
                }
                if (current.isEndpoint(stream)) {
                    if (text.isNotBlank()) postFinal(text)
                    current.reset(stream)
                    lastPostedPartial = ""
                    lastPartialPostAt = 0L
                    postPartial("")
                }
            }
            // Feed a short silence tail so the decoder emits the last words.
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
        private const val READ_SAMPLES = 640 // 40 ms
        private const val PARTIAL_POST_INTERVAL_MS = 60L
        private const val FLUSH_SAMPLES = SAMPLE_RATE / 4 // 250 ms
    }
}

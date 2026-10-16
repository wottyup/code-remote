package com.sevencnup.codexremote

import android.animation.ValueAnimator
import android.Manifest
import android.app.Activity
import android.app.Dialog
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.Typeface
import android.graphics.BitmapFactory
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.text.InputType
import android.text.Layout
import android.text.SpannableString
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextDirectionHeuristics
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.view.VelocityTracker
import android.view.WindowInsets
import android.view.WindowInsetsAnimation
import android.view.Window
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ProgressBar
import android.widget.RelativeLayout
import android.widget.SeekBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.util.LruCache
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import kotlin.math.max
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.ceil

class MainActivity : Activity() {
    private val prefs by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }
    private val themeName: String get() = prefs.getString(KEY_THEME, if (prefs.getBoolean(KEY_LIGHT_THEME, false)) "light" else "dark") ?: "dark"
    private val lightTheme get() = when (themeName) {
        "light", "warm" -> true
        "custom" -> Color.luminance(parseThemeColor(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND)) > .46f
        else -> false
    }
    private val DARK: Int get() = when (themeName) {
        "light" -> Color.rgb(247, 248, 250)
        "warm" -> Color.rgb(247, 240, 230)
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND), (100 - prefs.getInt(KEY_BACKGROUND_TRANSPARENCY, 0)).coerceIn(0, 100) / 100f)
        else -> Color.rgb(16, 17, 20)
    }
    private val PANEL: Int get() = when (themeName) {
        "warm" -> Color.rgb(255, 250, 243)
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND), .9f)
        else -> if (lightTheme) Color.rgb(255, 255, 255) else Color.rgb(23, 25, 30)
    }
    private val PANEL_INSET: Int get() = when (themeName) {
        "warm" -> Color.rgb(241, 231, 216)
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND), .78f)
        else -> if (lightTheme) Color.rgb(241, 243, 246) else Color.rgb(30, 32, 38)
    }
    private val BORDER: Int get() = when (themeName) {
        "warm" -> Color.rgb(225, 211, 194)
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT), .3f)
        else -> if (lightTheme) Color.rgb(213, 217, 224) else Color.rgb(52, 55, 63)
    }
    private val USER_BUBBLE: Int get() = when (themeName) {
        "warm" -> Color.rgb(240, 226, 208)
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND), .68f)
        else -> if (lightTheme) Color.rgb(232, 236, 244) else Color.rgb(29, 31, 37)
    }
    private val TEXT: Int get() = when (themeName) {
        "warm" -> Color.rgb(66, 53, 40)
        "custom" -> parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT)
        else -> if (lightTheme) Color.rgb(35, 38, 43) else Color.rgb(239, 241, 246)
    }
    private val SUBTLE: Int get() = when (themeName) {
        "warm" -> Color.rgb(109, 91, 71)
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT), .84f)
        else -> if (lightTheme) Color.rgb(77, 83, 93) else Color.rgb(194, 198, 208)
    }
    private val MUTED: Int get() = when (themeName) {
        "warm" -> Color.rgb(139, 121, 100)
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT), .64f)
        else -> if (lightTheme) Color.rgb(105, 112, 123) else Color.rgb(139, 145, 156)
    }
    private val ACCENT: Int get() = when {
        currentMode == "claude-code" -> if (lightTheme) Color.rgb(205, 102, 67) else Color.rgb(240, 141, 108)
        themeName == "warm" -> Color.rgb(146, 114, 83)
        themeName == "custom" -> parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT)
        lightTheme -> Color.rgb(75, 96, 157)
        else -> Color.rgb(170, 186, 255)
    }
    private val ACCENT_WARM: Int get() = if (lightTheme) Color.rgb(205, 102, 67) else Color.rgb(240, 141, 108)
    private val WARNING: Int get() = if (lightTheme) Color.rgb(135, 91, 28) else Color.rgb(232, 190, 112)
    private val ERROR: Int get() = if (lightTheme) Color.rgb(173, 48, 57) else Color.rgb(229, 135, 142)
    private val handler = Handler(Looper.getMainLooper())
    private val io: ExecutorService = Executors.newFixedThreadPool(3)
    private val socketClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
    private val messageImageCache = object : LruCache<String, Bitmap>(24 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = (value.byteCount / 1024).coerceAtLeast(1)
    }

    private var endpoint = ""
    private var token = ""
    private var currentMode = "codex"
    private var activeThreadId: String? = null
    private var activeThread: JSONObject? = null
    private var runtime = JSONObject()
    private var threads = JSONArray()
    internal var models = JSONArray()
    private var queuedMessages = JSONArray()
    private var syncRevisions = mutableMapOf<String, String>()
    private val threadReadsInFlight = mutableSetOf<String>()
    private val pendingThreadReads = mutableSetOf<String>()
    private val pinnedThreadIds = mutableSetOf<String>()
    private var running = false
    private var foreground = false
    private var sidebarVisible = false
    private var sidebarProgress = 0f
    private var sidebarRenderDirty = true
    private var sidebarGestureActive = false
    private var sidebarAnimator: ValueAnimator? = null
    private var workspaceVisible = false
    private var workspaceProgress = 0f
    private var workspaceLoadedPath: String? = null
    private var workspaceLoadingPath: String? = null
    private var workspaceAnimator: ValueAnimator? = null
    private var workspaceGestureActive = false
    private var workspacePendingRender: (() -> Unit)? = null
    private var messageRenderDeferred = false
    private var deferredMessageScrollToEnd = false
    private var deferredMessageRequiresFullRender = false
    private val deferredMessageTurnIds = mutableSetOf<String>()
    private var settingsOverlay: View? = null
    private var settingsDialog: Dialog? = null
    private var settingsNotificationButton: TextView? = null
    private var notificationPermissionRequestedFromSettings = false
    private var preferencePopup: PopupWindow? = null
    private var sidebarHost: EdgeDrawerHost? = null
    private var workspaceHost: EdgeDrawerHost? = null
    private var workspaceOverlay: FrameLayout? = null
    private var workspacePanel: LinearLayout? = null
    private var workspaceScrim: View? = null
    private var workspaceLoader: ((String) -> Unit)? = null
    private var workspaceRefresher: ((String) -> Unit)? = null
    private var historyLoadingThreadId: String? = null
    private var historyLoadError: String? = null
    private var historySelectionGeneration = 0L
    private var queueExpanded = false
    private var expandedOperationIds = mutableSetOf<String>()
    private var fullyExpandedOperationIds = mutableSetOf<String>()
    private var expandedFileChangeIds = mutableSetOf<String>()
    private var visibleHistoryTurnCount = DEFAULT_VISIBLE_HISTORY_TURNS
    private var selectedFiles = mutableListOf<JSONObject>()
    private var workspaceClipboard = mutableListOf<String>()
    private var workspaceClipboardMode = "copy"
    private var socket: WebSocket? = null
    private var socketConnected = false
    private var outstandingSocketPing: String? = null
    private var socketPingSentAt = 0L
    private var lastSocketActivityAt = 0L
    private var backgroundedAt = 0L
    private var pendingApproval: JSONObject? = null
    private var terminalOverlay: LinearLayout? = null
    private var terminalPositionListener: View.OnLayoutChangeListener? = null
    private var terminalSocket: WebSocket? = null
    private var terminalOutput: TextView? = null
    private var terminalStatusView: TextView? = null
    private var terminalDraftInput: EditText? = null
    private var terminalScreen = TerminalScreenBuffer(88, 26)
    @Volatile private var terminalReady = false
    private var terminalImeVisible = false
    private var terminalImeHiddenUntil = 0L
    private var attachRequestActive = false
    private var workspaceCurrentPath = ""
    private var workspaceRootPath = ""
    private var claudeAvailable = false
    private var claudeStatusMessage = "Claude Code 不可用"
    private var systemInsetLeft = 0
    private var systemInsetTop = 0
    private var systemInsetRight = 0
    private var systemInsetBottom = 0
    private var imeInsetVisible = false
    private var imeFollowMessageBottom = false
    private var imeFollowScrollQueued = false
    private var completionNoticeThreadId: String? = null
    private var completionNoticeEngine: String? = null
    private var completionNoticeDismissRunnable: Runnable? = null
    private var pendingCompletionNoticeThreadId: String? = null
    private var modeSwitchDismissRunnable: Runnable? = null
    private var workspacePathNavigate: ((String) -> Unit)? = null
    private var workspacePathInput: EditText? = null
    private var themeBackgroundPickerActive = false
    private var previewFontAdjustment: Int? = null
    private var activeThreadRefreshScheduled = false
    private var lastActiveThreadRefreshAt = 0L
    private val historyMemoryCache = object : LinkedHashMap<String, JSONObject>(12, .75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JSONObject>?): Boolean = size > 12
    }

    private lateinit var root: FrameLayout
    private lateinit var page: LinearLayout
    private lateinit var headerView: LinearLayout
    private lateinit var composerDock: LinearLayout
    private lateinit var titleView: TextView
    private lateinit var modeButton: ImageButton
    private lateinit var statusView: TextView
    private lateinit var messageScroll: ScrollView
    private lateinit var messageList: LinearLayout
    private lateinit var scrollToBottomButton: ImageButton
    private lateinit var queuePanel: LinearLayout
    private lateinit var queueContent: LinearLayout
    private lateinit var completionNotice: LinearLayout
    private lateinit var modeSwitchNotice: LinearLayout
    private lateinit var composerInput: EditText
    private lateinit var attachmentScroll: HorizontalScrollView
    private lateinit var attachmentStrip: LinearLayout
    private lateinit var sendButton: TextView
    private lateinit var modelButton: TextView
    private lateinit var effortButton: TextView
    private lateinit var permissionButton: TextView
    private lateinit var drawer: LinearLayout
    private lateinit var drawerSearch: EditText
    private lateinit var drawerThreads: LinearLayout

    private data class EdgeDrawerHost(
        val overlay: FrameLayout,
        val scrim: View,
        val panel: LinearLayout,
        val gravity: Int,
    )

    private val socketHeartbeatRunnable = object : Runnable {
        override fun run() {
            if (!foreground || !socketConnected) return
            val now = System.currentTimeMillis()
            if (outstandingSocketPing != null && now - socketPingSentAt > 35_000) {
                socket?.cancel()
                return
            }
            val pingId = UUID.randomUUID().toString()
            if (socket?.send(JSONObject().put("type", "ping").put("id", pingId).toString()) == true) {
                outstandingSocketPing = pingId
                socketPingSentAt = now
            } else {
                socket?.cancel()
                return
            }
            handler.postDelayed(this, 20_000)
        }
    }

    private val refreshRunnable = object : Runnable {
        override fun run() {
            if (token.isNotBlank() && foreground) {
                if (!socketConnected) {
                    refreshThreads(false)
                    refreshActiveThread(false)
                    refreshQueue(false)
                    connectSocket()
                }
                handler.postDelayed(this, if (socketConnected) 30_000 else 15_000)
            }
        }
    }
    private val activeThreadRefreshRunnable = Runnable {
        activeThreadRefreshScheduled = false
        lastActiveThreadRefreshAt = android.os.SystemClock.uptimeMillis()
        refreshActiveThread(false)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.statusBarColor = Color.TRANSPARENT
            window.navigationBarColor = Color.TRANSPARENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.isStatusBarContrastEnforced = false
                window.isNavigationBarContrastEnforced = false
            }
        } else {
            window.statusBarColor = DARK
            window.navigationBarColor = DARK
        }
        window.decorView.setBackgroundColor(DARK)
        window.decorView.systemUiVisibility = if (lightTheme) {
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        } else 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false

        endpoint = prefs.getString(KEY_ENDPOINT, "").orEmpty()
        token = prefs.getString(KEY_TOKEN, "").orEmpty()
        currentMode = prefs.getString(KEY_MODE, "codex") ?: "codex"
        if (endpoint.isNotBlank() && token.isNotBlank()) {
            openChatHome()
            verifySavedConnection(homeAlreadyOpen = true)
        } else showConnectionPage()
    }

    override fun onResume() {
        super.onResume()
        foreground = true
        if (token.isNotBlank()) {
            val now = System.currentTimeMillis()
            val resumedFromLongPause = backgroundedAt > 0L && now - backgroundedAt > 30_000L
            val socketIsStale = lastSocketActivityAt > 0L && now - lastSocketActivityAt > 45_000L
            if (socket != null && (!socketConnected || resumedFromLongPause || socketIsStale)) {
                socket?.cancel()
                socket = null
                socketConnected = false
                outstandingSocketPing = null
            }
            backgroundedAt = 0L
            connectSocket()
            handler.removeCallbacks(socketHeartbeatRunnable)
            handler.postDelayed(socketHeartbeatRunnable, 20_000)
            if (activeThreadId != null) {
                refreshThreads(false)
                refreshActiveThread(false)
                refreshQueue(false)
            }
            handler.removeCallbacks(refreshRunnable)
            handler.post(refreshRunnable)
        }
    }

    override fun onPause() {
        persistCurrentDraft()
        foreground = false
        backgroundedAt = System.currentTimeMillis()
        handler.removeCallbacks(refreshRunnable)
        handler.removeCallbacks(activeThreadRefreshRunnable)
        activeThreadRefreshScheduled = false
        handler.removeCallbacks(socketHeartbeatRunnable)
        outstandingSocketPing = null
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, "activity destroyed")
        terminalSocket?.close(1000, "terminal closed")
        io.shutdownNow()
        super.onDestroy()
    }

    @Deprecated("Native back handling is kept compatible with Android versions supported by this app")
    override fun onBackPressed() {
        when {
            settingsDialog?.isShowing == true -> settingsDialog?.dismiss()
            preferencePopup?.isShowing == true -> preferencePopup?.dismiss()
            settingsOverlay != null -> closeSettings()
            terminalOverlay != null && (terminalImeVisible || System.currentTimeMillis() < terminalImeHiddenUntil) -> {
                terminalImeHiddenUntil = 0L
                val input = terminalDraftInput
                if (input != null) {
                    (getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
                        ?.hideSoftInputFromWindow(input.windowToken, 0)
                }
            }
            terminalOverlay != null -> closeTerminal()
            workspaceVisible -> handleWorkspaceBack()
            sidebarVisible -> setSidebarVisible(false)
            activeThreadId != null -> showConfirmDialog("关闭应用", "要关闭 Codex Remote 吗？", "关闭") { finish() }
            else -> super.onBackPressed()
        }
    }

    private fun showConnectionPage(message: String? = null) {
        root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(16, 17, 20)) }
        installThemeBackground(root)
        val scroll = ScrollView(this).apply { isFillViewport = true; isVerticalScrollBarEnabled = false }
        root.addView(scroll, FrameLayout.LayoutParams(MATCH, MATCH))
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(24), dp(26), dp(24), dp(24))
        }
        scroll.addView(card, ViewGroup.LayoutParams(MATCH, MATCH))
        val mark = label("C", 22, TEXT, true).apply {
            gravity = Gravity.CENTER
            background = rounded(PANEL_INSET, dp(12))
        }
        card.addView(mark, LinearLayout.LayoutParams(dp(48), dp(48)).apply { bottomMargin = dp(18) })
        card.addView(label("CODEX REMOTE · ANDROID", 10, MUTED, true), widthWrap())
        card.addView(label("连接本机 Codex", 25, TEXT, true).apply { setPadding(0, dp(8), 0, dp(4)) }, widthWrap())
        card.addView(label("输入电脑网页地址和终端显示的匹配码。配对信息保存在本机，之后会自动重连。", 13, MUTED).apply {
            setLineSpacing(dp(2).toFloat(), 1.2f)
        }, widthWrap())

        card.addView(label("电脑网页地址", 12, SUBTLE, true).apply { setPadding(0, dp(22), 0, dp(6)) }, widthWrap())
        val address = editField("http://192.168.x.x:4173", endpoint, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        address.setSingleLine(true)
        card.addView(address, LinearLayout.LayoutParams(MATCH, dp(48)))
        card.addView(label("匹配码", 12, SUBTLE, true).apply { setPadding(0, dp(13), 0, dp(6)) }, widthWrap())
        val code = editField("输入电脑终端显示的匹配码", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        code.setSingleLine(true)
        card.addView(code, LinearLayout.LayoutParams(MATCH, dp(48)))
        val connect = actionButton("检测并连接")
        card.addView(connect, LinearLayout.LayoutParams(MATCH, dp(46)).apply { topMargin = dp(14) })
        val status = label(message.orEmpty(), 12, if (message == null) MUTED else ERROR).apply {
            setPadding(0, dp(12), 0, 0)
            setLineSpacing(dp(2).toFloat(), 1.2f)
        }
        card.addView(status, widthWrap())
        card.addView(label("手机需要能访问电脑上的 Codex Remote 服务。地址和配对码只用于本机连接。", 11, MUTED).apply {
            setPadding(0, dp(24), 0, 0)
        }, widthWrap())
        connect.setOnClickListener {
            val rawEndpoint = address.text.toString()
            val pairingCode = code.text.toString().trim()
            val normalized = try {
                RemoteApi.normalizeEndpoint(rawEndpoint)
            } catch (error: Exception) {
                status.text = error.message
                return@setOnClickListener
            }
            if (pairingCode.isBlank()) {
                status.text = "请输入电脑终端显示的匹配码。"
                return@setOnClickListener
            }
            connect.isEnabled = false
            connect.text = "正在连接…"
            status.setTextColor(MUTED)
            status.text = "正在连接电脑服务并验证配对码…"
            io.execute {
                try {
                    val paired = RemoteApi(normalized).post("/api/v1/pair", JSONObject().put("code", pairingCode))
                    val newToken = paired.getString("token")
                    handler.post {
                        endpoint = normalized
                        token = newToken
                        prefs.edit().putString(KEY_ENDPOINT, endpoint).putString(KEY_TOKEN, token).apply()
                        openChatHome()
                    }
                } catch (error: Exception) {
                    handler.post {
                        connect.isEnabled = true
                        connect.text = "检测并连接"
                        status.setTextColor(ERROR)
                        status.text = error.message ?: "连接失败，请确认电脑服务和匹配码。"
                    }
                }
            }
        }
        setContentView(root)
        installWindowInsets(root)
    }

    private fun verifySavedConnection(homeAlreadyOpen: Boolean = false) {
        io.execute {
            try {
                RemoteApi(endpoint, token).get("/api/v1/codex/status")
                if (!homeAlreadyOpen) handler.post { openChatHome() }
            } catch (error: Exception) {
                if (error is RemoteApiException && error.statusCode == 401) {
                    handler.post {
                        prefs.edit().remove(KEY_TOKEN).apply()
                        token = ""
                        showConnectionPage(error.message ?: "配对已失效，请重新输入匹配码。")
                    }
                } else {
                    handler.post {
                        if (!homeAlreadyOpen) openChatHome()
                        showStatus("电脑服务暂时无法连接，已保留配对信息，正在重试。")
                    }
                }
            }
        }
    }

    private fun openChatHome() {
        socket?.close(1000, "reconnecting")
        socket = null
        socketConnected = false
        outstandingSocketPing = null
        activeThreadId = null
        activeThread = null
        runtime = JSONObject()
        threads = JSONArray()
        models = JSONArray()
        queuedMessages = JSONArray()
        historyLoadingThreadId = null
        historyLoadError = null
        historySelectionGeneration += 1
        visibleHistoryTurnCount = DEFAULT_VISIBLE_HISTORY_TURNS
        handler.removeCallbacks(activeThreadRefreshRunnable)
        activeThreadRefreshScheduled = false
        lastActiveThreadRefreshAt = 0L
        sidebarVisible = false
        sidebarProgress = 0f
        workspaceVisible = false
        workspaceProgress = 0f
        workspaceAnimator?.cancel()
        sidebarHost = null
        workspaceHost = null
        workspaceOverlay?.visibility = View.GONE
        workspaceOverlay = null
        workspacePanel = null
        workspaceScrim = null
        workspaceLoader = null
        workspaceRefresher = null
        workspaceLoadedPath = null
        workspaceLoadingPath = null
        workspaceGestureActive = false
        workspacePendingRender = null
        closeTerminal()
        messageRenderDeferred = false
        deferredMessageScrollToEnd = false
        deferredMessageRequiresFullRender = false
        deferredMessageTurnIds.clear()
        syncRevisions.clear()
        renderHome()
        prefs.getString("$KEY_ACTIVE_THREAD_PREFIX$currentMode", null)
            ?.takeIf { it.isNotBlank() }
            ?.let { cachedId ->
                selectThread(
                    JSONObject().put("id", cachedId).put("engine", currentMode),
                    eagerDiskCache = true,
                )
            }
        refreshRuntime()
        refreshThreads(true)
        refreshPins()
        refreshClaudeStatus()
        refreshModels()
        connectSocket()
        handler.removeCallbacks(refreshRunnable)
        handler.post(refreshRunnable)
    }

    private fun installWindowInsets(view: View, content: View? = null) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val update = { insets: WindowInsets ->
            val systemBars = insets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsets.Type.ime())
            val keyboardVisible = insets.isVisible(WindowInsets.Type.ime())
            val keyboardJustOpened = keyboardVisible && !imeInsetVisible
            val bottom = if (keyboardVisible) max(systemBars.bottom, ime.bottom) else systemBars.bottom
            imeInsetVisible = keyboardVisible
            if (content == null) {
                view.setPadding(systemBars.left, systemBars.top, systemBars.right, bottom)
            } else {
                if (keyboardJustOpened && ::messageScroll.isInitialized) {
                    val distanceToBottom = messageList.height - messageScroll.scrollY - messageScroll.height
                    imeFollowMessageBottom = ::composerInput.isInitialized && composerInput.hasFocus() && distanceToBottom <= dp(180)
                }
                systemInsetLeft = systemBars.left
                systemInsetTop = systemBars.top
                systemInsetRight = systemBars.right
                systemInsetBottom = systemBars.bottom
                view.setPadding(0, 0, 0, 0)
                if (content.paddingLeft != systemBars.left || content.paddingTop != 0 ||
                    content.paddingRight != systemBars.right || content.paddingBottom != bottom
                ) {
                    content.setPadding(systemBars.left, 0, systemBars.right, bottom)
                }
                updateInsetAwareOverlays()
                val terminalKeyboardVisible = keyboardVisible && terminalDraftInput?.hasFocus() == true
                terminalImeHiddenUntil = when {
                    terminalKeyboardVisible -> 0L
                    terminalImeVisible -> System.currentTimeMillis() + 500L
                    else -> terminalImeHiddenUntil
                }
                terminalImeVisible = terminalKeyboardVisible
                if (keyboardJustOpened && imeFollowMessageBottom && !imeFollowScrollQueued && ::messageScroll.isInitialized) {
                    imeFollowScrollQueued = true
                    messageScroll.postOnAnimation {
                        imeFollowScrollQueued = false
                        if (imeInsetVisible && imeFollowMessageBottom) messageScroll.scrollTo(0, messageList.height)
                    }
                } else if (!keyboardVisible) {
                    imeFollowMessageBottom = false
                    imeFollowScrollQueued = false
                }
            }
        }
        view.setOnApplyWindowInsetsListener { _, insets ->
            update(insets)
            insets
        }
        view.setWindowInsetsAnimationCallback(object : WindowInsetsAnimation.Callback(
            WindowInsetsAnimation.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE,
        ) {
            override fun onProgress(
                insets: WindowInsets,
                runningAnimations: MutableList<WindowInsetsAnimation>,
            ): WindowInsets {
                update(insets)
                return insets
            }
        })
        view.requestApplyInsets()
    }

    private fun updateInsetAwareOverlays() {
        if (::headerView.isInitialized) {
            headerView.setPadding(dp(10), systemInsetTop + dp(2), dp(8), dp(2))
            headerView.layoutParams?.let { params ->
                val targetHeight = systemInsetTop + dp(44)
                if (params.height != targetHeight) {
                    params.height = targetHeight
                    headerView.layoutParams = params
                }
            }
        }
        applyEdgeDrawerInsets(sidebarHost)
        applyEdgeDrawerInsets(workspaceHost)
        (settingsOverlay?.findViewWithTag<View>(TAG_INSET_CONTENT))?.setPadding(
            systemInsetLeft,
            systemInsetTop,
            systemInsetRight,
            systemInsetBottom,
        )
        positionTerminalOverlay()
    }

    private fun renderHome() {
        root = ChatRootLayout(this).apply { setBackgroundColor(Color.rgb(16, 17, 20)) }
        installThemeBackground(root)
        page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(if (themeName == "custom") Color.TRANSPARENT else DARK)
        }
        root.addView(page, FrameLayout.LayoutParams(MATCH, MATCH))
        buildHeader()
        statusView = label("正在连接…", 11, MUTED).apply {
            setPadding(dp(16), 0, dp(16), dp(4))
            visibility = View.GONE
        }
        page.addView(statusView, widthWrap())
        messageScroll = ScrollView(this).apply {
            isFillViewport = false
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            clipToPadding = false
            setPadding(dp(12), dp(8), dp(12), dp(8))
        }
        messageList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        messageScroll.addView(messageList, FrameLayout.LayoutParams(MATCH, WRAP))
        val chatArea = FrameLayout(this).apply { clipChildren = false }
        chatArea.addView(messageScroll, FrameLayout.LayoutParams(MATCH, MATCH))
        scrollToBottomButton = iconButton("chevron_down", "回到底部") {
            messageScroll.post { messageScroll.smoothScrollTo(0, messageList.height) }
        }.apply {
            imageTintList = ColorStateList.valueOf(TEXT)
            setPadding(dp(10), dp(10), dp(10), dp(10))
            background = rounded(PANEL, dp(21), BORDER, dp(1))
            elevation = dp(3).toFloat()
            visibility = View.GONE
        }
        chatArea.addView(scrollToBottomButton, FrameLayout.LayoutParams(dp(42), dp(42), Gravity.END or Gravity.BOTTOM).apply {
            rightMargin = dp(16)
            bottomMargin = dp(12)
        })
        messageScroll.setOnScrollChangeListener { _, _, _, _, _ -> updateScrollToBottomButton() }
        page.addView(chatArea, LinearLayout.LayoutParams(MATCH, 0, 1f))
        buildQueuePanel()
        buildCompletionNotice()
        buildModeSwitchNotice()
        buildComposer()
        buildSidebar()
        setContentView(root)
        installWindowInsets(root, page)
        root.post { if (::root.isInitialized && workspaceOverlay == null) ensureWorkspaceBrowser() }
        renderHeader()
        renderMessages(false)
        renderQueue()
        renderSidebar(force = true)
    }

    private fun buildHeader() {
        headerView = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(2), dp(8), dp(2))
            setBackgroundColor(DARK)
        }
        val menu = iconButton("menu", "打开对话列表") { setSidebarVisible(true) }
        headerView.addView(menu, LinearLayout.LayoutParams(dp(40), dp(40)))
        val titleColumn = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(4), 0, dp(4), 0) }
        titleView = label("Codex Remote", 14, TEXT, true).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        titleColumn.addView(titleView, widthWrap())
        val path = label("本机项目", 10, MUTED).apply { tag = "workspace_path"; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE }
        titleColumn.addView(path, widthWrap())
        headerView.addView(titleColumn, LinearLayout.LayoutParams(0, WRAP, 1f))
        modeButton = iconButton(if (currentMode == "codex") "codex" else "claude", "切换 Codex / Claude") { switchMode() }
        headerView.addView(modeButton, LinearLayout.LayoutParams(dp(40), dp(40)))
        headerView.addView(iconButton("terminal", "打开终端") { showTerminal() }, LinearLayout.LayoutParams(dp(40), dp(40)))
        headerView.addView(iconButton("folder", "打开文件树") { showWorkspaceBrowser() }, LinearLayout.LayoutParams(dp(40), dp(40)))
        page.addView(headerView, LinearLayout.LayoutParams(MATCH, dp(44)))
    }

    private fun buildQueuePanel() {
        queuePanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(5), dp(14), dp(2))
            visibility = View.GONE
        }
        queueContent = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        page.addView(queuePanel, widthWrap())
        page.addView(queueContent, LinearLayout.LayoutParams(MATCH, WRAP).apply {
            leftMargin = dp(14); rightMargin = dp(14); bottomMargin = dp(4)
        })
    }

    private fun buildCompletionNotice() {
        completionNotice = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(6), dp(6), dp(6))
            background = rounded(PANEL, dp(12), BORDER, dp(1))
            visibility = View.GONE
            elevation = dp(3).toFloat()
        }
        page.addView(completionNotice, LinearLayout.LayoutParams(MATCH, WRAP).apply {
            leftMargin = dp(12); rightMargin = dp(12); bottomMargin = dp(5)
        })
    }

    private fun showCompletionNotice(threadId: String, engine: String) {
        if (!::completionNotice.isInitialized || engine == currentMode) return
        completionNoticeThreadId = threadId
        completionNoticeEngine = engine
        completionNotice.removeAllViews()
        val brand = ImageView(this).apply {
            setImageResource(if (engine == "claude-code") R.drawable.ic_brand_claude else R.drawable.ic_brand_codex)
            imageTintList = ColorStateList.valueOf(if (engine == "claude-code") ACCENT_WARM else codexBrandAccent())
            contentDescription = if (engine == "claude-code") "Claude Code" else "Codex"
        }
        completionNotice.addView(brand, LinearLayout.LayoutParams(dp(22), dp(22)).apply { rightMargin = dp(9) })
        val thread = findThread(threadId)
        val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        copy.addView(label(thread?.let(::threadTitle)?.let { "“$it”已完成回复" } ?: "另一模式的对话已完成回复", 12, TEXT, true), widthWrap())
        copy.addView(label("${if (engine == "claude-code") "Claude Code" else "Codex"} 已完成 · 点击查看", 10, MUTED), widthWrap())
        completionNotice.addView(copy, LinearLayout.LayoutParams(0, WRAP, 1f))
        completionNotice.addView(ImageView(this).apply {
            val activeClaude = currentMode == "claude-code"
            setImageResource(if (activeClaude) R.drawable.ic_brand_claude else R.drawable.ic_brand_codex)
            imageTintList = ColorStateList.valueOf(if (activeClaude) ACCENT_WARM else codexBrandAccent())
            contentDescription = "当前${if (activeClaude) "Claude Code" else "Codex"}模式"
        }, LinearLayout.LayoutParams(dp(19), dp(19)).apply { rightMargin = dp(3) })
        completionNotice.addView(iconButton("close", "关闭完成提示") { dismissCompletionNotice() }, LinearLayout.LayoutParams(dp(30), dp(30)))
        completionNotice.setOnClickListener {
            val target = completionNoticeThreadId?.let(::findThread)
            if (target != null) selectThread(target) else {
                pendingCompletionNoticeThreadId = completionNoticeThreadId
                refreshThreads(true)
            }
            dismissCompletionNotice()
        }
        completionNotice.visibility = View.VISIBLE
        completionNoticeDismissRunnable?.let(handler::removeCallbacks)
        completionNoticeDismissRunnable = Runnable { dismissCompletionNotice() }.also { handler.postDelayed(it, 3_500L) }
    }

    private fun dismissCompletionNotice() {
        completionNoticeDismissRunnable?.let(handler::removeCallbacks)
        completionNoticeDismissRunnable = null
        completionNoticeThreadId = null
        completionNoticeEngine = null
        if (::completionNotice.isInitialized) completionNotice.visibility = View.GONE
    }

    private fun buildModeSwitchNotice() {
        modeSwitchNotice = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(6), dp(6), dp(6))
            background = rounded(PANEL, dp(12), BORDER, dp(1))
            visibility = View.GONE
        }
        page.addView(modeSwitchNotice, LinearLayout.LayoutParams(MATCH, WRAP).apply {
            leftMargin = dp(12); rightMargin = dp(12); bottomMargin = dp(5)
        })
    }

    private fun showModeSwitchNotice(previousMode: String, newMode: String) {
        if (!::modeSwitchNotice.isInitialized) return
        modeSwitchNotice.removeAllViews()
        listOf(previousMode, newMode).forEachIndexed { index, engine ->
            val claude = engine == "claude-code"
            modeSwitchNotice.addView(ImageView(this).apply {
                setImageResource(if (claude) R.drawable.ic_brand_claude else R.drawable.ic_brand_codex)
                imageTintList = ColorStateList.valueOf(if (claude) ACCENT_WARM else codexBrandAccent())
                contentDescription = if (claude) "Claude Code" else "Codex"
            }, LinearLayout.LayoutParams(dp(19), dp(19)).apply { if (index == 0) rightMargin = dp(4) else leftMargin = dp(4) })
            if (index == 0) modeSwitchNotice.addView(label("→", 13, MUTED, true), LinearLayout.LayoutParams(WRAP, WRAP))
        }
        val modeLabel = if (newMode == "claude-code") "Claude Code" else "Codex"
        val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(8), 0, 0, 0) }
        copy.addView(label("已切换到 $modeLabel", 12, TEXT, true), widthWrap())
        copy.addView(label("新消息将发送到当前模式", 10, MUTED), widthWrap())
        modeSwitchNotice.addView(copy, LinearLayout.LayoutParams(0, WRAP, 1f))
        modeSwitchNotice.addView(iconButton("close", "关闭模式提示") { dismissModeSwitchNotice() }, LinearLayout.LayoutParams(dp(30), dp(30)))
        modeSwitchNotice.visibility = View.VISIBLE
        modeSwitchDismissRunnable?.let(handler::removeCallbacks)
        modeSwitchDismissRunnable = Runnable { dismissModeSwitchNotice() }.also { handler.postDelayed(it, 2_800L) }
    }

    private fun dismissModeSwitchNotice() {
        modeSwitchDismissRunnable?.let(handler::removeCallbacks)
        modeSwitchDismissRunnable = null
        if (::modeSwitchNotice.isInitialized) modeSwitchNotice.visibility = View.GONE
    }

    private fun buildComposer() {
        composerDock = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(2), dp(12), dp(12))
            background = rounded(DARK, dp(18))
        }
        val composer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(11), dp(8), dp(11), dp(6))
            background = rounded(PANEL, dp(18), BORDER, dp(1))
        }
        composerInput = editField("发送消息…", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_MULTI_LINE).apply {
            minHeight = dp(44)
            maxLines = 5
            gravity = Gravity.TOP or Gravity.START
            imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_ACTION_SEND
            setPadding(dp(2), dp(5), dp(2), dp(4))
            background = null
            setOnEditorActionListener { _, action, event ->
                val enter = event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER && event.isShiftPressed != true
                if (action == EditorInfo.IME_ACTION_SEND || enter) {
                    sendCurrentMessage()
                    true
                } else false
            }
            addTextChangedListener(SimpleTextWatcher { value -> prefs.edit().putString(draftStorageKey(), value).apply() })
        }
        attachmentStrip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            clipChildren = false
            clipToPadding = false
        }
        attachmentScroll = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            clipChildren = false
            clipToPadding = false
            visibility = View.GONE
            addView(attachmentStrip, FrameLayout.LayoutParams(WRAP, MATCH))
        }
        // Keep attachment previews above the editable text, matching the web composer.
        // A fixed-height horizontal strip prevents long filenames or multiple images
        // from growing the input field vertically.
        composer.addView(attachmentScroll, LinearLayout.LayoutParams(MATCH, dp(60)).apply {
            bottomMargin = dp(3)
        })
        composer.addView(composerInput, LinearLayout.LayoutParams(MATCH, WRAP))

        val footer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        footer.addView(iconButton("add", "添加图片或文件") { chooseAttachment() }, LinearLayout.LayoutParams(dp(40), dp(40)))
        val preferenceScroll = HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_NEVER }
        val preferenceRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        modelButton = preferenceButton("模型") { showModelOptions() }
        effortButton = preferenceButton("思考") { showEffortOptions() }
        permissionButton = preferenceButton("权限") { showPermissionOptions() }
        preferenceRow.addView(modelButton, LinearLayout.LayoutParams(WRAP, dp(40)))
        preferenceRow.addView(effortButton, LinearLayout.LayoutParams(WRAP, dp(40)).apply { leftMargin = dp(4) })
        preferenceRow.addView(permissionButton, LinearLayout.LayoutParams(WRAP, dp(40)).apply { leftMargin = dp(4) })
        preferenceScroll.addView(preferenceRow)
        footer.addView(preferenceScroll, LinearLayout.LayoutParams(0, dp(40), 1f))
        sendButton = label("↑", 18, DARK, true).apply {
            gravity = Gravity.CENTER
            includeFontPadding = false
            background = rounded(if (lightTheme) Color.rgb(35, 38, 43) else Color.rgb(228, 230, 235), dp(17))
            setOnClickListener { if (running) interruptTurn() else sendCurrentMessage() }
            contentDescription = "发送消息"
        }
        footer.addView(sendButton, LinearLayout.LayoutParams(dp(30), dp(30)).apply {
            leftMargin = dp(6)
            gravity = Gravity.CENTER_VERTICAL
        })
        composer.addView(footer, LinearLayout.LayoutParams(MATCH, dp(40)))
        composerDock.addView(composer, LinearLayout.LayoutParams(MATCH, WRAP))
        page.addView(composerDock, LinearLayout.LayoutParams(MATCH, WRAP))
        renderAttachmentStrip()
        updateComposerPreferences()
    }

    private fun buildSidebar() {
        drawer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        val brand = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(2), 0, 0, dp(2))
        }
        val brandMark = ImageView(this).apply {
            setImageResource(R.drawable.ic_brand_codex)
            setColorFilter(ACCENT)
            background = rounded(PANEL_INSET, dp(10))
            setPadding(dp(8), dp(8), dp(8), dp(8))
            contentDescription = "Codex Remote"
        }
        brand.addView(brandMark, LinearLayout.LayoutParams(dp(36), dp(36)).apply { rightMargin = dp(10) })
        val brandCopy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL }
        brandCopy.addView(label("Codex Remote", 15, TEXT, true), widthWrap())
        brandCopy.addView(label("对话工作台", 10, MUTED), widthWrap())
        brand.addView(brandCopy, LinearLayout.LayoutParams(0, WRAP, 1f))
        brand.addView(iconButton("close", "关闭对话列表") { setSidebarVisible(false) }, LinearLayout.LayoutParams(dp(38), dp(38)))
        drawer.addView(brand, LinearLayout.LayoutParams(MATCH, dp(44)))

        val searchBox = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), 0, dp(8), 0)
            background = rounded(PANEL_INSET, dp(10), BORDER, dp(1))
        }
        val searchIcon = ImageView(this).apply {
            setImageResource(R.drawable.ic_search)
            imageTintList = ColorStateList.valueOf(MUTED)
            contentDescription = "搜索"
        }
        searchBox.addView(searchIcon, LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(8) })
        drawerSearch = EditText(this).apply {
            hint = "搜索聊天记录"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
            setSingleLine(true)
            textSize = adjustedTextSize(13)
            setTag(R.id.base_text_size, 13f)
            setTextColor(TEXT)
            setHintTextColor(MUTED)
            background = null
            setPadding(0, 0, 0, 0)
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            addTextChangedListener(SimpleTextWatcher { renderSidebar(force = true) })
        }
        searchBox.addView(drawerSearch, LinearLayout.LayoutParams(0, MATCH, 1f))
        searchBox.addView(iconButton("close", "清除搜索") { drawerSearch.setText("") }.apply {
            setPadding(dp(10), dp(10), dp(10), dp(10))
            visibility = View.GONE
            tag = "sidebar_search_clear"
        }, LinearLayout.LayoutParams(dp(32), dp(32)))
        drawerSearch.addTextChangedListener(SimpleTextWatcher { value ->
            searchBox.findViewWithTag<View>("sidebar_search_clear")?.visibility = if (value.isBlank()) View.GONE else View.VISIBLE
        })
        drawer.addView(searchBox, LinearLayout.LayoutParams(MATCH, dp(42)).apply { topMargin = dp(12) })

        val newThread = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, dp(12), 0)
            val fill = if (lightTheme) Color.rgb(57, 75, 132) else Color.rgb(199, 208, 255)
            background = rounded(fill, dp(10))
            isClickable = true
            isFocusable = true
            contentDescription = "新建对话"
            setOnClickListener { createThread() }
        }
        val newIcon = ImageView(this).apply {
            setImageResource(R.drawable.ic_add)
            imageTintList = ColorStateList.valueOf(if (lightTheme) Color.WHITE else Color.rgb(24, 27, 37))
            background = rounded(if (lightTheme) Color.argb(40, 255, 255, 255) else Color.argb(38, 24, 27, 37), dp(7))
            setPadding(dp(4), dp(4), dp(4), dp(4))
        }
        newThread.addView(newIcon, LinearLayout.LayoutParams(dp(27), dp(27)).apply { rightMargin = dp(10) })
        newThread.addView(label("新建对话", 13, if (lightTheme) Color.WHITE else Color.rgb(24, 27, 37), true), widthWrap())
        drawer.addView(newThread, LinearLayout.LayoutParams(MATCH, dp(43)).apply { topMargin = dp(9) })

        val recentHeading = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(3), 0, 0, 0)
        }
        recentHeading.addView(label("最近对话", 11, MUTED, true), LinearLayout.LayoutParams(0, dp(34), 1f))
        recentHeading.addView(iconButton("refresh", "刷新对话列表") { refreshThreads(true); refreshPins() }, LinearLayout.LayoutParams(dp(34), dp(34)))
        drawer.addView(recentHeading, LinearLayout.LayoutParams(MATCH, dp(36)).apply { topMargin = dp(8) })
        val threadScroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
        }
        drawerThreads = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(2), 0, 0) }
        threadScroll.addView(drawerThreads)
        drawer.addView(threadScroll, LinearLayout.LayoutParams(MATCH, 0, 1f))

        val footerDivider = View(this).apply { setBackgroundColor(BORDER) }
        drawer.addView(footerDivider, LinearLayout.LayoutParams(MATCH, dp(1)).apply { topMargin = dp(8); bottomMargin = dp(5) })
        val footer = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        footer.addView(sidebarAction("设置", "settings") { showSettings() }, LinearLayout.LayoutParams(0, dp(42), 1f))
        footer.addView(sidebarAction("重连", "refresh") { reconnect() }, LinearLayout.LayoutParams(0, dp(42), 1f))
        drawer.addView(footer, widthWrap())

        sidebarHost = createEdgeDrawer(drawer, Gravity.START) { setSidebarVisible(false) }
        updateInsetAwareOverlays()
        renderSidebar(force = true)
    }

    private fun createEdgeDrawer(panel: LinearLayout, gravity: Int, close: () -> Unit): EdgeDrawerHost {
        val overlay = FrameLayout(this).apply {
            visibility = View.GONE
            elevation = dp(16).toFloat()
            clipChildren = false
        }
        val scrim = View(this).apply {
            setBackgroundColor(Color.argb(112, 0, 0, 0))
            alpha = 0f
            setOnClickListener { close() }
        }
        overlay.addView(scrim, FrameLayout.LayoutParams(MATCH, MATCH))
        val availableWidth = root.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels
        val panelWidth = min(dp(300), (availableWidth * .78f).toInt())
            .coerceAtLeast(dp(248))
            .coerceAtMost((availableWidth - dp(28)).coerceAtLeast(dp(220)))
        panel.apply {
            background = ColorDrawable(PANEL)
            elevation = dp(5).toFloat()
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
        }
        overlay.addView(panel, FrameLayout.LayoutParams(panelWidth, MATCH, gravity))
        root.addView(overlay, FrameLayout.LayoutParams(MATCH, MATCH))
        return EdgeDrawerHost(overlay, scrim, panel, gravity).also { applyEdgeDrawerProgress(it, 0f, false) }
    }

    private fun applyEdgeDrawerInsets(host: EdgeDrawerHost?) {
        host ?: return
        val isStart = host.gravity == Gravity.START
        host.panel.setPadding(
            dp(12) + if (isStart) systemInsetLeft else 0,
            dp(6) + systemInsetTop,
            dp(12) + if (isStart) 0 else systemInsetRight,
            dp(6) + systemInsetBottom,
        )
    }

    private fun applyEdgeDrawerProgress(host: EdgeDrawerHost, progress: Float, requestedVisible: Boolean) {
        val clamped = progress.coerceIn(0f, 1f)
        val width = host.panel.width.takeIf { it > 0 } ?: host.panel.layoutParams?.width ?: dp(280)
        val direction = if (host.gravity == Gravity.START) -1f else 1f
        host.panel.translationX = direction * width * (1f - clamped)
        host.scrim.alpha = clamped
        if (clamped > .001f) host.overlay.visibility = View.VISIBLE
        else if (!requestedVisible) host.overlay.visibility = View.GONE
    }

    private fun edgeDrawerAnimator(
        host: EdgeDrawerHost,
        from: Float,
        to: Float,
        requestedVisible: () -> Boolean,
        update: (Float) -> Unit,
        finished: () -> Unit,
    ): ValueAnimator = ValueAnimator.ofFloat(from, to).apply {
        duration = 190L
        interpolator = DecelerateInterpolator()
        addUpdateListener { update(it.animatedValue as Float) }
        addListener(object : android.animation.AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: android.animation.Animator) {
                if (!requestedVisible() && to <= .001f) host.overlay.visibility = View.GONE
                finished()
            }
        })
    }

    private fun sidebarAction(title: String, icon: String, action: () -> Unit): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(9), 0, dp(7), 0)
        background = rounded(Color.TRANSPARENT, dp(8))
        isClickable = true
        isFocusable = true
        contentDescription = title
        setOnClickListener { action() }
        addView(ImageView(this@MainActivity).apply {
            setImageResource(iconResource(icon))
            imageTintList = ColorStateList.valueOf(SUBTLE)
        }, LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(7) })
        addView(label(title, 11, SUBTLE, true), widthWrap())
    }

    private fun renderHeader() {
        if (!::titleView.isInitialized) return
        val title = activeThread?.let { threadTitle(it) }
            ?: if (activeThreadId == null) "新对话" else "Codex Remote"
        titleView.text = title
        if (::modeButton.isInitialized) {
            setBrandIcon(modeButton, currentMode)
            modeButton.contentDescription = if (currentMode == "codex") "切换到 Claude Code" else "切换到 Codex"
        }
        val path = page.findViewWithTag<TextView>("workspace_path")
        path?.text = activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" }
            ?: runtime.optString("workspace", "本机项目")
        statusView.visibility = if (runtime.optBoolean("connected", false)) View.GONE else View.VISIBLE
        statusView.text = runtime.optString("error").takeIf { it.isNotBlank() && it != "null" }
            ?: if (runtime.optBoolean("available", false)) "Codex 已连接" else "正在连接 Codex…"
        statusView.setTextColor(if (runtime.optBoolean("connected", false)) MUTED else WARNING)
        sendButton.text = if (running) "Ⅱ" else "↑"
        sendButton.contentDescription = if (running) "暂停回复" else "发送消息"
        sendButton.setTextColor(if (running) TEXT else DARK)
        sendButton.background = rounded(if (running) PANEL_INSET else if (lightTheme) Color.rgb(35, 38, 43) else Color.rgb(228, 230, 235), dp(17))
        updateComposerPreferences()
    }

    private fun threadTitle(thread: JSONObject): String = listOf(
        thread.optString("name"),
        thread.optString("preview"),
    ).firstOrNull { it.isNotBlank() && it != "null" } ?: "新对话"

    private fun renderSidebar(force: Boolean = false) {
        if (!::drawerThreads.isInitialized) return
        if (!force && !sidebarRenderDirty) return
        if (sidebarGestureActive || sidebarAnimator?.isRunning == true) {
            sidebarRenderDirty = true
            return
        }
        sidebarRenderDirty = false
        drawerThreads.removeAllViews()
        val query = if (::drawerSearch.isInitialized) drawerSearch.text.toString().trim().lowercase(Locale.ROOT) else ""
        val filtered = mutableListOf<JSONObject>()
        for (index in 0 until threads.length()) {
            val thread = threads.optJSONObject(index) ?: continue
            if (thread.optString("engine", "codex") != currentMode) continue
            val title = threadTitle(thread)
            if (query.isNotBlank() && !title.lowercase(Locale.ROOT).contains(query)) continue
            filtered += thread
        }
        filtered.sortWith(compareByDescending<JSONObject> { pinnedThreadIds.contains(it.optString("id")) }
            .thenByDescending { it.optString("updatedAt") })
        if (filtered.isEmpty()) {
            val empty = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(dp(12), dp(28), dp(12), dp(28))
            }
            empty.addView(ImageView(this).apply {
                setImageResource(if (currentMode == "claude-code") R.drawable.ic_brand_claude else R.drawable.ic_brand_codex)
                setColorFilter(MUTED)
                alpha = .55f
            }, LinearLayout.LayoutParams(dp(24), dp(24)).apply { bottomMargin = dp(9) })
            empty.addView(label(if (query.isBlank()) "当前模式暂无对话" else "没有匹配的对话", 12, MUTED).apply { gravity = Gravity.CENTER }, widthWrap())
            drawerThreads.addView(empty, widthWrap())
        }
        filtered.take(MAX_VISIBLE_SIDEBAR_THREADS).forEach { thread ->
            val id = thread.optString("id")
            val selected = id == activeThreadId
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(9), dp(5), dp(5), dp(5))
                background = if (selected) rounded(PANEL_INSET, dp(9), if (lightTheme) ACCENT else Color.rgb(76, 84, 112), dp(1)) else rounded(Color.TRANSPARENT, dp(9))
                isClickable = true
                isFocusable = true
                contentDescription = threadTitle(thread)
            }
            val engine = thread.optString("engine", "codex")
            val icon = ImageView(this).apply {
                setImageResource(if (engine == "claude-code") R.drawable.ic_brand_claude else R.drawable.ic_brand_codex)
                setColorFilter(if (engine == "claude-code") ACCENT_WARM else ACCENT)
                contentDescription = if (engine == "claude-code") "Claude Code" else "Codex"
            }
            row.addView(icon, LinearLayout.LayoutParams(dp(22), dp(22)).apply { rightMargin = dp(9) })
            val title = threadTitle(thread)
            val titleView = label(title, 13, if (selected) TEXT else SUBTLE, selected).apply {
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            }
            row.addView(titleView, LinearLayout.LayoutParams(0, WRAP, 1f))
            if (pinnedThreadIds.contains(id)) {
                row.addView(ImageView(this).apply {
                    setImageResource(R.drawable.ic_pin)
                    imageTintList = ColorStateList.valueOf(MUTED)
                    contentDescription = "已置顶"
                }, LinearLayout.LayoutParams(dp(14), dp(14)).apply { leftMargin = dp(5); rightMargin = dp(3) })
            }
            val moreButton = iconButton("more", "对话操作") { }
            moreButton.setOnClickListener { showThreadActions(moreButton, thread) }
            row.addView(moreButton, LinearLayout.LayoutParams(dp(32), dp(32)))
            row.setOnClickListener { selectThread(thread) }
            row.setOnLongClickListener { showThreadActions(row, thread); true }
            drawerThreads.addView(row, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(3) })
        }
        if (filtered.size > MAX_VISIBLE_SIDEBAR_THREADS) {
            drawerThreads.addView(label("继续输入名称可搜索其余对话", 11, MUTED).apply {
                gravity = Gravity.CENTER
                setPadding(dp(8), dp(10), dp(8), dp(10))
            }, widthWrap())
        }
    }

    private fun setSidebarVisible(visible: Boolean) {
        if (!::drawer.isInitialized) return
        val host = sidebarHost ?: return
        if (visible && workspaceVisible) setWorkspaceVisible(false)
        sidebarVisible = visible
        if (visible) renderSidebar()
        sidebarAnimator?.cancel()
        val start = sidebarProgress
        val target = if (visible) 1f else 0f
        if (start == target) {
            updateSidebarProgress(target)
            if (!visible) host.overlay.visibility = View.GONE
            return
        }
        if (visible) host.overlay.visibility = View.VISIBLE
        sidebarAnimator = edgeDrawerAnimator(host, start, target, { sidebarVisible }, ::updateSidebarProgress) {
            sidebarAnimator = null
            if (sidebarRenderDirty && !sidebarGestureActive) renderSidebar(force = true)
            flushDeferredMessageRender()
        }.also { it.start() }
    }

    private fun updateSidebarProgress(progress: Float) {
        sidebarProgress = progress.coerceIn(0f, 1f)
        val host = sidebarHost ?: return
        applyEdgeDrawerProgress(host, sidebarProgress, sidebarVisible)
    }

    private inner class ChatRootLayout(context: Context) : FrameLayout(context) {
        private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
        private var startX = 0f
        private var startY = 0f
        private var startProgress = 0f
        private var swipeTarget: String? = null
        private var interceptingSwipe = false
        private var velocityTracker: VelocityTracker? = null

        override fun dispatchTouchEvent(event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startX = event.x
                    startY = event.y
                    velocityTracker?.recycle()
                    velocityTracker = VelocityTracker.obtain().apply { addMovement(event) }
                    swipeTarget = when {
                        // Settings controls and text editing need the full touch
                        // sequence. Cancelling their MOVE events breaks SeekBar
                        // dragging and can drop the composer's cursor/selection.
                        settingsOverlay != null || isInteractiveTouchTarget(event.x, event.y) -> null
                        sidebarVisible || sidebarProgress > .02f -> if (event.x <= (drawer.width.takeIf { it > 0 } ?: dp(320))) "sidebar" else null
                        workspaceVisible || workspaceProgress > .02f -> "workspace"
                        !isChatSwipeOrigin(event.y) -> null
                        event.x >= dp(24).toFloat() && event.x < width / 2f -> "sidebar"
                        event.x >= width / 2f && event.x <= width - dp(24) -> "workspace"
                        else -> null
                    }
                    startProgress = if (swipeTarget == "workspace") workspaceProgress else sidebarProgress
                    interceptingSwipe = false
                    return super.dispatchTouchEvent(event)
                }
                MotionEvent.ACTION_MOVE -> {
                    velocityTracker?.addMovement(event)
                    if (!interceptingSwipe && beginSwipeIfNeeded(event)) return true
                    if (interceptingSwipe) {
                        updateSwipeProgress(event)
                        return true
                    }
                }
                MotionEvent.ACTION_UP -> {
                    velocityTracker?.addMovement(event)
                    if (interceptingSwipe) {
                        updateSwipeProgress(event)
                        finishInterceptedSwipe(event, cancelled = false)
                        return true
                    }
                }
                MotionEvent.ACTION_CANCEL -> {
                    if (interceptingSwipe) {
                        finishInterceptedSwipe(event, cancelled = true)
                        return true
                    }
                }
            }
            val handled = super.dispatchTouchEvent(event)
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) clearSwipeTracking()
            return handled
        }

        private fun beginSwipeIfNeeded(event: MotionEvent): Boolean {
            val target = swipeTarget ?: return false
            val dx = event.x - startX
            val dy = event.y - startY
            val horizontal = abs(dx) > touchSlop && abs(dx) > abs(dy) * 1.25f
            val isOpen = if (target == "workspace") workspaceVisible else sidebarVisible
            val opens = !isOpen && if (target == "workspace") dx < -touchSlop else dx > touchSlop
            val closes = isOpen && if (target == "workspace") dx > touchSlop else dx < -touchSlop
            if (!horizontal || (!opens && !closes)) return false

            interceptingSwipe = true
            if (target == "workspace") {
                workspaceAnimator?.removeAllListeners()
                workspaceAnimator?.cancel()
                workspaceAnimator = null
                workspaceGestureActive = true
                if (opens) prepareWorkspaceForGesture()
            } else {
                sidebarGestureActive = true
                sidebarAnimator?.cancel()
                sidebarAnimator = null
                if (opens) {
                    sidebarHost?.overlay?.visibility = View.VISIBLE
                }
            }

            val cancel = MotionEvent.obtain(event)
            cancel.setAction(MotionEvent.ACTION_CANCEL)
            super.dispatchTouchEvent(cancel)
            cancel.recycle()
            updateSwipeProgress(event)
            return true
        }

        private fun updateSwipeProgress(event: MotionEvent) {
            val target = swipeTarget ?: return
            if (target == "workspace") {
                val panelWidth = workspacePanel?.width?.takeIf { it > 0 } ?: dp(320)
                updateWorkspaceProgress(startProgress - (event.x - startX) / panelWidth)
            } else {
                val drawerWidth = drawer.width.takeIf { it > 0 } ?: dp(320)
                updateSidebarProgress(startProgress + (event.x - startX) / drawerWidth)
            }
        }

        private fun finishInterceptedSwipe(event: MotionEvent, cancelled: Boolean) {
            val target = swipeTarget
            if (target == "workspace") {
                if (cancelled) {
                    setWorkspaceVisible(startProgress >= .5f)
                } else {
                    velocityTracker?.computeCurrentVelocity(1000)
                    val velocity = velocityTracker?.xVelocity ?: 0f
                    val fastSwipe = abs(velocity) > dp(450)
                    val shouldOpen = if (fastSwipe) velocity < 0 else workspaceProgress >= .25f
                    val swipedBack = workspaceVisible && event.x - startX > touchSlop
                    if (swipedBack && workspaceCurrentPath.isNotBlank()) handleWorkspaceBack()
                    else if (workspaceVisible && !shouldOpen) setWorkspaceVisible(false)
                    else setWorkspaceVisible(shouldOpen)
                }
            } else if (target == "sidebar") {
                val shouldOpen = if (cancelled) {
                    startProgress >= .5f
                } else {
                    velocityTracker?.computeCurrentVelocity(1000)
                    val velocity = velocityTracker?.xVelocity ?: 0f
                    if (abs(velocity) > dp(450)) velocity > 0 else sidebarProgress >= .25f
                }
                sidebarVisible = shouldOpen
                setSidebarVisible(shouldOpen)
                sidebarGestureActive = false
                if (sidebarAnimator == null && sidebarRenderDirty) renderSidebar(force = true)
                if (sidebarAnimator == null) flushDeferredMessageRender()
            }
            clearSwipeTracking()
        }

        private fun clearSwipeTracking() {
            interceptingSwipe = false
            swipeTarget = null
            velocityTracker?.recycle()
            velocityTracker = null
        }

        private fun isInteractiveTouchTarget(x: Float, y: Float): Boolean {
            fun deepest(view: View, localX: Float, localY: Float): View? {
                if (view.visibility != View.VISIBLE || localX < 0f || localY < 0f ||
                    localX >= view.width || localY >= view.height
                ) return null
                if (view is ViewGroup) {
                    for (index in view.childCount - 1 downTo 0) {
                        val child = view.getChildAt(index)
                        val childX = localX + view.scrollX - child.left - child.translationX
                        val childY = localY + view.scrollY - child.top - child.translationY
                        deepest(child, childX, childY)?.let { return it }
                    }
                }
                return view
            }

            var target = deepest(this, x, y)
            while (target != null && target !== this) {
                if (target is EditText || target is SeekBar || target is ScrollView ||
                    target is HorizontalScrollView || (target is TextView && target.isTextSelectable) ||
                    target.isClickable || target.isLongClickable
                ) return true
                target = target.parent as? View
            }
            return false
        }

        private fun isChatSwipeOrigin(y: Float): Boolean = y >= dp(48) && y <= height - dp(145)
    }

    private fun refreshRuntime() {
        runApi({ RemoteApi(endpoint, token).get("/api/v1/codex/status") }, { result ->
            runtime = result
            renderHeader()
        }, { error -> showStatus(error.message ?: "Codex 连接失败") })
    }

    private fun refreshModels() {
        io.execute {
            try {
                val result = RemoteApi(endpoint, token).getArray("/api/v1/codex/models")
                handler.post { models = result; updateComposerPreferences() }
            } catch (_: Exception) { }
        }
    }

    private fun refreshPins() {
        io.execute {
            try {
                val result = RemoteApi(endpoint, token).get("/api/v1/codex/pins").optJSONArray("thread_ids") ?: JSONArray()
                handler.post {
                    pinnedThreadIds.clear()
                    for (index in 0 until result.length()) pinnedThreadIds += result.optString(index)
                    renderSidebar(force = true)
                }
            } catch (_: Exception) { }
        }
    }

    private fun refreshClaudeStatus() {
        io.execute {
            try {
                val result = RemoteApi(endpoint, token).get("/api/v1/claude/status")
                handler.post {
                    claudeAvailable = result.optBoolean("available")
                    claudeStatusMessage = result.optString("error").ifBlank { "Claude Code 不可用" }
                    renderHeader()
                }
            } catch (error: Exception) {
                handler.post { claudeAvailable = false; claudeStatusMessage = error.message ?: "Claude Code 不可用" }
            }
        }
    }

    private fun refreshThreads(showErrors: Boolean) {
        if (token.isBlank()) return
        io.execute {
            try {
                val result = RemoteApi(endpoint, token).getArray("/api/v1/codex/threads")
                handler.post {
                    threads = result
                    pendingCompletionNoticeThreadId?.let { completedId ->
                        pendingCompletionNoticeThreadId = null
                        val completed = findThread(completedId)
                        val engine = completed?.optString("engine")
                        if (engine != null && engine != currentMode && completedId != activeThreadId) {
                            showCompletionNotice(completedId, engine)
                        }
                    }
                    renderSidebar(force = true)
                    val selected = activeThreadId
                    if (selected != null) {
                        val latest = findThread(selected)
                        if (latest != null) {
                            val current = activeThread ?: JSONObject().put("id", selected).also { activeThread = it }
                            current.put("name", latest.optString("name"))
                            current.put("preview", latest.optString("preview"))
                            current.put("cwd", latest.optString("cwd"))
                            latest.optJSONObject("status")?.let { current.put("status", it) }
                            running = isThreadRunning(current)
                            renderHeader()
                        }
                    } else if (showErrors && result.length() > 0) {
                        val first = (0 until result.length()).mapNotNull { result.optJSONObject(it) }
                            .filter { it.optString("engine", "codex") == currentMode }
                            .firstOrNull { it.optString("id") == prefs.getString("$KEY_ACTIVE_THREAD_PREFIX$currentMode", null) }
                            ?: (0 until result.length()).mapNotNull { result.optJSONObject(it) }
                                .firstOrNull { it.optString("engine", "codex") == currentMode }
                        if (first != null) selectThread(first)
                    }
                }
            } catch (error: Exception) {
                if (showErrors) handler.post { showStatus(error.message ?: "读取对话列表失败") }
            }
        }
    }

    private fun findThread(id: String): JSONObject? = (0 until threads.length())
        .mapNotNull { threads.optJSONObject(it) }
        .firstOrNull { it.optString("id") == id }

    private fun selectThread(thread: JSONObject, eagerDiskCache: Boolean = false) {
        val id = thread.optString("id")
        if (id.isBlank()) return
        val existingHistory = activeThread?.takeIf { activeThreadId == id && it.optJSONArray("turns") != null }
        val memoryHistory = historyMemoryCache[id]
        val diskHistory = if (eagerDiskCache && existingHistory == null && memoryHistory == null) {
            readThreadHistoryCache(id, MAX_EAGER_HISTORY_CACHE_BYTES)
        } else null
        persistCurrentDraft()
        activeThreadId = id
        activeThread = existingHistory ?: memoryHistory ?: diskHistory?.first ?: thread
        if (diskHistory != null) {
            historyMemoryCache[id] = diskHistory.first
            diskHistory.second.takeIf { it.isNotBlank() }?.let { syncRevisions.putIfAbsent(id, it) }
        }
        workspaceLoadedPath = null
        workspaceLoadingPath = null
        val hasCachedHistory = activeThread?.optJSONArray("turns") != null
        historyLoadingThreadId = if (hasCachedHistory) null else id
        historyLoadError = null
        historySelectionGeneration += 1
        visibleHistoryTurnCount = DEFAULT_VISIBLE_HISTORY_TURNS
        currentMode = thread.optString("engine", "codex")
        prefs.edit().putString(KEY_MODE, currentMode).putString("$KEY_ACTIVE_THREAD_PREFIX$currentMode", id).apply()
        running = isThreadRunning(activeThread ?: thread)
        pendingApproval = null
        queuedMessages = JSONArray()
        setSidebarVisible(false)
        renderHeader()
        renderSidebar(force = true)
        composerInput.setText(prefs.getString(draftStorageKey(), ""))
        renderMessages(true)
        if (hasCachedHistory) refreshActiveThread(false) else loadThreadHistoryCacheThenRefresh(id)
        refreshQueue(true)
        socket?.send(JSONObject().put("type", "thread.subscribe").put("thread_id", id).toString())
    }

    private fun loadThreadHistoryCacheThenRefresh(threadId: String) {
        val generation = historySelectionGeneration
        io.execute {
            val cached = readThreadHistoryCache(threadId)
            handler.post {
                if (activeThreadId != threadId || historySelectionGeneration != generation) return@post
                val cachedThread = cached?.first
                if (cachedThread != null) {
                    if ((activeThread?.optJSONArray("turns")?.length() ?: 0) == 0) activeThread = cachedThread
                    historyMemoryCache[threadId] = cachedThread
                    cached.second?.takeIf { it.isNotBlank() }?.let { syncRevisions.putIfAbsent(threadId, it) }
                    historyLoadingThreadId = null
                    historyLoadError = null
                    running = isThreadRunning(activeThread ?: cachedThread)
                    renderHeader()
                    renderMessages(false)
                    refreshActiveThread(false)
                } else {
                    refreshActiveThread(true)
                }
            }
        }
    }

    private fun historyCacheDirectory(): File = File(filesDir, "thread_history_cache_v2")

    private fun historyCacheFile(threadId: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(threadId.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
        return File(historyCacheDirectory(), "$digest.json.gz")
    }

    private fun readThreadHistoryCache(
        threadId: String,
        maxCompressedBytes: Long = MAX_SINGLE_HISTORY_CACHE_BYTES,
    ): Pair<JSONObject, String>? {
        return try {
            val file = historyCacheFile(threadId)
            if (!file.isFile || file.length() <= 0L || file.length() > maxCompressedBytes) return null
            val json = GZIPInputStream(FileInputStream(file)).use { input -> readHistoryCachePayload(input) } ?: return null
            val wrapper = JSONObject(String(json, StandardCharsets.UTF_8))
            val thread = wrapper.optJSONObject("thread") ?: return null
            if (wrapper.optString("threadId") != threadId || thread.optString("id") != threadId || thread.optJSONArray("turns") == null) return null
            file.setLastModified(System.currentTimeMillis())
            thread to wrapper.optString("revision")
        } catch (_: Exception) {
            null
        }
    }

    private fun writeThreadHistoryCache(threadId: String, thread: JSONObject, revision: String?) {
        try {
            var partial = false
            var threadSnapshot = historyCacheSnapshot(thread, null)
            if (!jsonFitsHistoryCache(threadSnapshot)) {
                partial = true
                val fallbackLimits = listOf(DEFAULT_VISIBLE_HISTORY_TURNS, 6, 3, 1).distinct()
                threadSnapshot = fallbackLimits.asSequence()
                    .map { limit -> historyCacheSnapshot(thread, limit) }
                    .firstOrNull(::jsonFitsHistoryCache)
                    ?: return
            }
            val directory = historyCacheDirectory()
            if (!directory.exists() && !directory.mkdirs()) return
            val file = historyCacheFile(threadId)
            val temporary = File(directory, "${file.name}.tmp")
            temporary.delete()
            val wrapper = JSONObject()
                .put("threadId", threadId)
                .put("revision", if (partial) "" else revision.orEmpty())
                .put("partial", partial)
                .put("thread", threadSnapshot)
            val payload = wrapper.toString().toByteArray(StandardCharsets.UTF_8)
            if (payload.size > MAX_HISTORY_CACHE_JSON_BYTES) return
            GZIPOutputStream(FileOutputStream(temporary)).use { output ->
                output.write(payload)
            }
            if (temporary.length() <= 0L || temporary.length() > MAX_SINGLE_HISTORY_CACHE_BYTES) {
                temporary.delete()
                return
            }
            if (!temporary.renameTo(file)) {
                file.delete()
                if (!temporary.renameTo(file)) {
                    temporary.delete()
                    return
                }
            }
            file.setLastModified(System.currentTimeMillis())
            pruneThreadHistoryCache(file)
        } catch (_: Exception) { }
    }

    private fun historyCacheSnapshot(thread: JSONObject, recentTurnLimit: Int?): JSONObject {
        val copy = shallowCopyObject(thread, setOf("historySync", "turns", "codexRemoteWorkspaceChanges"))
        val sourceTurns = thread.optJSONArray("turns") ?: JSONArray()
        val firstTurn = recentTurnLimit?.let { (sourceTurns.length() - it).coerceAtLeast(0) } ?: 0
        val turns = JSONArray()
        val retainedTurnIds = mutableSetOf<String>()
        for (turnIndex in firstTurn until sourceTurns.length()) {
            val sourceTurn = sourceTurns.optJSONObject(turnIndex) ?: continue
            val turn = shallowCopyObject(sourceTurn, setOf("items"))
            sourceTurn.optString("id").takeIf { it.isNotBlank() && it != "null" }?.let(retainedTurnIds::add)
            val sourceItems = sourceTurn.optJSONArray("items") ?: JSONArray()
            val items = JSONArray()
            for (itemIndex in 0 until sourceItems.length()) {
                val sourceItem = sourceItems.optJSONObject(itemIndex) ?: continue
                if (normalizedType(sourceItem.optString("type")) != "usermessage") {
                    items.put(sourceItem)
                    continue
                }
                val sourceContent = sourceItem.optJSONArray("content")
                if (sourceContent == null) {
                    items.put(sourceItem)
                    continue
                }
                var contentChanged = false
                val content = JSONArray()
                for (partIndex in 0 until sourceContent.length()) {
                    val sourcePart = sourceContent.optJSONObject(partIndex)
                    if (sourcePart == null) {
                        content.put(sourceContent.opt(partIndex))
                        continue
                    }
                    val localImage = normalizedType(sourcePart.optString("type")) == "localimage"
                    if (localImage && sourcePart.has("data")) {
                        content.put(shallowCopyObject(sourcePart, setOf("data")))
                        contentChanged = true
                    } else content.put(sourcePart)
                }
                items.put(if (contentChanged) shallowCopyObject(sourceItem, setOf("content")).put("content", content) else sourceItem)
            }
            turns.put(turn.put("items", items))
        }
        copy.put("turns", turns)
        if (recentTurnLimit != null && sourceTurns.length() > turns.length()) {
            copy.put("historyPartial", true)
            copy.put("totalTurns", sourceTurns.length())
        }

        val sourceChanges = thread.optJSONObject("codexRemoteWorkspaceChanges")
        if (sourceChanges != null) {
            if (recentTurnLimit == null) copy.put("codexRemoteWorkspaceChanges", sourceChanges)
            else {
                val changes = JSONObject()
                retainedTurnIds.forEach { turnId -> if (sourceChanges.has(turnId)) changes.put(turnId, sourceChanges.opt(turnId)) }
                copy.put("codexRemoteWorkspaceChanges", changes)
            }
        }
        return copy
    }

    private fun readHistoryCachePayload(input: InputStream): ByteArray? {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > MAX_HISTORY_CACHE_JSON_BYTES) return null
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun pruneThreadHistoryCache(current: File) {
        val files = historyCacheDirectory().listFiles()?.filter { it.isFile && it.name.endsWith(".json.gz") }
            ?.sortedByDescending { it.lastModified() } ?: return
        var retainedCount = 0
        var retainedBytes = 0L
        files.forEach { file ->
            val exceedsLimit = retainedCount >= MAX_CACHED_THREADS || retainedBytes + file.length() > MAX_TOTAL_HISTORY_CACHE_BYTES
            if (exceedsLimit && file != current) {
                file.delete()
            } else {
                retainedCount++
                retainedBytes += file.length()
            }
        }
    }

    private fun refreshActiveThread(showLoading: Boolean, fullHistory: Boolean = false) {
        val threadId = activeThreadId ?: return
        if (showLoading && (activeThread?.optJSONArray("turns")?.length() ?: 0) == 0) {
            historyLoadingThreadId = threadId
            historyLoadError = null
            renderMessages(false)
        }
        if (!threadReadsInFlight.add(threadId)) {
            pendingThreadReads.add(threadId)
            return
        }
        val revision = syncRevisions[threadId].takeUnless { fullHistory }
        val boundedHistory = !fullHistory && (
            activeThread?.optJSONArray("turns") == null ||
                activeThread?.optBoolean("historyPartial", false) == true ||
                activeThread?.optBoolean("historyWindowed", false) == true
        )
        io.execute {
            try {
                val api = RemoteApi(endpoint, token)
                val encodedId = RemoteApi.encodePath(threadId)
                val lightweightQuery = buildString {
                    append("?include_images=false")
                    if (!revision.isNullOrBlank()) append("&since=${RemoteApi.encodePath(revision)}")
                    if (boundedHistory) append("&tail_turns=$DEFAULT_VISIBLE_HISTORY_TURNS")
                }
                var response = api.get("/api/v1/codex/threads/$encodedId$lightweightQuery")
                val changedTurnIds = if (revision != null) {
                    val changedTurns = response.optJSONArray("turns") ?: JSONArray()
                    (0 until changedTurns.length()).mapNotNull { changedTurns.optJSONObject(it)?.optString("id")?.takeIf(String::isNotBlank) }
                } else emptyList()
                val merged = if (revision != null) mergeHistory(threadId, activeThread, response, revision) else response
                val responseIsCompleteWindow = revision != null && response.has("turns") &&
                    response.optJSONObject("historySync")?.optString("baseRevision").orEmpty().isBlank()
                if (merged == null && !responseIsCompleteWindow) {
                    response = api.get(buildString {
                        append("/api/v1/codex/threads/$encodedId?include_images=false")
                        if (boundedHistory) append("&tail_turns=$DEFAULT_VISIBLE_HISTORY_TURNS")
                    })
                }
                val resolved = merged ?: response
                val usedDelta = revision != null && merged != null
                val resolvedTurns = resolved.optJSONArray("turns") ?: JSONArray()
                val lastTurnId = resolvedTurns.optJSONObject(resolvedTurns.length() - 1)?.optString("id")
                val incrementalTurnId = changedTurnIds.singleOrNull()?.takeIf { usedDelta && it == lastTurnId }
                val historyChanged = !usedDelta || changedTurnIds.isNotEmpty()
                val sync = resolved.optJSONObject("historySync") ?: response.optJSONObject("historySync")
                val newRevision = sync?.optString("revision")?.takeIf { !it.isNullOrBlank() && it != "null" }
                if (resolved.optString("id") != threadId) throw IOException("服务器返回了不匹配的聊天记录。")
                writeThreadHistoryCache(threadId, resolved, newRevision)
                handler.post {
                    finishThreadRead(threadId)
                    if (activeThreadId != threadId) return@post
                    if (newRevision != null) syncRevisions[threadId] = newRevision
                    activeThread = resolved
                    historyMemoryCache[threadId] = resolved
                    historyLoadingThreadId = null
                    historyLoadError = null
                    running = isThreadRunning(resolved)
                    renderHeader()
                    if (historyChanged) renderMessages(!showLoading, incrementalTurnId)
                }
            } catch (error: Exception) {
                handler.post {
                    finishThreadRead(threadId)
                    if (activeThreadId != threadId) return@post
                    historyLoadingThreadId = null
                    historyLoadError = error.message ?: "读取对话失败"
                    if (showLoading) showStatus(historyLoadError!!)
                    renderMessages(false)
                }
            }
        }
    }

    private fun finishThreadRead(threadId: String) {
        threadReadsInFlight.remove(threadId)
        if (pendingThreadReads.remove(threadId) && activeThreadId == threadId) scheduleActiveThreadRefresh()
    }

    private fun scheduleActiveThreadRefresh() {
        if (activeThreadRefreshScheduled) return
        val elapsed = android.os.SystemClock.uptimeMillis() - lastActiveThreadRefreshAt
        val delay = (900L - elapsed).coerceAtLeast(0L)
        activeThreadRefreshScheduled = true
        handler.postDelayed(activeThreadRefreshRunnable, delay)
    }

    private fun mergeHistory(threadId: String, previous: JSONObject?, delta: JSONObject, baseRevision: String): JSONObject? {
        val old = previous ?: return null
        val sync = delta.optJSONObject("historySync") ?: return if (delta.has("turns")) delta else null
        if (sync.optString("baseRevision") != baseRevision) return null
        val oldTurnsArray = old.optJSONArray("turns") ?: JSONArray()
        val deltaTurnsArray = delta.optJSONArray("turns") ?: JSONArray()
        val turns = linkedMapOf<String, JSONObject>()
        for (index in 0 until oldTurnsArray.length()) {
            oldTurnsArray.optJSONObject(index)?.let { turn -> turns[turn.optString("id")] = turn }
        }
        val itemIds = sync.optJSONObject("itemIds") ?: return null
        for (index in 0 until deltaTurnsArray.length()) {
            val changed = deltaTurnsArray.optJSONObject(index) ?: continue
            val id = changed.optString("id")
            val order = itemIds.optJSONArray(id) ?: return null
            val previousTurn = turns[id]
            val items = linkedMapOf<String, JSONObject>()
            val oldItems = previousTurn?.optJSONArray("items") ?: JSONArray()
            for (itemIndex in 0 until oldItems.length()) {
                oldItems.optJSONObject(itemIndex)?.let { items[it.optString("id")] = it }
            }
            val changedItems = changed.optJSONArray("items") ?: JSONArray()
            for (itemIndex in 0 until changedItems.length()) {
                changedItems.optJSONObject(itemIndex)?.let { items[it.optString("id")] = it }
            }
            val ordered = JSONArray()
            for (itemIndex in 0 until order.length()) {
                val item = items[order.optString(itemIndex)] ?: return null
                ordered.put(item)
            }
            turns[id] = shallowCopyObject(changed).put("items", ordered)
        }
        val order = sync.optJSONArray("turnIds") ?: return null
        val partialHistory = old.optBoolean("historyPartial", false)
        val firstOrderIndex = if (partialHistory) (order.length() - DEFAULT_VISIBLE_HISTORY_TURNS).coerceAtLeast(0) else 0
        val mergedTurns = JSONArray()
        val retainedTurnIds = mutableSetOf<String>()
        for (index in firstOrderIndex until order.length()) {
            val turnId = order.optString(index)
            mergedTurns.put(turns[turnId] ?: return null)
            retainedTurnIds += turnId
        }
        val result = shallowCopyObject(delta).put("turns", mergedTurns)
        val oldChanges = old.optJSONObject("codexRemoteWorkspaceChanges") ?: JSONObject()
        val changes = shallowCopyObject(oldChanges)
        val freshChanges = delta.optJSONObject("codexRemoteWorkspaceChanges") ?: JSONObject()
        val workspaceOrder = sync.optJSONArray("workspaceTurnIds")
        if (workspaceOrder != null) {
            for (index in 0 until workspaceOrder.length()) {
                val key = workspaceOrder.optString(index)
                if (freshChanges.has(key)) changes.put(key, freshChanges.get(key))
            }
        }
        if (partialHistory) {
            val boundedChanges = JSONObject()
            retainedTurnIds.forEach { turnId -> if (changes.has(turnId)) boundedChanges.put(turnId, changes.opt(turnId)) }
            result.put("codexRemoteWorkspaceChanges", boundedChanges)
            result.put("historyPartial", true)
            result.put("totalTurns", delta.optInt("totalTurns", old.optInt("totalTurns", order.length())))
        } else result.put("codexRemoteWorkspaceChanges", changes)
        return result
    }

    private fun refreshQueue(showErrors: Boolean) {
        val threadId = activeThreadId ?: return
        io.execute {
            try {
                val response = RemoteApi(endpoint, token).get("/api/v1/codex/queue/${RemoteApi.encodePath(threadId)}")
                val next = response.optJSONArray("queue") ?: JSONArray()
                handler.post {
                    if (activeThreadId != threadId) return@post
                    queuedMessages = next
                    renderQueue()
                }
            } catch (error: Exception) {
                if (showErrors) handler.post { showStatus(error.message ?: "读取排队消息失败") }
            }
        }
    }

    private fun renderMessages(scrollToEnd: Boolean, incrementalTurnId: String? = null) {
        if (!::messageList.isInitialized) return
        if (sidebarVisible || workspaceVisible || sidebarGestureActive || workspaceGestureActive || sidebarAnimator?.isRunning == true || workspaceAnimator?.isRunning == true) {
            messageRenderDeferred = true
            deferredMessageScrollToEnd = deferredMessageScrollToEnd || scrollToEnd
            if (incrementalTurnId == null) deferredMessageRequiresFullRender = true else deferredMessageTurnIds.add(incrementalTurnId)
            return
        }
        val wasNearEnd = messageScroll.scrollY + messageScroll.height >= messageList.height - dp(120)
        val thread = activeThread
        val turns = thread?.optJSONArray("turns") ?: JSONArray()
        val incrementalTurnIndex = incrementalTurnId?.let { requestedId ->
            (0 until turns.length()).firstOrNull { turns.optJSONObject(it)?.optString("id") == requestedId }
        }
        val useIncrementalRender = incrementalTurnIndex != null && incrementalTurnIndex == turns.length() - 1 && messageList.childCount > 0
        val effectiveIncrementalTurnId = incrementalTurnId?.takeIf { useIncrementalRender }
        if (effectiveIncrementalTurnId == null) {
            messageList.removeAllViews()
        } else {
            val turnTag = "$TAG_MESSAGE_TURN_PREFIX$effectiveIncrementalTurnId"
            for (childIndex in messageList.childCount - 1 downTo 0) {
                val tag = messageList.getChildAt(childIndex).tag
                if (tag == turnTag || tag == TAG_MESSAGE_DYNAMIC) messageList.removeViewAt(childIndex)
            }
        }
        val messages = mutableListOf<Pair<String, JSONObject>>()
        val turnsById = mutableMapOf<String, JSONObject>()
        val assistantTextBuilders = java.util.IdentityHashMap<JSONObject, StringBuilder>()
        val timelineTextBuilders = java.util.IdentityHashMap<JSONObject, StringBuilder>()
        val firstVisibleTurnIndex = effectiveIncrementalTurnId?.let { incrementalTurnIndex!! }
            ?: (turns.length() - visibleHistoryTurnCount).coerceAtLeast(0)
        val lastVisibleTurnIndex = effectiveIncrementalTurnId?.let { incrementalTurnIndex!! + 1 } ?: turns.length()
        for (turnIndex in firstVisibleTurnIndex until lastVisibleTurnIndex) {
            val turn = turns.optJSONObject(turnIndex) ?: continue
            val turnId = turn.optString("id").takeIf { it.isNotBlank() && it != "null" } ?: "history-turn-$turnIndex"
            turnsById[turnId] = turn
            val items = turn.optJSONArray("items") ?: JSONArray()
            var assistantInTurn: JSONObject? = null
            for (itemIndex in 0 until items.length()) {
                val item = items.optJSONObject(itemIndex) ?: continue
                when (normalizedType(item.optString("type"))) {
                    "usermessage" -> {
                        val hasImage = item.optJSONArray("content")?.let { content ->
                            (0 until content.length()).any { index ->
                                normalizedType(content.optJSONObject(index)?.optString("type").orEmpty()) in setOf("image", "localimage")
                            }
                        } == true
                        if (messageText(item, "user").isNotBlank() || hasImage) {
                            messages += "user" to shallowCopyObject(item)
                                .put("_turnId", turnId)
                                .put("_displayTime", messageTime(item, turn, false))
                        }
                        assistantInTurn = null
                    }
                    "agentmessage" -> {
                        val text = messageText(item, "assistant")
                        if (text.isNotBlank()) {
                            val message = assistantInTurn ?: shallowCopyObject(item)
                                .put("_turnId", turnId)
                                .put("_duration", turn.optLong("durationMs", 0))
                                .put("_displayTime", messageTime(item, turn, true))
                                .put("_activityTimeline", JSONArray())
                                .also {
                                    assistantTextBuilders[it] = StringBuilder()
                                    assistantInTurn = it
                                    messages += "assistant" to it
                                }
                            val assistantBuilder = assistantTextBuilders.getOrPut(message) { StringBuilder() }
                            if (assistantBuilder.isNotEmpty()) assistantBuilder.append("\n\n")
                            assistantBuilder.append(text)
                            val timeline = message.optJSONArray("_activityTimeline") ?: JSONArray().also { message.put("_activityTimeline", it) }
                            val lastBlock = timeline.optJSONObject(timeline.length() - 1)
                            val messageBlock = if (lastBlock?.optString("type") == "message") {
                                lastBlock
                            } else {
                                JSONObject().put("type", "message").also { timeline.put(it) }
                            }
                            val timelineBuilder = timelineTextBuilders.getOrPut(messageBlock) {
                                StringBuilder(messageBlock.optString("text"))
                            }
                            if (timelineBuilder.isNotEmpty()) timelineBuilder.append("\n\n")
                            timelineBuilder.append(text)
                        }
                    }
                    "reasoning", "plan" -> Unit
                    else -> {
                        val operation = shallowCopyObject(item).put("_turnId", turnId).put("_activityIndex", itemIndex)
                        val assistantTimeline = assistantInTurn?.optJSONArray("_activityTimeline")
                        if (assistantTimeline != null) {
                            assistantTimeline.put(JSONObject().put("type", "operation").put("item", operation))
                        } else {
                            messages += "operation" to operation
                        }
                    }
                }
            }
        }
        messages.forEach { (role, message) ->
            if (role != "assistant") return@forEach
            assistantTextBuilders[message]?.let { message.put("text", it.toString()) }
            val timeline = message.optJSONArray("_activityTimeline") ?: return@forEach
            for (index in 0 until timeline.length()) {
                val block = timeline.optJSONObject(index) ?: continue
                timelineTextBuilders[block]?.let { block.put("text", it.toString()) }
            }
        }
        val hasConversationMessages = messages.any { it.first == "user" || it.first == "assistant" }
        if (effectiveIncrementalTurnId == null && !hasConversationMessages && activeThreadId == null) {
            messageList.addView(label(if (currentMode == "claude-code") "与 Claude Code 一起完成项目" else "与 Codex Remote 一起完成项目", 19, TEXT, true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(14), dp(36), dp(14), dp(30))
            }, LinearLayout.LayoutParams(MATCH, WRAP))
        } else if (effectiveIncrementalTurnId == null && !hasConversationMessages && activeThreadId != null) {
            when {
                historyLoadingThreadId == activeThreadId -> {
                    messageList.addView(label("正在加载聊天记录…", 13, MUTED).apply {
                        gravity = Gravity.CENTER
                        setPadding(dp(14), dp(40), dp(14), dp(30))
                    }, LinearLayout.LayoutParams(MATCH, WRAP))
                }
                !historyLoadError.isNullOrBlank() -> {
                    val loadError = LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        gravity = Gravity.CENTER
                        setPadding(dp(18), dp(32), dp(18), dp(24))
                    }
                    loadError.addView(label("聊天记录暂时没有加载出来", 15, TEXT, true).apply { gravity = Gravity.CENTER }, widthWrap())
                    loadError.addView(label(historyLoadError.orEmpty(), 11, MUTED).apply {
                        gravity = Gravity.CENTER
                        setPadding(0, dp(6), 0, dp(12))
                        maxLines = 4
                    }, widthWrap())
                    loadError.addView(actionButton("重试加载").apply { setOnClickListener { refreshActiveThread(true) } }, LinearLayout.LayoutParams(WRAP, dp(38)))
                    messageList.addView(loadError, LinearLayout.LayoutParams(MATCH, WRAP))
                }
                turns.length() == 0 -> {
                    messageList.addView(label(if (currentMode == "claude-code") "与 Claude Code 一起完成项目" else "与 Codex Remote 一起完成项目", 18, TEXT, true).apply {
                        gravity = Gravity.CENTER
                        setPadding(dp(14), dp(36), dp(14), dp(30))
                    }, LinearLayout.LayoutParams(MATCH, WRAP))
                }
            }
        }

        val remoteHiddenTurnCount = if (thread?.optBoolean("historyPartial", false) == true) {
            (thread.optInt("totalTurns", turns.length()) - turns.length()).coerceAtLeast(0)
        } else 0
        if (effectiveIncrementalTurnId == null && (firstVisibleTurnIndex > 0 || remoteHiddenTurnCount > 0)) {
            val hiddenTurnCount = if (remoteHiddenTurnCount > 0) remoteHiddenTurnCount else firstVisibleTurnIndex
            messageList.addView(label(if (remoteHiddenTurnCount > 0) "加载更早的 $hiddenTurnCount 轮对话" else "显示更早的 $hiddenTurnCount 轮对话", 11, ACCENT, true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = rounded(PANEL_INSET, dp(9), BORDER, dp(1))
                setOnClickListener {
                    if (remoteHiddenTurnCount > 0) {
                        text = "正在加载更早的对话…"
                        isEnabled = false
                        visibleHistoryTurnCount += DEFAULT_VISIBLE_HISTORY_TURNS
                        refreshActiveThread(false, fullHistory = true)
                    } else {
                        val previousHeight = messageList.height
                        val previousScrollY = messageScroll.scrollY
                        visibleHistoryTurnCount += DEFAULT_VISIBLE_HISTORY_TURNS
                        renderMessages(false)
                        messageScroll.post {
                            messageScroll.scrollTo(0, previousScrollY + (messageList.height - previousHeight).coerceAtLeast(0))
                        }
                    }
                }
            }, LinearLayout.LayoutParams(MATCH, WRAP).apply {
                leftMargin = dp(4)
                rightMargin = dp(4)
                bottomMargin = dp(8)
            })
        }

        val lastAssistantByTurn = messages.filter { it.first == "assistant" }.groupBy { it.second.optString("_turnId") }
            .mapValues { (_, values) -> values.lastOrNull()?.second }
        val renderedFileChangeTurns = mutableSetOf<String>()
        var messageIndex = 0
        while (messageIndex < messages.size) {
            val (role, item) = messages[messageIndex]
            if (role == "operation") {
                val turnId = item.optString("_turnId")
                val groupedOperations = mutableListOf<JSONObject>()
                while (messageIndex < messages.size) {
                    val (nextRole, nextItem) = messages[messageIndex]
                    if (nextRole != "operation" || nextItem.optString("_turnId") != turnId) break
                    groupedOperations += nextItem
                    messageIndex++
                }
                addOperationLog(turnId, groupedOperations)
                if (lastAssistantByTurn[turnId] == null && renderedFileChangeTurns.add(turnId)) {
                    addFileChangeSummary(turnId, fileChangesForTurn(turnId, turnsById[turnId], thread))
                }
                continue
            }
            val viewportWidth = messageScroll.width.takeIf { it > 0 }
                ?: root.width.takeIf { it > 0 }
                ?: resources.displayMetrics.widthPixels
            val availableWidth = (viewportWidth - messageScroll.paddingLeft - messageScroll.paddingRight - dp(4)).coerceAtLeast(dp(160))
            val maxBubbleWidth = (availableWidth * if (role == "user") .92f else .98f).toInt()
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = if (role == "user") Gravity.END else Gravity.START
                setPadding(dp(2), dp(5), dp(2), dp(5))
            }
            val bubble = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(if (role == "user") dp(11) else dp(3), dp(7), if (role == "user") dp(11) else dp(3), dp(7))
                if (role == "user") background = rounded(USER_BUBBLE, dp(12))
            }
            if (role == "assistant") {
                val meta = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }
                meta.addView(
                    label(if (currentMode == "claude-code") "Claude" else "Codex", 11, ACCENT, true),
                    LinearLayout.LayoutParams(WRAP, WRAP),
                )
                item.optString("_displayTime").takeIf { it.isNotBlank() }?.let { displayTime ->
                    meta.addView(
                        label(displayTime, 10, MUTED).apply { setPadding(dp(7), 0, 0, 0) },
                        LinearLayout.LayoutParams(WRAP, WRAP),
                    )
                }
                bubble.addView(meta, LinearLayout.LayoutParams((maxBubbleWidth - dp(6)).coerceAtLeast(dp(120)), WRAP))
            }
            val text = messageText(item, role)
            val hasImage = item.optJSONArray("content")?.let { parts ->
                (0 until parts.length()).any { index ->
                    normalizedType(parts.optJSONObject(index)?.optString("type").orEmpty()) in setOf("image", "localimage")
                }
            } == true
            if (role == "assistant" && item.optJSONArray("_activityTimeline") != null) {
                addAssistantTimeline(bubble, item, (maxBubbleWidth - dp(6)).coerceAtLeast(dp(120)))
            } else if (text.isNotBlank() || !hasImage) {
                val content = label(text.ifBlank { "（附件消息）" }, 14, TEXT).apply {
                    setTextIsSelectable(true)
                    setLineSpacing(dp(2).toFloat(), 1.08f)
                    typeface = Typeface.create("sans-serif", Typeface.NORMAL)
                    setHorizontallyScrolling(false)
                    breakStrategy = android.text.Layout.BREAK_STRATEGY_SIMPLE
                    hyphenationFrequency = android.text.Layout.HYPHENATION_FREQUENCY_NONE
                    maxWidth = (maxBubbleWidth - if (role == "user") dp(22) else dp(6)).coerceAtLeast(dp(120))
                }
                val contentWidth = if (role == "user") {
                    val maxTextWidth = (maxBubbleWidth - bubble.paddingLeft - bubble.paddingRight).coerceAtLeast(dp(80))
                    naturalTextBlockWidth(content, text.ifBlank { "（附件消息）" }, maxTextWidth)
                } else WRAP
                // Specify the user's text width from Android's actual text layout.
                // Nested WRAP_CONTENT measurement alone was collapsing to one glyph
                // per line on some narrow devices even with maxWidth configured.
                bubble.addView(content, LinearLayout.LayoutParams(contentWidth, WRAP))
            }
            addMessageImages(bubble, item, maxBubbleWidth)
            if (role == "user") item.optString("_displayTime").takeIf { it.isNotBlank() }?.let { displayTime ->
                bubble.addView(label(displayTime, 10, MUTED).apply {
                    gravity = Gravity.END
                    setPadding(0, dp(3), 0, 0)
                }, LinearLayout.LayoutParams(WRAP, WRAP))
            }
            row.addView(bubble, LinearLayout.LayoutParams(WRAP, WRAP))
            val turnId = item.optString("_turnId")
            row.tag = "$TAG_MESSAGE_TURN_PREFIX$turnId"
            messageList.addView(row, LinearLayout.LayoutParams(MATCH, WRAP))

            if (role == "assistant" && lastAssistantByTurn[turnId] === item) {
                renderedFileChangeTurns.add(turnId)
                addFileChangeSummary(turnId, fileChangesForTurn(turnId, turnsById[turnId], thread))
            }
            messageIndex++
        }
        val approval = pendingApproval
        if (approval != null) renderApproval(approval)
        if (running && !(messages.isEmpty() && !historyLoadError.isNullOrBlank())) {
            val activity = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12), dp(8), dp(12), dp(8))
                tag = TAG_MESSAGE_DYNAMIC
            }
            activity.addView(ProgressBar(this, null, android.R.attr.progressBarStyleSmall).apply {
                isIndeterminate = true
                indeterminateTintList = ColorStateList.valueOf(ACCENT)
                contentDescription = activityLabel
            }, LinearLayout.LayoutParams(dp(16), dp(16)).apply { rightMargin = dp(7) })
            activity.addView(label(activityLabel, 12, ACCENT), LinearLayout.LayoutParams(0, WRAP, 1f))
            activity.addView(label(currentMessageTime(), 10, MUTED).apply {
                gravity = Gravity.END
                contentDescription = "思考开始时间 ${currentMessageTime()}"
            }, LinearLayout.LayoutParams(WRAP, WRAP))
            messageList.addView(activity, LinearLayout.LayoutParams(MATCH, WRAP))
        }
        messageScroll.post {
            if (scrollToEnd || wasNearEnd) messageScroll.fullScroll(View.FOCUS_DOWN)
            updateScrollToBottomButton()
        }
    }

    private fun updateScrollToBottomButton() {
        if (!::scrollToBottomButton.isInitialized || !::messageScroll.isInitialized || !::messageList.isInitialized) return
        val distanceToBottom = messageList.height - messageScroll.scrollY - messageScroll.height
        scrollToBottomButton.visibility = if (distanceToBottom > dp(96)) View.VISIBLE else View.GONE
    }

    private val activityLabel: String
        get() = if (socketConnected) "正在思考…" else "正在等待连接…"

    private fun addAssistantTimeline(container: LinearLayout, message: JSONObject, maximumWidth: Int) {
        val timeline = message.optJSONArray("_activityTimeline") ?: return
        val pendingOperations = mutableListOf<JSONObject>()
        val turnId = message.optString("_turnId")

        fun flushOperations() {
            if (pendingOperations.isEmpty()) return
            container.addView(operationLogView(turnId, pendingOperations.toList(), maximumWidth), LinearLayout.LayoutParams(WRAP, WRAP))
            pendingOperations.clear()
        }

        for (index in 0 until timeline.length()) {
            val block = timeline.optJSONObject(index) ?: continue
            when (block.optString("type")) {
                "message" -> {
                    flushOperations()
                    val text = block.optString("text")
                    if (text.isBlank()) continue
                    val content = label(text, 14, TEXT).apply {
                        setTextIsSelectable(true)
                        setLineSpacing(dp(2).toFloat(), 1.08f)
                        typeface = Typeface.create("sans-serif", Typeface.NORMAL)
                        setHorizontallyScrolling(false)
                        breakStrategy = android.text.Layout.BREAK_STRATEGY_SIMPLE
                        hyphenationFrequency = android.text.Layout.HYPHENATION_FREQUENCY_NONE
                        maxWidth = maximumWidth
                    }
                    container.addView(content, LinearLayout.LayoutParams(WRAP, WRAP))
                }
                "operation" -> block.optJSONObject("item")?.let(pendingOperations::add)
            }
        }
        flushOperations()
    }

    private fun addOperationLog(turnId: String, operations: List<JSONObject>) {
        val viewportWidth = messageScroll.width.takeIf { it > 0 } ?: root.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels
        val maxWidth = (viewportWidth - messageScroll.paddingLeft - messageScroll.paddingRight - dp(8)).coerceAtLeast(dp(160))
        messageList.addView(operationLogView(turnId, operations, maxWidth).apply {
            tag = "$TAG_MESSAGE_TURN_PREFIX$turnId"
        }, widthWrap())
    }

    private fun operationLogView(turnId: String, operations: List<JSONObject>, maximumWidth: Int): LinearLayout {
        val operationKey = operations.firstOrNull()?.let { operation ->
            operation.optString("_activityIndex").takeIf { it.isNotBlank() }
                ?: operation.optString("id").takeIf { it.isNotBlank() }
        } ?: "empty"
        val logId = "$turnId:$operationKey"
        val failed = operations.count { normalizedOperationStatus(it) == "failed" }
        val runningCount = operations.count { normalizedOperationStatus(it) == "running" }
        val statusText = when {
            runningCount > 0 -> "$runningCount 项进行中"
            failed > 0 -> "$failed 项失败"
            else -> "${operations.size} 项完成"
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(2), dp(1), dp(2), dp(2))
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(2), dp(2), dp(2), dp(2))
        }
        val chevron = ImageView(this).apply {
            imageTintList = ColorStateList.valueOf(MUTED)
        }
        header.addView(chevron, LinearLayout.LayoutParams(dp(15), dp(15)).apply { rightMargin = dp(6) })
        header.addView(label("操作记录", 12, SUBTLE, true), LinearLayout.LayoutParams(WRAP, dp(25)))
        header.addView(label(statusText, 11, if (failed > 0) ERROR else MUTED).apply { gravity = Gravity.END or Gravity.CENTER_VERTICAL }, LinearLayout.LayoutParams(0, dp(25), 1f))
        container.addView(header, LinearLayout.LayoutParams(maximumWidth, WRAP))

        lateinit var refreshDetails: () -> Unit
        refreshDetails = {
            val expanded = logId in expandedOperationIds
            chevron.setImageResource(if (expanded) R.drawable.ic_chevron_up else R.drawable.ic_chevron_down)
            if (container.childCount > 1) container.removeViews(1, container.childCount - 1)
            if (expanded) {
                container.addView(
                    operationDetailsView(logId, operations, maximumWidth, refreshDetails),
                    LinearLayout.LayoutParams(maximumWidth, WRAP),
                )
            }
        }
        header.setOnClickListener {
            if (logId in expandedOperationIds) expandedOperationIds.remove(logId) else expandedOperationIds.add(logId)
            refreshDetails()
        }
        refreshDetails()
        return container
    }

    private fun operationDetailsView(
        logId: String,
        operations: List<JSONObject>,
        maximumWidth: Int,
        refreshDetails: () -> Unit,
    ): LinearLayout {
        val showAll = logId in fullyExpandedOperationIds
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(5), 0, 0, dp(3)) }
        val visibleOperations = if (showAll) operations else operations.take(8)
        visibleOperations.forEach { operation ->
            val status = normalizedOperationStatus(operation)
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.TOP
                setPadding(0, dp(3), 0, dp(3))
            }
            row.addView(ImageView(this).apply {
                setImageResource(when (status) {
                    "failed" -> R.drawable.ic_alert
                    "running" -> R.drawable.ic_progress
                    "stopped" -> R.drawable.ic_stop
                    else -> R.drawable.ic_check
                })
                imageTintList = ColorStateList.valueOf(when (status) {
                    "failed" -> ERROR
                    "running" -> ACCENT
                    "stopped" -> WARNING
                    else -> if (lightTheme) Color.rgb(52, 132, 75) else Color.rgb(119, 174, 132)
                })
            }, LinearLayout.LayoutParams(dp(14), dp(14)).apply { topMargin = dp(3); rightMargin = dp(7) })
            val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            copy.addView(label(operationLabel(operation), 12, TEXT, true), widthWrap())
            val paths = operationPaths(operation)
            val detail = operationDetail(operation, paths)
            if (detail.isNotBlank()) copy.addView(label(detail, 10, MUTED).apply {
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                maxWidth = (maximumWidth - dp(42)).coerceAtLeast(dp(110))
            }, widthWrap())
            if (paths.isNotEmpty()) {
                val path = paths.first()
                val imagePath = isWorkspaceImagePath(path)
                copy.addView(label("${if (imagePath) "查看图片" else "打开文件"} · ${path.substringAfterLast('/')}", 10, ACCENT).apply {
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                    contentDescription = if (imagePath) "查看图片 ${path.substringAfterLast('/')}" else "打开文件 ${path.substringAfterLast('/')}"
                    setOnClickListener { showFilePreview(path, null) }
                }, widthWrap())
            }
            row.addView(copy, LinearLayout.LayoutParams(0, WRAP, 1f))
            list.addView(row, LinearLayout.LayoutParams(maximumWidth - dp(7), WRAP))
        }
        if (!showAll && operations.size > visibleOperations.size) {
            list.addView(label("查看其余 ${operations.size - visibleOperations.size} 项", 11, ACCENT, true).apply {
                setPadding(dp(21), dp(4), 0, dp(4))
                setOnClickListener {
                    fullyExpandedOperationIds.add(logId)
                    refreshDetails()
                }
            }, widthWrap())
        }
        return list
    }

    private fun normalizedOperationStatus(operation: JSONObject): String {
        val status = operation.optString("status").replace("-", "").replace("_", "").lowercase(Locale.ROOT)
        return when (status) {
            "inprogress", "running", "started" -> "running"
            "failed", "error" -> "failed"
            "interrupted", "cancelled", "canceled", "declined" -> "stopped"
            else -> "completed"
        }
    }

    private fun operationLabel(operation: JSONObject): String {
        val type = normalizedType(operation.optString("type"))
        if (type == "commandexecution") {
            val command = operation.optString("command")
            return when {
                SEARCH_COMMAND_PATTERN.containsMatchIn(command) -> "搜索文件"
                VIEW_COMMAND_PATTERN.containsMatchIn(command) -> "查看文件"
                else -> "执行命令"
            }
        }
        return when (type) {
            "filechange" -> "修改文件"
            "mcptoolcall", "dynamictoolcall" -> "调用工具"
            "collabagenttoolcall", "subagentactivity" -> "运行子任务"
            "websearch" -> "搜索资料"
            "imageview" -> "查看图片"
            "imagegeneration" -> "生成图片"
            "reasoning" -> "思考"
            "plan" -> "整理计划"
            else -> operation.optString("description").ifBlank { "处理任务" }
        }
    }

    private fun operationDetail(operation: JSONObject, knownPaths: List<String>? = null): String {
        val type = normalizedType(operation.optString("type"))
        val raw = when (type) {
            "commandexecution" -> operation.optString("command")
            "websearch" -> operation.optString("query")
            "filechange" -> (knownPaths ?: operationPaths(operation)).take(3).joinToString("、")
            else -> listOf(operation.optString("server"), operation.optString("tool"), operation.optString("name"), operation.optString("path"))
                .firstOrNull { it.isNotBlank() }.orEmpty()
        }
        return raw.replace(CONTROL_CHARACTER_PATTERN, " ")
            .replace(WHITESPACE_PATTERN, " ")
            .trim()
            .let { if (it.length > 120) it.take(119) + "…" else it }
    }

    private fun operationPaths(value: Any?, depth: Int = 0, output: LinkedHashSet<String> = linkedSetOf()): List<String> {
        if (depth > 4 || value == null || output.size >= 8) return output.toList()
        when (value) {
            is JSONObject -> {
                val keys = value.keys()
                while (keys.hasNext() && output.size < 8) {
                    val key = keys.next()
                    val entry = value.opt(key)
                    if (key.lowercase(Locale.ROOT) in OPERATION_PATH_KEYS && entry is String && entry.isNotBlank()) {
                        output += entry.trim()
                    } else if (entry is JSONObject || entry is JSONArray) operationPaths(entry, depth + 1, output)
                }
            }
            is JSONArray -> for (index in 0 until value.length()) operationPaths(value.opt(index), depth + 1, output)
        }
        return output.toList()
    }

    private fun addMessageImages(container: LinearLayout, item: JSONObject, maxBubbleWidth: Int) {
        val content = item.optJSONArray("content") ?: return
        val imageWidth = (maxBubbleWidth - container.paddingLeft - container.paddingRight).coerceAtLeast(dp(120))
        for (index in 0 until content.length()) {
            val part = content.optJSONObject(index) ?: continue
            val type = normalizedType(part.optString("type"))
            val dataValue = if (type == "image") part.optString("image_url") else if (type == "localimage") part.optString("data") else ""
            val data = dataValue.substringAfter("base64,", dataValue)
            if (data.isBlank()) {
                if (type == "localimage") {
                    part.optString("path").takeIf { it.isNotBlank() && it != "null" }?.let { path ->
                        addRemoteMessageImage(container, path, imageWidth)
                    }
                }
                continue
            }
            if (data.length > MAX_INLINE_IMAGE_BASE64_CHARS) {
                container.addView(label("图片过大，已跳过内嵌预览", 11, WARNING).apply {
                    setPadding(0, dp(5), 0, dp(3))
                }, widthWrap())
                continue
            }
            try {
                val cacheKey = "${item.optString("id")}:$index:${data.length}:${data.take(48).hashCode()}"
                val bitmap = messageImageCache.get(cacheKey) ?: run {
                    val bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT)
                    decodeSampledBitmap(bytes, 720)?.also { messageImageCache.put(cacheKey, it) }
                } ?: continue
                val image = ImageView(this).apply {
                    setImageBitmap(bitmap)
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    background = rounded(USER_BUBBLE, dp(8))
                    setOnClickListener { showImageDialog(bitmap) }
                }
                container.addView(image, LinearLayout.LayoutParams(imageWidth, dp(190)).apply { topMargin = dp(5) })
            } catch (_: IllegalArgumentException) { }
            catch (_: OutOfMemoryError) { messageImageCache.evictAll() }
        }
    }

    private fun addRemoteMessageImage(container: LinearLayout, path: String, imageWidth: Int) {
        val cwd = activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" }
        val requestPath = workspaceImageRequestPath(cwd, path)
        val cacheKey = "path:${cwd.orEmpty()}:$requestPath"
        val holder = FrameLayout(this).apply {
            background = rounded(USER_BUBBLE, dp(8))
            clipToOutline = true
        }
        val image = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            visibility = View.INVISIBLE
        }
        holder.addView(image, FrameLayout.LayoutParams(MATCH, MATCH))
        val progress = ProgressBar(this, null, android.R.attr.progressBarStyleSmall).apply {
            isIndeterminate = true
            indeterminateTintList = ColorStateList.valueOf(MUTED)
        }
        holder.addView(progress, FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER))
        container.addView(holder, LinearLayout.LayoutParams(imageWidth, dp(190)).apply { topMargin = dp(5) })
        var failureView: View? = null

        fun display(bitmap: Bitmap) {
            image.setImageBitmap(bitmap)
            image.visibility = View.VISIBLE
            progress.visibility = View.GONE
            image.setOnClickListener { showImageDialog(bitmap) }
        }

        messageImageCache.get(cacheKey)?.let {
            display(it)
            return
        }
        lateinit var loadImage: () -> Unit
        loadImage = {
            failureView?.let(holder::removeView)
            failureView = null
            progress.visibility = View.VISIBLE
            io.execute {
                try {
                    val query = buildString {
                        append("?path=${Uri.encode(requestPath)}")
                        if (!cwd.isNullOrBlank()) append("&cwd=${Uri.encode(cwd)}")
                    }
                    val response = RemoteApi(endpoint, token).get("/api/v1/codex/workspace/image$query")
                    val encoded = response.optString("data")
                    if (encoded.isBlank() || encoded.length > MAX_FILE_PREVIEW_BASE64_CHARS) throw IOException("图片过大")
                    val bitmap = decodeSampledBitmap(android.util.Base64.decode(encoded, android.util.Base64.DEFAULT), 720)
                        ?: throw IOException("图片内容无法解析")
                    messageImageCache.put(cacheKey, bitmap)
                    handler.post { if (holder.isAttachedToWindow) display(bitmap) }
                } catch (error: Exception) {
                    handler.post {
                        if (!holder.isAttachedToWindow) return@post
                        progress.visibility = View.GONE
                        failureView = LinearLayout(this).apply {
                            orientation = LinearLayout.VERTICAL
                            gravity = Gravity.CENTER
                            addView(label("图片无法加载", 11, MUTED).apply { gravity = Gravity.CENTER }, widthWrap())
                            addView(label("点按重试 · ${error.message ?: ""}", 10, ACCENT).apply {
                                gravity = Gravity.CENTER
                                setOnClickListener { loadImage() }
                            }, widthWrap())
                        }
                        holder.addView(failureView, FrameLayout.LayoutParams(MATCH, MATCH))
                    }
                } catch (_: OutOfMemoryError) {
                    messageImageCache.evictAll()
                    handler.post { if (holder.isAttachedToWindow) progress.visibility = View.GONE }
                }
            }
        }
        loadImage()
    }

    private fun decodeSampledBitmap(bytes: ByteArray, maximumDimension: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sampleSize = 1
        while (bounds.outWidth / sampleSize > maximumDimension || bounds.outHeight / sampleSize > maximumDimension) {
            sampleSize *= 2
        }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
            inSampleSize = sampleSize
            inPreferredConfig = Bitmap.Config.ARGB_8888
        })
    }

    private fun naturalTextBlockWidth(textView: TextView, value: String, maxWidth: Int): Int {
        if (value.isEmpty()) return dp(1).coerceAtMost(maxWidth)
        val layout = StaticLayout.Builder.obtain(value, 0, value.length, textView.paint, maxWidth)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR)
            .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
            .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
            .build()
        val widestLine = (0 until layout.lineCount).maxOfOrNull { layout.getLineWidth(it) } ?: 0f
        return ceil(widestLine.toDouble()).toInt().coerceIn(dp(1), maxWidth)
    }

    private fun createAttachmentThumbnail(bytes: ByteArray): String {
        val bitmap = decodeSampledBitmap(bytes, 160) ?: return ""
        return try {
            val output = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
            android.util.Base64.encodeToString(output.toByteArray(), android.util.Base64.NO_WRAP)
        } finally {
            bitmap.recycle()
        }
    }

    private fun showImageDialog(bitmap: android.graphics.Bitmap) {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val frame = FrameLayout(this).apply { background = rounded(PANEL, dp(14), BORDER, dp(1)) }
        frame.addView(ImageView(this).apply {
            setImageBitmap(bitmap)
            adjustViewBounds = true
            scaleType = ImageView.ScaleType.FIT_CENTER
            setPadding(dp(8), dp(8), dp(8), dp(8))
        }, FrameLayout.LayoutParams(MATCH, MATCH))
        frame.addView(iconButton("close", "关闭图片") { dialog.dismiss() }.apply {
            background = rounded(PANEL_INSET, dp(18))
        }, FrameLayout.LayoutParams(dp(36), dp(36), Gravity.TOP or Gravity.END).apply { topMargin = dp(8); rightMargin = dp(8) })
        dialog.setContentView(frame)
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout(MATCH, (resources.displayMetrics.heightPixels * .82f).toInt())
            setGravity(Gravity.CENTER)
        }
    }

    private data class FileChangeEntry(
        val path: String,
        val additions: Int = 0,
        val deletions: Int = 0,
        val kind: String = "",
        val diff: String = "",
    )

    private fun fileChangesForTurn(turnId: String, turn: JSONObject?, thread: JSONObject?): List<FileChangeEntry> {
        val merged = linkedMapOf<String, FileChangeEntry>()
        val items = turn?.optJSONArray("items") ?: JSONArray()
        for (itemIndex in 0 until items.length()) {
            val item = items.optJSONObject(itemIndex) ?: continue
            if (normalizedType(item.optString("type")) != "filechange") continue
            parseFileChanges(item.opt("changes")).forEach { incoming ->
                val previous = merged[incoming.path]
                merged[incoming.path] = if (previous == null) incoming else previous.copy(
                    additions = previous.additions + incoming.additions,
                    deletions = previous.deletions + incoming.deletions,
                    kind = incoming.kind.ifBlank { previous.kind },
                    diff = listOf(previous.diff, incoming.diff).filter(String::isNotBlank).distinct().joinToString("\n\n"),
                )
            }
        }
        val workspaceValue = thread?.optJSONObject("codexRemoteWorkspaceChanges")?.opt(turnId)
        val workspaceChanges = when (workspaceValue) {
            is JSONObject -> workspaceValue.opt("changes") ?: workspaceValue
            else -> workspaceValue
        }
        parseFileChanges(workspaceChanges).forEach { incoming ->
            val previous = merged[incoming.path]
            merged[incoming.path] = if (previous == null) incoming else previous.copy(
                additions = if (previous.additions > 0 || previous.deletions > 0) previous.additions else incoming.additions,
                deletions = if (previous.additions > 0 || previous.deletions > 0) previous.deletions else incoming.deletions,
                kind = previous.kind.ifBlank { incoming.kind },
                diff = listOf(previous.diff, incoming.diff).filter(String::isNotBlank).distinct().joinToString("\n\n"),
            )
        }
        return merged.values.toList()
    }

    private fun parseFileChanges(value: Any?): List<FileChangeEntry> {
        val raw = mutableListOf<Any?>()
        when (value) {
            is JSONArray -> for (index in 0 until value.length()) raw += value.opt(index)
            is JSONObject -> {
                val looksLikeEntry = value.has("path") || value.has("filePath") || value.has("filename")
                if (looksLikeEntry) raw += value
                else {
                    val keys = value.keys()
                    while (keys.hasNext()) {
                        val path = keys.next()
                        val detail = value.opt(path)
                        raw += if (detail is JSONObject) shallowCopyObject(detail).putIfAbsentCompat("path", path) else JSONObject().put("path", path)
                    }
                }
            }
            is String -> raw += value
        }
        return raw.mapNotNull { entry ->
            if (entry is String) return@mapNotNull entry.takeIf { it.isNotBlank() }?.let(::FileChangeEntry)
            val item = entry as? JSONObject ?: return@mapNotNull null
            val path = listOf("path", "filePath", "filename", "move_path", "movePath")
                .map { key -> item.optString(key) }.firstOrNull { it.isNotBlank() } ?: return@mapNotNull null
            val diff = listOf("diff", "patch", "unified_diff", "unifiedDiff").map { key -> item.optString(key) }.firstOrNull { it.isNotBlank() }.orEmpty()
            val additions = if (item.has("additions")) item.optInt("additions") else diff.lineSequence().count { it.startsWith("+") && !it.startsWith("+++") }
            val deletions = if (item.has("deletions")) item.optInt("deletions") else diff.lineSequence().count { it.startsWith("-") && !it.startsWith("---") }
            FileChangeEntry(
                path,
                additions.coerceAtLeast(0),
                deletions.coerceAtLeast(0),
                item.optString("kind").ifBlank { item.optString("type") },
                diff,
            )
        }
    }

    private fun addFileChangeSummary(turnId: String, entries: List<FileChangeEntry>) {
        if (entries.isEmpty()) return
        val summaryId = "files:$turnId"
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), dp(8), dp(10), dp(8))
            background = rounded(PANEL, dp(11), BORDER, dp(1))
            tag = "$TAG_MESSAGE_TURN_PREFIX$turnId"
        }
        val totalAdditions = entries.sumOf { it.additions }
        val totalDeletions = entries.sumOf { it.deletions }
        val heading = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isClickable = true
            isFocusable = true
            contentDescription = "展开或收起最近编辑文件"
        }
        val headingIcon = ImageView(this).apply {
            setImageResource(R.drawable.ic_edit)
            imageTintList = ColorStateList.valueOf(MUTED)
        }
        heading.addView(headingIcon, LinearLayout.LayoutParams(dp(15), dp(15)).apply { rightMargin = dp(6) })
        heading.addView(label("最近编辑文件 · ${entries.size}", 12, SUBTLE, true).apply {
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }, LinearLayout.LayoutParams(0, dp(25), 1f))
        val headingStats = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            if (totalAdditions > 0) addView(label("+$totalAdditions", 11, if (lightTheme) Color.rgb(22, 130, 63) else Color.rgb(91, 201, 123), true), LinearLayout.LayoutParams(WRAP, MATCH))
            if (totalDeletions > 0) addView(label("-$totalDeletions", 11, if (lightTheme) Color.rgb(190, 48, 57) else Color.rgb(239, 102, 113), true).apply {
                setPadding(dp(7), 0, 0, 0)
            }, LinearLayout.LayoutParams(WRAP, MATCH))
        }
        heading.addView(headingStats, LinearLayout.LayoutParams(WRAP, dp(25)).apply { leftMargin = dp(7) })
        val chevron = ImageView(this).apply { imageTintList = ColorStateList.valueOf(MUTED) }
        heading.addView(chevron, LinearLayout.LayoutParams(dp(15), dp(15)).apply { leftMargin = dp(8) })
        card.addView(heading, LinearLayout.LayoutParams(MATCH, dp(25)))

        lateinit var refreshFileRows: () -> Unit
        refreshFileRows = {
            val expanded = summaryId in expandedFileChangeIds
            chevron.setImageResource(if (expanded) R.drawable.ic_chevron_up else R.drawable.ic_chevron_down)
            if (card.childCount > 1) card.removeViews(1, card.childCount - 1)
            if (expanded) {
                val rows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
                entries.forEach { item ->
                    val line = RelativeLayout(this).apply {
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(21), dp(3), 0, dp(3))
                        setOnClickListener { showDiffPreview(item) }
                    }
                    val stats = LinearLayout(this).apply {
                        id = View.generateViewId()
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        if (item.additions > 0) addView(label("+${item.additions}", 10, if (lightTheme) Color.rgb(22, 130, 63) else Color.rgb(91, 201, 123), true), LinearLayout.LayoutParams(WRAP, MATCH))
                        if (item.deletions > 0) addView(label("-${item.deletions}", 10, if (lightTheme) Color.rgb(190, 48, 57) else Color.rgb(239, 102, 113), true).apply {
                            setPadding(dp(6), 0, 0, 0)
                        }, LinearLayout.LayoutParams(WRAP, MATCH))
                    }
                    line.addView(stats, RelativeLayout.LayoutParams(WRAP, dp(22)).apply {
                        addRule(RelativeLayout.ALIGN_PARENT_END)
                        addRule(RelativeLayout.CENTER_VERTICAL)
                    })
                    line.addView(label(item.path, 11, ACCENT).apply {
                        maxLines = 1
                        ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                    }, RelativeLayout.LayoutParams(MATCH, dp(22)).apply {
                        addRule(RelativeLayout.ALIGN_PARENT_START)
                        addRule(RelativeLayout.START_OF, stats.id)
                        marginEnd = if (item.additions > 0 || item.deletions > 0) dp(8) else 0
                    })
                    rows.addView(line, LinearLayout.LayoutParams(MATCH, WRAP))
                }
                val listHeight = min(dp(252), (entries.size * dp(28)).coerceAtLeast(dp(28)))
                var previousY = 0f
                val scroll = ScrollView(this).apply {
                    isVerticalScrollBarEnabled = false
                    overScrollMode = View.OVER_SCROLL_NEVER
                    isNestedScrollingEnabled = true
                    addView(rows, FrameLayout.LayoutParams(MATCH, WRAP))
                    setOnTouchListener { view, event ->
                        when (event.actionMasked) {
                            MotionEvent.ACTION_DOWN -> {
                                previousY = event.y
                                view.parent?.requestDisallowInterceptTouchEvent(true)
                            }
                            MotionEvent.ACTION_MOVE -> {
                                val movingDown = event.y > previousY
                                previousY = event.y
                                val canConsume = canScrollVertically(if (movingDown) -1 else 1)
                                view.parent?.requestDisallowInterceptTouchEvent(canConsume)
                            }
                            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> view.parent?.requestDisallowInterceptTouchEvent(false)
                        }
                        false
                    }
                }
                card.addView(scroll, LinearLayout.LayoutParams(MATCH, listHeight).apply { topMargin = dp(3) })
            }
        }
        heading.setOnClickListener {
            if (summaryId in expandedFileChangeIds) expandedFileChangeIds.remove(summaryId) else expandedFileChangeIds.add(summaryId)
            refreshFileRows()
        }
        refreshFileRows()
        messageList.addView(card, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(3); bottomMargin = dp(4) })
    }

    private fun renderApproval(approval: JSONObject) {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(9))
            background = rounded(if (lightTheme) Color.rgb(250, 245, 232) else Color.rgb(43, 37, 27), dp(12), if (lightTheme) Color.rgb(224, 205, 163) else Color.rgb(98, 77, 44), dp(1))
            tag = TAG_MESSAGE_DYNAMIC
        }
        box.addView(label("需要批准", 13, WARNING, true), widthWrap())
        val params = approval.optJSONObject("params") ?: JSONObject()
        box.addView(label(params.optString("reason").ifBlank { params.optString("command") }.ifBlank { "Codex 请求执行一项需要批准的操作。" }, 12, TEXT).apply {
            setPadding(0, dp(5), 0, dp(7)); setTextIsSelectable(true)
        }, widthWrap())
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END }
        actions.addView(smallButton("拒绝") { respondApproval("decline") }, LinearLayout.LayoutParams(WRAP, dp(30)).apply { rightMargin = dp(6) })
        actions.addView(smallButton("允许一次") { respondApproval("accept") }, LinearLayout.LayoutParams(WRAP, dp(30)))
        box.addView(actions, widthWrap())
        messageList.addView(box, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(7); bottomMargin = dp(7) })
    }

    private fun renderQueue() {
        if (!::queuePanel.isInitialized || !::queueContent.isInitialized) return
        queuePanel.removeAllViews()
        val count = queuedMessages.length()
        if (count == 0) {
            queuePanel.visibility = View.GONE
            queueContent.visibility = View.GONE
            return
        }
        queuePanel.visibility = View.VISIBLE
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(label("排队消息 · $count", 12, SUBTLE, true), LinearLayout.LayoutParams(0, dp(28), 1f))
        header.addView(iconButton(if (queueExpanded) "chevron_up" else "chevron_down", if (queueExpanded) "收起排队消息" else "展开排队消息") {
            queueExpanded = !queueExpanded
            renderQueue()
        }.apply { setPadding(dp(6), dp(6), dp(6), dp(6)) }, LinearLayout.LayoutParams(dp(28), dp(28)))
        queuePanel.addView(header, widthWrap())
        queueContent.removeAllViews()
        queueContent.visibility = if (queueExpanded) View.VISIBLE else View.GONE
        if (!queueExpanded) return
        for (index in 0 until count) {
            val item = queuedMessages.optJSONObject(index) ?: continue
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(9), dp(7), dp(9), dp(7))
                background = rounded(PANEL_INSET, dp(9))
            }
            val text = item.optString("text").ifBlank { item.optString("requestText") }
            card.addView(label("${index + 1}.  ${text.ifBlank { "（附件消息）" }}", 12, TEXT).apply {
                maxLines = 3; ellipsize = android.text.TextUtils.TruncateAt.END; setTextIsSelectable(true)
            }, widthWrap())
            val claudeQueueItem = item.has("claudeModel") || item.has("claudeEffort") || currentMode == "claude-code"
            val rawModel = item.optString(if (claudeQueueItem) "claudeModel" else "model")
            val rawEffort = item.optString(if (claudeQueueItem) "claudeEffort" else "effort")
            val queuedModel = if (rawModel.isBlank() || rawModel == "default") "默认模型"
                else if (claudeQueueItem) claudeModelLabel(rawModel) else modelLabel(rawModel)
            val queuedEffort = if (rawEffort.isBlank() || rawEffort == "default") "默认"
                else effortLabel(rawEffort)
            card.addView(label("模型：$queuedModel  ·  思考：$queuedEffort", 10, MUTED).apply {
                setPadding(0, dp(4), 0, 0)
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            }, widthWrap())
            val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END }
            controls.addView(iconButton("edit", "修改排队消息") { editQueuedMessage(item) }.apply { setPadding(dp(6), dp(6), dp(6), dp(6)) }, LinearLayout.LayoutParams(dp(29), dp(29)).apply { rightMargin = dp(4) })
            controls.addView(iconButton("arrow_up", "立即发送") { sendQueuedNow(item) }.apply { setPadding(dp(6), dp(6), dp(6), dp(6)) }, LinearLayout.LayoutParams(dp(29), dp(29)).apply { rightMargin = dp(4) })
            controls.addView(iconButton("delete", "删除排队消息") { removeQueuedMessage(item) }.apply { setPadding(dp(6), dp(6), dp(6), dp(6)) }, LinearLayout.LayoutParams(dp(29), dp(29)))
            card.addView(controls, LinearLayout.LayoutParams(MATCH, dp(30)).apply { topMargin = dp(4) })
            queueContent.addView(card, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(4) })
        }
    }

    private fun sendCurrentMessage() {
        val text = composerInput.text.toString().trim()
        if (text.isBlank()) return
        val threadId = activeThreadId
        val requestId = UUID.randomUUID().toString()
        val payload = queuedPayload(text, requestId)
        composerInput.setText("")
        (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(composerInput.windowToken, 0)
        if (threadId == null) {
            io.execute {
                try {
                    val created = RemoteApi(endpoint, token).post("/api/v1/codex/threads", JSONObject()
                        .put("engine", currentMode)
                        .put("request_id", requestId)
                        .putOpt("model", preference("model"))
                        .putOpt("approval_policy", if (currentMode == "codex") preference("approvalPolicy") else null))
                    handler.post {
                        threads = JSONArray().put(created).also { old ->
                            for (index in 0 until threads.length()) if (threads.optJSONObject(index)?.optString("id") != created.optString("id")) old.put(threads.optJSONObject(index))
                        }
                        selectThread(created)
                        submitPayload(created.optString("id"), payload)
                    }
                } catch (error: Exception) {
                    handler.post { composerInput.setText(text); showStatus(error.message ?: "新建对话失败") }
                }
            }
        } else submitPayload(threadId, payload)
    }

    private fun queuedPayload(text: String, id: String): JSONObject {
        val images = JSONArray()
        val documents = JSONArray()
        selectedFiles.forEach { file ->
            if (file.optString("kind") == "image") images.put(JSONObject()
                .put("name", file.optString("name"))
                .put("mediaType", file.optString("mediaType"))
                .put("data", file.optString("data")))
            else documents.put(JSONObject()
                .put("name", file.optString("name"))
                .put("content", file.optString("content"))
                .putOpt("sourceFileId", file.optString("sourceFileId").takeIf { it.isNotBlank() }))
        }
        val textWithDocs = buildString {
            append(text)
            for (index in 0 until documents.length()) {
                val doc = documents.optJSONObject(index) ?: continue
                if (doc.optString("sourceFileId").isBlank()) append("\n\n[附件文档：${doc.optString("name")}]\n${doc.optString("content")}\n[/附件文档]")
            }
        }
        val payload = JSONObject()
            .put("id", id)
            .put("text", textWithDocs)
            .put("requestText", textWithDocs)
            .put("images", images)
            .put("documents", documents)
            .put("createdAt", java.time.Instant.now().toString())
        val model = preference(if (currentMode == "codex") "model" else "claudeModel")
        val effort = preference(if (currentMode == "codex") "effort" else "claudeEffort")
        if (!model.isNullOrBlank() && model != "default") payload.put(if (currentMode == "codex") "model" else "claudeModel", model)
        if (!effort.isNullOrBlank() && effort != "default") payload.put(if (currentMode == "codex") "effort" else "claudeEffort", effort)
        if (currentMode == "codex") payload.put("approvalPolicy", preference("approvalPolicy") ?: "on-request")
        else payload.put("claudePermissionMode", preference("claudePermissionMode") ?: "default")
        return payload
    }

    private fun submitPayload(threadId: String, payload: JSONObject) {
        val oldSelected = activeThreadId
        setSendBusy(true)
        io.execute {
            try {
                val response = RemoteApi(endpoint, token).post("/api/v1/codex/queue/${RemoteApi.encodePath(threadId)}/submit", payload)
                handler.post {
                    if (activeThreadId == oldSelected || activeThreadId == threadId) {
                        running = response.optBoolean("sent", false) || running
                        renderHeader()
                        renderMessages(true)
                    }
                    queuedMessages = response.optJSONArray("queue") ?: JSONArray()
                    selectedFiles.clear()
                    renderAttachmentStrip()
                    renderQueue()
                    refreshActiveThread(false)
                    refreshThreads(false)
                    if (!response.optBoolean("sent", false)) showToast("已加入排队")
                }
            } catch (error: Exception) {
                handler.post {
                    if (::composerInput.isInitialized && composerInput.text.isBlank()) composerInput.setText(payload.optString("text"))
                    showStatus(error.message ?: "发送失败")
                    setSendBusy(false)
                }
            }
        }
    }

    private fun setSendBusy(busy: Boolean) {
        if (!::sendButton.isInitialized) return
        sendButton.isEnabled = !busy
        sendButton.text = if (busy) "…" else if (running) "Ⅱ" else "↑"
    }

    private fun interruptTurn() {
        val threadId = activeThreadId ?: return
        io.execute {
            try {
                RemoteApi(endpoint, token).post("/api/v1/codex/threads/${RemoteApi.encodePath(threadId)}/interrupt", JSONObject())
                handler.post { showStatus("已发送暂停请求"); running = false; renderHeader() }
            } catch (error: Exception) { handler.post { showStatus(error.message ?: "暂停失败") } }
        }
    }

    private fun editQueuedMessage(item: JSONObject) {
        val input = editField("排队消息", item.optString("text"), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE).apply {
            minLines = 3
            maxLines = 8
        }
        showInputDialog("修改排队消息", input, "确定") {
            val threadId = activeThreadId ?: return@showInputDialog false
            val ownerId = "android-${UUID.randomUUID()}"
            val updated = shallowCopyObject(item).put("text", input.text.toString()).put("requestText", input.text.toString())
            io.execute {
                try {
                    val api = RemoteApi(endpoint, token)
                    val base = "/api/v1/codex/queue/${RemoteApi.encodePath(threadId)}"
                    val ownerBody = JSONObject().put("message_id", item.optString("id")).put("owner_id", ownerId)
                    api.post("$base/edit/begin", ownerBody)
                    api.post("$base/edit/update", updated)
                    api.post("$base/edit/end", ownerBody)
                    handler.post { refreshQueue(false) }
                } catch (error: Exception) { handler.post { showStatus(error.message ?: "修改排队消息失败"); refreshQueue(false) } }
            }
            true
        }
    }

    private fun sendQueuedNow(item: JSONObject) = queueAction("send-now", item) { refreshActiveThread(false) }

    private fun removeQueuedMessage(item: JSONObject) = queueAction("remove", item) { }

    private fun queueAction(action: String, item: JSONObject, after: () -> Unit) {
        val threadId = activeThreadId ?: return
        io.execute {
            try {
                val result = RemoteApi(endpoint, token).post("/api/v1/codex/queue/${RemoteApi.encodePath(threadId)}/$action", queueIdBody(item))
                handler.post {
                    queuedMessages = result.optJSONArray("queue") ?: JSONArray()
                    renderQueue()
                    if (result.optBoolean("sent", false)) refreshActiveThread(false)
                    after()
                }
            } catch (error: Exception) { handler.post { showStatus(error.message ?: "队列操作失败") } }
        }
    }

    private fun queueIdBody(item: JSONObject) = JSONObject()
        .put("message_id", item.optString("id"))
        .put("owner_id", "android-${UUID.randomUUID()}")

    private fun createThread() {
        val requestId = UUID.randomUUID().toString()
        val body = JSONObject().put("engine", currentMode).put("request_id", requestId)
            .putOpt("model", preference(if (currentMode == "codex") "model" else "claudeModel"))
        if (currentMode == "codex") body.put("approval_policy", preference("approvalPolicy") ?: "on-request")
        io.execute {
            try {
                val thread = RemoteApi(endpoint, token).post("/api/v1/codex/threads", body)
                handler.post { refreshThreads(false); selectThread(thread); setSidebarVisible(false) }
            } catch (error: Exception) { handler.post { showStatus(error.message ?: "新建对话失败") } }
        }
    }

    private fun switchMode() {
        val previousMode = currentMode
        val targetMode = if (currentMode == "codex") "claude-code" else "codex"
        if (targetMode == "claude-code" && !claudeAvailable) {
            showToast(claudeStatusMessage)
            return
        }
        persistCurrentDraft()
        currentMode = targetMode
        prefs.edit().putString(KEY_MODE, currentMode).apply()
        val currentEngine = activeThread?.optString("engine", "codex") ?: ""
        if (currentEngine != currentMode) {
            activeThreadId = null
            activeThread = null
            queuedMessages = JSONArray()
            historyLoadingThreadId = null
            historyLoadError = null
            historySelectionGeneration += 1
            running = false
            renderMessages(false)
            renderQueue()
            renderHeader()
        }
        if (::composerInput.isInitialized) composerInput.setText(prefs.getString(draftStorageKey(), ""))
        renderSidebar(force = true)
        showModeSwitchNotice(previousMode, currentMode)
        showToast(if (currentMode == "codex") "Codex 对话" else "Claude Code 对话")
    }

    private fun showThreadActions(anchor: View, thread: JSONObject) {
        val actions = listOf(
            MenuAction("打开", "open"),
            MenuAction(if (pinnedThreadIds.contains(thread.optString("id"))) "取消置顶" else "置顶", "pin"),
            MenuAction("重命名", "edit"),
            MenuAction("删除聊天", "delete", destructive = true),
        )
        showActionPopup(anchor, threadTitle(thread), actions) { which ->
            when (which) {
                0 -> selectThread(thread)
                1 -> togglePin(thread)
                2 -> renameThread(thread)
                3 -> deleteThread(thread)
            }
        }
    }

    private fun renameThread(thread: JSONObject) {
        val input = editField("聊天名称", thread.optString("name").ifBlank { thread.optString("preview") }, InputType.TYPE_CLASS_TEXT).apply { setSingleLine(true) }
        showInputDialog("聊天名称", input, "保存") {
            val name = input.text.toString().trim()
            if (name.isBlank()) return@showInputDialog false
            runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/threads/${RemoteApi.encodePath(thread.optString("id"))}/name", JSONObject().put("name", name)) }, {
                refreshThreads(false)
                if (activeThreadId == thread.optString("id")) { activeThread?.put("name", name); renderHeader() }
            })
            true
        }
    }

    private fun togglePin(thread: JSONObject) {
        val id = thread.optString("id")
        val pinned = id in pinnedThreadIds
        runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/threads/${RemoteApi.encodePath(id)}/pin", JSONObject().put("pinned", !pinned)) }, {
            if (pinned) pinnedThreadIds.remove(id) else pinnedThreadIds.add(id)
            renderSidebar(force = true)
        })
    }

    private fun deleteThread(thread: JSONObject) {
        showConfirmDialog("删除聊天", "删除“${threadTitle(thread)}”？此操作无法撤销。", "删除", destructive = true) {
            val id = thread.optString("id")
            runApi({ RemoteApi(endpoint, token).delete("/api/v1/codex/threads/${RemoteApi.encodePath(id)}") }, {
                if (activeThreadId == id) {
                    prefs.edit().remove("$KEY_ACTIVE_THREAD_PREFIX$currentMode").apply()
                    activeThreadId = null
                    activeThread = null
                    historyLoadingThreadId = null
                    historyLoadError = null
                    historySelectionGeneration += 1
                    queuedMessages = JSONArray()
                    running = false
                    renderMessages(false)
                    renderQueue()
                    renderHeader()
                }
                syncRevisions.remove(id)
                refreshThreads(false)
            })
        }
    }

    private fun updateComposerPreferences() {
        if (!::modelButton.isInitialized) return
        val modelKey = if (currentMode == "codex") "model" else "claudeModel"
        val effortKey = if (currentMode == "codex") "effort" else "claudeEffort"
        val selectedModel = preference(modelKey)
        val modelLabel = if (currentMode == "codex") modelLabel(selectedModel) else claudeModelLabel(selectedModel)
        modelButton.text = modelLabel
        effortButton.text = effortLabel(preference(effortKey))
        permissionButton.text = when (currentMode) {
            "codex" -> approvalLabel(preference("approvalPolicy"))
            else -> claudePermissionLabel(preference("claudePermissionMode"))
        }
    }

    private fun preference(key: String): String? {
        val scope = activeThreadId?.let { "$PREF_THREAD_PREFIX$it" } ?: PREF_DEFAULT
        val value = prefs.getString("$scope:$key", null)
        return value?.takeIf { it.isNotBlank() && it != "null" }
    }

    private fun draftStorageKey(): String = "draft_${currentMode}_${activeThreadId ?: "new"}"

    private fun persistCurrentDraft() {
        if (::composerInput.isInitialized) prefs.edit().putString(draftStorageKey(), composerInput.text.toString()).apply()
    }

    private fun savePreference(key: String, value: String?) {
        val scope = activeThreadId?.let { "$PREF_THREAD_PREFIX$it" } ?: PREF_DEFAULT
        prefs.edit().putString("$scope:$key", value ?: "").apply()
        updateComposerPreferences()
    }

    private fun showModelOptions() {
        val values: List<Pair<String, String>> = if (currentMode == "codex") {
            (0 until models.length()).mapNotNull { index ->
                val model = models.optJSONObject(index) ?: return@mapNotNull null
                val value = model.optString("model").ifBlank { model.optString("id") }
                if (value.isBlank()) null else value to model.optString("displayName").ifBlank { value }
            }
        } else listOf("default" to "本机默认模型", "opus" to "Claude Opus", "sonnet" to "Claude Sonnet", "fable" to "Claude Fable")
        val choices = listOf("default" to "默认") + values
        showChoicePopup(modelButton, "模型", choices, preference(if (currentMode == "codex") "model" else "claudeModel") ?: "default") { selected ->
            savePreference(if (currentMode == "codex") "model" else "claudeModel", selected.takeIf { it != "default" })
            if (currentMode == "codex") savePreference("effort", modelDefaultEffort(selected))
        }
    }

    private fun showEffortOptions() {
        val choices = if (currentMode == "codex") {
            val selected = preference("model")
            val model = (0 until models.length()).mapNotNull { models.optJSONObject(it) }.firstOrNull {
                it.optString("model").ifBlank { it.optString("id") } == selected
            }
            val efforts = model?.optJSONArray("supportedReasoningEfforts")
            if (efforts != null && efforts.length() > 0) (0 until efforts.length()).mapNotNull { index ->
                val effort = efforts.optJSONObject(index)?.optString("reasoningEffort") ?: return@mapNotNull null
                effort to effortLabel(effort)
            } else listOf("minimal" to "最小", "low" to "低", "medium" to "中", "high" to "高", "xhigh" to "极高")
        } else listOf("default" to "本机默认", "low" to "低", "medium" to "中", "high" to "高", "xhigh" to "极高", "max" to "最大")
        val key = if (currentMode == "codex") "effort" else "claudeEffort"
        showChoicePopup(effortButton, "思考等级", listOf("default" to "默认") + choices, preference(key) ?: "default") { savePreference(key, it.takeIf { value -> value != "default" }) }
    }

    private fun showPermissionOptions() {
        if (currentMode == "codex") {
            showChoicePopup(permissionButton, "授权", listOf("on-request" to "请求批准", "untrusted" to "帮我批准", "never" to "完全访问"), preference("approvalPolicy") ?: "on-request") {
                savePreference("approvalPolicy", it)
                val threadId = activeThreadId
                if (threadId != null) runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/threads/${RemoteApi.encodePath(threadId)}/settings", JSONObject().put("approval_policy", it)) })
            }
        } else {
            showChoicePopup(permissionButton, "权限模式", listOf(
                "default" to "本机默认权限", "manual" to "手动确认", "acceptEdits" to "自动接受编辑",
                "auto" to "自动模式", "dontAsk" to "不询问（拒绝需授权操作）", "plan" to "计划模式",
            ), preference("claudePermissionMode") ?: "default") { savePreference("claudePermissionMode", it) }
        }
    }

    private fun showChoicePopup(anchor: View, title: String, choices: List<Pair<String, String>>, selected: String?, onChoice: (String) -> Unit) {
        preferencePopup?.dismiss()
        val anchorLocation = IntArray(2)
        val rootLocation = IntArray(2)
        anchor.getLocationOnScreen(anchorLocation)
        root.getLocationOnScreen(rootLocation)
        val availableAbove = anchorLocation[1] - rootLocation[1] - systemInsetTop - dp(11)
        val maxHeight = min(dp(244), availableAbove.coerceAtLeast(dp(118)))
        val menuHeight = min(dp(32) + choices.size * dp(32), maxHeight)
        val menu = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(5), dp(4), dp(5), dp(4))
            background = rounded(PANEL, dp(12), BORDER, dp(1))
        }
        menu.addView(label(title, 11, MUTED, true).apply {
            setPadding(dp(7), 0, dp(7), dp(3))
        }, LinearLayout.LayoutParams(MATCH, WRAP))
        val options = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        choices.forEach { (value, name) ->
            val isSelected = value == selected
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(8), dp(1), dp(8), dp(1))
                minimumHeight = dp(30)
                background = if (isSelected) rounded(PANEL_INSET, dp(7)) else ColorDrawable(Color.TRANSPARENT)
                isClickable = true
                isFocusable = false
                setOnClickListener {
                    preferencePopup?.dismiss()
                    onChoice(value)
                }
            }
            row.addView(label(name, 12, if (isSelected) TEXT else SUBTLE, isSelected).apply {
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
            }, LinearLayout.LayoutParams(0, WRAP, 1f))
            if (isSelected) row.addView(ImageView(this).apply {
                setImageResource(R.drawable.ic_check)
                imageTintList = ColorStateList.valueOf(ACCENT)
                contentDescription = "已选择"
            }, LinearLayout.LayoutParams(dp(16), dp(16)).apply { leftMargin = dp(6) })
            options.addView(row, LinearLayout.LayoutParams(MATCH, WRAP))
        }
        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            addView(options, FrameLayout.LayoutParams(MATCH, WRAP))
        }
        menu.addView(scroll, LinearLayout.LayoutParams(MATCH, 0, 1f))
        val popupWidth = min(dp(224), (root.width - dp(28)).coerceAtLeast(dp(190)))
        val popup = PopupWindow(menu, popupWidth, menuHeight, false).apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            elevation = dp(12).toFloat()
            isTouchable = true
            isOutsideTouchable = true
            isClippingEnabled = true
            inputMethodMode = PopupWindow.INPUT_METHOD_NOT_NEEDED
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
            setOnDismissListener { if (preferencePopup === this) preferencePopup = null }
        }
        preferencePopup = popup
        val x = (anchorLocation[0] - rootLocation[0])
            .coerceIn(dp(10), (root.width - popupWidth - dp(10)).coerceAtLeast(dp(10)))
        val anchorTop = anchorLocation[1] - rootLocation[1]
        val above = anchorTop - menuHeight - dp(5)
        val safeTop = systemInsetTop + dp(6)
        val y = above.coerceAtLeast(safeTop)
        popup.showAtLocation(root, Gravity.TOP or Gravity.START, x, y)
    }

    private data class MenuAction(val title: String, val icon: String, val destructive: Boolean = false)

    private fun showActionPopup(anchor: View, title: String, actions: List<MenuAction>, onChoice: (Int) -> Unit) {
        preferencePopup?.dismiss()
        val popupWidth = min(dp(244), (root.width - dp(20)).coerceAtLeast(dp(204)))
        val estimatedHeight = dp(36) + actions.size * dp(38) + dp(10)
        val menu = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(6), dp(5), dp(6), dp(5))
            background = rounded(PANEL, dp(12), BORDER, dp(1))
            addView(label(title, 11, MUTED, true).apply {
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(dp(9), dp(2), dp(9), dp(5))
            }, LinearLayout.LayoutParams(MATCH, dp(31)))
        }
        actions.forEachIndexed { index, action ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(9), 0, dp(9), 0)
                background = ColorDrawable(Color.TRANSPARENT)
                isClickable = true
                isFocusable = false
                contentDescription = action.title
                setOnClickListener {
                    preferencePopup?.dismiss()
                    onChoice(index)
                }
            }
            row.addView(ImageView(this).apply {
                setImageResource(iconResource(action.icon))
                imageTintList = ColorStateList.valueOf(if (action.destructive) ERROR else SUBTLE)
            }, LinearLayout.LayoutParams(dp(17), dp(17)).apply { rightMargin = dp(9) })
            row.addView(label(action.title, 12, if (action.destructive) ERROR else TEXT), LinearLayout.LayoutParams(0, WRAP, 1f))
            menu.addView(row, LinearLayout.LayoutParams(MATCH, dp(38)))
        }
        val popup = PopupWindow(menu, popupWidth, WRAP, true).apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            elevation = dp(12).toFloat()
            isOutsideTouchable = true
            isClippingEnabled = true
            setOnDismissListener { if (preferencePopup === this) preferencePopup = null }
        }
        preferencePopup = popup
        val anchorLocation = IntArray(2)
        val rootLocation = IntArray(2)
        anchor.getLocationOnScreen(anchorLocation)
        root.getLocationOnScreen(rootLocation)
        val x = (anchorLocation[0] - rootLocation[0] + anchor.width - popupWidth)
            .coerceIn(dp(10), (root.width - popupWidth - dp(10)).coerceAtLeast(dp(10)))
        val above = anchorLocation[1] - rootLocation[1] - estimatedHeight - dp(4)
        val below = anchorLocation[1] - rootLocation[1] + anchor.height + dp(4)
        val y = (if (above >= dp(8)) above else below)
            .coerceIn(dp(8), (root.height - estimatedHeight - dp(8)).coerceAtLeast(dp(8)))
        popup.showAtLocation(root, Gravity.TOP or Gravity.START, x, y)
    }

    private fun showInputDialog(title: String, input: EditText, positiveLabel: String, onPositive: () -> Boolean) {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(15), dp(18), dp(12))
            background = rounded(PANEL, dp(14), BORDER, dp(1))
        }
        card.addView(label(title, 15, TEXT, true), widthWrap())
        card.addView(input, LinearLayout.LayoutParams(MATCH, if (input.minLines > 1) dp(112) else dp(46)).apply { topMargin = dp(12) })
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END }
        actions.addView(dialogTextButton("取消", MUTED) { dialog.dismiss() }, LinearLayout.LayoutParams(WRAP, dp(38)))
        actions.addView(dialogTextButton(positiveLabel, ACCENT) {
            if (onPositive()) dialog.dismiss()
        }, LinearLayout.LayoutParams(WRAP, dp(38)).apply { leftMargin = dp(8) })
        card.addView(actions, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(8) })
        dialog.setContentView(card)
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout(min(dp(360), resources.displayMetrics.widthPixels - dp(28)), WRAP)
            setGravity(Gravity.CENTER)
        }
        input.requestFocus()
    }

    private fun showConfirmDialog(title: String, message: String, confirmLabel: String, destructive: Boolean = false, onConfirm: () -> Unit) {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(15), dp(18), dp(12))
            background = rounded(PANEL, dp(14), BORDER, dp(1))
        }
        card.addView(label(title, 15, TEXT, true), widthWrap())
        card.addView(label(message, 12, SUBTLE).apply {
            setPadding(0, dp(7), 0, dp(3))
            setLineSpacing(dp(2).toFloat(), 1.08f)
        }, widthWrap())
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END }
        actions.addView(dialogTextButton("取消", MUTED) { dialog.dismiss() }, LinearLayout.LayoutParams(WRAP, dp(38)))
        actions.addView(dialogTextButton(confirmLabel, if (destructive) ERROR else ACCENT) {
            dialog.dismiss()
            onConfirm()
        }, LinearLayout.LayoutParams(WRAP, dp(38)).apply { leftMargin = dp(8) })
        card.addView(actions, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(7) })
        dialog.setContentView(card)
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout(min(dp(360), resources.displayMetrics.widthPixels - dp(28)), WRAP)
            setGravity(Gravity.CENTER)
        }
    }

    private fun modelDefaultEffort(modelName: String): String? {
        val model = (0 until models.length()).mapNotNull { models.optJSONObject(it) }.firstOrNull {
            it.optString("model").ifBlank { it.optString("id") } == modelName
        } ?: return null
        return model.optString("defaultReasoningEffort").takeIf { it.isNotBlank() && it != "null" }
    }

    private fun showSettings() {
        if (settingsOverlay != null) return
        if (sidebarVisible) setSidebarVisible(false)

        val overlay = FrameLayout(this).apply {
            setBackgroundColor(DARK)
            elevation = dp(16).toFloat()
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(DARK)
            tag = TAG_INSET_CONTENT
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(4), dp(14), dp(4))
        }
        header.addView(iconButton("back", "返回聊天") { closeSettings() }, LinearLayout.LayoutParams(dp(40), dp(40)))
        val titleCopy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(8), 0, 0, 0) }
        titleCopy.addView(label("设置", 17, TEXT, true), widthWrap())
        titleCopy.addView(label("偏好保存在本机", 10, MUTED), widthWrap())
        header.addView(titleCopy, LinearLayout.LayoutParams(0, WRAP, 1f))
        layout.addView(header, LinearLayout.LayoutParams(MATCH, dp(56)))

        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            clipToPadding = false
            setPadding(dp(14), dp(5), dp(14), dp(18))
        }
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(content, LinearLayout.LayoutParams(MATCH, WRAP))
        layout.addView(scroll, LinearLayout.LayoutParams(MATCH, 0, 1f))
        overlay.addView(layout, FrameLayout.LayoutParams(MATCH, MATCH))
        root.addView(overlay, FrameLayout.LayoutParams(MATCH, MATCH))
        settingsOverlay = overlay
        updateInsetAwareOverlays()

        fun section(title: String, description: String): LinearLayout {
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(13), dp(14), dp(12))
                background = rounded(PANEL, dp(14), BORDER, dp(1))
            }
            card.addView(label(title, 14, TEXT, true), widthWrap())
            card.addView(label(description, 11, MUTED).apply {
                setPadding(0, dp(4), 0, dp(10))
                setLineSpacing(dp(1).toFloat(), 1.1f)
            }, widthWrap())
            content.addView(card, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(10) })
            return card
        }

        val appearance = section("主题", "选择工作区色彩；自定义主题支持背景图片与颜色。")
        listOf(
            Triple("light", "白色", "清爽明亮"),
            Triple("dark", "黑色", "低光阅读"),
            Triple("warm", "暖色", "柔和纸感"),
            Triple("custom", "自定义主题", "颜色、图片与透明度"),
        ).forEach { (theme, title, description) ->
            val selected = themeName == theme
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(11), dp(8), dp(11), dp(8))
                background = rounded(if (selected) PANEL_INSET else Color.TRANSPARENT, dp(10))
                isClickable = true
                isFocusable = false
                setOnClickListener { applyThemeFromSettings(theme) }
            }
            val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            copy.addView(label(title, 13, TEXT, selected), widthWrap())
            copy.addView(label(description, 10, MUTED), widthWrap())
            row.addView(copy, LinearLayout.LayoutParams(0, WRAP, 1f))
            row.addView(ImageView(this).apply {
                setImageResource(R.drawable.ic_check)
                imageTintList = ColorStateList.valueOf(ACCENT)
                visibility = if (selected) View.VISIBLE else View.INVISIBLE
                contentDescription = if (selected) "已选择" else null
            }, LinearLayout.LayoutParams(dp(18), dp(18)).apply { leftMargin = dp(8); rightMargin = dp(4) })
            appearance.addView(row, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(4) })
        }

        if (themeName == "custom") {
            appearance.addView(settingsActionRow("背景颜色", prefs.getString(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND).orEmpty()) {
                showThemeColorDialog("背景颜色", KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND)
            }, widthWrap())
            appearance.addView(settingsActionRow("字体颜色", prefs.getString(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT).orEmpty()) {
                showThemeColorDialog("字体颜色", KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT)
            }, widthWrap())
            val selectedImage = prefs.getString(KEY_CUSTOM_BACKGROUND_IMAGE, null)
            appearance.addView(settingsActionRow("背景图片", if (selectedImage.isNullOrBlank()) "选择图片" else "更换或清除当前图片") {
                chooseThemeBackground()
            }, widthWrap())
            if (!selectedImage.isNullOrBlank()) appearance.addView(settingsActionRow("清除背景图片", "保留自定义颜色") {
                prefs.edit().remove(KEY_CUSTOM_BACKGROUND_IMAGE).apply()
                rerenderAppKeepSettings()
            }, widthWrap())
            val transparencyRow = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(2), dp(7), dp(2), 0) }
            val transparencyHeader = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            transparencyHeader.addView(label("背景透明度", 12, SUBTLE), LinearLayout.LayoutParams(0, WRAP, 1f))
            val transparencyValue = prefs.getInt(KEY_BACKGROUND_TRANSPARENCY, 0).coerceIn(0, 100)
            val transparencyLabel = label("$transparencyValue%", 12, ACCENT, true)
            transparencyHeader.addView(transparencyLabel, widthWrap())
            transparencyRow.addView(transparencyHeader, widthWrap())
            transparencyRow.addView(label("数值越高，背景图片和底色越透明。", 10, MUTED), widthWrap())
            val transparencySeek = SeekBar(this).apply {
                max = 100
                progress = transparencyValue
                progressTintList = ColorStateList.valueOf(ACCENT)
                thumbTintList = ColorStateList.valueOf(ACCENT)
                progressBackgroundTintList = ColorStateList.valueOf(BORDER)
                contentDescription = "背景透明度"
            }
            transparencySeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar, progress: Int, fromUser: Boolean) { transparencyLabel.text = "$progress%" }
                override fun onStartTrackingTouch(seekBar: SeekBar) = Unit
                override fun onStopTrackingTouch(seekBar: SeekBar) {
                    prefs.edit().putInt(KEY_BACKGROUND_TRANSPARENCY, seekBar.progress).apply()
                    rerenderAppKeepSettings()
                }
            })
            transparencyRow.addView(transparencySeek, LinearLayout.LayoutParams(MATCH, dp(38)))
            appearance.addView(transparencyRow, widthWrap())
        }

        val display = section("显示", "字体大小会同时影响聊天、输入框、侧栏、文件区和设置页面。")
        val sizeRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val currentFontAdjustment = globalFontAdjustment()
        val sizeLabel = label(if (currentFontAdjustment == 0) "标准" else "${if (currentFontAdjustment > 0) "+" else ""}${currentFontAdjustment} px", 13, ACCENT, true)
        sizeRow.addView(label("全局字体", 12, SUBTLE), LinearLayout.LayoutParams(0, WRAP, 1f))
        sizeRow.addView(sizeLabel, LinearLayout.LayoutParams(WRAP, WRAP))
        display.addView(sizeRow, widthWrap())
        val fontSeek = SeekBar(this).apply {
            max = 9
            progress = currentFontAdjustment + 3
            progressTintList = ColorStateList.valueOf(ACCENT)
            thumbTintList = ColorStateList.valueOf(ACCENT)
            progressBackgroundTintList = ColorStateList.valueOf(BORDER)
            contentDescription = "全局字体大小"
        }
        fontSeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar, progress: Int, fromUser: Boolean) {
                val adjustment = progress - 3
                sizeLabel.text = if (adjustment == 0) "标准" else "${if (adjustment > 0) "+" else ""}${adjustment} px"
                if (fromUser) {
                    previewFontAdjustment = adjustment
                    applyGlobalFontAdjustment(root)
                }
            }
            override fun onStartTrackingTouch(seekBar: SeekBar) = Unit
            override fun onStopTrackingTouch(seekBar: SeekBar) {
                val adjustment = seekBar.progress - 3
                prefs.edit().putInt(KEY_GLOBAL_FONT_ADJUSTMENT, adjustment).apply()
                previewFontAdjustment = null
                applyGlobalFontAdjustment(root)
            }
        })
        display.addView(fontSeek, LinearLayout.LayoutParams(MATCH, dp(56)).apply {
            topMargin = dp(2)
            fontSeek.setPadding(0, dp(10), 0, dp(10))
        })

        val notifications = section("系统通知", "应用在后台时提醒回复完成；通知不包含聊天正文。")
        val notificationRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(2), dp(2), dp(2), dp(2))
            isClickable = true
            isFocusable = false
            setOnClickListener { toggleSystemNotifications() }
        }
        notificationRow.addView(label("回复与审批提醒", 12, SUBTLE), LinearLayout.LayoutParams(0, WRAP, 1f))
        settingsNotificationButton = label("", 12, ACCENT, true).apply { gravity = Gravity.CENTER; minWidth = dp(72) }
        notificationRow.addView(settingsNotificationButton, LinearLayout.LayoutParams(dp(72), WRAP))
        notifications.addView(notificationRow, LinearLayout.LayoutParams(MATCH, dp(40)))
        refreshSettingsNotificationControl()

        val connection = section("连接", "连接到运行 Codex Remote 的电脑。")
        connection.addView(label(if (runtime.optBoolean("connected", false)) "电脑服务已连接" else "电脑服务等待连接", 12, if (runtime.optBoolean("connected", false)) ACCENT else MUTED, true), widthWrap())
        connection.addView(label(endpoint, 11, MUTED).apply {
            setPadding(0, dp(5), 0, dp(7))
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
            setTextIsSelectable(true)
        }, widthWrap())
        connection.addView(settingsActionRow("更改电脑地址", "输入新地址和电脑端匹配码") {
            showChangeConnectionDialog()
        }, widthWrap())

        val account = section("本机配对", "管理本机保存的电脑连接凭据。")
        account.addView(settingsActionRow("解除配对", "清除此设备保存的配对信息") {
            showConfirmDialog("解除配对", "清除此设备保存的电脑连接信息？", "解除", destructive = true) {
                runApi({ RemoteApi(endpoint, token).post("/api/v1/unpair") }, {
                    closeSettings()
                    prefs.edit().remove(KEY_TOKEN).apply()
                    token = ""
                    socket?.close(1000, "unpaired")
                    showConnectionPage()
                })
            }
        }, widthWrap())
    }

    private fun closeSettings() {
        val overlay = settingsOverlay ?: return
        if (::root.isInitialized) root.removeView(overlay)
        settingsOverlay = null
        settingsNotificationButton = null
    }

    private fun settingsActionRow(title: String, description: String, action: () -> Unit): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(2), dp(7), dp(2), dp(7))
        isClickable = true
        isFocusable = false
        setOnClickListener { action() }
        val copy = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
        copy.addView(label(title, 12, SUBTLE, true), widthWrap())
        copy.addView(label(description, 10, MUTED), widthWrap())
        addView(copy, LinearLayout.LayoutParams(0, WRAP, 1f))
        addView(ImageView(this@MainActivity).apply {
            setImageResource(R.drawable.ic_chevron_right)
            imageTintList = ColorStateList.valueOf(MUTED)
        }, LinearLayout.LayoutParams(dp(18), dp(18)).apply { leftMargin = dp(6) })
    }

    private fun applyThemeFromSettings(theme: String) {
        if (themeName == theme) return
        prefs.edit().putString(KEY_THEME, theme).putBoolean(KEY_LIGHT_THEME, theme != "dark").apply()
        rerenderAppKeepSettings()
    }

    private fun showThemeColorDialog(title: String, key: String, fallback: String) {
        val current = prefs.getString(key, fallback) ?: fallback
        val input = editField("#RRGGBB", current, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS).apply {
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_DONE
        }
        showInputDialog(title, input, "应用") {
            val value = input.text.toString().trim()
            if (!Regex("^#[0-9a-fA-F]{6}$").matches(value)) {
                showToast("请输入 #RRGGBB 格式的颜色")
                return@showInputDialog false
            }
            prefs.edit().putString(key, value.uppercase(Locale.ROOT)).apply()
            rerenderAppKeepSettings()
            true
        }
    }

    private fun chooseThemeBackground() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "image/*"
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        themeBackgroundPickerActive = true
        try {
            startActivityForResult(intent, REQUEST_THEME_BACKGROUND)
        } catch (_: Exception) {
            themeBackgroundPickerActive = false
            showToast("没有可用的图片选择器")
        }
    }

    private fun rerenderAppKeepSettings() {
        val reopenSettings = settingsOverlay != null
        val draft = if (::composerInput.isInitialized) composerInput.text.toString() else ""
        if (::composerInput.isInitialized) persistCurrentDraft()
        if (reopenSettings) closeSettings()
        preferencePopup?.dismiss()
        sidebarAnimator?.cancel()
        sidebarVisible = false
        sidebarProgress = 0f
        sidebarRenderDirty = true
        closeTerminal()
        sidebarHost = null
        workspaceHost = null
        workspaceOverlay?.visibility = View.GONE
        workspaceOverlay = null
        workspacePanel = null
        workspaceScrim = null
        workspaceLoader = null
        workspaceLoadedPath = null
        workspaceLoadingPath = null
        workspaceGestureActive = false
        workspacePendingRender = null
        window.decorView.systemUiVisibility = if (lightTheme) {
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        } else 0
        renderHome()
        composerInput.setText(draft)
        if (reopenSettings) showSettings()
    }

    private fun refreshSettingsNotificationControl() {
        settingsNotificationButton?.apply {
            text = if (prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)) "已开启" else "已关闭"
            setTextColor(if (prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)) ACCENT else MUTED)
        }
    }

    private fun toggleSystemNotifications() {
        val enabled = prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)
        if (enabled) {
            prefs.edit().putBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false).apply()
            refreshSettingsNotificationControl()
            showToast("系统通知已关闭")
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermissionRequestedFromSettings = true
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
            return
        }
        prefs.edit().putBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false).apply()
        refreshSettingsNotificationControl()
        showToast("系统通知已开启")
    }

    private fun showChangeConnectionDialog() {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(11), 0, 0)
        }
        val address = editField("电脑网页地址", endpoint, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI).apply { setSingleLine(true) }
        val code = editField("电脑终端显示的匹配码", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD).apply { setSingleLine(true) }
        form.addView(label("电脑网页地址", 11, SUBTLE, true), widthWrap())
        form.addView(address, LinearLayout.LayoutParams(MATCH, dp(48)).apply { topMargin = dp(4); bottomMargin = dp(12) })
        form.addView(label("匹配码", 11, SUBTLE, true), widthWrap())
        form.addView(code, LinearLayout.LayoutParams(MATCH, dp(48)).apply { topMargin = dp(4) })
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(15), dp(18), dp(12))
            background = rounded(PANEL, dp(14), BORDER, dp(1))
        }
        card.addView(label("更改电脑地址", 15, TEXT, true), widthWrap())
        card.addView(form, LinearLayout.LayoutParams(MATCH, WRAP))
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END }
        actions.addView(dialogTextButton("取消", MUTED) { dialog.dismiss() }, LinearLayout.LayoutParams(WRAP, dp(38)))
        val connectButton = dialogTextButton("连接", ACCENT) { }
        actions.addView(connectButton, LinearLayout.LayoutParams(WRAP, dp(38)).apply { leftMargin = dp(8) })
        card.addView(actions, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(8) })
        dialog.setContentView(card)
        settingsDialog = dialog
        dialog.setOnDismissListener { if (settingsDialog === dialog) settingsDialog = null }
        connectButton.setOnClickListener {
                val normalized = try { RemoteApi.normalizeEndpoint(address.text.toString()) }
                catch (error: Exception) { showToast(error.message ?: "电脑地址无效"); return@setOnClickListener }
                val pairingCode = code.text.toString().trim()
                if (pairingCode.isBlank()) { showToast("请输入电脑端匹配码"); return@setOnClickListener }
                connectButton.isEnabled = false
                connectButton.text = "正在连接…"
                io.execute {
                    try {
                        val paired = RemoteApi(normalized).post("/api/v1/pair", JSONObject().put("code", pairingCode))
                        val newToken = paired.getString("token")
                        handler.post {
                            dialog.dismiss()
                            endpoint = normalized
                            token = newToken
                            prefs.edit().putString(KEY_ENDPOINT, endpoint).putString(KEY_TOKEN, token).apply()
                            closeSettings()
                            openChatHome()
                        }
                    } catch (error: Exception) {
                        handler.post {
                            connectButton.isEnabled = true
                            connectButton.text = "连接"
                            showToast(error.message ?: "连接失败，请检查地址和匹配码")
                        }
                    }
                }
        }
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout(min(dp(380), resources.displayMetrics.widthPixels - dp(28)), WRAP)
            setGravity(Gravity.CENTER)
        }
    }

    private fun reconnect() {
        val codeInput = editField("输入电脑终端显示的匹配码", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD).apply { setSingleLine(true) }
        showInputDialog("重新配对", codeInput, "连接") {
            val code = codeInput.text.toString().trim()
            if (code.isBlank()) return@showInputDialog false
            runApi({ RemoteApi(endpoint).post("/api/v1/pair", JSONObject().put("code", code)).getString("token") }, { newToken ->
                token = newToken
                prefs.edit().putString(KEY_TOKEN, newToken).apply()
                openChatHome()
            })
            true
        }
    }

    private fun showWorkspaceBrowser() {
        if (token.isBlank()) return
        ensureWorkspaceBrowser()
        workspaceLoader?.invoke(workspaceCurrentPath)
        setWorkspaceVisible(true)
    }

    private fun ensureWorkspaceBrowser() {
        if (workspaceOverlay != null) return
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        val host = createEdgeDrawer(panel, Gravity.END) { setWorkspaceVisible(false) }
        val overlay = host.overlay
        val scrim = host.scrim

        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val pathTitle = label("文件", 14, TEXT, true).apply {
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        }
        header.addView(pathTitle, LinearLayout.LayoutParams(0, dp(35), 1f))
        val refreshButton = iconButton("refresh", "刷新文件树") { workspaceRefresher?.invoke(workspaceCurrentPath) }
        header.addView(refreshButton, LinearLayout.LayoutParams(dp(32), dp(32)))
        val createButton = iconButton("add", "新建文件或文件夹") { }
        createButton.setOnClickListener { showCreateEntry(createButton, workspaceCurrentPath) { workspaceRefresher?.invoke(workspaceCurrentPath) } }
        header.addView(createButton, LinearLayout.LayoutParams(dp(32), dp(32)))
        header.addView(iconButton("close", "关闭文件树") { setWorkspaceVisible(false) }, LinearLayout.LayoutParams(dp(32), dp(32)))
        panel.addView(header, widthWrap())

        val pathNavigation = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val parentButton = iconButton("back", "返回上级目录") { handleWorkspaceBack() }
        pathNavigation.addView(parentButton, LinearLayout.LayoutParams(dp(32), dp(32)))
        val pathInput = editField("输入路径", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS).apply {
            setSingleLine(true)
            textSize = adjustedTextSize(11)
            setTag(R.id.base_text_size, 11f)
            imeOptions = EditorInfo.IME_ACTION_GO
            setPadding(dp(8), 0, dp(7), 0)
            setOnEditorActionListener { _, action, _ ->
                if (action == EditorInfo.IME_ACTION_GO) { workspacePathNavigate?.invoke(text.toString()); true } else false
            }
        }
        pathNavigation.addView(pathInput, LinearLayout.LayoutParams(0, dp(34), 1f).apply { rightMargin = dp(2) })
        pathNavigation.addView(iconButton("open", "跳转到输入路径") {
            (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(pathInput.windowToken, 0)
            workspacePathNavigate?.invoke(pathInput.text.toString())
        }, LinearLayout.LayoutParams(dp(32), dp(32)))
        panel.addView(pathNavigation, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(2) })
        workspacePathInput = pathInput

        val entries = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            addView(entries)
        }
        panel.addView(scroll, LinearLayout.LayoutParams(MATCH, 0, 1f).apply { topMargin = dp(3); bottomMargin = dp(3) })
        val footer = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        footer.addView(label("点按文件夹展开 · 长按查看更多操作", 10, MUTED), LinearLayout.LayoutParams(0, WRAP, 1f))
        footer.addView(smallButton("粘贴") { pasteWorkspaceEntries(workspaceCurrentPath) { workspaceRefresher?.invoke(workspaceCurrentPath) } })
        panel.addView(footer, widthWrap())

        workspaceOverlay = overlay
        workspacePanel = panel
        workspaceScrim = scrim
        workspaceHost = host
        updateInsetAwareOverlays()

        val directoryChildren = linkedMapOf<String, JSONArray>()
        val directoryTruncated = mutableSetOf<String>()
        val directoryErrors = mutableMapOf<String, String>()
        val loadingDirectories = mutableSetOf<String>()
        val expandedDirectories = linkedSetOf<String>()
        var loadedWorkspaceKey: String? = null
        lateinit var renderTree: () -> Unit
        lateinit var loadDirectory: (String, Boolean) -> Unit
        lateinit var addDirectoryRows: (String, Int) -> Unit

        fun currentCwd(): String? = activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" }
        fun workspaceKey(): String = currentCwd() ?: runtime.optString("workspace", "<default>")
        fun parentPath(value: String): String = value.trim('/').substringBeforeLast('/', "")
        fun dispatchRender() {
            if (workspaceGestureActive || workspaceAnimator?.isRunning == true) workspacePendingRender = renderTree
            else renderTree()
        }
        fun absolutePath(relativePath: String): String = listOf(workspaceRootPath.trimEnd('/'), relativePath.trimStart('/'))
            .filter { it.isNotBlank() }.joinToString("/")
        fun navigateToDirectory(rawPath: String) {
            val input = rawPath.trim().replace('\\', '/')
            val rootPath = workspaceRootPath.replace('\\', '/').trimEnd('/')
            val windowsPath = Regex("^[a-zA-Z]:/").containsMatchIn(rootPath)
            fun samePath(left: String, right: String): Boolean = if (windowsPath) left.equals(right, ignoreCase = true) else left == right
            val relative = when {
                input.isBlank() -> ""
                rootPath.isNotBlank() && samePath(input.trimEnd('/'), rootPath) -> ""
                rootPath.isNotBlank() && (if (windowsPath) input.startsWith("$rootPath/", ignoreCase = true) else input.startsWith("$rootPath/")) -> input.substring(rootPath.length + 1)
                input.startsWith('/') || Regex("^[a-zA-Z]:/").containsMatchIn(input) -> {
                    showToast("路径必须位于当前工作目录内")
                    return
                }
                else -> input.trim('/')
            }
            val segments = relative.split('/').filter { it.isNotBlank() }
            if (segments.any { it == "." || it == ".." }) {
                showToast("路径不能越出当前工作目录")
                return
            }
            workspaceCurrentPath = segments.joinToString("/")
            workspacePathInput?.setText(absolutePath(workspaceCurrentPath))
            if (directoryChildren.containsKey(workspaceCurrentPath)) dispatchRender()
            else loadDirectory(workspaceCurrentPath, false)
        }
        workspacePathNavigate = ::navigateToDirectory

        addDirectoryRows = addRows@{ directoryPath, depth ->
            val children = directoryChildren[directoryPath] ?: return@addRows
            for (index in 0 until children.length()) {
                val entry = children.optJSONObject(index) ?: continue
                val isDirectory = entry.optString("kind") == "directory"
                val relativePath = entry.optString("path")
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(3 + depth * 15), dp(4), dp(2), dp(4))
                    background = rounded(Color.TRANSPARENT, dp(7))
                }
                if (isDirectory) {
                    row.addView(ImageView(this).apply {
                        setImageResource(if (relativePath in expandedDirectories) R.drawable.ic_chevron_down else R.drawable.ic_chevron_right)
                        imageTintList = ColorStateList.valueOf(MUTED)
                        contentDescription = if (relativePath in expandedDirectories) "已展开" else "已收起"
                    }, LinearLayout.LayoutParams(dp(14), dp(14)).apply { rightMargin = dp(3) })
                } else {
                    row.addView(View(this), LinearLayout.LayoutParams(dp(17), dp(1)))
                }
                row.addView(ImageView(this).apply {
                    setImageResource(if (isDirectory) R.drawable.ic_folder else fileIconResource(entry.optString("name")))
                    imageTintList = if (isDirectory) ColorStateList.valueOf(ACCENT) else null
                    contentDescription = if (isDirectory) "文件夹" else fileGlyph(entry.optString("name"))
                }, LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(7) })
                row.addView(label(entry.optString("name"), 13, TEXT).apply {
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                }, LinearLayout.LayoutParams(0, WRAP, 1f))
                if (!isDirectory) row.addView(
                    label(formatFileSize(entry.optLong("size")), 9, MUTED),
                    LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = dp(4) },
                )
                val fullPath = absolutePath(relativePath)
                if (fullPath.isNotBlank() && !composerInput.text.toString().contains(fullPath)) {
                    row.addView(iconButton("add", "加入输入框 ${entry.optString("name")}") {
                        insertWorkspacePathIntoComposer(fullPath)
                    }, LinearLayout.LayoutParams(dp(28), dp(28)).apply { leftMargin = dp(2) })
                }
                row.setOnClickListener {
                    if (isDirectory) {
                        if (relativePath in expandedDirectories) {
                            expandedDirectories.remove(relativePath)
                            dispatchRender()
                        } else {
                            expandedDirectories.add(relativePath)
                            if (directoryChildren.containsKey(relativePath)) dispatchRender()
                            else loadDirectory(relativePath, false)
                        }
                    } else showFilePreview(relativePath, currentCwd())
                }
                row.setOnLongClickListener {
                    showWorkspaceEntryActions(row, entry, currentCwd()) { changedDirectory ->
                        loadDirectory(changedDirectory, true)
                    }
                    true
                }
                entries.addView(row, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(1) })

                if (!isDirectory || relativePath !in expandedDirectories) continue
                when {
                    relativePath in loadingDirectories && !directoryChildren.containsKey(relativePath) -> entries.addView(
                        label("正在读取…", 10, MUTED).apply { setPadding(dp(38 + (depth + 1) * 15), dp(6), dp(6), dp(6)) },
                        widthWrap(),
                    )
                    directoryErrors.containsKey(relativePath) -> entries.addView(
                        label("读取失败，点此重试", 10, ERROR).apply {
                            setPadding(dp(38 + (depth + 1) * 15), dp(6), dp(6), dp(6))
                            setOnClickListener { loadDirectory(relativePath, true) }
                        },
                        widthWrap(),
                    )
                    directoryChildren[relativePath]?.length() == 0 -> entries.addView(
                        label("空文件夹", 10, MUTED).apply { setPadding(dp(38 + (depth + 1) * 15), dp(5), dp(6), dp(5)) },
                        widthWrap(),
                    )
                    else -> addDirectoryRows(relativePath, depth + 1)
                }
                if (relativePath in directoryTruncated) entries.addView(
                    label("目录内容较多，仅显示前 400 项", 9, MUTED).apply { setPadding(dp(38 + (depth + 1) * 15), dp(4), dp(6), dp(5)) },
                    widthWrap(),
                )
            }
        }

        renderTree = render@{
            if (workspaceOverlay !== overlay) return@render
            val previousScrollY = scroll.scrollY
            val currentPath = workspaceCurrentPath
            pathTitle.text = workspaceRootPath.ifBlank { currentCwd() ?: runtime.optString("workspace", "工作区") }
            if (currentPath.isNotBlank()) pathTitle.text = "$currentPath · ${pathTitle.text}"
            if (!pathInput.hasFocus()) pathInput.setText(absolutePath(currentPath))
            parentButton.isEnabled = currentPath.isNotBlank()
            parentButton.alpha = if (parentButton.isEnabled) 1f else .45f
            entries.removeAllViews()
            when {
                currentPath in loadingDirectories && !directoryChildren.containsKey(currentPath) -> entries.addView(
                    label("正在读取…", 12, MUTED).apply { setPadding(dp(8), dp(12), dp(8), dp(12)) }, widthWrap(),
                )
                directoryErrors.containsKey(currentPath) -> entries.addView(
                    label("${directoryErrors[currentPath]}\n点此重新加载", 12, ERROR).apply {
                        setPadding(dp(8), dp(12), dp(8), dp(12))
                        setOnClickListener { loadDirectory(currentPath, true) }
                    }, widthWrap(),
                )
                directoryChildren[currentPath]?.length() == 0 -> entries.addView(
                    label("空文件夹", 12, MUTED).apply { setPadding(dp(8), dp(12), dp(8), dp(12)) }, widthWrap(),
                )
                else -> addDirectoryRows(currentPath, 0)
            }
            if (currentPath in directoryTruncated) entries.addView(
                label("目录内容较多，仅显示前 400 项", 10, MUTED).apply { setPadding(dp(8), dp(8), dp(8), dp(8)) }, widthWrap(),
            )
            scroll.post { scroll.scrollTo(0, previousScrollY.coerceAtMost((entries.height - scroll.height).coerceAtLeast(0))) }
        }

        loadDirectory = load@{ requestedPath, force ->
            val resetTree = requestedPath == "*"
            val path = if (resetTree) "" else requestedPath.trim('/')
            val requestWorkspaceKey = workspaceKey()
            if (resetTree || loadedWorkspaceKey != requestWorkspaceKey) {
                loadedWorkspaceKey = requestWorkspaceKey
                directoryChildren.clear()
                directoryTruncated.clear()
                directoryErrors.clear()
                loadingDirectories.clear()
                expandedDirectories.clear()
                workspaceRootPath = ""
                workspaceCurrentPath = ""
                workspaceLoadedPath = null
            }
            if (!force && (directoryChildren.containsKey(path) || path in loadingDirectories)) {
                dispatchRender()
                return@load
            }
            loadingDirectories.add(path)
            directoryErrors.remove(path)
            workspaceLoadingPath = path
            dispatchRender()
            val cwd = currentCwd()
            val query = buildString {
                append("?path=${Uri.encode(path)}")
                if (!cwd.isNullOrBlank()) append("&cwd=${Uri.encode(cwd)}")
            }
            io.execute {
                try {
                    val tree = RemoteApi(endpoint, token).get("/api/v1/codex/workspace/tree$query")
                    handler.post {
                        if (workspaceOverlay !== overlay || loadedWorkspaceKey != requestWorkspaceKey || workspaceKey() != requestWorkspaceKey) return@post
                        directoryChildren[path] = tree.optJSONArray("entries") ?: JSONArray()
                        if (tree.optBoolean("truncated", false)) directoryTruncated.add(path) else directoryTruncated.remove(path)
                        directoryErrors.remove(path)
                        loadingDirectories.remove(path)
                        workspaceLoadingPath = null
                        workspaceRootPath = tree.optString("cwd").ifBlank { workspaceRootPath }
                        if (path == workspaceCurrentPath) workspaceLoadedPath = path
                        dispatchRender()
                    }
                } catch (error: Exception) {
                    handler.post {
                        if (workspaceOverlay !== overlay || loadedWorkspaceKey != requestWorkspaceKey) return@post
                        directoryErrors[path] = error.message ?: "无法读取文件目录"
                        loadingDirectories.remove(path)
                        workspaceLoadingPath = null
                        dispatchRender()
                    }
                }
            }
        }
        workspaceLoader = { path -> loadDirectory(path, false) }
        workspaceRefresher = { path -> loadDirectory(path, true) }
        updateWorkspaceProgress(workspaceProgress)
    }

    private fun prepareWorkspaceForGesture() {
        val needsInitialLoad = workspaceLoadedPath != workspaceCurrentPath && workspaceLoadingPath != workspaceCurrentPath
        if (sidebarVisible) {
            sidebarAnimator?.cancel()
            sidebarAnimator = null
            sidebarVisible = false
            updateSidebarProgress(0f)
            sidebarHost?.overlay?.visibility = View.GONE
        }
        ensureWorkspaceBrowser()
        workspaceVisible = true
        workspaceOverlay?.visibility = View.VISIBLE
        if (needsInitialLoad) {
            workspaceOverlay?.postDelayed({
                if (workspaceVisible && workspaceLoadedPath != workspaceCurrentPath && workspaceLoadingPath != workspaceCurrentPath) {
                    workspaceLoader?.invoke(workspaceCurrentPath)
                }
            }, 220L)
        }
        updateWorkspaceProgress(workspaceProgress)
    }

    private fun setWorkspaceVisible(visible: Boolean) {
        val host = workspaceHost ?: if (visible) {
            ensureWorkspaceBrowser()
            workspaceHost ?: return
        } else return
        if (visible) {
            if (sidebarVisible) setSidebarVisible(false)
            host.overlay.visibility = View.VISIBLE
        }
        workspaceVisible = visible
        workspaceAnimator?.removeAllListeners()
        workspaceAnimator?.cancel()
        val start = workspaceProgress
        val target = if (visible) 1f else 0f
        if (start == target) {
            updateWorkspaceProgress(target)
            if (!visible) host.overlay.visibility = View.GONE
            finishWorkspaceMotion()
            return
        }
        workspaceAnimator = edgeDrawerAnimator(host, start, target, { workspaceVisible }, ::updateWorkspaceProgress) {
            workspaceAnimator = null
            finishWorkspaceMotion()
        }.also { it.start() }
    }

    private fun updateWorkspaceProgress(progress: Float) {
        workspaceProgress = progress.coerceIn(0f, 1f)
        val host = workspaceHost ?: return
        applyEdgeDrawerProgress(host, workspaceProgress, workspaceVisible)
    }

    private fun finishWorkspaceMotion() {
        workspaceGestureActive = false
        val pending = workspacePendingRender
        workspacePendingRender = null
        pending?.invoke()
        flushDeferredMessageRender()
    }

    private fun flushDeferredMessageRender() {
        if (!messageRenderDeferred) return
        if (sidebarVisible || workspaceVisible || sidebarGestureActive || workspaceGestureActive || sidebarAnimator?.isRunning == true || workspaceAnimator?.isRunning == true) return
        val scrollToEnd = deferredMessageScrollToEnd
        val incrementalTurnId = deferredMessageTurnIds.singleOrNull().takeUnless { deferredMessageRequiresFullRender }
        messageRenderDeferred = false
        deferredMessageScrollToEnd = false
        deferredMessageRequiresFullRender = false
        deferredMessageTurnIds.clear()
        handler.post { renderMessages(scrollToEnd, incrementalTurnId) }
    }

    private fun handleWorkspaceBack(): Boolean {
        if (!workspaceVisible) return false
        if (workspaceCurrentPath.isNotBlank()) {
            workspaceCurrentPath = workspaceCurrentPath.trimEnd('/').substringBeforeLast('/', "")
            val absolutePath = listOf(workspaceRootPath.trimEnd('/'), workspaceCurrentPath.trimStart('/'))
                .filter { it.isNotBlank() }.joinToString("/")
            workspacePathInput?.setText(absolutePath)
            workspacePathNavigate?.invoke(absolutePath)
            return true
        }
        setWorkspaceVisible(false)
        return true
    }

    private fun refreshDirectory() { workspaceRefresher?.invoke(workspaceCurrentPath) }

    private fun insertWorkspacePathIntoComposer(path: String) {
        val current = composerInput.text.toString()
        if (current.contains(path)) {
            showToast("该路径已在输入框中")
            return
        }
        val separator = if (current.isBlank() || current.last().isWhitespace()) "" else "\n"
        composerInput.append(separator + path)
        composerInput.setSelection(composerInput.text.length)
        showToast("已加入输入框")
    }

    private fun showCreateEntry(anchor: View, parentPath: String, refresh: () -> Unit) {
        showActionPopup(anchor, "新建", listOf(MenuAction("新建文件", "file_add"), MenuAction("新建文件夹", "folder_add"))) { index ->
            val kind = if (index == 0) "file" else "directory"
            showCreateWorkspaceEntryDialog(kind, parentPath, refresh)
        }
    }

    private fun showCreateWorkspaceEntryDialog(kind: String, parentPath: String, refresh: () -> Unit) {
        val input = editField("名称", "", InputType.TYPE_CLASS_TEXT).apply { setSingleLine(true) }
        showInputDialog(if (kind == "file") "新建文件" else "新建文件夹", input, "创建") {
            val name = input.text.toString().trim()
            if (name.isBlank()) return@showInputDialog false
            val path = listOf(parentPath.trim('/'), name).filter { it.isNotBlank() }.joinToString("/")
            val cwd = activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" }
            runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/workspace/entries", JSONObject()
                .put("path", path).put("kind", kind).putOpt("cwd", cwd)) }, { refresh() })
            true
        }
    }

    private fun showWorkspaceEntryActions(anchor: View, entry: JSONObject, cwd: String?, refreshed: (String) -> Unit) {
        val path = entry.optString("path")
        val isDirectory = entry.optString("kind") == "directory"
        val parentPath = path.trim('/').substringBeforeLast('/', "")
        val absolutePath = listOf(workspaceRootPath.trimEnd('/'), path.trimStart('/')).filter { it.isNotBlank() }.joinToString("/")
        val actions = mutableListOf<MenuAction>()
        if (isDirectory && activeThreadId != null) actions += MenuAction("绑定当前聊天到此目录", "link")
        if (absolutePath.isNotBlank() && !composerInput.text.toString().contains(absolutePath)) actions += MenuAction("加入输入框", "add")
        if (isDirectory) actions += listOf(MenuAction("新建文件", "file_add"), MenuAction("新建文件夹", "folder_add"))
        actions += listOf(
            MenuAction("重命名", "edit"),
            MenuAction("复制", "copy"),
            MenuAction("剪切", "cut"),
        )
        if (isDirectory && workspaceClipboard.isNotEmpty()) actions += MenuAction("粘贴到此处", "paste")
        actions += MenuAction("删除", "delete", destructive = true)
        showActionPopup(anchor, entry.optString("name"), actions) { which ->
            when (actions[which].title) {
                "绑定当前聊天到此目录" -> {
                    val threadId = activeThreadId ?: return@showActionPopup
                    runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/threads/${RemoteApi.encodePath(threadId)}/workspace", JSONObject().put("cwd", absolutePath)) }, {
                        activeThread?.put("cwd", absolutePath)
                        workspaceLoadedPath = null
                        renderHeader()
                        refreshThreads(false)
                        showToast("已绑定当前聊天的工作路径")
                    })
                }
                "加入输入框" -> insertWorkspacePathIntoComposer(absolutePath)
                "新建文件" -> showCreateWorkspaceEntryDialog("file", path) { refreshed(path) }
                "新建文件夹" -> showCreateWorkspaceEntryDialog("directory", path) { refreshed(path) }
                "重命名" -> {
                    val input = editField("名称", entry.optString("name"), InputType.TYPE_CLASS_TEXT).apply { setSingleLine(true) }
                    showInputDialog("重命名", input, "确定") {
                        if (input.text.toString().trim().isBlank()) return@showInputDialog false
                        runApi({ RemoteApi(endpoint, token).patch("/api/v1/codex/workspace/entry", JSONObject().put("path", path).put("name", input.text.toString().trim()).putOpt("cwd", cwd)) }, { refreshed(parentPath) })
                        true
                    }
                }
                "复制", "剪切" -> { workspaceClipboard.clear(); workspaceClipboard += path; workspaceClipboardMode = if (actions[which].title == "复制") "copy" else "move"; showToast(if (workspaceClipboardMode == "copy") "已复制" else "已剪切") }
                "粘贴到此处" -> pasteWorkspaceEntries(path) { refreshed("*") }
                "删除" -> showConfirmDialog("删除所选内容", "永久删除 ${entry.optString("name")}？非空文件夹也会一并删除，此操作无法恢复。", "删除", destructive = true) {
                    runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/workspace/delete", JSONObject().put("paths", JSONArray().put(path)).putOpt("cwd", cwd)) }, { refreshed(parentPath) })
                }
            }
        }
    }

    private fun pasteWorkspaceEntries(destination: String, refreshed: () -> Unit) {
        if (workspaceClipboard.isEmpty()) { showToast("剪贴板为空"); return }
        val cwd = activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" }
        val paths = JSONArray().also { array -> workspaceClipboard.forEach(array::put) }
        runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/workspace/paste", JSONObject()
            .put("paths", paths).put("destination", destination).put("mode", workspaceClipboardMode).putOpt("cwd", cwd)) }, {
            if (workspaceClipboardMode == "move") workspaceClipboard.clear()
            refreshed()
        })
    }

    private data class NumberedDiffLine(
        val content: String,
        val kind: String,
        val oldLine: Int? = null,
        val newLine: Int? = null,
    )

    private fun numberDiffLines(diff: String): List<NumberedDiffLine> {
        val result = mutableListOf<NumberedDiffLine>()
        val hunkPattern = Regex("""^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@""")
        var oldLine = 0
        var newLine = 0
        var oldRemaining = 0
        var newRemaining = 0
        var insideHunk = false
        diff.lineSequence().forEach { line ->
            val hunk = hunkPattern.find(line)
            if (hunk != null) {
                oldLine = hunk.groupValues[1].toIntOrNull() ?: 0
                oldRemaining = hunk.groupValues[2].toIntOrNull() ?: 1
                newLine = hunk.groupValues[3].toIntOrNull() ?: 0
                newRemaining = hunk.groupValues[4].toIntOrNull() ?: 1
                insideHunk = true
                result += NumberedDiffLine(line, "hunk")
                return@forEach
            }
            if (!insideHunk) return@forEach
            when {
                line.startsWith("\\") -> result += NumberedDiffLine(line, "context")
                line.startsWith("-") && oldRemaining > 0 -> {
                    result += NumberedDiffLine(line.drop(1), "deleted", oldLine = oldLine)
                    oldLine += 1
                    oldRemaining -= 1
                }
                line.startsWith("+") && newRemaining > 0 -> {
                    result += NumberedDiffLine(line.drop(1), "added", newLine = newLine)
                    newLine += 1
                    newRemaining -= 1
                }
                line.startsWith(" ") && oldRemaining > 0 && newRemaining > 0 -> {
                    result += NumberedDiffLine(line.drop(1), "context", oldLine, newLine)
                    oldLine += 1
                    newLine += 1
                    oldRemaining -= 1
                    newRemaining -= 1
                }
            }
            if (oldRemaining <= 0 && newRemaining <= 0) insideHunk = false
        }
        if (result.isNotEmpty()) return result
        return diff.lineSequence().mapNotNull { line ->
            when {
                line.startsWith("+") && !line.startsWith("+++") -> NumberedDiffLine(line.drop(1), "added")
                line.startsWith("-") && !line.startsWith("---") -> NumberedDiffLine(line.drop(1), "deleted")
                else -> null
            }
        }.toList()
    }

    private fun syntaxKind(path: String): String {
        val name = path.substringAfterLast('/').lowercase(Locale.ROOT)
        return when {
            name == "dockerfile" || name.startsWith("dockerfile.") -> "docker"
            name in setOf("makefile", "gnumakefile", "cmakelists.txt") -> "build"
            name == "gradlew" || name == "gradlew.bat" -> "shell"
            name.endsWith(".gradle") || name.endsWith(".gradle.kts") -> "gradle"
            name.startsWith(".env") -> "config"
            else -> name.substringAfterLast('.', "")
        }
    }

    private fun highlightedCode(path: String, source: String): SpannableString {
        val value = SpannableString(source)
        if (value.isEmpty()) return value
        val extension = syntaxKind(path)
        val keywordSet = when (extension) {
            "kt", "kts" -> "class|interface|object|fun|val|var|when|if|else|for|while|return|private|public|internal|protected|override|data|sealed|suspend|try|catch|finally|throw|is|in|as|null|true|false|package|import"
            "java", "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "cs", "swift", "m", "mm" -> "class|interface|struct|enum|public|private|protected|static|final|const|void|int|long|double|float|char|boolean|bool|if|else|for|while|switch|case|break|continue|return|new|null|true|false|try|catch|finally|throw|using|namespace|package|import"
            "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte" -> "const|let|var|function|class|interface|type|enum|import|export|from|async|await|if|else|for|while|switch|case|break|continue|return|new|null|undefined|true|false|try|catch|finally|throw|extends|implements|typeof|instanceof"
            "py", "pyi", "pyw", "pyx" -> "def|class|import|from|as|async|await|if|elif|else|for|while|break|continue|return|yield|try|except|finally|raise|with|lambda|None|True|False|and|or|not|in|is|pass|global|nonlocal"
            "sh", "bash", "zsh", "fish", "shell", "csh", "ps1", "psm1", "bat", "cmd" -> "if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|export|local|readonly|set|unset|shift|return|break|continue|true|false"
            "json", "jsonl", "ndjson", "json5", "jsonc", "geojson", "yaml", "yml", "toml", "config" -> "true|false|null|yes|no|on|off"
            "gradle", "groovy", "build" -> "plugins|pluginManagement|id|version|apply|repositories|dependencies|implementation|api|compileOnly|runtimeOnly|testImplementation|android|namespace|compileSdk|minSdk|targetSdk|buildTypes|release|debug|def|class|interface|if|else|for|while|return|import|package|true|false|null"
            "go" -> "package|import|func|type|struct|interface|map|chan|go|defer|select|case|switch|if|else|for|range|break|continue|return|var|const|nil|true|false"
            "rs" -> "fn|let|mut|const|static|struct|enum|trait|impl|type|mod|use|pub|crate|self|Self|super|async|await|move|match|if|else|for|while|loop|break|continue|return|where|dyn|ref|true|false"
            "php", "rb", "ruby", "dart", "lua", "pl", "pm", "r" -> "class|module|interface|function|def|end|var|val|const|local|import|require|include|if|elseif|elif|else|unless|for|foreach|while|do|then|switch|case|when|break|continue|return|yield|try|catch|rescue|finally|throw|raise|async|await|new|null|nil|true|false"
            "sql" -> "select|from|where|join|left|right|inner|outer|on|group|by|order|having|limit|offset|insert|into|values|update|set|delete|create|alter|drop|table|index|view|primary|foreign|key|constraint|and|or|not|null|is|as|distinct|union|all|case|when|then|else|end|true|false"
            "html", "htm", "xml", "xsd", "xsl", "svg", "css", "scss", "sass", "less", "md", "mdx", "markdown" -> "true|false|null|important"
            else -> "class|interface|struct|enum|function|fun|def|const|let|var|if|else|for|while|return|import|export|package|true|false|null|nil"
        }
        val keywordColor = if (lightTheme) Color.rgb(104, 73, 184) else Color.rgb(197, 154, 255)
        val stringColor = if (lightTheme) Color.rgb(20, 118, 91) else Color.rgb(126, 211, 176)
        val numberColor = if (lightTheme) Color.rgb(176, 83, 27) else Color.rgb(244, 176, 112)
        val commentColor = if (lightTheme) Color.rgb(103, 112, 124) else Color.rgb(132, 145, 153)
        Regex("\\b(?:$keywordSet)\\b").findAll(value).forEach { match ->
            value.setSpan(ForegroundColorSpan(keywordColor), match.range.first, match.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            value.setSpan(StyleSpan(Typeface.BOLD), match.range.first, match.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        Regex("""\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b""").findAll(value).forEach { match ->
            value.setSpan(ForegroundColorSpan(numberColor), match.range.first, match.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        Regex("""\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`""").findAll(value).forEach { match ->
            value.setSpan(ForegroundColorSpan(stringColor), match.range.first, match.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        Regex("(?m)^\\s*(?://|#|--|;).*$").findAll(value).forEach { match ->
            value.setSpan(ForegroundColorSpan(commentColor), match.range.first, match.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        Regex("(?s)/\\*.*?\\*/|<!--.*?-->").findAll(value).forEach { match ->
            value.setSpan(ForegroundColorSpan(commentColor), match.range.first, match.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        if (extension in setOf("html", "htm", "xml", "xsd", "xsl", "svg", "vue", "svelte")) {
            Regex("</?([A-Za-z][A-Za-z0-9:_-]*)").findAll(value).forEach { match ->
                val group = match.groups[1] ?: return@forEach
                value.setSpan(ForegroundColorSpan(keywordColor), group.range.first, group.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                value.setSpan(StyleSpan(Typeface.BOLD), group.range.first, group.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        return value
    }

    private fun highlightedCodeLine(path: String, source: String): SpannableString =
        highlightedCode(path, source.ifEmpty { " " })

    private fun showDiffPreview(entry: FileChangeEntry) {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), dp(8), dp(10), dp(8))
            background = rounded(PANEL, dp(14), BORDER, dp(1))
        }
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(ImageView(this).apply {
            setImageResource(fileIconResource(entry.path))
            imageTintList = null
            contentDescription = fileGlyph(entry.path)
        }, LinearLayout.LayoutParams(dp(19), dp(19)).apply { rightMargin = dp(7) })
        header.addView(label(entry.path.substringAfterLast('/'), 13, TEXT, true).apply {
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        }, LinearLayout.LayoutParams(0, dp(34), 1f))
        if (entry.additions > 0) header.addView(label("+${entry.additions}", 11, if (lightTheme) Color.rgb(12, 119, 53) else Color.rgb(92, 218, 128), true))
        if (entry.deletions > 0) header.addView(label("-${entry.deletions}", 11, if (lightTheme) Color.rgb(184, 35, 47) else Color.rgb(255, 104, 116), true).apply { setPadding(dp(7), 0, dp(3), 0) })
        header.addView(iconButton("close", "关闭修改预览") { dialog.dismiss() }, LinearLayout.LayoutParams(dp(32), dp(32)))
        layout.addView(header, widthWrap())

        val lines = numberDiffLines(entry.diff)
        if (lines.isEmpty()) {
            layout.addView(label("这条编辑记录没有保存可审核的差异片段。", 12, MUTED).apply {
                gravity = Gravity.CENTER
                setPadding(dp(18), dp(90), dp(18), dp(90))
            }, LinearLayout.LayoutParams(MATCH, 0, 1f))
        } else {
            val visibleLines = lines.take(MAX_DIFF_PREVIEW_LINES)
            val code = SpannableStringBuilder()
            visibleLines.forEach { line ->
                val backgroundColor = when (line.kind) {
                    "added" -> if (lightTheme) Color.rgb(223, 246, 228) else Color.rgb(24, 58, 36)
                    "deleted" -> if (lightTheme) Color.rgb(252, 226, 229) else Color.rgb(67, 31, 38)
                    "hunk" -> if (lightTheme) Color.rgb(231, 236, 250) else Color.rgb(36, 43, 63)
                    else -> Color.TRANSPARENT
                }
                val lineStart = code.length
                val oldNumber = line.oldLine?.toString().orEmpty().padStart(5)
                val newNumber = line.newLine?.toString().orEmpty().padStart(5)
                val marker = when (line.kind) { "added" -> "+"; "deleted" -> "-"; else -> " " }
                val gutter = if (line.kind == "hunk") "           │ " else "$oldNumber $newNumber │$marker"
                code.append(gutter)
                val gutterEnd = code.length
                if (line.kind == "hunk") code.append(line.content) else code.append(highlightedCodeLine(entry.path, line.content))
                val contentEnd = code.length
                code.append('\n')
                code.setSpan(ForegroundColorSpan(MUTED), lineStart, gutterEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                if (line.kind == "hunk") {
                    code.setSpan(ForegroundColorSpan(ACCENT), gutterEnd, contentEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    code.setSpan(StyleSpan(Typeface.BOLD), gutterEnd, contentEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                if (backgroundColor != Color.TRANSPARENT) {
                    code.setSpan(BackgroundColorSpan(backgroundColor), lineStart, contentEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
            if (lines.size > visibleLines.size) {
                val start = code.length
                code.append("           │ 其余 ${lines.size - visibleLines.size} 行未显示")
                code.setSpan(ForegroundColorSpan(WARNING), start, code.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            val codeView = label("", 11, TEXT).apply {
                text = code
                typeface = Typeface.MONOSPACE
                includeFontPadding = false
                setTextIsSelectable(true)
                setPadding(dp(5), dp(5), dp(12), dp(8))
                setHorizontallyScrolling(false)
                minimumWidth = (resources.displayMetrics.widthPixels - dp(20)).coerceAtLeast(dp(300))
            }
            val horizontal = HorizontalScrollView(this).apply {
                isHorizontalScrollBarEnabled = false
                overScrollMode = View.OVER_SCROLL_NEVER
                addView(codeView, FrameLayout.LayoutParams(WRAP, WRAP))
            }
            val vertical = ScrollView(this).apply {
                isVerticalScrollBarEnabled = false
                overScrollMode = View.OVER_SCROLL_NEVER
                addView(horizontal, FrameLayout.LayoutParams(WRAP, WRAP))
            }
            layout.addView(vertical, LinearLayout.LayoutParams(MATCH, 0, 1f).apply { topMargin = dp(5) })
        }
        dialog.setContentView(layout)
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout(MATCH, (resources.displayMetrics.heightPixels * .86f).toInt())
            setGravity(Gravity.BOTTOM)
        }
    }

    private fun showFilePreview(path: String, cwd: String?) {
        val effectiveCwd = cwd?.takeIf { it.isNotBlank() && it != "null" }
            ?: activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" }
            ?: runtime.optString("workspace").takeIf { it.isNotBlank() && it != "null" }
        val requestPath = workspaceRelativePath(effectiveCwd, path)
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(9), dp(12), dp(10))
            background = rounded(PANEL, dp(14), BORDER, dp(1))
        }
        val previewInput = EditText(this).apply {
            setTextColor(TEXT); setHintTextColor(MUTED); textSize = adjustedTextSize(13); setTag(R.id.base_text_size, 13f)
            typeface = Typeface.MONOSPACE; gravity = Gravity.TOP or Gravity.START
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setPadding(dp(9), dp(9), dp(9), dp(9)); background = rounded(if (lightTheme) Color.rgb(246, 247, 249) else Color.rgb(14, 16, 20), dp(8))
            minHeight = dp(280)
            visibility = View.GONE
        }
        val imagePreview = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            minimumHeight = dp(280)
            visibility = View.GONE
        }
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(label(path.substringAfterLast('/'), 13, TEXT, true).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE }, LinearLayout.LayoutParams(0, dp(34), 1f))
        val saveButton = smallButton("保存") { savePreviewFile(requestPath, effectiveCwd, previewInput.text.toString(), previewInput.tag?.toString().orEmpty(), previewInput) }.apply {
            visibility = View.GONE
        }
        header.addView(saveButton)
        header.addView(iconButton("close", "关闭文件预览") { dialog.dismiss() }, LinearLayout.LayoutParams(dp(32), dp(32)))
        layout.addView(header, widthWrap())
        val loadingStatus = label("正在加载文件…", 12, MUTED).apply {
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(80), dp(12), dp(18))
        }
        val retryButton = smallButton("重新加载") { }.apply { visibility = View.GONE }
        val state = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            addView(loadingStatus, widthWrap())
            addView(retryButton, LinearLayout.LayoutParams(WRAP, dp(34)))
        }
        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(previewInput, LinearLayout.LayoutParams(MATCH, WRAP))
                addView(imagePreview, LinearLayout.LayoutParams(MATCH, dp(420)))
            }, FrameLayout.LayoutParams(MATCH, WRAP))
        }
        layout.addView(state, LinearLayout.LayoutParams(MATCH, 0, 1f))
        layout.addView(scroll, LinearLayout.LayoutParams(MATCH, 0, 1f).apply { topMargin = dp(6) })
        scroll.visibility = View.GONE
        dialog.setContentView(layout)
        dialog.show()
        dialog.window?.apply { setBackgroundDrawableResource(android.R.color.transparent); setLayout(MATCH, (resources.displayMetrics.heightPixels * .86f).toInt()); setGravity(Gravity.BOTTOM) }

        val showPreviewError = { error: Throwable ->
            handler.post {
                if (dialog.isShowing) {
                    loadingStatus.text = "加载失败：${error.message ?: "无法预览文件"}"
                    loadingStatus.setTextColor(ERROR)
                    retryButton.visibility = View.VISIBLE
                }
            }
        }
        lateinit var loadPreview: () -> Unit
        loadPreview = {
            state.visibility = View.VISIBLE
            scroll.visibility = View.GONE
            loadingStatus.text = "正在加载文件…"
            loadingStatus.setTextColor(MUTED)
            retryButton.visibility = View.GONE
            previewInput.visibility = View.GONE
            imagePreview.visibility = View.GONE
            saveButton.visibility = View.GONE
            io.execute {
                try {
                    val query = "?path=${Uri.encode(requestPath)}" + if (effectiveCwd.isNullOrBlank()) "" else "&cwd=${Uri.encode(effectiveCwd)}"
                    val isImage = requestPath.substringAfterLast('.', "").lowercase(Locale.ROOT) in setOf("png", "jpg", "jpeg", "webp", "gif")
                    val file = RemoteApi(endpoint, token).get("/api/v1/codex/workspace/${if (isImage) "image" else "file"}$query")
                    val bitmap = if (isImage) {
                        val encoded = file.optString("data")
                        if (encoded.length > MAX_FILE_PREVIEW_BASE64_CHARS) throw IOException("图片过大，无法在 APP 内预览")
                        val data = android.util.Base64.decode(encoded, android.util.Base64.DEFAULT)
                        decodeSampledBitmap(data, 1600) ?: throw IOException("图片内容无法解析")
                    } else null
                    val content = if (isImage) null else file.optString("content")
                    val highlightedContent = content?.let { highlightedCode(requestPath, it) }
                    handler.post {
                        if (!dialog.isShowing) return@post
                        state.visibility = View.GONE
                        scroll.visibility = View.VISIBLE
                        if (isImage) {
                            imagePreview.setImageBitmap(bitmap)
                            imagePreview.visibility = View.VISIBLE
                        } else {
                            previewInput.tag = file.optString("revision")
                            previewInput.setText(highlightedContent)
                            previewInput.visibility = View.VISIBLE
                            saveButton.visibility = View.VISIBLE
                        }
                    }
                } catch (error: Exception) { showPreviewError(error) }
                catch (error: OutOfMemoryError) { showPreviewError(IOException("设备内存不足，无法预览该图片")) }
            }
        }
        retryButton.setOnClickListener { loadPreview() }
        loadPreview()
    }

    private fun workspaceRelativePath(cwd: String?, path: String): String {
        val normalizedPath = path.replace('\\', '/').removePrefix("./")
        val normalizedCwd = cwd?.replace('\\', '/')?.trimEnd('/').orEmpty()
        if (normalizedCwd.isBlank()) return normalizedPath
        if (normalizedPath == normalizedCwd) return ""
        val prefix = "$normalizedCwd/"
        val windowsPath = Regex("^[a-zA-Z]:/").containsMatchIn(prefix)
        return if (windowsPath && normalizedPath.lowercase(Locale.ROOT).startsWith(prefix.lowercase(Locale.ROOT))) {
            normalizedPath.substring(prefix.length)
        } else if (!windowsPath && normalizedPath.startsWith(prefix)) {
            normalizedPath.substring(prefix.length)
        } else normalizedPath
    }

    private fun workspaceImageRequestPath(cwd: String?, path: String): String {
        val normalizedPath = path.replace('\\', '/').removePrefix("./")
        val normalizedCwd = cwd?.replace('\\', '/')?.trimEnd('/').orEmpty()
        if (normalizedCwd.isBlank() || !normalizedPath.startsWith('/') && !Regex("^[a-zA-Z]:/").containsMatchIn(normalizedPath)) {
            return normalizedPath
        }
        return workspaceRelativePath(cwd, normalizedPath).takeIf { it != normalizedPath } ?: normalizedPath
    }

    private fun isWorkspaceImagePath(path: String): Boolean = path.substringAfterLast('.', "").lowercase(Locale.ROOT) in setOf("png", "jpg", "jpeg", "webp", "gif")

    private fun savePreviewFile(path: String, cwd: String?, content: String, revision: String, editor: EditText) {
        if (revision.isBlank()) { showToast("文件还在加载"); return }
        runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/workspace/file", JSONObject()
            .put("path", path).put("content", content).put("revision", revision).putOpt("cwd", cwd)) }, { result ->
            showToast("已保存")
            if (result.has("revision")) editor.tag = result.optString("revision")
        })
    }

    private fun showTerminal() {
        if (terminalOverlay != null) return
        preferencePopup?.dismiss()
        terminalScreen = TerminalScreenBuffer(88, 26)
        val shell = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), 0, dp(10), dp(8))
            setBackgroundColor(if (lightTheme) Color.rgb(250, 250, 251) else Color.rgb(12, 14, 17))
            elevation = dp(18).toFloat()
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, systemInsetTop, 0, 0)
        }
        header.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_terminal)
            imageTintList = ColorStateList.valueOf(SUBTLE)
            contentDescription = "本机终端"
        }, LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(7) })
        header.addView(label("本机终端", 13, TEXT, true), LinearLayout.LayoutParams(0, dp(34), 1f))
        header.addView(smallButton("复制到输入框") {
            val value = terminalOutput?.text?.toString().orEmpty()
            composerInput.append(value.takeLast(120_000))
            closeTerminal()
        })
        header.addView(iconButton("close", "关闭终端") { closeTerminal() }, LinearLayout.LayoutParams(dp(40), dp(40)))
        header.addView(View(this), LinearLayout.LayoutParams(dp(40), dp(1)))
        shell.addView(header, LinearLayout.LayoutParams(MATCH, systemInsetTop + dp(44)))
        terminalStatusView = label("正在连接终端…", 10, MUTED).apply {
            setPadding(dp(3), 0, dp(3), dp(4))
        }
        shell.addView(terminalStatusView, widthWrap())
        terminalOutput = label("", 12, if (lightTheme) SUBTLE else Color.rgb(207, 214, 226)).apply {
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
            setPadding(dp(9), dp(9), dp(9), dp(9))
            gravity = Gravity.TOP or Gravity.START
            minHeight = dp(190)
        }
        val outputScroll = ScrollView(this).apply {
            isFillViewport = true; isVerticalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_NEVER
            background = rounded(if (lightTheme) Color.rgb(244, 246, 248) else Color.rgb(8, 10, 12), dp(8))
            addView(terminalOutput, FrameLayout.LayoutParams(MATCH, WRAP))
        }
        shell.addView(outputScroll, LinearLayout.LayoutParams(MATCH, 0, 1f).apply { topMargin = dp(5); bottomMargin = dp(5) })
        val arrows = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        listOf("↑" to "\u001b[A", "↓" to "\u001b[B", "←" to "\u001b[D", "→" to "\u001b[C", "Tab" to "\t", "Esc" to "\u001b", "Ctrl+C" to "\u0003").forEach { (label, value) ->
            arrows.addView(smallButton(label) { sendTerminalInput(value) }, LinearLayout.LayoutParams(0, dp(32), 1f).apply { leftMargin = dp(2); rightMargin = dp(2) })
        }
        shell.addView(arrows, widthWrap())
        val inputRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        terminalDraftInput = editField("终端命令", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS).apply {
            typeface = Typeface.MONOSPACE
            setSingleLine(true)
            isFocusable = true
            isFocusableInTouchMode = true
            showSoftInputOnFocus = true
            imeOptions = EditorInfo.IME_ACTION_SEND
            setOnEditorActionListener { _, action, _ ->
                if (action == EditorInfo.IME_ACTION_SEND || action == EditorInfo.IME_NULL) { sendTerminalLine(); true } else false
            }
            setOnClickListener {
                requestFocus()
                post {
                    (getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
                        ?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
                }
            }
        }
        inputRow.addView(terminalDraftInput, LinearLayout.LayoutParams(0, dp(42), 1f))
        inputRow.addView(smallButton("发送") { sendTerminalLine() }, LinearLayout.LayoutParams(WRAP, dp(38)).apply { leftMargin = dp(5) })
        shell.addView(inputRow, LinearLayout.LayoutParams(MATCH, dp(44)).apply { topMargin = dp(5) })
        terminalReady = false
        terminalImeVisible = false
        terminalOverlay = shell
        root.addView(shell, FrameLayout.LayoutParams(MATCH, MATCH, Gravity.TOP))
        terminalPositionListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> positionTerminalOverlay() }
        terminalPositionListener?.let { listener ->
            root.addOnLayoutChangeListener(listener)
            composerDock.addOnLayoutChangeListener(listener)
        }
        positionTerminalOverlay()
        shell.post { positionTerminalOverlay() }
        connectTerminal()
    }

    private fun positionTerminalOverlay() {
        val shell = terminalOverlay ?: return
        if (!::root.isInitialized || !::composerDock.isInitialized || root.height <= 0) return
        val rootLocation = IntArray(2)
        val composerLocation = IntArray(2)
        root.getLocationOnScreen(rootLocation)
        composerDock.getLocationOnScreen(composerLocation)
        val composerTop = (composerLocation[1] - rootLocation[1]).coerceIn(0, root.height)
        (shell.layoutParams as? FrameLayout.LayoutParams)?.let { params ->
            if (params.height != composerTop) {
                params.width = MATCH
                params.height = composerTop
                params.gravity = Gravity.TOP
                shell.layoutParams = params
            }
        }
        (shell.getChildAt(0)?.layoutParams as? LinearLayout.LayoutParams)?.let { headerParams ->
            val target = systemInsetTop + dp(44)
            if (headerParams.height != target) {
                headerParams.height = target
                shell.getChildAt(0).layoutParams = headerParams
            }
        }
        (shell.getChildAt(0) as? ViewGroup)?.setPadding(0, systemInsetTop, 0, 0)
    }

    private fun closeTerminal() {
        val shell = terminalOverlay ?: return
        terminalPositionListener?.let { listener ->
            if (::root.isInitialized) root.removeOnLayoutChangeListener(listener)
            if (::composerDock.isInitialized) composerDock.removeOnLayoutChangeListener(listener)
        }
        terminalPositionListener = null
        (getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
            ?.hideSoftInputFromWindow(terminalDraftInput?.windowToken, 0)
        if (::root.isInitialized && shell.parent === root) root.removeView(shell)
        terminalReady = false
        terminalSocket?.close(1000, "closed")
        terminalSocket = null
        terminalOverlay = null
        terminalDraftInput = null
        terminalOutput = null
        terminalStatusView = null
        terminalImeVisible = false
        terminalImeHiddenUntil = 0L
    }

    private fun connectTerminal() {
        updateTerminalStatus("正在连接电脑终端…", MUTED)
        val url = endpoint.replaceFirst(Regex("^http"), "ws") + "/api/v1/codex/terminal"
        val request = Request.Builder().url(url).build()
        terminalSocket = socketClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                updateTerminalStatus("连接成功，正在恢复终端会话…", MUTED)
                val thread = activeThreadId
                val cwd = activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" } ?: runtime.optString("workspace", "")
                val sent = webSocket.send(JSONObject().put("type", "terminal.connect").put("token", token)
                    .putOpt("threadId", thread).putOpt("cwd", cwd.takeIf { it.isNotBlank() })
                    .put("columns", 88).put("rows", 26).toString())
                if (!sent) updateTerminalStatus("终端连接信息发送失败", ERROR)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val event = JSONObject(text)
                    when (event.optString("type")) {
                        "ready" -> {
                            terminalReady = true
                            updateTerminalStatus("${event.optString("shell")} · ${event.optString("cwd")}", if (lightTheme) Color.rgb(44, 126, 70) else Color.rgb(119, 174, 132))
                        }
                        "error" -> {
                            terminalReady = false
                            val message = event.optString("message", "终端连接失败")
                            updateTerminalStatus(message, ERROR)
                            appendTerminal("$message\n")
                        }
                        "exit" -> {
                            terminalReady = false
                            updateTerminalStatus("终端会话已结束", WARNING)
                            appendTerminal("\n[终端已退出]\n")
                        }
                    }
                } catch (_: JSONException) { }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { appendTerminal(bytes.utf8()) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                terminalReady = false
                val message = "终端连接失败：${t.message ?: "未知错误"}"
                updateTerminalStatus(message, ERROR)
                appendTerminal("\n$message\n")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                terminalReady = false
                if (terminalOverlay != null) {
                    updateTerminalStatus("连接已关闭（$code）", WARNING)
                    appendTerminal("\n终端连接已关闭：${reason.ifBlank { "无原因说明" }}\n")
                }
            }
        })
    }

    private fun appendTerminal(value: String) = handler.post {
        val output = terminalOutput ?: return@post
        output.text = terminalScreen.append(value)
        (output.parent as? ScrollView)?.post { (output.parent as? ScrollView)?.fullScroll(View.FOCUS_DOWN) }
    }

    private fun updateTerminalStatus(value: String, color: Int) = handler.post {
        terminalStatusView?.apply {
            text = value
            setTextColor(color)
        }
    }

    private fun sendTerminalLine() {
        val input = terminalDraftInput ?: return
        val value = input.text.toString()
        if (value.isBlank()) return
        if (!terminalReady) {
            showToast("终端还在连接，命令先留在输入框里")
            return
        }
        if (sendTerminalInput(value + "\n")) input.setText("")
    }

    private fun sendTerminalInput(value: String): Boolean {
        if (!terminalReady) return false
        val sent = terminalSocket?.send(JSONObject().put("type", "input").put("data", value).toString()) == true
        if (!sent) terminalReady = false
        return sent
    }

    private fun fileIconResource(path: String): Int {
        val name = path.substringAfterLast('/').substringAfterLast('\\').lowercase(Locale.ROOT)
        val extension = name.substringAfterLast('.', "")
        return when {
            name == "agents.md" -> R.drawable.file_icon_agents
            name == "package.json" || name == "package-lock.json" || name == ".npmrc" -> R.drawable.file_icon_npm
            name == "pnpm-lock.yaml" -> R.drawable.file_icon_pnpm
            name in setOf(".gitignore", ".gitattributes", ".gitconfig") -> R.drawable.file_icon_git
            name == "dockerfile" || name.startsWith("dockerfile.") -> R.drawable.file_icon_docker
            name == "gradlew" || name == "gradlew.bat" || name.endsWith(".gradle") || name.endsWith(".gradle.kts") -> R.drawable.file_icon_gradle
            name == "readme" || name.startsWith("readme.") || name.startsWith("changelog") || name.startsWith("license") -> R.drawable.file_icon_markdown
            name.startsWith(".env") -> R.drawable.file_icon_config
            extension in setOf("js", "jsx", "mjs", "cjs") -> R.drawable.file_icon_js
            extension in setOf("ts", "tsx", "mts", "cts") -> R.drawable.file_icon_ts
            extension in setOf("json", "json5", "jsonc", "jsonl", "ndjson", "geojson", "ipynb") -> R.drawable.file_icon_json
            extension in setOf("py", "pyi", "pyw", "pyx", "pxd", "pxi") -> R.drawable.file_icon_python
            extension in setOf("sh", "bash", "zsh", "fish", "csh", "ps1", "psm1", "psd1", "bat", "cmd") -> R.drawable.file_icon_shell
            extension in setOf("kt", "kts") -> R.drawable.file_icon_kotlin
            extension in setOf("java", "class", "jar") -> R.drawable.file_icon_java
            extension in setOf("md", "mdx", "markdown", "qmd") -> R.drawable.file_icon_markdown
            extension in setOf("css", "scss", "sass", "less") -> R.drawable.file_icon_css
            extension in setOf("html", "htm", "ejs", "erb", "hbs", "handlebars", "vue", "svelte") -> R.drawable.file_icon_html
            extension in setOf("png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg") -> R.drawable.file_icon_image
            extension in setOf("zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz") -> R.drawable.file_icon_archive
            extension in setOf("db", "sqlite", "sqlite3", "sql") -> R.drawable.file_icon_database
            extension in setOf("yaml", "yml") -> R.drawable.file_icon_yaml
            extension in setOf("toml") -> R.drawable.file_icon_toml
            extension in setOf("ini", "conf", "config", "properties", "lock", "pro") -> R.drawable.file_icon_config
            extension in setOf("csv", "tsv") -> R.drawable.file_icon_csv
            extension in setOf("xml", "xsd", "xsl", "plist") -> R.drawable.file_icon_xml
            extension == "c" || extension in setOf("h") -> R.drawable.file_icon_c
            extension in setOf("cc", "cpp", "cxx", "hh", "hpp", "hxx") -> R.drawable.file_icon_cpp
            extension == "go" -> R.drawable.file_icon_go
            extension == "rs" -> R.drawable.file_icon_rust
            extension == "pdf" -> R.drawable.file_icon_pdf
            extension in setOf("txt", "text", "log") -> R.drawable.file_icon_text
            else -> R.drawable.file_icon_default
        }
    }

    private fun fileGlyph(name: String): String = when (fileIconResource(name)) {
        R.drawable.file_icon_js -> "JavaScript 文件"
        R.drawable.file_icon_ts -> "TypeScript 文件"
        R.drawable.file_icon_json -> "JSON 数据文件"
        R.drawable.file_icon_python -> "Python 文件"
        R.drawable.file_icon_shell -> "终端脚本"
        R.drawable.file_icon_kotlin -> "Kotlin 文件"
        R.drawable.file_icon_java -> "Java 文件"
        R.drawable.file_icon_markdown -> "Markdown 文档"
        R.drawable.file_icon_css -> "样式文件"
        R.drawable.file_icon_html, R.drawable.file_icon_xml -> "标记文件"
        R.drawable.file_icon_image -> "图片文件"
        R.drawable.file_icon_archive -> "压缩文件"
        R.drawable.file_icon_database -> "数据库文件"
        R.drawable.file_icon_yaml, R.drawable.file_icon_toml, R.drawable.file_icon_config -> "配置文件"
        else -> "文件"
    }

    private fun formatFileSize(size: Long): String = when {
        size < 1024 -> "$size B"
        size < 1024 * 1024 -> "${size / 1024} KB"
        else -> String.format(Locale.ROOT, "%.1f MB", size / (1024f * 1024f))
    }

    private fun chooseAttachment() {
        if (attachRequestActive) return
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try { startActivityForResult(intent, REQUEST_ATTACH) } catch (_: Exception) { showToast("没有可用的文件选择器") }
    }

    @Deprecated("Use Activity Result APIs when the Android module adopts AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_THEME_BACKGROUND) {
            themeBackgroundPickerActive = false
            val uri = data?.data
            if (resultCode == RESULT_OK && uri != null) {
                runCatching {
                    contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                prefs.edit().putString(KEY_CUSTOM_BACKGROUND_IMAGE, uri.toString()).apply()
                rerenderAppKeepSettings()
            }
            return
        }
        if (requestCode != REQUEST_ATTACH || resultCode != RESULT_OK || data == null) return
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris += clip.getItemAt(i).uri }
        if (uris.isEmpty()) data.data?.let(uris::add)
        processAttachments(uris)
    }

    private fun processAttachments(uris: List<Uri>) {
        if (uris.isEmpty()) return
        attachRequestActive = true
        showToast("正在读取附件…")
        io.execute {
            try {
                val result = uris.map { readAttachment(it) }
                handler.post { selectedFiles.addAll(result); attachRequestActive = false; renderAttachmentStrip(); showToast("已添加 ${result.size} 个附件") }
            } catch (error: Exception) {
                handler.post { attachRequestActive = false; showStatus(error.message ?: "读取附件失败") }
            }
        }
    }

    private fun readAttachment(uri: Uri): JSONObject {
        val resolver = contentResolver
        val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        } ?: "attachment"
        val mime = resolver.getType(uri).orEmpty().lowercase(Locale.ROOT)
        val bytes = resolver.openInputStream(uri)?.use(InputStream::readAll) ?: throw IllegalStateException("无法读取文件：$name")
        if (mime.startsWith("image/") || name.substringAfterLast('.', "").lowercase() in setOf("png", "jpg", "jpeg", "webp", "gif")) {
            val mediaType = when {
                mime == "image/jpeg" || name.endsWith(".jpg", true) || name.endsWith(".jpeg", true) -> "image/jpeg"
                mime == "image/webp" || name.endsWith(".webp", true) -> "image/webp"
                mime == "image/gif" || name.endsWith(".gif", true) -> "image/gif"
                else -> "image/png"
            }
            return JSONObject().put("kind", "image").put("name", name).put("mediaType", mediaType)
                .put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                .put("thumbnail", createAttachmentThumbnail(bytes))
        }
        if (mime == "application/pdf" || name.endsWith(".pdf", true) || name.endsWith(".xlsx", true) || name.endsWith(".xls", true)) {
            val contentType = if (mime.startsWith("application/") && mime != "application/octet-stream") mime else if (name.endsWith(".pdf", true)) "application/pdf" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            val path = "/api/v1/codex/pdf-attachments?name=${java.net.URLEncoder.encode(name, "UTF-8")}"
            val uploaded = RemoteApi(endpoint, token).upload(path, contentType, bytes)
            return JSONObject().put("kind", "document").put("name", name).put("content", "").put("sourceFileId", uploaded.getString("attachment_id"))
        }
        val text = String(bytes, StandardCharsets.UTF_8)
        if (text.indexOf('\u0000') >= 0) throw IllegalArgumentException("暂不支持该文件格式：$name")
        return JSONObject().put("kind", "document").put("name", name).put("content", text)
    }

    private fun connectSocket() {
        if (token.isBlank() || socket != null) return
        val url = endpoint.replaceFirst(Regex("^http"), "ws") + "/api/v1/codex/ws"
        val request = Request.Builder().url(url).build()
        socket = socketClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                socketConnected = true
                outstandingSocketPing = null
                lastSocketActivityAt = System.currentTimeMillis()
                webSocket.send(JSONObject().put("type", "codex.client.hello").put("protocol_version", 1)
                    .put("token", token).put("thread_id", activeThreadId).toString())
                handler.post {
                    handler.removeCallbacks(socketHeartbeatRunnable)
                    handler.postDelayed(socketHeartbeatRunnable, 20_000)
                    renderHeader()
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                lastSocketActivityAt = System.currentTimeMillis()
                try { handleSocketEvent(JSONObject(text)) } catch (_: JSONException) { }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (socket === webSocket) {
                    socketConnected = false
                    socket = null
                    outstandingSocketPing = null
                    handler.removeCallbacks(socketHeartbeatRunnable)
                    handler.post {
                        renderHeader()
                        if (foreground) handler.postDelayed({ if (foreground) connectSocket() }, 1200)
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (socket === webSocket) {
                    socketConnected = false
                    socket = null
                    outstandingSocketPing = null
                    handler.removeCallbacks(socketHeartbeatRunnable)
                    handler.post { renderHeader(); if (foreground) handler.postDelayed({ if (foreground) connectSocket() }, 1200) }
                }
            }
        })
    }

    private fun handleSocketEvent(event: JSONObject) {
        when (event.optString("type")) {
            "pong" -> handler.post {
                lastSocketActivityAt = System.currentTimeMillis()
                if (event.optString("id") == outstandingSocketPing) outstandingSocketPing = null
            }
            "connection" -> {
                runtime = JSONObject(event.toString())
                handler.post { renderHeader() }
            }
            "error" -> handler.post { showStatus(event.optString("message", "Codex 请求失败")) }
            "server_request" -> {
                val method = event.optString("method")
                if (method in setOf("item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval")) {
                    pendingApproval = JSONObject(event.toString())
                    handler.post { renderMessages(false) }
                }
            }
            "server_request.resolved" -> {
                val approval = pendingApproval
                if (approval != null && approval.opt("request_id") == event.opt("request_id")) {
                    pendingApproval = null
                    handler.post { renderMessages(false) }
                }
            }
            "threads.changed" -> handler.post { refreshThreads(false) }
            "remote.queue.changed" -> {
                if (event.optString("threadId") == activeThreadId) handler.post { refreshQueue(false) }
            }
            "notification" -> handleNotificationEvent(event)
        }
    }

    private fun handleNotificationEvent(event: JSONObject) {
        val method = event.optString("method")
        val params = event.optJSONObject("params") ?: JSONObject()
        when (method) {
            "turn/started" -> {
                val eventThread = eventThreadId(params)
                if (eventThread == activeThreadId) { running = true; handler.post { renderHeader(); renderMessages(false) } }
            }
            "turn/completed" -> {
                val eventThread = eventThreadId(params)
                if (eventThread == activeThreadId) {
                    running = false
                    handler.post { renderHeader(); refreshActiveThread(false); refreshQueue(false) }
                } else if (eventThread != null) {
                    pendingCompletionNoticeThreadId = eventThread
                }
                if (!foreground && eventThread != null) showSystemNotification(eventThread)
                handler.post { refreshThreads(false) }
            }
            "item/agentMessage/delta" -> {
                val eventThread = eventThreadId(params)
                if (eventThread == activeThreadId) handler.post { scheduleActiveThreadRefresh() }
            }
            "item/started", "item/completed", "item/fileChange/patchUpdated", "turn/workspaceChanges" -> {
                val eventThread = eventThreadId(params)
                if (eventThread == activeThreadId) handler.post { scheduleActiveThreadRefresh() }
            }
            "thread/name/updated", "thread/deleted", "remote.pins.changed" -> handler.post { refreshThreads(false) }
        }
    }

    private fun eventThreadId(params: JSONObject): String? {
        params.optString("threadId").takeIf { it.isNotBlank() && it != "null" }?.let { return it }
        return params.optJSONObject("turn")?.optString("threadId")?.takeIf { it.isNotBlank() && it != "null" }
    }

    private fun respondApproval(decision: String) {
        val requestId = pendingApproval?.opt("request_id") ?: return
        socket?.send(JSONObject().put("type", "approval.response").put("request_id", requestId).put("decision", decision).toString())
        pendingApproval = null
        renderMessages(false)
    }

    private fun showSystemNotification(threadId: String) {
        if (!prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)) return
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            handler.post { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS) }
            return
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Codex Remote", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val thread = findThread(threadId)
        val title = thread?.optString("name")?.takeIf { !it.isNullOrBlank() && it != "null" } ?: "Codex 回复完成"
        val intent = Intent(this, MainActivity::class.java).apply {
            action = "$packageName.NOTIFICATION.$threadId"
            putExtra(EXTRA_THREAD_ID, threadId)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pending = PendingIntent.getActivity(this, threadId.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
        manager.notify(threadId.hashCode(), notification.setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title)
            .setContentText("有一条新的回复。打开查看对话。")
            .setContentIntent(pending).setAutoCancel(true).build())
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_NOTIFICATIONS || !notificationPermissionRequestedFromSettings) return
        notificationPermissionRequestedFromSettings = false
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        prefs.edit().putBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, granted).apply()
        refreshSettingsNotificationControl()
        showToast(if (granted) "系统通知已开启" else "未获得通知权限")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val threadId = intent.getStringExtra(EXTRA_THREAD_ID) ?: return
        handler.post {
            val thread = findThread(threadId)
            if (thread != null) selectThread(thread) else {
                activeThreadId = threadId
                activeThread = null
                historyLoadingThreadId = threadId
                historyLoadError = null
                historySelectionGeneration += 1
                queuedMessages = JSONArray()
                running = false
                renderMessages(false)
                renderQueue()
                loadThreadHistoryCacheThenRefresh(threadId)
            }
        }
    }

    private fun showStatus(message: String) {
        if (::statusView.isInitialized) {
            statusView.visibility = View.VISIBLE
            statusView.text = message
            statusView.setTextColor(WARNING)
            handler.postDelayed({ if (::statusView.isInitialized && statusView.text == message && runtime.optBoolean("connected", false)) statusView.visibility = View.GONE }, 5000)
        } else showToast(message)
    }

    private fun showToast(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private fun <T> runApi(block: () -> T, success: (T) -> Unit = {}, failure: (Throwable) -> Unit = { showStatus(it.message ?: "请求失败") }) {
        io.execute {
            try {
                val value = block()
                handler.post { if (!isFinishing && !isDestroyed) success(value) }
            } catch (error: Throwable) {
                handler.post { if (!isFinishing && !isDestroyed) failure(error) }
            }
        }
    }

    private fun messageText(item: JSONObject, role: String): String {
        if (role == "assistant") return flattenText(item.opt("text"))
        val content = item.optJSONArray("content") ?: return item.optString("text")
        val pieces = mutableListOf<String>()
        for (index in 0 until content.length()) {
            val part = content.optJSONObject(index) ?: continue
            if (part.optString("type") == "text") pieces += part.optString("text")
        }
        return pieces.joinToString("").ifBlank { item.optString("text") }
    }

    private fun messageTime(item: JSONObject, turn: JSONObject, assistant: Boolean): String {
        val itemValue = firstJsonValue(
            item,
            "createdAt", "created_at", "timestamp", "timestampMs", "timestamp_ms",
            "createdAtMs", "created_at_ms", "completedAt", "completed_at", "time", "date",
        )
        val turnValue = if (assistant) {
            firstJsonValue(
                turn,
                "completedAt", "completed_at", "completedAtMs", "completed_at_ms",
                "startedAt", "started_at", "startedAtMs", "started_at_ms",
                "createdAt", "created_at", "timestamp", "timestampMs", "timestamp_ms",
            )
        } else {
            firstJsonValue(turn, "startedAt", "started_at", "startedAtMs", "started_at_ms", "createdAt", "created_at", "timestamp", "timestampMs", "timestamp_ms")
        }
        return formatMessageTime(itemValue ?: turnValue)
    }

    private fun currentMessageTime(): String = formatMessageTime(Instant.now().toString())

    private fun firstJsonValue(value: JSONObject, vararg keys: String): Any? {
        for (key in keys) {
            val candidate = value.opt(key)
            if (candidate != null && candidate !== JSONObject.NULL && candidate.toString().isNotBlank() && candidate.toString() != "null") return candidate
        }
        return null
    }

    private fun formatMessageTime(value: Any?): String {
        val instant = try {
            when (value) {
                is Number -> {
                    val raw = value.toLong()
                    Instant.ofEpochMilli(if (raw in -9_999_999_999L..9_999_999_999L) raw * 1000L else raw)
                }
                is String -> {
                    val text = value.trim()
                    text.toLongOrNull()?.let { raw ->
                        Instant.ofEpochMilli(if (raw in -9_999_999_999L..9_999_999_999L) raw * 1000L else raw)
                    } ?: runCatching { Instant.parse(text) }.getOrNull()
                        ?: runCatching { OffsetDateTime.parse(text).toInstant() }.getOrNull()
                }
                else -> null
            }
        } catch (_: Exception) {
            null
        } ?: return ""
        val zone = ZoneId.systemDefault()
        val local = instant.atZone(zone)
        val pattern = if (local.toLocalDate() == LocalDate.now(zone)) "HH:mm" else "MM-dd HH:mm"
        return DateTimeFormatter.ofPattern(pattern, Locale.getDefault()).format(local)
    }

    private fun flattenText(value: Any?): String = when (value) {
        is String -> value
        is JSONArray -> (0 until value.length()).mapNotNull { index ->
            val part = value.optJSONObject(index) ?: return@mapNotNull null
            part.optString("text").takeIf { it.isNotBlank() }
        }.joinToString("")
        else -> ""
    }

    private fun isThreadRunning(thread: JSONObject): Boolean {
        val status = thread.optJSONObject("status")?.optString("type")
        if (status == "active" || status == "running") return true
        val turns = thread.optJSONArray("turns") ?: return false
        val last = turns.optJSONObject(turns.length() - 1) ?: return false
        val state = last.optString("status").lowercase(Locale.ROOT)
        return state == "inprogress" || state == "running"
    }

    private fun normalizedType(value: String) = value.replace("-", "").replace("_", "").lowercase(Locale.ROOT)

    private fun renderAttachmentStrip() {
        if (!::attachmentStrip.isInitialized) return
        attachmentStrip.removeAllViews()
        attachmentScroll.visibility = if (selectedFiles.isEmpty()) View.GONE else View.VISIBLE
        selectedFiles.toList().forEach { file ->
            if (file.optString("kind") == "image") {
                val frame = FrameLayout(this)
                val previewData = file.optString("thumbnail").ifBlank { file.optString("data") }
                val cacheKey = "attachment:${file.optString("name")}:${file.optString("data").length}:${file.optString("data").take(40).hashCode()}"
                val bitmap = messageImageCache.get(cacheKey) ?: runCatching {
                    decodeSampledBitmap(android.util.Base64.decode(previewData, android.util.Base64.DEFAULT), 160)
                        ?.also { messageImageCache.put(cacheKey, it) }
                }.getOrNull()
                val image = ImageView(this).apply {
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    background = rounded(PANEL_INSET, dp(8), BORDER, dp(1))
                    bitmap?.let(::setImageBitmap)
                    contentDescription = file.optString("name")
                    clipToOutline = true
                }
                frame.addView(image, FrameLayout.LayoutParams(dp(52), dp(52), Gravity.BOTTOM or Gravity.START))
                val remove = label("×", 15, TEXT, true).apply {
                    gravity = Gravity.CENTER
                    includeFontPadding = false
                    background = rounded(PANEL, dp(10), BORDER, dp(1))
                    contentDescription = "移除 ${file.optString("name")}"
                    setOnClickListener {
                        selectedFiles.remove(file)
                        renderAttachmentStrip()
                    }
                }
                frame.addView(remove, FrameLayout.LayoutParams(dp(20), dp(20), Gravity.TOP or Gravity.END))
                attachmentStrip.addView(frame, LinearLayout.LayoutParams(dp(60), dp(60)).apply {
                    rightMargin = dp(5)
                })
            } else {
                val chip = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(9), dp(3), dp(7), dp(3))
                    background = rounded(PANEL_INSET, dp(8))
                }
                chip.addView(label(file.optString("name"), 10, SUBTLE).apply {
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                }, LinearLayout.LayoutParams(dp(150), WRAP))
                chip.addView(label("×", 14, MUTED, true).apply {
                    gravity = Gravity.CENTER
                    contentDescription = "移除 ${file.optString("name")}"
                    setOnClickListener {
                        selectedFiles.remove(file)
                        renderAttachmentStrip()
                    }
                }, LinearLayout.LayoutParams(dp(22), dp(28)))
                attachmentStrip.addView(chip, LinearLayout.LayoutParams(WRAP, dp(42)).apply {
                    rightMargin = dp(5)
                })
            }
        }
    }

    private fun modelLabel(selected: String?): String {
        if (selected.isNullOrBlank()) return "模型"
        for (index in 0 until models.length()) {
            val model = models.optJSONObject(index) ?: continue
            val id = model.optString("model").ifBlank { model.optString("id") }
            if (id == selected) return model.optString("displayName").ifBlank { selected }
        }
        return selected
    }

    private fun claudeModelLabel(selected: String?): String = when (selected) {
        "opus" -> "Opus"
        "sonnet" -> "Sonnet"
        "fable" -> "Fable"
        "default", null -> "模型"
        else -> selected
    }

    private fun effortLabel(selected: String?): String = when (selected) {
        "minimal" -> "最小"
        "low" -> "低"
        "medium" -> "中"
        "high" -> "高"
        "xhigh" -> "极高"
        "max" -> "最大"
        null, "default" -> "思考"
        else -> selected
    }

    private fun approvalLabel(selected: String?): String = when (selected) {
        "untrusted" -> "批准"
        "never" -> "完全访问"
        else -> "请求批准"
    }

    private fun claudePermissionLabel(selected: String?): String = when (selected) {
        "manual" -> "手动确认"
        "acceptEdits" -> "自动编辑"
        "auto" -> "自动模式"
        "dontAsk" -> "不询问"
        "plan" -> "计划"
        else -> "权限"
    }

    private fun JSONObject.putIfAbsentCompat(key: String, value: Any?): JSONObject {
        if (!has(key)) put(key, value)
        return this
    }

    private fun shallowCopyObject(source: JSONObject, excludedKeys: Set<String> = emptySet()): JSONObject {
        val copy = JSONObject()
        val keys = source.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key !in excludedKeys) copy.put(key, source.opt(key) ?: JSONObject.NULL)
        }
        return copy
    }

    private fun jsonFitsHistoryCache(value: Any?): Boolean {
        var estimatedBytes = 0L

        fun addString(text: String): Boolean {
            if (text.length > MAX_HISTORY_CACHE_STRING_CHARS) return false
            for (character in text) {
                estimatedBytes += when {
                    character.code < 0x80 -> 1
                    character.code < 0x800 -> 2
                    character.isHighSurrogate() -> 2
                    else -> 3
                }
                if (estimatedBytes > MAX_HISTORY_CACHE_JSON_BYTES) return false
            }
            return true
        }

        fun scan(entry: Any?, depth: Int): Boolean {
            if (depth > MAX_HISTORY_CACHE_DEPTH || estimatedBytes > MAX_HISTORY_CACHE_JSON_BYTES) return false
            estimatedBytes += 2
            return when (entry) {
                null, JSONObject.NULL -> true
                is String -> addString(entry)
                is Number, is Boolean -> {
                    estimatedBytes += 24
                    estimatedBytes <= MAX_HISTORY_CACHE_JSON_BYTES
                }
                is JSONObject -> {
                    val keys = entry.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        if (!addString(key) || !scan(entry.opt(key), depth + 1)) return false
                    }
                    true
                }
                is JSONArray -> {
                    for (index in 0 until entry.length()) if (!scan(entry.opt(index), depth + 1)) return false
                    true
                }
                else -> addString(entry.toString())
            }
        }

        return scan(value, 0)
    }

    private fun editField(hintText: String, value: String, inputTypeValue: Int): EditText = EditText(this).apply {
        hint = hintText
        setText(value)
        inputType = inputTypeValue
        setTextColor(TEXT)
        setHintTextColor(MUTED)
        textSize = adjustedTextSize(14)
        setTag(R.id.base_text_size, 14f)
        setPadding(dp(12), dp(7), dp(12), dp(7))
        background = rounded(if (lightTheme) Color.rgb(255, 255, 255) else Color.rgb(18, 20, 24), dp(9), BORDER, dp(1))
    }

    private fun label(value: String, size: Int, color: Int, bold: Boolean = false): TextView = TextView(this).apply {
        text = value
        textSize = adjustedTextSize(size)
        setTag(R.id.base_text_size, size.toFloat())
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        gravity = Gravity.CENTER_VERTICAL
    }

    private fun iconButton(icon: String, description: String, action: () -> Unit): ImageButton = ImageButton(this).apply {
        setImageResource(iconResource(icon))
        imageTintList = ColorStateList.valueOf(if (icon == "codex") ACCENT else if (icon == "claude") ACCENT_WARM else SUBTLE)
        scaleType = ImageView.ScaleType.FIT_CENTER
        setPadding(dp(9), dp(9), dp(9), dp(9))
        contentDescription = description
        background = ColorDrawable(Color.TRANSPARENT)
        foreground = null
        stateListAnimator = null
        setDefaultFocusHighlightEnabled(false)
        isFocusable = true
        isClickable = true
        setOnClickListener { action() }
    }

    private fun setBrandIcon(view: ImageView, engine: String) {
        val claude = engine == "claude-code"
        view.setImageResource(if (claude) R.drawable.ic_brand_claude else R.drawable.ic_brand_codex)
        view.imageTintList = ColorStateList.valueOf(if (claude) ACCENT_WARM else ACCENT)
    }

    private fun codexBrandAccent(): Int = when (themeName) {
        "warm" -> Color.rgb(146, 114, 83)
        "custom" -> parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT)
        "light" -> Color.rgb(75, 96, 157)
        else -> Color.rgb(170, 186, 255)
    }

    private fun iconResource(icon: String): Int = when (icon) {
        "codex" -> R.drawable.ic_brand_codex
        "claude" -> R.drawable.ic_brand_claude
        "menu" -> R.drawable.ic_menu
        "terminal" -> R.drawable.ic_terminal
        "folder" -> R.drawable.ic_folder
        "add" -> R.drawable.ic_add
        "close" -> R.drawable.ic_close
        "more" -> R.drawable.ic_more
        "search" -> R.drawable.ic_search
        "settings" -> R.drawable.ic_settings
        "refresh" -> R.drawable.ic_refresh
        "arrow_up" -> R.drawable.ic_arrow_up
        "file" -> R.drawable.ic_file
        "file_add" -> R.drawable.ic_file_add
        "folder_add" -> R.drawable.ic_folder_add
        "paste" -> R.drawable.ic_paste
        "open" -> R.drawable.ic_open
        "edit" -> R.drawable.ic_edit
        "pin" -> R.drawable.ic_pin
        "copy" -> R.drawable.ic_copy
        "cut" -> R.drawable.ic_cut
        "delete" -> R.drawable.ic_delete
        "link" -> R.drawable.ic_link
        "check" -> R.drawable.ic_check
        "chevron_down" -> R.drawable.ic_chevron_down
        "chevron_up" -> R.drawable.ic_chevron_up
        "back" -> R.drawable.ic_back
        else -> R.drawable.ic_add
    }

    private fun preferenceButton(value: String, action: () -> Unit): TextView = label(value, 12, SUBTLE, true).apply {
        gravity = Gravity.CENTER
        setPadding(dp(7), 0, dp(7), 0)
        minWidth = dp(44)
        minHeight = dp(40)
        background = ColorDrawable(Color.TRANSPARENT)
        foreground = null
        stateListAnimator = null
        setDefaultFocusHighlightEnabled(false)
        setOnClickListener { action() }
    }

    private fun smallButton(value: String, action: () -> Unit): TextView = label(value, 12, SUBTLE, true).apply {
        gravity = Gravity.CENTER
        setPadding(dp(9), 0, dp(9), 0)
        background = rounded(PANEL_INSET, dp(7))
        setOnClickListener { action() }
    }

    private fun dialogTextButton(value: String, color: Int, action: () -> Unit): TextView = label(value, 12, color, true).apply {
        gravity = Gravity.CENTER
        setPadding(dp(10), 0, dp(10), 0)
        background = ColorDrawable(Color.TRANSPARENT)
        setOnClickListener { action() }
    }

    private fun actionButton(value: String): Button = Button(this).apply {
        text = value
        textSize = adjustedTextSize(13)
        setTag(R.id.base_text_size, 13f)
        setTextColor(DARK)
        isAllCaps = false
        background = rounded(if (lightTheme) Color.rgb(35, 38, 43) else Color.rgb(224, 226, 231), dp(9))
    }

    private fun rounded(color: Int, radius: Int, strokeColor: Int? = null, strokeWidth: Int = 0): GradientDrawable = GradientDrawable().apply {
        setColor(color)
        cornerRadius = radius.toFloat()
        if (strokeColor != null && strokeWidth > 0) setStroke(strokeWidth, strokeColor)
    }

    private fun widthWrap() = LinearLayout.LayoutParams(MATCH, WRAP)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun adjustedTextSize(baseSize: Int): Float = (baseSize + globalFontAdjustment()).coerceAtLeast(8).toFloat()

    private fun globalFontAdjustment(): Int = previewFontAdjustment ?: prefs.getInt(
        KEY_GLOBAL_FONT_ADJUSTMENT,
        (prefs.getInt(KEY_FONT_SIZE, 14) - 14).coerceIn(-3, 6),
    ).coerceIn(-3, 6)

    private fun applyGlobalFontAdjustment(view: View) {
        val baseSize = view.getTag(R.id.base_text_size) as? Float
        if (view is TextView && baseSize != null) view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, (baseSize + globalFontAdjustment()).coerceAtLeast(8f))
        if (view is ViewGroup) for (index in 0 until view.childCount) applyGlobalFontAdjustment(view.getChildAt(index))
    }

    private fun parseThemeColor(key: String, fallback: String): Int = runCatching {
        Color.parseColor(prefs.getString(key, fallback) ?: fallback)
    }.getOrElse { Color.parseColor(fallback) }

    private fun colorWithAlpha(color: Int, opacity: Float): Int = Color.argb(
        (Color.alpha(color) * opacity.coerceIn(0f, 1f)).toInt(),
        Color.red(color),
        Color.green(color),
        Color.blue(color),
    )

    private fun installThemeBackground(target: FrameLayout) {
        if (themeName != "custom") {
            target.setBackgroundColor(DARK)
            return
        }
        target.setBackgroundColor(DARK)
        val storedUri = prefs.getString(KEY_CUSTOM_BACKGROUND_IMAGE, null).orEmpty()
        if (storedUri.isBlank()) return
        val image = runCatching { decodeThemeBackground(Uri.parse(storedUri)) }.getOrNull() ?: return
        val opacity = (100 - prefs.getInt(KEY_BACKGROUND_TRANSPARENCY, 0)).coerceIn(0, 100) / 100f
        val imageView = ImageView(this).apply {
            setImageBitmap(image)
            scaleType = ImageView.ScaleType.CENTER_CROP
            alpha = opacity
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        target.addView(imageView, FrameLayout.LayoutParams(MATCH, MATCH))
    }

    private fun decodeThemeBackground(uri: Uri): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        val boundsRead = runCatching {
            contentResolver.openInputStream(uri)?.use {
                BitmapFactory.decodeStream(it, null, bounds)
                true
            } ?: false
        }.getOrDefault(false)
        if (!boundsRead) return null
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sampleSize = 1
        while (bounds.outWidth / sampleSize > 1800 || bounds.outHeight / sampleSize > 1800) sampleSize *= 2
        return contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply {
                inSampleSize = sampleSize
                inPreferredConfig = Bitmap.Config.RGB_565
            })
        }
    }

    companion object {
        private const val PREFS = "codex_remote_mobile"
        private const val KEY_ENDPOINT = "endpoint"
        private const val KEY_TOKEN = "token"
        private const val KEY_MODE = "native_engine_mode"
        private const val KEY_ACTIVE_THREAD_PREFIX = "native_active_thread_"
        private const val KEY_FONT_SIZE = "native_chat_font_size"
        private const val KEY_GLOBAL_FONT_ADJUSTMENT = "native_global_font_adjustment"
        private const val KEY_THEME = "native_theme"
        private const val KEY_CUSTOM_BACKGROUND = "native_custom_background_color"
        private const val KEY_CUSTOM_TEXT = "native_custom_text_color"
        private const val KEY_BACKGROUND_TRANSPARENCY = "native_background_transparency"
        private const val KEY_CUSTOM_BACKGROUND_IMAGE = "native_custom_background_image_uri"
        private const val DEFAULT_CUSTOM_BACKGROUND = "#4B5563"
        private const val DEFAULT_CUSTOM_TEXT = "#F1F5F9"
        private const val PREF_DEFAULT = "composer_default"
        private const val PREF_THREAD_PREFIX = "composer_thread_"
        private const val REQUEST_ATTACH = 4101
        private const val REQUEST_NOTIFICATIONS = 4102
        private const val REQUEST_THEME_BACKGROUND = 4103
        private const val CHANNEL_ID = "codex_remote_native"
        private const val EXTRA_THREAD_ID = "notification_thread_id"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        private const val KEY_LIGHT_THEME = "native_light_theme"
        private const val KEY_SYSTEM_NOTIFICATIONS_ENABLED = "native_system_notifications_enabled"
        private const val TAG_INSET_CONTENT = "inset_content"
        private const val TAG_MESSAGE_TURN_PREFIX = "message_turn:"
        private const val TAG_MESSAGE_DYNAMIC = "message_dynamic"
        private const val DEFAULT_VISIBLE_HISTORY_TURNS = 12
        private const val MAX_VISIBLE_SIDEBAR_THREADS = 80
        private val OPERATION_PATH_KEYS = setOf(
            "path", "filepath", "file_path", "filename", "target_path", "source_path", "imagepath", "image_path",
        )
        private val SEARCH_COMMAND_PATTERN = Regex("(?:^|\\s)(?:rg|grep|find|fd)(?:\\s|$)", RegexOption.IGNORE_CASE)
        private val VIEW_COMMAND_PATTERN = Regex("(?:^|\\s)(?:cat|head|tail|sed|less|bat)(?:\\s|$)", RegexOption.IGNORE_CASE)
        private val CONTROL_CHARACTER_PATTERN = Regex("[\\u0000-\\u001f\\u007f]+")
        private val WHITESPACE_PATTERN = Regex("\\s+")
        private const val MAX_CACHED_THREADS = 32
        private const val MAX_EAGER_HISTORY_CACHE_BYTES = 1024L * 1024L
        private const val MAX_SINGLE_HISTORY_CACHE_BYTES = 24L * 1024 * 1024
        private const val MAX_TOTAL_HISTORY_CACHE_BYTES = 64L * 1024 * 1024
        private const val MAX_HISTORY_CACHE_JSON_BYTES = 12 * 1024 * 1024
        private const val MAX_HISTORY_CACHE_STRING_CHARS = 3 * 1024 * 1024
        private const val MAX_HISTORY_CACHE_DEPTH = 64
        private const val MAX_INLINE_IMAGE_BASE64_CHARS = 12 * 1024 * 1024
        private const val MAX_FILE_PREVIEW_BASE64_CHARS = 12 * 1024 * 1024
        private const val MAX_DIFF_PREVIEW_LINES = 2500
    }
}

private class TerminalScreenBuffer(private val columns: Int, private val rows: Int) {
    private val screen = MutableList(rows) { CharArray(columns) { ' ' } }
    private var cursorRow = 0
    private var cursorColumn = 0
    private var savedRow = 0
    private var savedColumn = 0
    private var state = 0
    private val sequence = StringBuilder()

    fun append(value: String): String {
        value.forEach(::consume)
        val rendered = screen.map { String(it).trimEnd() }
        val first = rendered.indexOfFirst { it.isNotBlank() }
        val last = rendered.indexOfLast { it.isNotBlank() }
        return if (first < 0 || last < first) "等待终端输出…" else rendered.subList(first, last + 1).joinToString("\n")
    }

    private fun consume(character: Char) {
        when (state) {
            0 -> when (character) {
                '\u001b' -> state = 1
                '\r' -> cursorColumn = 0
                '\n' -> newLine()
                '\b' -> cursorColumn = (cursorColumn - 1).coerceAtLeast(0)
                '\t' -> cursorColumn = ((cursorColumn / 8 + 1) * 8).coerceAtMost(columns - 1)
                '\u0000', '\u0007' -> Unit
                else -> if (character >= ' ') put(character)
            }
            1 -> when (character) {
                '[' -> { sequence.setLength(0); state = 2 }
                ']' -> { sequence.setLength(0); state = 3 }
                '7' -> { savedRow = cursorRow; savedColumn = cursorColumn; state = 0 }
                '8' -> { cursorRow = savedRow; cursorColumn = savedColumn; state = 0 }
                'c' -> { clear(); state = 0 }
                '(', ')', '#', '%' -> state = 4
                else -> state = 0
            }
            2 -> {
                if (character in '@'..'~') {
                    applyCsi(character, sequence.toString())
                    state = 0
                } else if (sequence.length < 64) sequence.append(character) else state = 0
            }
            3 -> when {
                character == '\u0007' -> state = 0
                character == '\u001b' -> state = 5
                sequence.length < 512 -> sequence.append(character)
                else -> state = 0
            }
            4 -> state = 0
            5 -> state = if (character == '\\') 0 else 3
        }
    }

    private fun put(character: Char) {
        if (cursorColumn >= columns) newLine()
        screen[cursorRow][cursorColumn] = character
        cursorColumn += 1
    }

    private fun newLine() {
        cursorRow += 1
        cursorColumn = 0
        if (cursorRow < rows) return
        screen.removeAt(0)
        screen.add(CharArray(columns) { ' ' })
        cursorRow = rows - 1
    }

    private fun applyCsi(command: Char, raw: String) {
        val cleaned = raw.trimStart('?', '>', '!', '=')
        val values = cleaned.split(';').map { it.toIntOrNull() ?: 0 }
        fun value(index: Int, fallback: Int = 1): Int = values.getOrNull(index)?.takeIf { it > 0 } ?: fallback
        when (command) {
            'A' -> cursorRow = (cursorRow - value(0)).coerceAtLeast(0)
            'B' -> cursorRow = (cursorRow + value(0)).coerceAtMost(rows - 1)
            'C' -> cursorColumn = (cursorColumn + value(0)).coerceAtMost(columns - 1)
            'D' -> cursorColumn = (cursorColumn - value(0)).coerceAtLeast(0)
            'E' -> { cursorRow = (cursorRow + value(0)).coerceAtMost(rows - 1); cursorColumn = 0 }
            'F' -> { cursorRow = (cursorRow - value(0)).coerceAtLeast(0); cursorColumn = 0 }
            'G' -> cursorColumn = (value(0) - 1).coerceIn(0, columns - 1)
            'H', 'f' -> {
                cursorRow = (value(0) - 1).coerceIn(0, rows - 1)
                cursorColumn = (value(1) - 1).coerceIn(0, columns - 1)
            }
            'd' -> cursorRow = (value(0) - 1).coerceIn(0, rows - 1)
            'J' -> eraseDisplay(values.firstOrNull() ?: 0)
            'K' -> eraseLine(values.firstOrNull() ?: 0)
            'P' -> deleteCharacters(value(0))
            '@' -> insertCharacters(value(0))
            'X' -> repeat(value(0).coerceAtMost(columns - cursorColumn)) { screen[cursorRow][cursorColumn + it] = ' ' }
            'S' -> repeat(value(0).coerceAtMost(rows)) { screen.removeAt(0); screen.add(CharArray(columns) { ' ' }) }
            'T' -> repeat(value(0).coerceAtMost(rows)) { screen.removeAt(rows - 1); screen.add(0, CharArray(columns) { ' ' }) }
            's' -> { savedRow = cursorRow; savedColumn = cursorColumn }
            'u' -> { cursorRow = savedRow; cursorColumn = savedColumn }
        }
    }

    private fun eraseDisplay(mode: Int) {
        when (mode) {
            1 -> {
                for (row in 0 until cursorRow) screen[row].fill(' ')
                for (column in 0..cursorColumn.coerceAtMost(columns - 1)) screen[cursorRow][column] = ' '
            }
            2, 3 -> clear()
            else -> {
                for (column in cursorColumn until columns) screen[cursorRow][column] = ' '
                for (row in cursorRow + 1 until rows) screen[row].fill(' ')
            }
        }
    }

    private fun eraseLine(mode: Int) {
        when (mode) {
            1 -> for (column in 0..cursorColumn.coerceAtMost(columns - 1)) screen[cursorRow][column] = ' '
            2 -> screen[cursorRow].fill(' ')
            else -> for (column in cursorColumn until columns) screen[cursorRow][column] = ' '
        }
    }

    private fun deleteCharacters(count: Int) {
        val line = screen[cursorRow]
        val amount = count.coerceAtMost(columns - cursorColumn)
        for (column in cursorColumn until columns - amount) line[column] = line[column + amount]
        for (column in columns - amount until columns) line[column] = ' '
    }

    private fun insertCharacters(count: Int) {
        val line = screen[cursorRow]
        val amount = count.coerceAtMost(columns - cursorColumn)
        for (column in columns - 1 downTo cursorColumn + amount) line[column] = line[column - amount]
        for (column in cursorColumn until cursorColumn + amount) line[column] = ' '
    }

    private fun clear() {
        screen.forEach { it.fill(' ') }
        cursorRow = 0
        cursorColumn = 0
    }
}

private class SimpleTextWatcher(private val changed: (String) -> Unit) : android.text.TextWatcher {
    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = changed(s?.toString().orEmpty())
    override fun afterTextChanged(s: android.text.Editable?) = Unit
}

private fun InputStream.readAll(): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(16 * 1024)
    while (true) {
        val count = read(buffer)
        if (count < 0) break
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}

private fun String.modelLabel(selected: String?): String = if (selected.isNullOrBlank()) "模型" else selected

private fun MainActivity.modelLabel(selected: String?): String {
    if (selected.isNullOrBlank()) return "模型"
    for (index in 0 until models.length()) {
        val model = models.optJSONObject(index) ?: continue
        val id = model.optString("model").ifBlank { model.optString("id") }
        if (id == selected) return model.optString("displayName").ifBlank { selected }
    }
    return selected
}

private fun MainActivity.claudeModelLabel(selected: String?): String = when (selected) {
    "opus" -> "Opus"
    "sonnet" -> "Sonnet"
    "fable" -> "Fable"
    "default", null -> "模型"
    else -> selected
}

private fun MainActivity.effortLabel(selected: String?): String = when (selected) {
    "minimal" -> "最小"
    "low" -> "低"
    "medium" -> "中"
    "high" -> "高"
    "xhigh" -> "极高"
    "max" -> "最大"
    null, "default" -> "思考"
    else -> selected
}

private fun MainActivity.approvalLabel(selected: String?): String = when (selected) {
    "untrusted" -> "批准"
    "never" -> "完全访问"
    else -> "请求批准"
}

private fun MainActivity.claudePermissionLabel(selected: String?): String = when (selected) {
    "manual" -> "手动确认"
    "acceptEdits" -> "自动编辑"
    "auto" -> "自动模式"
    "dontAsk" -> "不询问"
    "plan" -> "计划"
    else -> "权限"
}

package com.sevencnup.codexremote

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.BitmapFactory
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowInsetsAnimation
import android.view.Window
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.abs

class MainActivity : Activity() {
    private val prefs by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }
    private val lightTheme get() = prefs.getBoolean(KEY_LIGHT_THEME, false)
    private val DARK: Int get() = if (lightTheme) Color.rgb(247, 248, 250) else Color.rgb(16, 17, 20)
    private val PANEL: Int get() = if (lightTheme) Color.rgb(255, 255, 255) else Color.rgb(23, 25, 30)
    private val PANEL_INSET: Int get() = if (lightTheme) Color.rgb(241, 243, 246) else Color.rgb(30, 32, 38)
    private val BORDER: Int get() = if (lightTheme) Color.rgb(213, 217, 224) else Color.rgb(52, 55, 63)
    private val USER_BUBBLE: Int get() = if (lightTheme) Color.rgb(232, 236, 244) else Color.rgb(29, 31, 37)
    private val TEXT: Int get() = if (lightTheme) Color.rgb(35, 38, 43) else Color.rgb(239, 241, 246)
    private val SUBTLE: Int get() = if (lightTheme) Color.rgb(77, 83, 93) else Color.rgb(194, 198, 208)
    private val MUTED: Int get() = if (lightTheme) Color.rgb(105, 112, 123) else Color.rgb(139, 145, 156)
    private val ACCENT: Int get() = if (lightTheme) Color.rgb(75, 96, 157) else Color.rgb(170, 186, 255)
    private val ACCENT_WARM = Color.rgb(217, 119, 87)
    private val WARNING: Int get() = if (lightTheme) Color.rgb(135, 91, 28) else Color.rgb(232, 190, 112)
    private val ERROR: Int get() = if (lightTheme) Color.rgb(173, 48, 57) else Color.rgb(229, 135, 142)
    private val handler = Handler(Looper.getMainLooper())
    private val io: ExecutorService = Executors.newFixedThreadPool(3)
    private val socketClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

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
    private var queueExpanded = false
    private var expandedOperationIds = mutableSetOf<String>()
    private var selectedFiles = mutableListOf<JSONObject>()
    private var workspaceClipboard = mutableListOf<String>()
    private var workspaceClipboardMode = "copy"
    private var socket: WebSocket? = null
    private var socketConnected = false
    private var outstandingSocketPing: String? = null
    private var socketPingSentAt = 0L
    private var pendingApproval: JSONObject? = null
    private var terminalDialog: Dialog? = null
    private var terminalSocket: WebSocket? = null
    private var terminalOutput: TextView? = null
    private var terminalDraftInput: EditText? = null
    private var attachRequestActive = false
    private var workspaceCurrentPath = ""
    private var workspaceRootPath = ""
    private var claudeAvailable = false
    private var claudeStatusMessage = "Claude Code 不可用"

    private lateinit var root: FrameLayout
    private lateinit var page: LinearLayout
    private lateinit var titleView: TextView
    private lateinit var modeButton: TextView
    private lateinit var statusView: TextView
    private lateinit var messageScroll: ScrollView
    private lateinit var messageList: LinearLayout
    private lateinit var queuePanel: LinearLayout
    private lateinit var queueContent: LinearLayout
    private lateinit var composerInput: EditText
    private lateinit var attachmentStrip: LinearLayout
    private lateinit var sendButton: TextView
    private lateinit var modelButton: TextView
    private lateinit var effortButton: TextView
    private lateinit var permissionButton: TextView
    private lateinit var drawer: LinearLayout
    private lateinit var drawerSearch: EditText
    private lateinit var drawerThreads: LinearLayout

    private val socketHeartbeatRunnable = object : Runnable {
        override fun run() {
            if (!foreground || !socketConnected) return
            val now = System.currentTimeMillis()
            if (outstandingSocketPing != null && now - socketPingSentAt > 45_000) {
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
    private val activeThreadRefreshRunnable = Runnable { refreshActiveThread(false) }

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
        showConnectionPage()
        if (endpoint.isNotBlank() && token.isNotBlank()) verifySavedConnection()
    }

    override fun onResume() {
        super.onResume()
        foreground = true
        if (token.isNotBlank()) {
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
        handler.removeCallbacks(refreshRunnable)
        handler.removeCallbacks(activeThreadRefreshRunnable)
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
            terminalDialog?.isShowing == true -> terminalDialog?.dismiss()
            sidebarVisible -> setSidebarVisible(false)
            activeThreadId != null -> AlertDialog.Builder(this)
                .setMessage("要关闭 Codex Remote 吗？")
                .setNegativeButton("继续使用", null)
                .setPositiveButton("关闭") { _, _ -> finish() }
                .show()
            else -> super.onBackPressed()
        }
    }

    private fun showConnectionPage(message: String? = null) {
        root = FrameLayout(this).apply { setBackgroundColor(DARK) }
        val scroll = ScrollView(this).apply { isFillViewport = true }
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

    private fun verifySavedConnection() {
        io.execute {
            try {
                RemoteApi(endpoint, token).get("/api/v1/codex/status")
                handler.post { openChatHome() }
            } catch (error: Exception) {
                handler.post {
                    prefs.edit().remove(KEY_TOKEN).apply()
                    token = ""
                    showConnectionPage(error.message ?: "连接已失效，请重新配对。")
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
        syncRevisions.clear()
        renderHome()
        refreshRuntime()
        refreshThreads(true)
        refreshPins()
        refreshClaudeStatus()
        refreshModels()
        connectSocket()
        handler.removeCallbacks(refreshRunnable)
        handler.post(refreshRunnable)
    }

    private fun installWindowInsets(view: View) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val update = { insets: WindowInsets ->
            val systemBars = insets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsets.Type.ime())
            val bottom = if (insets.isVisible(WindowInsets.Type.ime())) max(systemBars.bottom, ime.bottom) else systemBars.bottom
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, bottom)
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

    private fun renderHome() {
        root = ChatRootLayout(this).apply { setBackgroundColor(DARK) }
        page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(DARK)
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
            overScrollMode = View.OVER_SCROLL_NEVER
            clipToPadding = false
            setPadding(dp(12), dp(8), dp(12), dp(8))
        }
        messageList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        messageScroll.addView(messageList, FrameLayout.LayoutParams(MATCH, WRAP))
        page.addView(messageScroll, LinearLayout.LayoutParams(MATCH, 0, 1f))
        buildQueuePanel()
        buildComposer()
        buildSidebar()
        setContentView(root)
        installWindowInsets(root)
        renderHeader()
        renderMessages(false)
        renderQueue()
        renderSidebar()
    }

    private fun buildHeader() {
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(2), dp(8), dp(2))
            background = rounded(DARK, 0, BORDER, dp(1))
        }
        val menu = iconButton("☰", "打开对话列表") { setSidebarVisible(true) }
        header.addView(menu, LinearLayout.LayoutParams(dp(40), dp(40)))
        val titleColumn = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(4), 0, dp(4), 0) }
        titleView = label("Codex Remote", 14, TEXT, true).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        titleColumn.addView(titleView, widthWrap())
        val path = label("本机项目", 10, MUTED).apply { tag = "workspace_path"; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE }
        titleColumn.addView(path, widthWrap())
        header.addView(titleColumn, LinearLayout.LayoutParams(0, WRAP, 1f))
        modeButton = iconButton(if (currentMode == "codex") "◉" else "◈", "切换 Codex / Claude") { switchMode() }
        header.addView(modeButton, LinearLayout.LayoutParams(dp(40), dp(40)))
        header.addView(iconButton("▤", "打开终端") { showTerminal() }, LinearLayout.LayoutParams(dp(40), dp(40)))
        header.addView(iconButton("▣", "打开文件树") { showWorkspaceBrowser() }, LinearLayout.LayoutParams(dp(40), dp(40)))
        page.addView(header, LinearLayout.LayoutParams(MATCH, dp(44)))
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

    private fun buildComposer() {
        val dock = LinearLayout(this).apply {
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
        composer.addView(composerInput, LinearLayout.LayoutParams(MATCH, WRAP))
        attachmentStrip = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; visibility = View.GONE }
        composer.addView(attachmentStrip, widthWrap())

        val footer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        footer.addView(iconButton("＋", "添加图片或文件") { chooseAttachment() }, LinearLayout.LayoutParams(dp(40), dp(40)))
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
        sendButton = label("↑", 23, DARK, true).apply {
            gravity = Gravity.CENTER
            background = rounded(if (lightTheme) Color.rgb(35, 38, 43) else Color.rgb(228, 230, 235), dp(9))
            setOnClickListener { if (running) interruptTurn() else sendCurrentMessage() }
            contentDescription = "发送消息"
        }
        footer.addView(sendButton, LinearLayout.LayoutParams(dp(40), dp(38)).apply { leftMargin = dp(5) })
        composer.addView(footer, LinearLayout.LayoutParams(MATCH, dp(40)))
        dock.addView(composer, LinearLayout.LayoutParams(MATCH, WRAP))
        page.addView(dock, LinearLayout.LayoutParams(MATCH, WRAP))
        renderAttachmentStrip()
        updateComposerPreferences()
    }

    private fun buildSidebar() {
        drawer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(10))
            background = rounded(PANEL, dp(12), BORDER, dp(1))
            visibility = View.GONE
            elevation = dp(12).toFloat()
        }
        val heading = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        heading.addView(label("对话", 17, TEXT, true), LinearLayout.LayoutParams(0, WRAP, 1f))
        heading.addView(iconButton("×", "关闭对话列表") { setSidebarVisible(false) }, LinearLayout.LayoutParams(dp(40), dp(40)))
        drawer.addView(heading, LinearLayout.LayoutParams(MATCH, dp(40)))
        drawerSearch = editField("搜索聊天记录", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT).apply {
            setSingleLine(true)
            addTextChangedListener(SimpleTextWatcher { renderSidebar() })
        }
        drawer.addView(drawerSearch, LinearLayout.LayoutParams(MATCH, dp(36)).apply { topMargin = dp(7) })
        val newThread = actionButton("＋  新建对话")
        newThread.setOnClickListener { createThread() }
        drawer.addView(newThread, LinearLayout.LayoutParams(MATCH, dp(38)).apply { topMargin = dp(7) })
        val settings = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        settings.addView(smallButton("设置") { showSettings() }, LinearLayout.LayoutParams(0, dp(32), 1f).apply { rightMargin = dp(4); topMargin = dp(5) })
        settings.addView(smallButton("重新连接") { reconnect() }, LinearLayout.LayoutParams(0, dp(32), 1f).apply { leftMargin = dp(4); topMargin = dp(5) })
        drawer.addView(settings, widthWrap())
        val threadScroll = ScrollView(this).apply { overScrollMode = View.OVER_SCROLL_NEVER }
        drawerThreads = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(6), 0, 0) }
        threadScroll.addView(drawerThreads)
        drawer.addView(threadScroll, LinearLayout.LayoutParams(MATCH, 0, 1f))
        val scrim = View(this).apply {
            setBackgroundColor(Color.argb(140, 0, 0, 0))
            visibility = View.GONE
            setOnClickListener { setSidebarVisible(false) }
        }
        root.addView(scrim, FrameLayout.LayoutParams(MATCH, MATCH))
        root.addView(drawer, FrameLayout.LayoutParams(dp(300), MATCH, Gravity.START))
        drawer.tag = scrim
        renderSidebar()
    }

    private fun renderHeader() {
        if (!::titleView.isInitialized) return
        val title = activeThread?.optString("name")?.takeIf { it.isNotBlank() && it != "null" }
            ?: activeThread?.optString("preview")?.takeIf { it.isNotBlank() }
            ?: if (activeThreadId == null) "新对话" else "Codex Remote"
        titleView.text = title
        if (::modeButton.isInitialized) modeButton.text = if (currentMode == "codex") "◉" else "◈"
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
        sendButton.background = rounded(if (running) PANEL_INSET else if (lightTheme) Color.rgb(35, 38, 43) else Color.rgb(228, 230, 235), dp(9))
        updateComposerPreferences()
    }

    private fun renderSidebar() {
        if (!::drawerThreads.isInitialized) return
        drawerThreads.removeAllViews()
        val query = if (::drawerSearch.isInitialized) drawerSearch.text.toString().trim().lowercase(Locale.ROOT) else ""
        val filtered = mutableListOf<JSONObject>()
        for (index in 0 until threads.length()) {
            val thread = threads.optJSONObject(index) ?: continue
            if (thread.optString("engine", "codex") != currentMode) continue
            val title = thread.optString("name").ifBlank { thread.optString("preview") }
            if (query.isNotBlank() && !title.lowercase(Locale.ROOT).contains(query)) continue
            filtered += thread
        }
        filtered.sortWith(compareByDescending<JSONObject> { pinnedThreadIds.contains(it.optString("id")) }
            .thenByDescending { it.optString("updatedAt") })
        if (filtered.isEmpty()) {
            drawerThreads.addView(label(if (query.isBlank()) "還没有对话" else "没有匹配的对话", 12, MUTED).apply {
                setPadding(dp(8), dp(16), dp(8), dp(16))
            }, widthWrap())
        }
        filtered.forEach { thread ->
            val id = thread.optString("id")
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(9), dp(6), dp(6), dp(6))
                background = rounded(if (id == activeThreadId) PANEL_INSET else Color.TRANSPARENT, dp(8))
            }
            val icon = label(if (thread.optString("engine") == "claude-code") "◈" else "◉", 14, if (thread.optString("engine") == "claude-code") ACCENT_WARM else ACCENT, true)
            row.addView(icon, LinearLayout.LayoutParams(dp(24), WRAP))
            val title = thread.optString("name").ifBlank { thread.optString("preview").ifBlank { "新对话" } }
            val titleView = label(title, 13, if (id == activeThreadId) TEXT else SUBTLE).apply {
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
            }
            row.addView(titleView, LinearLayout.LayoutParams(0, WRAP, 1f))
            row.addView(iconButton("⋮", "对话操作") { showThreadActions(thread) }, LinearLayout.LayoutParams(dp(30), dp(30)))
            row.setOnClickListener { selectThread(thread) }
            row.setOnLongClickListener { showThreadActions(thread); true }
            drawerThreads.addView(row, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(2) })
        }
    }

    private fun setSidebarVisible(visible: Boolean) {
        sidebarVisible = visible
        if (!::drawer.isInitialized) return
        drawer.visibility = if (visible) View.VISIBLE else View.GONE
        (drawer.tag as? View)?.visibility = if (visible) View.VISIBLE else View.GONE
        if (visible) renderSidebar()
    }

    private inner class ChatRootLayout(context: Context) : FrameLayout(context) {
        private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
        private var startX = 0f
        private var startY = 0f
        private var swipeCandidate = false
        private var interceptingSwipe = false

        override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startX = event.x
                    startY = event.y
                    swipeCandidate = if (sidebarVisible) {
                        event.x < dp(300)
                    } else {
                        // Stay outside Android's reserved back-gesture strip.
                        event.x in dp(24).toFloat()..dp(56).toFloat()
                    }
                    interceptingSwipe = false
                }
                MotionEvent.ACTION_MOVE -> {
                    if (swipeCandidate && !interceptingSwipe) {
                        val dx = event.x - startX
                        val dy = event.y - startY
                        val horizontal = abs(dx) > touchSlop && abs(dx) > abs(dy) * 1.25f
                        val opens = !sidebarVisible && dx > touchSlop
                        val closes = sidebarVisible && dx < -touchSlop
                        if (horizontal && (opens || closes)) {
                            interceptingSwipe = true
                            return true
                        }
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> swipeCandidate = false
            }
            return interceptingSwipe || super.onInterceptTouchEvent(event)
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            if (!interceptingSwipe) return super.onTouchEvent(event)
            when (event.actionMasked) {
                MotionEvent.ACTION_UP -> {
                    val dx = event.x - startX
                    if (abs(dx) >= dp(56)) setSidebarVisible(dx > 0)
                    interceptingSwipe = false
                    swipeCandidate = false
                }
                MotionEvent.ACTION_CANCEL -> {
                    interceptingSwipe = false
                    swipeCandidate = false
                }
            }
            return true
        }
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
                    renderSidebar()
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
                    renderSidebar()
                    val selected = activeThreadId
                    if (selected != null) {
                        val latest = findThread(selected)
                        if (latest != null) {
                            activeThread?.put("name", latest.optString("name"))
                            activeThread?.put("preview", latest.optString("preview"))
                            activeThread?.put("cwd", latest.optString("cwd"))
                            activeThread?.put("status", latest.optJSONObject("status") ?: JSONObject())
                            if (latest.optJSONObject("status")?.optString("type") == "active") running = true
                            renderHeader()
                        } else {
                            activeThreadId = null
                            activeThread = null
                            renderHeader()
                            renderMessages(false)
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

    private fun selectThread(thread: JSONObject) {
        val id = thread.optString("id")
        if (id.isBlank()) return
        persistCurrentDraft()
        activeThreadId = id
        activeThread = thread
        currentMode = thread.optString("engine", "codex")
        prefs.edit().putString(KEY_MODE, currentMode).putString("$KEY_ACTIVE_THREAD_PREFIX$currentMode", id).apply()
        running = thread.optJSONObject("status")?.optString("type") == "active"
        pendingApproval = null
        queuedMessages = JSONArray()
        setSidebarVisible(false)
        renderHeader()
        renderSidebar()
        composerInput.setText(prefs.getString(draftStorageKey(), ""))
        renderMessages(true)
        refreshActiveThread(true)
        refreshQueue(true)
        socket?.send(JSONObject().put("type", "thread.subscribe").put("thread_id", id).toString())
    }

    private fun refreshActiveThread(showLoading: Boolean) {
        val threadId = activeThreadId ?: return
        if (!threadReadsInFlight.add(threadId)) {
            pendingThreadReads.add(threadId)
            return
        }
        val revision = syncRevisions[threadId]
        io.execute {
            try {
                val api = RemoteApi(endpoint, token)
                val encodedId = RemoteApi.encodePath(threadId)
                var response = api.get("/api/v1/codex/threads/$encodedId" + if (revision.isNullOrBlank()) "" else "?since=${RemoteApi.encodePath(revision)}")
                val merged = if (revision != null) mergeHistory(threadId, activeThread, response, revision) else response
                if (merged == null) {
                    response = api.get("/api/v1/codex/threads/$encodedId")
                }
                val resolved = merged ?: response
                val sync = resolved.optJSONObject("historySync") ?: response.optJSONObject("historySync")
                val newRevision = sync?.optString("revision")?.takeIf { !it.isNullOrBlank() && it != "null" }
                handler.post {
                    finishThreadRead(threadId)
                    if (activeThreadId != threadId) return@post
                    if (newRevision != null) syncRevisions[threadId] = newRevision
                    activeThread = resolved
                    running = isThreadRunning(resolved)
                    renderHeader()
                    renderMessages(!showLoading)
                }
            } catch (error: Exception) {
                handler.post {
                    finishThreadRead(threadId)
                    if (showLoading) showStatus(error.message ?: "读取对话失败")
                }
            }
        }
    }

    private fun finishThreadRead(threadId: String) {
        threadReadsInFlight.remove(threadId)
        if (pendingThreadReads.remove(threadId) && activeThreadId == threadId) refreshActiveThread(false)
    }

    private fun scheduleActiveThreadRefresh() {
        handler.removeCallbacks(activeThreadRefreshRunnable)
        handler.postDelayed(activeThreadRefreshRunnable, 650)
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
            turns[id] = JSONObject(changed.toString()).put("items", ordered)
        }
        val order = sync.optJSONArray("turnIds") ?: return null
        val mergedTurns = JSONArray()
        for (index in 0 until order.length()) mergedTurns.put(turns[order.optString(index)] ?: return null)
        val result = JSONObject(delta.toString()).put("turns", mergedTurns)
        val oldChanges = old.optJSONObject("codexRemoteWorkspaceChanges") ?: JSONObject()
        val changes = JSONObject(oldChanges.toString())
        val freshChanges = delta.optJSONObject("codexRemoteWorkspaceChanges") ?: JSONObject()
        val workspaceOrder = sync.optJSONArray("workspaceTurnIds")
        if (workspaceOrder != null) {
            for (index in 0 until workspaceOrder.length()) {
                val key = workspaceOrder.optString(index)
                if (freshChanges.has(key)) changes.put(key, freshChanges.get(key))
            }
        }
        result.put("codexRemoteWorkspaceChanges", changes)
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

    private fun renderMessages(scrollToEnd: Boolean) {
        if (!::messageList.isInitialized) return
        val wasNearEnd = messageScroll.scrollY + messageScroll.height >= messageList.height - dp(120)
        messageList.removeAllViews()
        val thread = activeThread
        val turns = thread?.optJSONArray("turns") ?: JSONArray()
        val messages = mutableListOf<Pair<String, JSONObject>>()
        val operations = mutableListOf<JSONObject>()
        for (turnIndex in 0 until turns.length()) {
            val turn = turns.optJSONObject(turnIndex) ?: continue
            val turnId = turn.optString("id")
            val items = turn.optJSONArray("items") ?: JSONArray()
            for (itemIndex in 0 until items.length()) {
                val item = items.optJSONObject(itemIndex) ?: continue
                when (normalizedType(item.optString("type"))) {
                    "usermessage" -> messages += "user" to JSONObject(item.toString()).put("_turnId", turnId)
                    "agentmessage" -> messages += "assistant" to JSONObject(item.toString()).put("_turnId", turnId).put("_duration", turn.optLong("durationMs", 0))
                    else -> operations += JSONObject(item.toString()).put("_turnId", turnId)
                }
            }
        }
        if (messages.isEmpty() && activeThreadId == null) {
            messageList.addView(label("与 Codex Remote 一起完成项目", 19, TEXT, true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(14), dp(36), dp(14), dp(30))
            }, LinearLayout.LayoutParams(MATCH, WRAP))
        } else if (messages.isEmpty() && thread != null && turns.length() == 0) {
            messageList.addView(label(if (currentMode == "claude-code") "与 Claude Code 一起完成项目" else "与 Codex Remote 一起完成项目", 18, TEXT, true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(14), dp(36), dp(14), dp(30))
            }, LinearLayout.LayoutParams(MATCH, WRAP))
        }

        val operationsByTurn = operations.groupBy { it.optString("_turnId") }
        val lastAssistantByTurn = messages.filter { it.first == "assistant" }.groupBy { it.second.optString("_turnId") }
            .mapValues { (_, values) -> values.lastOrNull()?.second?.optString("id") }
        messages.forEach { (role, item) ->
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
                val name = label(if (currentMode == "claude-code") "Claude" else "Codex", 11, MUTED, true)
                bubble.addView(name, widthWrap())
            }
            val text = messageText(item, role)
            val hasImage = item.optJSONArray("content")?.let { parts ->
                (0 until parts.length()).any { parts.optJSONObject(it)?.optString("type") in setOf("image", "localImage") }
            } == true
            if (text.isNotBlank() || !hasImage) {
                val content = label(text.ifBlank { "（附件消息）" }, prefs.getInt(KEY_FONT_SIZE, 14), TEXT).apply {
                    setTextIsSelectable(true)
                    setLineSpacing(dp(2).toFloat(), 1.08f)
                    typeface = Typeface.create("sans-serif", Typeface.NORMAL)
                }
                bubble.addView(content, widthWrap())
            }
            addMessageImages(bubble, item)
            val time = item.optString("createdAt").ifBlank { item.optString("timestamp") }
            if (time.isNotBlank()) bubble.addView(label(time.take(16).replace('T', ' '), 9, MUTED), widthWrap())
            val maxBubbleWidth = (resources.displayMetrics.widthPixels * if (role == "user") .84f else .96f).toInt()
            row.addView(bubble, LinearLayout.LayoutParams(maxBubbleWidth, WRAP))
            messageList.addView(row, LinearLayout.LayoutParams(MATCH, WRAP))

            if (role == "assistant" && lastAssistantByTurn[item.optString("_turnId")] == item.optString("id")) {
                val turnOps = operationsByTurn[item.optString("_turnId")].orEmpty()
                if (turnOps.isNotEmpty()) addOperationLog(item.optString("_turnId"), turnOps)
                val fileChanges = thread?.optJSONObject("codexRemoteWorkspaceChanges")?.optJSONObject(item.optString("_turnId"))
                if (fileChanges != null) addFileChangeSummary(fileChanges)
            }
        }
        val approval = pendingApproval
        if (approval != null) renderApproval(approval)
        if (running) {
            messageList.addView(label("◌  ${activityLabel}", 12, ACCENT).apply {
                setPadding(dp(12), dp(8), dp(12), dp(8))
            }, widthWrap())
        }
        if (scrollToEnd || wasNearEnd) messageScroll.post { messageScroll.fullScroll(View.FOCUS_DOWN) }
    }

    private val activityLabel: String
        get() = if (socketConnected) "正在思考…" else "正在等待连接…"

    private fun addOperationLog(turnId: String, operations: List<JSONObject>) {
        val expanded = turnId in expandedOperationIds
        val header = label("⌄  操作记录 · ${operations.size}", 12, MUTED, true).apply {
            setPadding(dp(8), dp(5), dp(8), dp(5))
            setOnClickListener {
                if (expanded) expandedOperationIds.remove(turnId) else expandedOperationIds.add(turnId)
                renderMessages(false)
            }
        }
        messageList.addView(header, widthWrap())
        if (!expanded) return
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(2), 0, dp(5)) }
        operations.forEach { operation ->
            val kind = operation.optString("type").replace(Regex("([a-z])([A-Z])"), "$1 $2")
            val detail = operation.optString("command").ifBlank { operation.optString("description") }
                .ifBlank { operation.optString("path") }.ifBlank { kind }
            list.addView(label("•  $detail", 11, SUBTLE).apply { setPadding(0, dp(3), 0, dp(3)); setTextIsSelectable(true) }, widthWrap())
            val changes = operation.optJSONArray("changes")
            if (changes != null) for (index in 0 until changes.length()) {
                val change = changes.optJSONObject(index) ?: continue
                val path = change.optString("path").ifBlank { change.optString("filePath") }
                if (path.isNotBlank()) list.addView(label("  ${change.optString("kind", "修改")} · $path", 11, ACCENT).apply {
                    setPadding(0, dp(2), 0, dp(3))
                    setOnClickListener { showFilePreview(path, null) }
                }, widthWrap())
            }
        }
        messageList.addView(list, widthWrap())
    }

    private fun addMessageImages(container: LinearLayout, item: JSONObject) {
        val content = item.optJSONArray("content") ?: return
        for (index in 0 until content.length()) {
            val part = content.optJSONObject(index) ?: continue
            val type = part.optString("type")
            val dataValue = if (type == "image") part.optString("image_url") else if (type == "localImage") part.optString("data") else ""
            val data = dataValue.substringAfter("base64,", dataValue)
            if (data.isBlank()) continue
            try {
                val bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT)
                val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
                options.inSampleSize = 1
                while (options.outWidth / options.inSampleSize > 720 || options.outHeight / options.inSampleSize > 720) options.inSampleSize *= 2
                options.inJustDecodeBounds = false
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: continue
                val image = ImageView(this).apply {
                    setImageBitmap(bitmap)
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    background = rounded(USER_BUBBLE, dp(8))
                    setOnClickListener {
                        val full = ImageView(this@MainActivity).apply { setImageBitmap(bitmap); adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER }
                        AlertDialog.Builder(this@MainActivity).setView(full).setPositiveButton("关闭", null).show()
                    }
                }
                container.addView(image, LinearLayout.LayoutParams(MATCH, dp(190)).apply { topMargin = dp(5) })
            } catch (_: Exception) { }
        }
    }

    private fun addFileChangeSummary(changes: JSONObject) {
        val entries = changes.optJSONArray("changes") ?: JSONArray()
        if (entries.length() == 0) return
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), dp(7), dp(10), dp(7))
            background = rounded(if (lightTheme) Color.rgb(232, 242, 233) else Color.rgb(24, 28, 27), dp(10), if (lightTheme) Color.rgb(188, 211, 190) else Color.rgb(45, 62, 51), dp(1))
        }
        card.addView(label("已编辑文件 · ${entries.length()}", 12, TEXT, true), widthWrap())
        for (index in 0 until entries.length()) {
            val item = entries.optJSONObject(index) ?: continue
            val path = item.optString("path").ifBlank { item.optString("filePath") }
            if (path.isBlank()) continue
            val line = label("•  $path", 11, ACCENT).apply { setPadding(0, dp(4), 0, 0); setOnClickListener { showFilePreview(path, null) } }
            card.addView(line, widthWrap())
        }
        messageList.addView(card, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(3); bottomMargin = dp(4) })
    }

    private fun renderApproval(approval: JSONObject) {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(9))
            background = rounded(if (lightTheme) Color.rgb(250, 245, 232) else Color.rgb(43, 37, 27), dp(12), if (lightTheme) Color.rgb(224, 205, 163) else Color.rgb(98, 77, 44), dp(1))
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
        header.addView(label(if (queueExpanded) "⌃" else "⌄", 15, MUTED).apply {
            gravity = Gravity.CENTER
            setOnClickListener { queueExpanded = !queueExpanded; renderQueue() }
        }, LinearLayout.LayoutParams(dp(28), dp(28)))
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
            val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END }
            controls.addView(smallButton("✎") { editQueuedMessage(item) }, LinearLayout.LayoutParams(WRAP, dp(29)).apply { rightMargin = dp(4) })
            controls.addView(smallButton("↑") { sendQueuedNow(item) }, LinearLayout.LayoutParams(WRAP, dp(29)).apply { rightMargin = dp(4) })
            controls.addView(smallButton("×") { removeQueuedMessage(item) }, LinearLayout.LayoutParams(WRAP, dp(29)))
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
        val input = EditText(this).apply { setText(item.optString("text")); minLines = 3; maxLines = 8 }
        AlertDialog.Builder(this).setTitle("修改排队消息").setView(input)
            .setNegativeButton("取消", null)
            .setPositiveButton("确定") { _, _ ->
                val threadId = activeThreadId ?: return@setPositiveButton
                val ownerId = "android-${UUID.randomUUID()}"
                val updated = JSONObject(item.toString()).put("text", input.text.toString()).put("requestText", input.text.toString())
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
            }.show()
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
            running = false
            renderMessages(false)
            renderQueue()
            renderHeader()
        }
        if (::composerInput.isInitialized) composerInput.setText(prefs.getString(draftStorageKey(), ""))
        renderSidebar()
        showToast(if (currentMode == "codex") "Codex 对话" else "Claude Code 对话")
    }

    private fun showThreadActions(thread: JSONObject) {
        val actions = arrayOf("打开", "重命名", "固定 / 取消固定", "删除")
        AlertDialog.Builder(this).setTitle(thread.optString("name").ifBlank { "对话操作" }).setItems(actions) { _, which ->
            when (which) {
                0 -> selectThread(thread)
                1 -> renameThread(thread)
                2 -> togglePin(thread)
                3 -> deleteThread(thread)
            }
        }.show()
    }

    private fun renameThread(thread: JSONObject) {
        val input = EditText(this).apply { setText(thread.optString("name").ifBlank { thread.optString("preview") }); setSingleLine(true) }
        AlertDialog.Builder(this).setTitle("聊天名称").setView(input).setNegativeButton("取消", null)
            .setPositiveButton("保存") { _, _ ->
                val name = input.text.toString().trim()
                runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/threads/${RemoteApi.encodePath(thread.optString("id"))}/name", JSONObject().put("name", name)) }, {
                    refreshThreads(false)
                    if (activeThreadId == thread.optString("id")) { activeThread?.put("name", name); renderHeader() }
                })
            }.show()
    }

    private fun togglePin(thread: JSONObject) {
        val id = thread.optString("id")
        val pinned = id in pinnedThreadIds
        runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/threads/${RemoteApi.encodePath(id)}/pin", JSONObject().put("pinned", !pinned)) }, {
            if (pinned) pinnedThreadIds.remove(id) else pinnedThreadIds.add(id)
            renderSidebar()
        })
    }

    private fun deleteThread(thread: JSONObject) {
        AlertDialog.Builder(this).setMessage("删除这个聊天？")
            .setNegativeButton("取消", null)
            .setPositiveButton("删除") { _, _ ->
                val id = thread.optString("id")
                runApi({ RemoteApi(endpoint, token).delete("/api/v1/codex/threads/${RemoteApi.encodePath(id)}") }, {
                    if (activeThreadId == id) {
                        prefs.edit().remove("$KEY_ACTIVE_THREAD_PREFIX$currentMode").apply()
                        activeThreadId = null; activeThread = null; running = false; renderMessages(false); renderHeader()
                    }
                    syncRevisions.remove(id)
                    refreshThreads(false)
                })
            }.show()
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
        val choices = listOf("默认" to "default") + values
        showChoiceDialog("模型", choices, preference(if (currentMode == "codex") "model" else "claudeModel")) { selected ->
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
        showChoiceDialog("思考等级", listOf("default" to "默认") + choices, preference(key)) { savePreference(key, it.takeIf { value -> value != "default" }) }
    }

    private fun showPermissionOptions() {
        if (currentMode == "codex") {
            showChoiceDialog("授权", listOf("on-request" to "请求批准", "untrusted" to "帮我批准", "never" to "完全访问"), preference("approvalPolicy") ?: "on-request") {
                savePreference("approvalPolicy", it)
                val threadId = activeThreadId
                if (threadId != null) runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/threads/${RemoteApi.encodePath(threadId)}/settings", JSONObject().put("approval_policy", it)) })
            }
        } else {
            showChoiceDialog("权限模式", listOf(
                "default" to "本机默认权限", "manual" to "手动确认", "acceptEdits" to "自动接受编辑",
                "auto" to "自动模式", "dontAsk" to "不询问（拒绝需授权操作）", "plan" to "计划模式",
            ), preference("claudePermissionMode") ?: "default") { savePreference("claudePermissionMode", it) }
        }
    }

    private fun showChoiceDialog(title: String, choices: List<Pair<String, String>>, selected: String?, onChoice: (String) -> Unit) {
        val names = choices.map { if (it.first == selected) "✓  ${it.second}" else it.second }.toTypedArray()
        AlertDialog.Builder(this).setTitle(title).setItems(names) { _, which -> choices.getOrNull(which)?.let { onChoice(it.first) } }.show()
    }

    private fun modelDefaultEffort(modelName: String): String? {
        val model = (0 until models.length()).mapNotNull { models.optJSONObject(it) }.firstOrNull {
            it.optString("model").ifBlank { it.optString("id") } == modelName
        } ?: return null
        return model.optString("defaultReasoningEffort").takeIf { it.isNotBlank() && it != "null" }
    }

    private fun showSettings() {
        val choices = arrayOf("调整字体大小", "浅色 / 深色主题", "更改电脑地址", "解除配对")
        AlertDialog.Builder(this).setTitle("设置").setItems(choices) { _, which ->
            when (which) {
                0 -> showFontSizeDialog()
                1 -> {
                    prefs.edit().putBoolean(KEY_LIGHT_THEME, !lightTheme).apply()
                    recreate()
                }
                2 -> showConnectionPage()
                3 -> AlertDialog.Builder(this).setMessage("解除本机配对？").setNegativeButton("取消", null).setPositiveButton("解除") { _, _ ->
                    runApi({ RemoteApi(endpoint, token).post("/api/v1/unpair") }, {
                        prefs.edit().remove(KEY_TOKEN).apply(); token = ""; socket?.close(1000, "unpaired"); showConnectionPage()
                    })
                }.show()
            }
        }.show()
    }

    private fun reconnect() {
        val codeInput = EditText(this).apply {
            hint = "输入电脑终端显示的匹配码"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setTextColor(TEXT)
        }
        AlertDialog.Builder(this).setTitle("重新配对").setView(codeInput)
            .setNegativeButton("取消", null)
            .setPositiveButton("连接") { _, _ ->
                val code = codeInput.text.toString().trim()
                if (code.isBlank()) return@setPositiveButton
                runApi({ RemoteApi(endpoint).post("/api/v1/pair", JSONObject().put("code", code)).getString("token") }, { newToken ->
                    token = newToken
                    prefs.edit().putString(KEY_TOKEN, newToken).apply()
                    openChatHome()
                })
            }.show()
    }

    private fun showWorkspaceBrowser() {
        if (token.isBlank()) return
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(9), dp(12), dp(8))
            background = rounded(PANEL, dp(16), BORDER, dp(1))
        }
        val currentPath = arrayOf("")
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val pathTitle = label("文件", 14, TEXT, true).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE }
        header.addView(pathTitle, LinearLayout.LayoutParams(0, dp(35), 1f))
        header.addView(iconButton("↥", "返回上级目录") {
            val normalized = currentPath[0].trimEnd('/')
            currentPath[0] = normalized.substringBeforeLast('/', "")
            workspaceCurrentPath = currentPath[0]
            refreshDirectory()
        }, LinearLayout.LayoutParams(dp(32), dp(32)))
        header.addView(iconButton("＋", "新建文件或文件夹") { showCreateEntry(currentPath[0], ::refreshDirectory) }, LinearLayout.LayoutParams(dp(32), dp(32)))
        header.addView(iconButton("×", "关闭文件树") { dialog.dismiss() }, LinearLayout.LayoutParams(dp(32), dp(32)))
        content.addView(header, widthWrap())
        val entries = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scroll = ScrollView(this).apply { overScrollMode = View.OVER_SCROLL_NEVER }
        scroll.addView(entries)
        content.addView(scroll, LinearLayout.LayoutParams(MATCH, 0, 1f).apply { topMargin = dp(5); bottomMargin = dp(6) })
        val footer = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        footer.addView(label("长按条目可重命名、复制、剪切或删除", 10, MUTED), LinearLayout.LayoutParams(0, WRAP, 1f))
        footer.addView(smallButton("粘贴") { pasteWorkspaceEntries(currentPath[0], ::refreshDirectory) })
        content.addView(footer, widthWrap())

        fun load(path: String) {
            currentPath[0] = path
            workspaceCurrentPath = path
            pathTitle.text = path.ifBlank { activeThread?.optString("cwd")?.takeIf { !it.isNullOrBlank() && it != "null" } ?: runtime.optString("workspace", "工作区") }
            entries.removeAllViews()
            entries.addView(label("正在读取…", 12, MUTED).apply { setPadding(dp(8), dp(12), dp(8), dp(12)) }, widthWrap())
            val cwd = activeThread?.optString("cwd")?.takeIf { !it.isNullOrBlank() && it != "null" }
            val query = buildString {
                append("?path=${Uri.encode(path)}")
                if (!cwd.isNullOrBlank()) append("&cwd=${Uri.encode(cwd)}")
            }
            io.execute {
                try {
                    val tree = RemoteApi(endpoint, token).get("/api/v1/codex/workspace/tree$query")
                    handler.post {
                        if (!dialog.isShowing || currentPath[0] != path) return@post
                        workspaceRootPath = tree.optString("cwd")
                        pathTitle.text = tree.optString("cwd", "") + if (path.isBlank()) "" else "/$path"
                        entries.removeAllViews()
                        val children = tree.optJSONArray("entries") ?: JSONArray()
                        if (children.length() == 0) entries.addView(label("空文件夹", 12, MUTED).apply { setPadding(dp(8), dp(12), dp(8), dp(12)) }, widthWrap())
                        for (index in 0 until children.length()) {
                            val entry = children.optJSONObject(index) ?: continue
                            val isDirectory = entry.optString("kind") == "directory"
                            val row = LinearLayout(this@MainActivity).apply {
                                orientation = LinearLayout.HORIZONTAL
                                gravity = Gravity.CENTER_VERTICAL
                                setPadding(dp(8), dp(6), dp(5), dp(6))
                                background = rounded(Color.TRANSPARENT, dp(7))
                            }
                            row.addView(label(if (isDirectory) "▰" else fileGlyph(entry.optString("name")), 14, if (isDirectory) ACCENT else SUBTLE, true), LinearLayout.LayoutParams(dp(25), WRAP))
                            val name = label(entry.optString("name"), 13, TEXT).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE }
                            row.addView(name, LinearLayout.LayoutParams(0, WRAP, 1f))
                            if (!isDirectory) row.addView(label(formatFileSize(entry.optLong("size")), 10, MUTED), widthWrap())
                            row.setOnClickListener {
                                if (isDirectory) load(entry.optString("path")) else showFilePreview(entry.optString("path"), cwd)
                            }
                            row.setOnLongClickListener { showWorkspaceEntryActions(entry, cwd) { load(currentPath[0]) }; true }
                            entries.addView(row, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(1) })
                        }
                        val truncated = tree.optBoolean("truncated", false)
                        if (truncated) entries.addView(label("目录内容较多，已显示前 400 项", 10, MUTED).apply { setPadding(dp(8), dp(8), dp(8), dp(8)) }, widthWrap())
                    }
                } catch (error: Exception) {
                    handler.post {
                        if (!dialog.isShowing || currentPath[0] != path) return@post
                        entries.removeAllViews()
                        entries.addView(label(error.message ?: "无法读取文件目录", 12, ERROR).apply { setPadding(dp(8), dp(12), dp(8), dp(12)) }, widthWrap())
                    }
                }
            }
        }

        // Captured local loader is reached through this small callback after the dialog is built.
        workspaceLoader = { path -> load(path) }
        dialog.setContentView(content)
        dialog.setOnDismissListener { workspaceLoader = null }
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout(MATCH, (resources.displayMetrics.heightPixels * .88f).toInt())
            setGravity(Gravity.BOTTOM)
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        load("")
    }

    private var workspaceLoader: ((String) -> Unit)? = null

    private fun refreshDirectory() { workspaceLoader?.invoke(workspaceCurrentPath) }

    private fun showCreateEntry(parentPath: String, refresh: () -> Unit) {
        AlertDialog.Builder(this).setTitle("新建")
            .setItems(arrayOf("新建文件", "新建文件夹")) { _, index ->
                val kind = if (index == 0) "file" else "directory"
                val input = EditText(this).apply { hint = "名称"; setSingleLine(true) }
                AlertDialog.Builder(this).setTitle(if (kind == "file") "新建文件" else "新建文件夹").setView(input)
                    .setNegativeButton("取消", null).setPositiveButton("创建") { _, _ ->
                        val name = input.text.toString().trim()
                        if (name.isBlank()) return@setPositiveButton
                        val path = listOf(parentPath.trim('/'), name).filter { it.isNotBlank() }.joinToString("/")
                        val cwd = activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" }
                        runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/workspace/entries", JSONObject()
                            .put("path", path).put("kind", kind).putOpt("cwd", cwd)) }, { refresh() })
                    }.show()
            }.show()
    }

    private fun showWorkspaceEntryActions(entry: JSONObject, cwd: String?, refreshed: () -> Unit) {
        val path = entry.optString("path")
        val isDirectory = entry.optString("kind") == "directory"
        val actions = if (isDirectory && activeThreadId != null)
            arrayOf("打开", "进入该路径并绑定当前聊天", "重命名", "复制", "剪切", "删除")
        else arrayOf("打开", "重命名", "复制", "剪切", "删除")
        AlertDialog.Builder(this).setTitle(entry.optString("name")).setItems(actions) { _, which ->
            when (actions[which]) {
                "打开" -> if (isDirectory) workspaceLoader?.invoke(path) else showFilePreview(path, cwd)
                "进入该路径并绑定当前聊天" -> {
                    val threadId = activeThreadId ?: return@setItems
                    val absolutePath = listOf(workspaceRootPath.trimEnd('/'), path.trimStart('/')).filter { it.isNotBlank() }.joinToString("/")
                    runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/threads/${RemoteApi.encodePath(threadId)}/workspace", JSONObject().put("cwd", absolutePath)) }, {
                        activeThread?.put("cwd", absolutePath)
                        renderHeader()
                        refreshThreads(false)
                        showToast("已绑定当前聊天的工作路径")
                    })
                }
                "重命名" -> {
                    val input = EditText(this).apply { setText(entry.optString("name")); setSingleLine(true) }
                    AlertDialog.Builder(this).setTitle("重命名").setView(input).setNegativeButton("取消", null).setPositiveButton("确定") { _, _ ->
                        runApi({ RemoteApi(endpoint, token).patch("/api/v1/codex/workspace/entry", JSONObject().put("path", path).put("name", input.text.toString().trim()).putOpt("cwd", cwd)) }, { refreshed() })
                    }.show()
                }
                "复制", "剪切" -> { workspaceClipboard.clear(); workspaceClipboard += path; workspaceClipboardMode = if (actions[which] == "复制") "copy" else "move"; showToast(if (workspaceClipboardMode == "copy") "已复制" else "已剪切") }
                "删除" -> AlertDialog.Builder(this).setMessage("删除 ${entry.optString("name")}？").setNegativeButton("取消", null).setPositiveButton("删除") { _, _ ->
                    runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/workspace/delete", JSONObject().put("paths", JSONArray().put(path)).putOpt("cwd", cwd)) }, { refreshed() })
                }.show()
            }
        }.show()
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

    private fun showFilePreview(path: String, cwd: String?) {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(9), dp(12), dp(10))
            background = rounded(PANEL, dp(14), BORDER, dp(1))
        }
        val previewInput = EditText(this).apply {
            setTextColor(TEXT); setHintTextColor(MUTED); textSize = (prefs.getInt(KEY_FONT_SIZE, 14) - 1).toFloat()
            typeface = Typeface.MONOSPACE; gravity = Gravity.TOP or Gravity.START
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setPadding(dp(9), dp(9), dp(9), dp(9)); background = rounded(if (lightTheme) Color.rgb(246, 247, 249) else Color.rgb(14, 16, 20), dp(8))
        }
        val imagePreview = ImageView(this).apply { scaleType = ImageView.ScaleType.FIT_CENTER; visibility = View.GONE }
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(label(path.substringAfterLast('/'), 13, TEXT, true).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE }, LinearLayout.LayoutParams(0, dp(34), 1f))
        val saveButton = smallButton("保存") { savePreviewFile(path, cwd, previewInput.text.toString(), previewInput.tag?.toString().orEmpty(), previewInput) }
        header.addView(saveButton)
        header.addView(iconButton("×", "关闭文件预览") { dialog.dismiss() }, LinearLayout.LayoutParams(dp(32), dp(32)))
        layout.addView(header, widthWrap())
        val scroll = ScrollView(this).apply {
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(previewInput, LinearLayout.LayoutParams(MATCH, WRAP))
                addView(imagePreview, LinearLayout.LayoutParams(MATCH, dp(420)))
            }, FrameLayout.LayoutParams(MATCH, WRAP))
        }
        layout.addView(scroll, LinearLayout.LayoutParams(MATCH, 0, 1f).apply { topMargin = dp(6) })
        dialog.setContentView(layout)
        dialog.show()
        dialog.window?.apply { setBackgroundDrawableResource(android.R.color.transparent); setLayout(MATCH, (resources.displayMetrics.heightPixels * .86f).toInt()); setGravity(Gravity.BOTTOM) }
        io.execute {
            try {
                val query = "?path=${Uri.encode(path)}" + if (cwd.isNullOrBlank()) "" else "&cwd=${Uri.encode(cwd)}"
                val isImage = path.substringAfterLast('.', "").lowercase(Locale.ROOT) in setOf("png", "jpg", "jpeg", "webp", "gif")
                val file = RemoteApi(endpoint, token).get("/api/v1/codex/workspace/${if (isImage) "image" else "file"}$query")
                handler.post {
                    if (dialog.isShowing) {
                        if (isImage) {
                            val data = android.util.Base64.decode(file.optString("data"), android.util.Base64.DEFAULT)
                            imagePreview.setImageBitmap(BitmapFactory.decodeByteArray(data, 0, data.size))
                            imagePreview.visibility = View.VISIBLE
                            previewInput.visibility = View.GONE
                            saveButton.visibility = View.GONE
                        } else {
                            previewInput.tag = file.optString("revision")
                            previewInput.setText(file.optString("content"))
                        }
                    }
                }
            } catch (error: Exception) { handler.post { if (dialog.isShowing) showStatus(error.message ?: "无法预览文件") } }
        }
    }

    private fun savePreviewFile(path: String, cwd: String?, content: String, revision: String, editor: EditText) {
        if (revision.isBlank()) { showToast("文件还在加载"); return }
        runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/workspace/file", JSONObject()
            .put("path", path).put("content", content).put("revision", revision).putOpt("cwd", cwd)) }, { result ->
            showToast("已保存")
            if (result.has("revision")) editor.tag = result.optString("revision")
        })
    }

    private fun showTerminal() {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val shell = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), dp(8), dp(10), dp(9))
            background = rounded(if (lightTheme) Color.rgb(250, 250, 251) else Color.rgb(12, 14, 17), dp(14), BORDER, dp(1))
        }
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(label("⌘  本机终端", 13, TEXT, true), LinearLayout.LayoutParams(0, dp(34), 1f))
        header.addView(smallButton("复制到输入框") {
            val value = terminalOutput?.text?.toString().orEmpty()
            composerInput.append(value.takeLast(120_000))
            dialog.dismiss()
        })
        header.addView(iconButton("×", "关闭终端") { dialog.dismiss() }, LinearLayout.LayoutParams(dp(32), dp(32)))
        shell.addView(header, widthWrap())
        terminalOutput = label("正在连接终端…", 12, if (lightTheme) SUBTLE else Color.rgb(207, 214, 226)).apply {
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
            setPadding(dp(9), dp(9), dp(9), dp(9))
            gravity = Gravity.TOP or Gravity.START
            minHeight = dp(190)
        }
        val outputScroll = ScrollView(this).apply {
            isFillViewport = false; overScrollMode = View.OVER_SCROLL_NEVER
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
            imeOptions = EditorInfo.IME_ACTION_SEND
            setOnEditorActionListener { _, action, _ ->
                if (action == EditorInfo.IME_ACTION_SEND) { sendTerminalLine(); true } else false
            }
        }
        inputRow.addView(terminalDraftInput, LinearLayout.LayoutParams(0, dp(42), 1f))
        inputRow.addView(smallButton("发送") { sendTerminalLine() }, LinearLayout.LayoutParams(WRAP, dp(38)).apply { leftMargin = dp(5) })
        shell.addView(inputRow, LinearLayout.LayoutParams(MATCH, dp(44)).apply { topMargin = dp(5) })
        dialog.setContentView(shell)
        dialog.setOnDismissListener { terminalSocket?.close(1000, "closed"); terminalSocket = null; terminalDialog = null }
        terminalDialog = dialog
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout(MATCH, (resources.displayMetrics.heightPixels * .72f).toInt())
            setGravity(Gravity.BOTTOM)
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        connectTerminal()
    }

    private fun connectTerminal() {
        val url = endpoint.replaceFirst(Regex("^http"), "ws") + "/api/v1/codex/terminal"
        val request = Request.Builder().url(url).build()
        terminalSocket = socketClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val thread = activeThreadId
                val cwd = activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" } ?: runtime.optString("workspace", "")
                webSocket.send(JSONObject().put("type", "terminal.connect").put("token", token)
                    .putOpt("threadId", thread).putOpt("cwd", cwd.takeIf { it.isNotBlank() })
                    .put("columns", 88).put("rows", 26).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val event = JSONObject(text)
                    when (event.optString("type")) {
                        "ready" -> appendTerminal("已连接 ${event.optString("shell")} · ${event.optString("cwd")}\n")
                        "error" -> appendTerminal("\n${event.optString("message", "终端连接失败")}\n")
                        "exit" -> appendTerminal("\n[终端已退出]\n")
                    }
                } catch (_: JSONException) { }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { appendTerminal(bytes.utf8()) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { appendTerminal("\n终端连接失败：${t.message}\n") }
        })
    }

    private fun appendTerminal(value: String) = handler.post {
        val output = terminalOutput ?: return@post
        val clean = value.replace(Regex("\u001B\\[[0-?]*[ -/]*[@-~]"), "")
            .replace(Regex("\u001B\\][^\u0007]*(?:\u0007|\u001B\\\\)"), "")
            .replace("\u0000", "")
        val buffer = StringBuilder(output.text)
        for (character in clean) {
            when (character) {
                '\r' -> { while (buffer.isNotEmpty() && buffer.last() != '\n') buffer.deleteCharAt(buffer.length - 1) }
                '\b' -> if (buffer.isNotEmpty() && buffer.last() != '\n') buffer.deleteCharAt(buffer.length - 1)
                else -> buffer.append(character)
            }
        }
        val text = buffer.toString().takeLast(180_000)
        output.text = text
        (output.parent as? ScrollView)?.post { (output.parent as? ScrollView)?.fullScroll(View.FOCUS_DOWN) }
    }

    private fun sendTerminalLine() {
        val input = terminalDraftInput ?: return
        sendTerminalInput(input.text.toString() + "\n")
        input.setText("")
    }

    private fun sendTerminalInput(value: String) {
        terminalSocket?.send(JSONObject().put("type", "input").put("data", value).toString())
    }

    private fun fileGlyph(name: String): String = when (name.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
        "kt", "kts" -> "K"
        "java" -> "J"
        "js", "jsx", "mjs" -> "JS"
        "ts", "tsx" -> "TS"
        "py" -> "Py"
        "json", "jsonl" -> "{}"
        "md", "mdx" -> "M"
        "sh", "bash", "zsh" -> "${'$'}_"
        "html", "htm" -> "<>"
        "css", "scss" -> "#"
        "yml", "yaml" -> "Y"
        else -> "·"
    }

    private fun formatFileSize(size: Long): String = when {
        size < 1024 -> "$size B"
        size < 1024 * 1024 -> "${size / 1024} KB"
        else -> String.format(Locale.ROOT, "%.1f MB", size / (1024f * 1024f))
    }

    private fun showFontSizeDialog() {
        val size = prefs.getInt(KEY_FONT_SIZE, 14)
        val input = EditText(this).apply { inputType = InputType.TYPE_CLASS_NUMBER; setText(size.toString()) }
        AlertDialog.Builder(this).setTitle("聊天字体大小（12–20）").setView(input)
            .setNegativeButton("取消", null).setPositiveButton("保存") { _, _ ->
                prefs.edit().putInt(KEY_FONT_SIZE, input.text.toString().toIntOrNull()?.coerceIn(12, 20) ?: 14).apply()
                renderMessages(false)
            }.show()
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
                webSocket.send(JSONObject().put("type", "codex.client.hello").put("protocol_version", 1)
                    .put("token", token).put("thread_id", activeThreadId).toString())
                handler.post {
                    handler.removeCallbacks(socketHeartbeatRunnable)
                    handler.postDelayed(socketHeartbeatRunnable, 20_000)
                    renderHeader()
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try { handleSocketEvent(JSONObject(text)) } catch (_: JSONException) { }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (socket === webSocket) {
                    socketConnected = false
                    socket = null
                    outstandingSocketPing = null
                    handler.removeCallbacks(socketHeartbeatRunnable)
                    handler.post { renderHeader(); handler.postDelayed({ connectSocket() }, 1800) }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (socket === webSocket) {
                    socketConnected = false
                    socket = null
                    outstandingSocketPing = null
                    handler.removeCallbacks(socketHeartbeatRunnable)
                    handler.post { renderHeader(); if (foreground) handler.postDelayed({ connectSocket() }, 1600) }
                }
            }
        })
    }

    private fun handleSocketEvent(event: JSONObject) {
        when (event.optString("type")) {
            "pong" -> handler.post {
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
                if (eventThread == activeThreadId) handler.post { refreshActiveThread(false) }
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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val threadId = intent.getStringExtra(EXTRA_THREAD_ID) ?: return
        handler.post {
            val thread = findThread(threadId)
            if (thread != null) selectThread(thread) else {
                activeThreadId = threadId
                refreshActiveThread(true)
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
        attachmentStrip.visibility = if (selectedFiles.isEmpty()) View.GONE else View.VISIBLE
        selectedFiles.toList().forEachIndexed { index, file ->
            val name = label("${file.optString("name")}  ×", 10, SUBTLE).apply {
                setPadding(dp(8), dp(4), dp(8), dp(4))
                background = rounded(PANEL_INSET, dp(8))
                setOnClickListener { selectedFiles.removeAt(index); renderAttachmentStrip() }
            }
            attachmentStrip.addView(name, LinearLayout.LayoutParams(WRAP, WRAP).apply {
                rightMargin = dp(5); topMargin = dp(3); bottomMargin = dp(3)
            })
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

    private fun editField(hintText: String, value: String, inputTypeValue: Int): EditText = EditText(this).apply {
        hint = hintText
        setText(value)
        inputType = inputTypeValue
        setTextColor(TEXT)
        setHintTextColor(MUTED)
        textSize = 14f
        setPadding(dp(12), dp(7), dp(12), dp(7))
        background = rounded(if (lightTheme) Color.rgb(255, 255, 255) else Color.rgb(18, 20, 24), dp(9), BORDER, dp(1))
    }

    private fun label(value: String, size: Int, color: Int, bold: Boolean = false): TextView = TextView(this).apply {
        text = value
        textSize = size.toFloat()
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        gravity = Gravity.CENTER_VERTICAL
    }

    private fun iconButton(value: String, description: String, action: () -> Unit): TextView = label(value, 18, SUBTLE, true).apply {
        gravity = Gravity.CENTER
        contentDescription = description
        background = rounded(Color.TRANSPARENT, dp(8))
        setOnClickListener { action() }
    }

    private fun preferenceButton(value: String, action: () -> Unit): TextView = label(value, 12, SUBTLE, true).apply {
        gravity = Gravity.CENTER
        setPadding(dp(7), 0, dp(7), 0)
        minWidth = dp(44)
        minHeight = dp(40)
        background = rounded(PANEL_INSET, dp(7))
        setOnClickListener { action() }
    }

    private fun smallButton(value: String, action: () -> Unit): TextView = label(value, 12, SUBTLE, true).apply {
        gravity = Gravity.CENTER
        setPadding(dp(9), 0, dp(9), 0)
        background = rounded(PANEL_INSET, dp(7))
        setOnClickListener { action() }
    }

    private fun actionButton(value: String): Button = Button(this).apply {
        text = value
        textSize = 13f
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

    companion object {
        private const val PREFS = "codex_remote_mobile"
        private const val KEY_ENDPOINT = "endpoint"
        private const val KEY_TOKEN = "token"
        private const val KEY_MODE = "native_engine_mode"
        private const val KEY_ACTIVE_THREAD_PREFIX = "native_active_thread_"
        private const val KEY_FONT_SIZE = "native_chat_font_size"
        private const val PREF_DEFAULT = "composer_default"
        private const val PREF_THREAD_PREFIX = "composer_thread_"
        private const val REQUEST_ATTACH = 4101
        private const val REQUEST_NOTIFICATIONS = 4102
        private const val CHANNEL_ID = "codex_remote_native"
        private const val EXTRA_THREAD_ID = "notification_thread_id"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        private const val KEY_LIGHT_THEME = "native_light_theme"
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

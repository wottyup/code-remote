package com.sevencnup.codexremote;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ClipboardManager;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;
import android.webkit.ConsoleMessage;
import android.util.Log;
import org.json.JSONObject;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Space;
import android.widget.TextView;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final String APP_VERSION = BuildConfig.VERSION_NAME;
    private static final long WEBVIEW_LOAD_TIMEOUT_MS = 20000;
    private static final int FILE_CHOOSER_REQUEST_CODE = 4101;
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 4102;
    private static final String PREFS_NAME = "codex_remote_mobile";
    private static final String ENDPOINT_KEY = "endpoint";
    private static final String NOTIFICATION_CHANNEL_ID = "codex_remote_updates";
    private static final String EXTRA_NOTIFICATION_THREAD_ID = "notification_thread_id";
    private static final int DARK = Color.rgb(16, 17, 20);
    private static final int PANEL = Color.rgb(23, 25, 30);
    private static final int TEXT = Color.rgb(239, 241, 246);
    private static final int MUTED = Color.rgb(150, 157, 170);
    private static final int ACCENT = Color.rgb(170, 186, 255);

    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final Handler connectionHandler = new Handler(Looper.getMainLooper());
    private final Runnable connectionRecovery = this::recoverWebConnection;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean activityResumed;
    private boolean autoRestoreSavedEndpoint;
    private int connectionCheckGeneration;
    private SharedPreferences preferences;
    private FrameLayout root;
    private WebView webView;
    private EditText endpointInput;
    private TextView endpointStatus;
    private Button connectButton;
    private TextView webViewStatus;
    private Button webViewRetryButton;
    private Button webViewChangeEndpointButton;
    private Runnable webViewReadyCheck;
    private long webViewLoadStartedAt;
    private boolean webViewLoadFailed;
    private boolean webViewPageFinished;
    private String activeEndpoint;
    private volatile String pendingNotificationThreadId;
    private boolean checking;
    private boolean handlingBack;
    private int navigationBarInsetPx;
    private volatile int composerBottomInsetDp;
    private volatile int statusBarInsetDp;
    private volatile int keyboardInsetDp;
    private volatile boolean softKeyboardVisible;
    private ValueCallback<Uri[]> pendingFileChooser;
    private OnBackInvokedCallback backInvokedCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        captureNotificationNavigation(getIntent());
        configureSystemBars();
        getWindow().setSoftInputMode(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
                : WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        preferences = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        registerBackNavigationCallback();
        showConnector(preferences.getString(ENDPOINT_KEY, ""), null);

        String savedEndpoint = preferences.getString(ENDPOINT_KEY, "");
        registerNetworkRecovery();
        if (savedEndpoint != null && !savedEndpoint.isBlank()) {
            autoRestoreSavedEndpoint = true;
            checkAndOpen(savedEndpoint, true);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureNotificationNavigation(intent);
        dispatchPendingNotificationNavigation();
    }

    private void captureNotificationNavigation(Intent intent) {
        if (intent == null) return;
        String threadId = intent.getStringExtra(EXTRA_NOTIFICATION_THREAD_ID);
        if (threadId != null && !threadId.isBlank()) pendingNotificationThreadId = threadId;
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private TextView text(String value, float size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private LinearLayout.LayoutParams widthParams(int height) {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height);
    }

    private LinearLayout.LayoutParams wrapParams() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private void showConnector(String initialEndpoint, String errorMessage) {
        disposeWebView();
        checking = false;
        autoRestoreSavedEndpoint = false;
        root = new FrameLayout(this);
        root.setBackgroundColor(DARK);
        applySystemBarInsets(root, false, false);
        setContentView(root);

        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);
        root.addView(scrollView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(24), dp(30), dp(24), dp(24));
        scrollView.addView(page, widthParams(ViewGroup.LayoutParams.MATCH_PARENT));

        Space topSpace = new Space(this);
        page.addView(topSpace, widthParams(dp(40)));

        TextView mark = text("C", 22, TEXT);
        mark.setGravity(Gravity.CENTER);
        mark.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        mark.setBackgroundColor(Color.rgb(48, 51, 58));
        LinearLayout.LayoutParams markParams = new LinearLayout.LayoutParams(dp(46), dp(46));
        markParams.bottomMargin = dp(22);
        page.addView(mark, markParams);

        TextView eyebrow = text("CODEX REMOTE · ANDROID", 10, MUTED);
        eyebrow.setLetterSpacing(.12f);
        page.addView(eyebrow, widthParams(dp(22)));

        TextView title = text("连接本机 Codex", 25, TEXT);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        LinearLayout.LayoutParams titleParams = widthParams(dp(38));
        titleParams.bottomMargin = dp(5);
        page.addView(title, titleParams);

        TextView description = text("先连接电脑上的 Codex Remote，再输入网页显示的匹配码。地址只需设置一次。", 13, MUTED);
        description.setLineSpacing(0, 1.35f);
        LinearLayout.LayoutParams descriptionParams = widthParams(dp(58));
        descriptionParams.bottomMargin = dp(18);
        page.addView(description, descriptionParams);

        TextView label = text("电脑网页地址", 11, Color.rgb(195, 199, 208));
        LinearLayout.LayoutParams labelParams = widthParams(dp(24));
        labelParams.bottomMargin = dp(6);
        page.addView(label, labelParams);

        endpointInput = new EditText(this);
        endpointInput.setSingleLine(true);
        endpointInput.setText(initialEndpoint == null ? "" : initialEndpoint);
        endpointInput.setHint("http://192.168.x.x:4173");
        endpointInput.setHintTextColor(Color.rgb(96, 102, 113));
        endpointInput.setTextColor(TEXT);
        endpointInput.setTextSize(14);
        endpointInput.setPadding(dp(13), 0, dp(13), 0);
        endpointInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        endpointInput.setBackgroundColor(Color.rgb(17, 19, 23));
        LinearLayout.LayoutParams inputParams = widthParams(dp(50));
        inputParams.bottomMargin = dp(10);
        page.addView(endpointInput, inputParams);

        connectButton = new Button(this);
        connectButton.setText("检测并连接");
        connectButton.setTextSize(13);
        connectButton.setTextColor(Color.rgb(25, 26, 30));
        connectButton.setAllCaps(false);
        connectButton.setBackgroundColor(Color.rgb(228, 229, 232));
        connectButton.setOnClickListener(view -> {
            autoRestoreSavedEndpoint = false;
            checkAndOpen(endpointInput.getText().toString(), false);
        });
        LinearLayout.LayoutParams buttonParams = widthParams(dp(48));
        buttonParams.bottomMargin = dp(12);
        page.addView(connectButton, buttonParams);

        endpointStatus = text(errorMessage == null ? "" : errorMessage, 11, errorMessage == null ? MUTED : Color.rgb(226, 154, 158));
        endpointStatus.setLineSpacing(0, 1.3f);
        page.addView(endpointStatus, widthParams(dp(44)));

        TextView hint = text("手机需要能通过局域网或远程隧道访问电脑。启动网页服务后，终端会显示匹配码。", 10, Color.rgb(126, 132, 144));
        hint.setLineSpacing(0, 1.3f);
        LinearLayout.LayoutParams hintParams = widthParams(dp(42));
        hintParams.topMargin = dp(24);
        page.addView(hint, hintParams);
    }

    private String normalizeEndpoint(String raw) throws IllegalArgumentException {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("请输入电脑网页地址。 ");
        }
        if (!value.contains("://")) {
            value = "http://" + value;
        }
        Uri uri = Uri.parse(value);
        String scheme = uri.getScheme();
        if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) || uri.getHost() == null) {
            throw new IllegalArgumentException("地址格式无效，请填写 http://电脑IP:4173。 ");
        }
        if (uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("地址不要包含查询参数或片段。 ");
        }
        String normalized = value.replaceAll("/+$", "");
        return normalized;
    }

    private void checkAndOpen(String rawEndpoint, boolean automatic) {
        if (checking) return;
        final String endpoint;
        try {
            endpoint = normalizeEndpoint(rawEndpoint);
        } catch (IllegalArgumentException error) {
            if (endpointStatus != null) endpointStatus.setText(error.getMessage());
            return;
        }

        checking = true;
        final int checkGeneration = ++connectionCheckGeneration;
        if (connectButton != null) {
            connectButton.setEnabled(false);
            connectButton.setText("检测中…");
        }
        if (endpointStatus != null) {
            endpointStatus.setText(automatic ? "正在恢复上次连接…" : "正在检测电脑网页服务…");
            endpointStatus.setTextColor(MUTED);
        }

        networkExecutor.execute(() -> {
            String failure = null;
            for (int attempt = 0; attempt < 3; attempt++) {
                if (Thread.currentThread().isInterrupted()) return;
                try {
                    checkEndpoint(endpoint);
                    failure = null;
                    break;
                } catch (IOException | IllegalArgumentException error) {
                    failure = error.getMessage() == null ? "无法连接到电脑网页服务。" : error.getMessage();
                    if (attempt < 2) {
                        try {
                            Thread.sleep(750L * (attempt + 1));
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            return;
                        }
                    }
                }
            }
            String resultFailure = failure;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || checkGeneration != connectionCheckGeneration) return;
                checking = false;
                if (resultFailure == null) {
                    activeEndpoint = endpoint;
                    preferences.edit().putString(ENDPOINT_KEY, endpoint).apply();
                    showWebView(endpoint);
                    return;
                }
                if (connectButton != null) {
                    connectButton.setEnabled(true);
                    connectButton.setText("检测并连接");
                }
                if (endpointStatus != null) {
                    endpointStatus.setText(resultFailure + "\n请确认地址和端口正确，且手机的局域网或远程隧道已连接。 ");
                    endpointStatus.setTextColor(Color.rgb(226, 154, 158));
                }
            });
        });
    }

    private void checkEndpoint(String endpoint) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint + "/").openConnection();
        // A HEAD probe verifies that the web service is reachable without forcing
        // Android's HTTP client to consume a Vite response through a VPN tunnel.
        // Some tunnels close that short response early and report a misleading
        // "unexpected end of stream" even though the server is healthy.
        connection.setRequestMethod("HEAD");
        connection.setConnectTimeout(6000);
        connection.setReadTimeout(6000);
        connection.setInstanceFollowRedirects(true);
        connection.setUseCaches(false);
        connection.setRequestProperty("User-Agent", "CodexRemoteAndroid/" + APP_VERSION);
        connection.setRequestProperty("Accept", "text/html, */*");
        connection.setRequestProperty("Connection", "close");
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status >= 400) {
                throw new IOException("网页服务返回 HTTP " + status + "。 ");
            }
        } finally {
            connection.disconnect();
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void showWebView(String endpoint) {
        disposeWebView();
        root = new FrameLayout(this);
        root.setBackgroundColor(DARK);
        applySystemBarInsets(root, true, true);
        setContentView(root);

        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(DARK);
        root.addView(shell, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setLoadsImagesAutomatically(true);
        // HTML revalidates and production assets carry content hashes. Honor
        // their HTTP cache headers so a weak connection can reuse the assets.
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        webView.setBackgroundColor(DARK);
        webView.addJavascriptInterface(new AndroidBridge(), "CodexRemoteAndroid");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (pendingFileChooser != null) {
                    pendingFileChooser.onReceiveValue(null);
                }
                pendingFileChooser = filePathCallback;
                Intent picker = fileChooserParams.createIntent();
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, fileChooserParams.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
                picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivityForResult(Intent.createChooser(picker, "选择附件"), FILE_CHOOSER_REQUEST_CODE);
                } catch (ActivityNotFoundException error) {
                    pendingFileChooser = null;
                    filePathCallback.onReceiveValue(null);
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.w("CodexRemoteWebView", message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                return true;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (view != webView) return;
                webViewPageFinished = false;
                updateWebViewStatus("正在加载电脑网页…", false);
                startWebViewReadyCheck(view);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (view != webView) return;
                webViewPageFinished = true;
                dispatchPendingNotificationNavigation();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    runOnUiThread(() -> {
                        if (view != webView) return;
                        webViewLoadFailed = true;
                        updateWebViewStatus("网页加载失败：" + error.getDescription() + "\n请确认电脑网页服务仍在运行。", true);
                    });
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                if (request.isForMainFrame()) {
                    runOnUiThread(() -> {
                        if (view != webView) return;
                        webViewLoadFailed = true;
                        updateWebViewStatus("网页服务返回 HTTP " + errorResponse.getStatusCode() + "。\n请确认电脑端地址正确。", true);
                    });
                }
            }
        });
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        shell.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1));
        addWebViewStatusOverlay(root, endpoint);
        startWebViewReadyCheck(webView);
        webView.loadUrl(endpoint + "/?codexRemoteMobile=" + Uri.encode(APP_VERSION));
    }

    private void startWebViewReadyCheck(WebView view) {
        stopWebViewReadyCheck();
        webViewLoadStartedAt = SystemClock.elapsedRealtime();
        webViewLoadFailed = false;
        Runnable check = new Runnable() {
            @Override
            public void run() {
                if (view != webView || webViewReadyCheck != this || webViewStatus == null) return;
                view.evaluateJavascript(
                        "(function(){var root=document.getElementById('root');return !!root && root.children.length>0;})()",
                        result -> {
                            if (view != webView || webViewReadyCheck != this || webViewStatus == null) return;
                            if ("true".equals(result)) {
                                hideWebViewStatus();
                                return;
                            }
                            if (!webViewLoadFailed
                                    && SystemClock.elapsedRealtime() - webViewLoadStartedAt >= WEBVIEW_LOAD_TIMEOUT_MS) {
                                webViewLoadFailed = true;
                                updateWebViewStatus("电脑网页加载超时。可以重新加载，或修改电脑地址。", true);
                            }
                            view.postDelayed(this, 1000);
                        });
            }
        };
        webViewReadyCheck = check;
        view.postDelayed(check, 500);
    }

    private void stopWebViewReadyCheck() {
        if (webView != null && webViewReadyCheck != null) webView.removeCallbacks(webViewReadyCheck);
        webViewReadyCheck = null;
    }

    private void addWebViewStatusOverlay(FrameLayout container, String endpoint) {
        LinearLayout overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setPadding(dp(28), dp(28), dp(28), dp(28));
        overlay.setBackgroundColor(DARK);

        webViewStatus = text("正在加载电脑网页…", 12, MUTED);
        webViewStatus.setGravity(Gravity.CENTER);
        webViewStatus.setTextAlignment(View.TEXT_ALIGNMENT_CENTER);
        overlay.addView(webViewStatus, widthParams(ViewGroup.LayoutParams.WRAP_CONTENT));

        webViewRetryButton = new Button(this);
        webViewRetryButton.setText("重新加载");
        webViewRetryButton.setTextSize(12);
        webViewRetryButton.setTextColor(Color.rgb(25, 26, 30));
        webViewRetryButton.setAllCaps(false);
        webViewRetryButton.setBackgroundColor(Color.rgb(228, 229, 232));
        webViewRetryButton.setVisibility(View.GONE);
        webViewRetryButton.setOnClickListener(view -> showWebView(endpoint));
        LinearLayout.LayoutParams retryParams = wrapParams();
        retryParams.topMargin = dp(12);
        overlay.addView(webViewRetryButton, retryParams);

        webViewChangeEndpointButton = new Button(this);
        webViewChangeEndpointButton.setText("修改电脑地址");
        webViewChangeEndpointButton.setTextSize(12);
        webViewChangeEndpointButton.setTextColor(TEXT);
        webViewChangeEndpointButton.setAllCaps(false);
        webViewChangeEndpointButton.setBackgroundColor(PANEL);
        webViewChangeEndpointButton.setVisibility(View.GONE);
        webViewChangeEndpointButton.setOnClickListener(view -> showConnector(endpoint, null));
        LinearLayout.LayoutParams changeEndpointParams = wrapParams();
        changeEndpointParams.topMargin = dp(8);
        overlay.addView(webViewChangeEndpointButton, changeEndpointParams);

        container.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void updateWebViewStatus(String message, boolean failed) {
        if (webViewStatus == null) return;
        webViewStatus.setText(message);
        webViewStatus.setTextColor(failed ? Color.rgb(226, 154, 158) : MUTED);
        if (webViewRetryButton != null) webViewRetryButton.setVisibility(failed ? View.VISIBLE : View.GONE);
        if (webViewChangeEndpointButton != null) webViewChangeEndpointButton.setVisibility(failed ? View.VISIBLE : View.GONE);
    }

    private void hideWebViewStatus() {
        if (webViewStatus == null) return;
        stopWebViewReadyCheck();
        View parent = (View) webViewStatus.getParent();
        if (parent != null) parent.setVisibility(View.GONE);
        webViewStatus = null;
        webViewRetryButton = null;
        webViewChangeEndpointButton = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            ValueCallback<Uri[]> callback = pendingFileChooser;
            pendingFileChooser = null;
            if (callback != null) {
                callback.onReceiveValue(resultCode == RESULT_OK ? selectedUris(data) : null);
            }
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private Uri[] selectedUris(Intent data) {
        if (data == null) return null;
        ClipData clipData = data.getClipData();
        if (clipData != null && clipData.getItemCount() > 0) {
            ArrayList<Uri> uris = new ArrayList<>(clipData.getItemCount());
            for (int index = 0; index < clipData.getItemCount(); index++) {
                Uri uri = clipData.getItemAt(index).getUri();
                if (uri != null) uris.add(uri);
            }
            return uris.isEmpty() ? null : uris.toArray(new Uri[0]);
        }
        Uri uri = data.getData();
        return uri == null ? null : new Uri[]{uri};
    }

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        return manager != null && manager.areNotificationsEnabled();
    }

    private void dispatchNotificationPermissionResult(boolean granted) {
        WebView current = webView;
        if (current == null) return;
        String script = "window.dispatchEvent(new CustomEvent('codex-remote-notification-permission',{detail:{granted:" + granted + "}}));";
        current.post(() -> {
            if (current == webView) current.evaluateJavascript(script, null);
        });
    }

    private void dispatchPendingNotificationNavigation() {
        String threadId = pendingNotificationThreadId;
        WebView current = webView;
        if (threadId == null || current == null || !webViewPageFinished) return;
        String quotedThreadId = JSONObject.quote(threadId);
        String script = "window.__codexRemotePendingThreadId=" + quotedThreadId + ";"
                + "if(typeof window.CodexRemoteOpenThread==='function'){"
                + "const threadId=window.__codexRemotePendingThreadId;"
                + "delete window.__codexRemotePendingThreadId;"
                + "window.CodexRemoteOpenThread(threadId);"
                + "}true;";
        current.evaluateJavascript(script, result -> {
            if ("true".equals(result) && threadId.equals(pendingNotificationThreadId)) {
                pendingNotificationThreadId = null;
            }
        });
    }

    private void postSystemNotification(String title, String body, String threadId, String eventKey) {
        if (!hasNotificationPermission() || activityResumed) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Codex Remote",
                NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Codex 回复完成和待批准提醒");
        manager.createNotificationChannel(channel);

        int notificationId = (threadId + ":" + eventKey).hashCode() & 0x7fffffff;
        if (notificationId == 0) notificationId = 1;
        Intent openApp = new Intent(this, MainActivity.class);
        openApp.setAction(getPackageName() + ".NOTIFICATION." + eventKey);
        openApp.putExtra(EXTRA_NOTIFICATION_THREAD_ID, threadId);
        openApp.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                notificationId,
                openApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String safeTitle = title == null || title.isBlank() ? "Codex Remote" : title.trim();
        String safeBody = body == null || body.isBlank() ? "Codex 有一条更新。" : body.trim();
        if (safeTitle.length() > 90) safeTitle = safeTitle.substring(0, 87) + "…";
        if (safeBody.length() > 180) safeBody = safeBody.substring(0, 177) + "…";
        Notification notification = new Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setColor(ACCENT)
                .setContentTitle(safeTitle)
                .setContentText(safeBody)
                .setStyle(new Notification.BigTextStyle().bigText(safeBody))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .build();
        try {
            manager.notify(notificationId, notification);
        } catch (SecurityException error) {
            Log.w("CodexRemoteNotifications", "Unable to post system notification", error);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != NOTIFICATION_PERMISSION_REQUEST_CODE) return;
        dispatchNotificationPermissionResult(hasNotificationPermission());
    }

    private final class AndroidBridge {
        @JavascriptInterface
        public int getStatusBarInsetDp() {
            return statusBarInsetDp;
        }

        @JavascriptInterface
        public int getComposerBottomInsetDp() {
            return composerBottomInsetDp;
        }

        @JavascriptInterface
        public int getKeyboardInsetDp() {
            return keyboardInsetDp;
        }

        @JavascriptInterface
        public boolean hasNotificationPermission() {
            return MainActivity.this.hasNotificationPermission();
        }

        @JavascriptInterface
        public boolean isAppInBackground() {
            return !activityResumed;
        }

        @JavascriptInterface
        public void requestNotificationPermission() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(
                            new String[]{Manifest.permission.POST_NOTIFICATIONS},
                            NOTIFICATION_PERMISSION_REQUEST_CODE);
                } else {
                    dispatchNotificationPermissionResult(hasNotificationPermission());
                }
            });
        }

        @JavascriptInterface
        public boolean showSystemNotification(String title, String body, String threadId, String eventKey) {
            if (activityResumed || !hasNotificationPermission()) return false;
            runOnUiThread(() -> postSystemNotification(title, body, threadId, eventKey));
            return true;
        }

        @JavascriptInterface
        public String consumeNotificationThreadId() {
            String threadId = pendingNotificationThreadId;
            pendingNotificationThreadId = null;
            return threadId;
        }

        @JavascriptInterface
        public void setStatusBarDarkIcons(boolean darkIcons) {
            runOnUiThread(() -> applyStatusBarIconAppearance(darkIcons));
        }

        @JavascriptInterface
        public boolean copyToClipboard(String value) {
            try {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (clipboard == null) return false;
                clipboard.setPrimaryClip(ClipData.newPlainText("Codex Remote", value == null ? "" : value));
                return true;
            } catch (RuntimeException error) {
                Log.w("CodexRemoteWebView", "Unable to write to the system clipboard", error);
                return false;
            }
        }

        @JavascriptInterface
        public void changeEndpoint() {
            runOnUiThread(() -> showConnector(activeEndpoint, null));
        }

        @JavascriptInterface
        public void showKeyboard() {
            runOnUiThread(() -> {
                if (webView == null || softKeyboardVisible) return;
                webView.requestFocus(View.FOCUS_DOWN);
                InputMethodManager inputMethodManager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (inputMethodManager == null) return;
                inputMethodManager.restartInput(webView);
                webView.postDelayed(() -> {
                    if (webView == null || !webView.hasFocus()) return;
                    inputMethodManager.showSoftInput(webView, InputMethodManager.SHOW_FORCED);
                    webView.postDelayed(() -> {
                        if (webView != null && webView.hasFocus() && !softKeyboardVisible) {
                            inputMethodManager.showSoftInput(webView, InputMethodManager.SHOW_FORCED);
                        }
                    }, 240);
                }, 80);
            });
        }
    }

    private void registerBackNavigationCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        backInvokedCallback = this::handleBackNavigation;
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                backInvokedCallback);
    }

    private void unregisterBackNavigationCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || backInvokedCallback == null) return;
        getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backInvokedCallback);
        backInvokedCallback = null;
    }

    private void handleBackNavigation() {
        if (handlingBack) return;
        WebView currentWebView = webView;
        if (currentWebView == null || currentWebView.getVisibility() != View.VISIBLE) {
            finish();
            return;
        }

        handlingBack = true;
        try {
            currentWebView.evaluateJavascript(
                    "(function(){try{return !!(window.CodexRemoteHandleBack && window.CodexRemoteHandleBack());}catch(error){return false;}})();",
                    result -> {
                        handlingBack = false;
                        if (isFinishing() || currentWebView != webView) return;
                        if ("true".equals(result)) return;
                        if (currentWebView.canGoBack()) {
                            currentWebView.goBack();
                        } else {
                            finish();
                        }
                    });
        } catch (RuntimeException error) {
            handlingBack = false;
            if (currentWebView.canGoBack()) {
                currentWebView.goBack();
            } else {
                finish();
            }
        }
    }

    @Override
    public void onBackPressed() {
        handleBackNavigation();
    }

    private void registerNetworkRecovery() {
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                connectionHandler.post(MainActivity.this::scheduleConnectionRecovery);
            }

            @Override
            public void onLost(Network network) {
                connectionHandler.post(MainActivity.this::scheduleConnectionRecovery);
            }
        };
        try {
            connectivityManager.registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException error) {
            networkCallback = null;
        }
    }

    private void scheduleConnectionRecovery() {
        if (!activityResumed || isFinishing() || isDestroyed()) return;
        connectionHandler.removeCallbacks(connectionRecovery);
        connectionHandler.postDelayed(connectionRecovery, 500);
    }

    private void recoverWebConnection() {
        if (!activityResumed || isFinishing() || isDestroyed()) return;
        if (webView != null) {
            if (webViewStatus != null && webViewLoadFailed) {
                // Retry only a page that never finished loading. An existing
                // chat keeps its draft, scroll position and local caches.
                webView.reload();
            } else {
                webView.evaluateJavascript("window.dispatchEvent(new Event('codex-remote:resume'));", null);
            }
            return;
        }
        String savedEndpoint = preferences.getString(ENDPOINT_KEY, "");
        if (autoRestoreSavedEndpoint && !checking && savedEndpoint != null && !savedEndpoint.isBlank()
                && endpointInput != null && savedEndpoint.equals(endpointInput.getText().toString().trim())) {
            checkAndOpen(savedEndpoint, true);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityResumed = true;
        if (webView != null) {
            webView.onResume();
            if (webViewStatus != null && !webViewLoadFailed) startWebViewReadyCheck(webView);
        }
        scheduleConnectionRecovery();
    }

    @Override
    protected void onPause() {
        activityResumed = false;
        connectionHandler.removeCallbacks(connectionRecovery);
        stopWebViewReadyCheck();
        if (webView != null) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('codex-remote-app-background'));", null);
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        activityResumed = false;
        connectionHandler.removeCallbacksAndMessages(null);
        if (connectivityManager != null && networkCallback != null) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            } catch (RuntimeException ignored) {
                // The OS may already have released the callback.
            }
            networkCallback = null;
        }
        unregisterBackNavigationCallback();
        disposeWebView();
        networkExecutor.shutdownNow();
        super.onDestroy();
    }

    private void disposeWebView() {
        connectionCheckGeneration++;
        stopWebViewReadyCheck();
        if (pendingFileChooser != null) {
            pendingFileChooser.onReceiveValue(null);
            pendingFileChooser = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        webViewPageFinished = false;
        webViewStatus = null;
        webViewRetryButton = null;
        webViewChangeEndpointButton = null;
    }

    private void configureSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().getDecorView().setBackgroundColor(DARK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
        }
    }

    private void applyStatusBarIconAppearance(boolean darkIcons) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.view.WindowInsetsController controller = getWindow().getInsetsController();
            if (controller == null) return;
            int appearance = darkIcons
                    ? android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    : 0;
            controller.setSystemBarsAppearance(
                    appearance,
                    android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
            return;
        }

        View decorView = getWindow().getDecorView();
        int visibility = decorView.getSystemUiVisibility();
        visibility = darkIcons
                ? visibility | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                : visibility & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        decorView.setSystemUiVisibility(visibility);
    }

    private void applySystemBarInsets(
            FrameLayout container,
            boolean extendWebViewBehindNavigationBar,
            boolean extendWebViewBehindStatusBar) {
        container.setOnApplyWindowInsetsListener((view, insets) -> {
            int top;
            int navigationBottom;
            int imeBottom = 0;
            boolean imeVisible = false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets statusBars = insets.getInsets(android.view.WindowInsets.Type.statusBars());
                android.graphics.Insets navigationBars = insets.getInsets(android.view.WindowInsets.Type.navigationBars());
                top = statusBars.top;
                navigationBottom = navigationBars.bottom;
                imeVisible = insets.isVisible(android.view.WindowInsets.Type.ime());
                if (imeVisible) {
                    imeBottom = insets.getInsets(android.view.WindowInsets.Type.ime()).bottom;
                }
            } else {
                top = insets.getSystemWindowInsetTop();
                int systemBottom = insets.getSystemWindowInsetBottom();
                if (systemBottom > dp(80)) {
                    imeVisible = true;
                    imeBottom = systemBottom;
                    navigationBottom = navigationBarInsetPx;
                } else {
                    navigationBottom = systemBottom;
                }
            }
            softKeyboardVisible = imeVisible;
            updateKeyboardInset(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && imeVisible
                    ? Math.round(imeBottom / getResources().getDisplayMetrics().density)
                    : 0);
            if (!imeVisible) navigationBarInsetPx = navigationBottom;
            updateStatusBarInset(Math.round(top / getResources().getDisplayMetrics().density));
            int bottomInsetDp = imeVisible ? 0 : Math.round(navigationBottom / getResources().getDisplayMetrics().density);
            updateComposerBottomInset(bottomInsetDp);
            int contentBottom = extendWebViewBehindNavigationBar
                    ? 0
                    : Math.max(navigationBottom, imeBottom);
            view.setPadding(
                    view.getPaddingLeft(),
                    extendWebViewBehindStatusBar ? 0 : top,
                    view.getPaddingRight(),
                    contentBottom);
            return insets;
        });
        container.requestApplyInsets();
    }

    private void updateStatusBarInset(int insetDp) {
        statusBarInsetDp = insetDp;
        WebView currentWebView = webView;
        if (currentWebView == null) return;
        currentWebView.post(() -> {
            if (currentWebView != webView) return;
            currentWebView.evaluateJavascript(
                    "document.documentElement.style.setProperty('--native-status-bar-inset', '" + insetDp + "px')",
                    null);
        });
    }

    private void updateComposerBottomInset(int insetDp) {
        composerBottomInsetDp = insetDp;
        WebView currentWebView = webView;
        if (currentWebView == null) return;
        currentWebView.post(() -> {
            if (currentWebView != webView) return;
            currentWebView.evaluateJavascript(
                    "document.documentElement.style.setProperty('--native-composer-bottom-inset', '" + insetDp + "px')",
                    null);
        });
    }

    private void updateKeyboardInset(int insetDp) {
        if (keyboardInsetDp == insetDp) return;
        keyboardInsetDp = insetDp;
        WebView currentWebView = webView;
        if (currentWebView == null) return;
        currentWebView.post(() -> {
            if (currentWebView != webView) return;
            currentWebView.evaluateJavascript(
                    "document.documentElement.style.setProperty('--native-keyboard-inset', '" + insetDp + "px');"
                            + "window.dispatchEvent(new Event('codex-remote:keyboard-inset'))",
                    null);
        });
    }
}

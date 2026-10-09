package com.sevencnup.codexremote;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
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
    private static final String APP_VERSION = "0.0.83";
    private static final int FILE_CHOOSER_REQUEST_CODE = 4101;
    private static final String PREFS_NAME = "codex_remote_mobile";
    private static final String ENDPOINT_KEY = "endpoint";
    private static final int DARK = Color.rgb(16, 17, 20);
    private static final int PANEL = Color.rgb(23, 25, 30);
    private static final int TEXT = Color.rgb(239, 241, 246);
    private static final int MUTED = Color.rgb(150, 157, 170);
    private static final int ACCENT = Color.rgb(170, 186, 255);

    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private SharedPreferences preferences;
    private FrameLayout root;
    private WebView webView;
    private EditText endpointInput;
    private TextView endpointStatus;
    private Button connectButton;
    private TextView webViewStatus;
    private Button webViewRetryButton;
    private String activeEndpoint;
    private boolean checking;
    private boolean handlingBack;
    private ValueCallback<Uri[]> pendingFileChooser;
    private OnBackInvokedCallback backInvokedCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(true);
        }
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setStatusBarColor(DARK);
        getWindow().setNavigationBarColor(DARK);
        preferences = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        registerBackNavigationCallback();
        showConnector(preferences.getString(ENDPOINT_KEY, ""), null);

        String savedEndpoint = preferences.getString(ENDPOINT_KEY, "");
        if (savedEndpoint != null && !savedEndpoint.isBlank()) {
            checkAndOpen(savedEndpoint, true);
        }
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
        root = new FrameLayout(this);
        root.setBackgroundColor(DARK);
        applySystemBarInsets(root);
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
        connectButton.setOnClickListener(view -> checkAndOpen(endpointInput.getText().toString(), false));
        LinearLayout.LayoutParams buttonParams = widthParams(dp(48));
        buttonParams.bottomMargin = dp(12);
        page.addView(connectButton, buttonParams);

        endpointStatus = text(errorMessage == null ? "" : errorMessage, 11, errorMessage == null ? MUTED : Color.rgb(226, 154, 158));
        endpointStatus.setLineSpacing(0, 1.3f);
        page.addView(endpointStatus, widthParams(dp(44)));

        TextView hint = text("电脑和手机需要在同一个局域网。启动网页服务后，终端会显示匹配码。", 10, Color.rgb(126, 132, 144));
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
            try {
                checkEndpoint(endpoint);
            } catch (IOException | IllegalArgumentException error) {
                failure = error.getMessage() == null ? "无法连接到电脑网页服务。" : error.getMessage();
            }
            String resultFailure = failure;
            runOnUiThread(() -> {
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
                    endpointStatus.setText(resultFailure + "\n请确认电脑服务已启动、端口为 4173，且手机和电脑在同一局域网。 ");
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
        connection.setConnectTimeout(4500);
        connection.setReadTimeout(4500);
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
        applySystemBarInsets(root);
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
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("image/*");
                picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                try {
                    startActivityForResult(Intent.createChooser(picker, "选择图片"), FILE_CHOOSER_REQUEST_CODE);
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
                if (view == webView) updateWebViewStatus("正在加载电脑网页…", false);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (view != webView) return;
                view.postDelayed(() -> view.evaluateJavascript(
                        "(function(){var root=document.getElementById('root');return document.readyState==='complete' && !!root && root.children.length>0;})()",
                        result -> {
                            if (view != webView) return;
                            if ("true".equals(result)) hideWebViewStatus();
                            else updateWebViewStatus("网页脚本没有正常启动。请确认电脑端网页服务已更新，然后重试。", true);
                        }), 800);
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
                        updateWebViewStatus("网页加载失败：" + error.getDescription() + "\n请确认电脑网页服务仍在运行。", true);
                    });
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                if (request.isForMainFrame()) {
                    runOnUiThread(() -> {
                        if (view != webView) return;
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
        // Keep the WebView from reusing an older index.html after an APK update.
        webView.loadUrl(endpoint + "/?codexRemoteMobile=" + Uri.encode(APP_VERSION));
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

        container.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void updateWebViewStatus(String message, boolean failed) {
        if (webViewStatus == null) return;
        webViewStatus.setText(message);
        webViewStatus.setTextColor(failed ? Color.rgb(226, 154, 158) : MUTED);
        if (webViewRetryButton != null) webViewRetryButton.setVisibility(failed ? View.VISIBLE : View.GONE);
    }

    private void hideWebViewStatus() {
        if (webViewStatus == null) return;
        View parent = (View) webViewStatus.getParent();
        if (parent != null) parent.setVisibility(View.GONE);
        webViewStatus = null;
        webViewRetryButton = null;
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

    private final class AndroidBridge {
        @JavascriptInterface
        public void changeEndpoint() {
            runOnUiThread(() -> showConnector(activeEndpoint, null));
        }

        @JavascriptInterface
        public void showKeyboard() {
            runOnUiThread(() -> {
                if (webView == null) return;
                webView.requestFocus(View.FOCUS_DOWN);
                InputMethodManager inputMethodManager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (inputMethodManager == null) return;
                inputMethodManager.restartInput(webView);
                webView.postDelayed(() -> {
                    if (webView == null || !webView.hasFocus()) return;
                    inputMethodManager.showSoftInput(webView, InputMethodManager.SHOW_FORCED);
                    webView.postDelayed(() -> {
                        if (webView != null && webView.hasFocus()) {
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

    @Override
    protected void onDestroy() {
        unregisterBackNavigationCallback();
        disposeWebView();
        networkExecutor.shutdownNow();
        super.onDestroy();
    }

    private void disposeWebView() {
        if (pendingFileChooser != null) {
            pendingFileChooser.onReceiveValue(null);
            pendingFileChooser = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        webViewStatus = null;
        webViewRetryButton = null;
    }

    private void applySystemBarInsets(FrameLayout container) {
        container.setOnApplyWindowInsetsListener((view, insets) -> {
            int top;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(
                        android.view.WindowInsets.Type.statusBars() | android.view.WindowInsets.Type.navigationBars());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(view.getPaddingLeft(), top, view.getPaddingRight(), bottom);
            return insets;
        });
        container.requestApplyInsets();
    }
}

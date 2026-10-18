package com.sevencnup.codexremote

import android.animation.ValueAnimator
import android.Manifest
import android.app.Activity
import android.app.Dialog
import android.app.DownloadManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.ColorStateList
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PaintFlagsDrawFilter
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.Rect
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.BitmapFactory
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.OpenableColumns
import android.text.InputType
import android.text.Layout
import android.text.Selection
import android.text.Spannable
import android.text.SpannableString
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.text.StaticLayout
import android.text.TextDirectionHeuristics
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.text.style.URLSpan
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
import android.util.Patterns
import android.text.util.Linkify
import android.webkit.SslErrorHandler
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import io.noties.markwon.Markwon
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.core.MarkwonTheme
import io.noties.markwon.linkify.LinkifyPlugin
import io.noties.markwon.ext.tables.TablePlugin
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
import java.lang.ref.WeakReference
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
import kotlin.math.roundToInt

private class PixelFrameNineSliceDrawable(
    private val bitmap: Bitmap,
    private val sourceCornerWidth: Int,
    private val sourceCornerHeight: Int,
    private val targetCornerSize: Int,
) : Drawable() {
    private val paint = Paint().apply {
        isAntiAlias = false
        isFilterBitmap = false
    }
    private val sourceRects = Array(9) { Rect() }
    private val destinationRects = Array(9) { Rect() }
    private val destinationX = IntArray(4)
    private val destinationY = IntArray(4)
    private var drawableAlpha = 255
    private var drawableColorFilter: ColorFilter? = null
    private val sourceX = intArrayOf(0, sourceCornerWidth.coerceIn(1, bitmap.width / 2), bitmap.width - sourceCornerWidth.coerceIn(1, bitmap.width / 2), bitmap.width)
    private val sourceY = intArrayOf(0, sourceCornerHeight.coerceIn(1, bitmap.height / 2), bitmap.height - sourceCornerHeight.coerceIn(1, bitmap.height / 2), bitmap.height)

    init {
        var index = 0
        for (row in 0..2) for (column in 0..2) {
            sourceRects[index++].set(sourceX[column], sourceY[row], sourceX[column + 1], sourceY[row + 1])
        }
    }

    override fun draw(canvas: Canvas) {
        val area = bounds
        if (area.isEmpty) return
        val horizontalInset = min(targetCornerSize, area.width() / 2)
        val verticalInset = min(targetCornerSize, area.height() / 2)
        destinationX[0] = area.left
        destinationX[1] = area.left + horizontalInset
        destinationX[2] = area.right - horizontalInset
        destinationX[3] = area.right
        destinationY[0] = area.top
        destinationY[1] = area.top + verticalInset
        destinationY[2] = area.bottom - verticalInset
        destinationY[3] = area.bottom
        paint.alpha = drawableAlpha
        paint.colorFilter = drawableColorFilter
        var index = 0
        for (row in 0..2) for (column in 0..2) {
            val source = sourceRects[index]
            val destination = destinationRects[index++]
            destination.set(destinationX[column], destinationY[row], destinationX[column + 1], destinationY[row + 1])
            if (!source.isEmpty && !destination.isEmpty) canvas.drawBitmap(bitmap, source, destination, paint)
        }
    }

    override fun setAlpha(alpha: Int) {
        drawableAlpha = alpha.coerceIn(0, 255)
        invalidateSelf()
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        drawableColorFilter = colorFilter
        invalidateSelf()
    }

    override fun getConstantState(): Drawable.ConstantState = PixelFrameNineSliceConstantState(
        bitmap,
        sourceCornerWidth,
        sourceCornerHeight,
        targetCornerSize,
    )

    @Deprecated("Deprecated in Android graphics API")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

private class PixelFrameNineSliceConstantState(
    private val bitmap: Bitmap,
    private val sourceCornerWidth: Int,
    private val sourceCornerHeight: Int,
    private val targetCornerSize: Int,
) : Drawable.ConstantState() {
    override fun newDrawable(): Drawable = PixelFrameNineSliceDrawable(
        bitmap,
        sourceCornerWidth,
        sourceCornerHeight,
        targetCornerSize,
    )

    override fun getChangingConfigurations(): Int = 0
}

private class LollipopSystemBarsDrawable(
    private val contentColor: Int,
    private val statusBarColor: Int,
    private val navigationBarColor: Int,
    private val statusBarHeight: () -> Int,
    private val navigationBarHeight: () -> Int,
) : Drawable() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var drawableAlpha = 255
    private var drawableColorFilter: ColorFilter? = null

    override fun draw(canvas: Canvas) {
        val area = bounds
        paint.colorFilter = drawableColorFilter
        paint.color = contentColor
        paint.alpha = Color.alpha(contentColor) * drawableAlpha / 255
        canvas.drawRect(area, paint)

        val top = statusBarHeight().coerceIn(0, area.height())
        if (top > 0) {
            paint.color = statusBarColor
            paint.alpha = Color.alpha(statusBarColor) * drawableAlpha / 255
            canvas.drawRect(area.left.toFloat(), area.top.toFloat(), area.right.toFloat(), area.top + top.toFloat(), paint)
        }
        val bottom = navigationBarHeight().coerceIn(0, (area.height() - top).coerceAtLeast(0))
        if (bottom > 0) {
            paint.color = navigationBarColor
            paint.alpha = Color.alpha(navigationBarColor) * drawableAlpha / 255
            canvas.drawRect(area.left.toFloat(), area.bottom - bottom.toFloat(), area.right.toFloat(), area.bottom.toFloat(), paint)
        }
    }

    override fun setAlpha(alpha: Int) {
        drawableAlpha = alpha.coerceIn(0, 255)
        invalidateSelf()
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        drawableColorFilter = colorFilter
        invalidateSelf()
    }

    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.OPAQUE
}

private class ThemeWallpaperDrawable(
    private val bitmap: Bitmap,
    private val baseColor: Int,
    imageOpacity: Float,
    private val cornerRadius: Float = 0f,
    private val strokeColor: Int? = null,
    private val strokeWidth: Float = 0f,
    private val viewportWidth: Float = 0f,
    private val viewportHeight: Float = 0f,
    viewportOffsetX: Float = 0f,
    viewportOffsetY: Float = 0f,
) : Drawable() {
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val imagePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private var imageOpacity = imageOpacity.coerceIn(0f, 1f)
    private var drawableAlpha = 255
    private var colorFilter: ColorFilter? = null
    private var viewportOffsetX = viewportOffsetX
    private var viewportOffsetY = viewportOffsetY

    override fun draw(canvas: Canvas) {
        val rect = RectF(bounds)
        if (rect.isEmpty) return
        val checkpoint = canvas.save()
        if (cornerRadius > 0f) {
            val clip = Path().apply { addRoundRect(rect, cornerRadius, cornerRadius, Path.Direction.CW) }
            canvas.clipPath(clip)
        }

        fillPaint.color = baseColor
        fillPaint.alpha = Color.alpha(baseColor) * drawableAlpha / 255
        fillPaint.colorFilter = colorFilter
        canvas.drawRect(rect, fillPaint)

        val renderWidth = viewportWidth.takeIf { it > 0f } ?: rect.width()
        val renderHeight = viewportHeight.takeIf { it > 0f } ?: rect.height()
        val scale = maxOf(renderWidth / bitmap.width, renderHeight / bitmap.height)
        val imageWidth = bitmap.width * scale
        val imageHeight = bitmap.height * scale
        val centerX = renderWidth / 2f - viewportOffsetX
        val centerY = renderHeight / 2f - viewportOffsetY
        val imageRect = RectF(
            centerX - imageWidth / 2f,
            centerY - imageHeight / 2f,
            centerX + imageWidth / 2f,
            centerY + imageHeight / 2f,
        )
        imagePaint.alpha = (255f * imageOpacity * drawableAlpha / 255f).roundToInt()
        imagePaint.colorFilter = colorFilter
        canvas.drawBitmap(bitmap, null, imageRect, imagePaint)
        canvas.restoreToCount(checkpoint)

        if (strokeColor != null && strokeWidth > 0f) {
            strokePaint.color = strokeColor
            strokePaint.alpha = drawableAlpha
            strokePaint.strokeWidth = strokeWidth
            strokePaint.colorFilter = colorFilter
            val inset = strokeWidth / 2f
            val strokeRect = RectF(rect).apply { inset(inset, inset) }
            if (cornerRadius > 0f) {
                canvas.drawRoundRect(strokeRect, (cornerRadius - inset).coerceAtLeast(0f), (cornerRadius - inset).coerceAtLeast(0f), strokePaint)
            } else canvas.drawRect(strokeRect, strokePaint)
        }
    }

    fun setImageOpacity(value: Float) {
        imageOpacity = value.coerceIn(0f, 1f)
        invalidateSelf()
    }

    fun setViewportOffset(x: Float, y: Float) {
        viewportOffsetX = x
        viewportOffsetY = y
        invalidateSelf()
    }

    override fun setAlpha(alpha: Int) {
        drawableAlpha = alpha.coerceIn(0, 255)
        invalidateSelf()
    }

    override fun setColorFilter(filter: ColorFilter?) {
        colorFilter = filter
        invalidateSelf()
    }

    @Deprecated("Deprecated in Android graphics API")
    override fun getOpacity(): Int = if (drawableAlpha == 255 && Color.alpha(baseColor) == 255) PixelFormat.OPAQUE else PixelFormat.TRANSLUCENT
}

private class ComposerGlassDrawable(
    private val fillColors: IntArray,
    private val highlightColor: Int,
    private val borderColor: Int,
    private val cornerRadius: Float,
) : Drawable() {
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val highlightPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val reflectionPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private var drawableAlpha = 255
    private var colorFilter: ColorFilter? = null

    override fun draw(canvas: Canvas) {
        val rect = RectF(bounds)
        if (rect.isEmpty) return

        val clip = Path().apply { addRoundRect(rect, cornerRadius, cornerRadius, Path.Direction.CW) }
        fillPaint.alpha = drawableAlpha
        fillPaint.colorFilter = colorFilter
        fillPaint.shader = LinearGradient(
            rect.left, rect.top, rect.right, rect.bottom,
            fillColors, null, Shader.TileMode.CLAMP,
        )
        canvas.drawRoundRect(rect, cornerRadius, cornerRadius, fillPaint)

        val checkpoint = canvas.save()
        canvas.clipPath(clip)
        highlightPaint.alpha = drawableAlpha
        highlightPaint.colorFilter = colorFilter
        highlightPaint.shader = RadialGradient(
            rect.left + rect.width() * .13f, rect.top + rect.height() * .06f,
            rect.width() * .92f,
            intArrayOf(withAlpha(highlightColor, .25f), withAlpha(highlightColor, .08f), Color.TRANSPARENT),
            floatArrayOf(0f, .48f, 1f), Shader.TileMode.CLAMP,
        )
        canvas.drawRect(rect, highlightPaint)

        reflectionPaint.alpha = drawableAlpha
        reflectionPaint.colorFilter = colorFilter
        reflectionPaint.shader = LinearGradient(
            rect.left, rect.top, rect.right, rect.top + rect.height() * .34f,
            intArrayOf(Color.TRANSPARENT, withAlpha(highlightColor, .09f), Color.TRANSPARENT),
            floatArrayOf(0f, .5f, 1f), Shader.TileMode.CLAMP,
        )
        canvas.drawRoundRect(rect, cornerRadius, cornerRadius, reflectionPaint)
        canvas.restoreToCount(checkpoint)

        val strokeWidth = (cornerRadius / 18f).coerceAtLeast(1f)
        val inset = strokeWidth / 2f
        borderPaint.color = borderColor
        borderPaint.alpha = (Color.alpha(borderColor) * drawableAlpha / 255f).roundToInt()
        borderPaint.strokeWidth = strokeWidth
        borderPaint.colorFilter = colorFilter
        val borderRect = RectF(rect).apply { inset(inset, inset) }
        canvas.drawRoundRect(borderRect, cornerRadius - inset, cornerRadius - inset, borderPaint)
        fillPaint.shader = null
        highlightPaint.shader = null
        reflectionPaint.shader = null
    }

    override fun setAlpha(alpha: Int) {
        drawableAlpha = alpha.coerceIn(0, 255)
        invalidateSelf()
    }

    override fun setColorFilter(filter: ColorFilter?) {
        colorFilter = filter
        invalidateSelf()
    }

    @Deprecated("Deprecated in Android graphics API")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT

    override fun getOutline(outline: Outline) {
        outline.setRoundRect(bounds, cornerRadius)
        outline.alpha = .92f
    }

    private fun withAlpha(color: Int, fraction: Float): Int = Color.argb(
        (Color.alpha(color) * fraction).roundToInt().coerceIn(0, 255),
        Color.red(color), Color.green(color), Color.blue(color),
    )
}

private class ComposerGlowDrawable(
    private val color: Int,
    private val cornerRadius: Float,
    private val centerOpacity: Float,
) : Drawable() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var drawableAlpha = 0

    fun currentIntensity(): Float = drawableAlpha / 255f

    fun setIntensity(value: Float) {
        drawableAlpha = (value.coerceIn(0f, 1f) * 255).roundToInt()
        invalidateSelf()
    }

    override fun draw(canvas: Canvas) {
        val rect = RectF(bounds)
        if (rect.isEmpty) return
        val checkpoint = canvas.save()
        canvas.clipPath(Path().apply { addRoundRect(rect, cornerRadius, cornerRadius, Path.Direction.CW) })
        paint.alpha = drawableAlpha
        paint.shader = RadialGradient(
            rect.centerX(), rect.top, max(rect.width() * .92f, rect.height() * 1.15f),
            intArrayOf(withAlpha(color, centerOpacity), withAlpha(color, centerOpacity * .44f), Color.TRANSPARENT),
            floatArrayOf(0f, .43f, 1f), Shader.TileMode.CLAMP,
        )
        canvas.drawRect(rect, paint)
        paint.shader = null
        canvas.restoreToCount(checkpoint)
    }

    override fun setAlpha(alpha: Int) {
        drawableAlpha = alpha.coerceIn(0, 255)
        invalidateSelf()
    }

    override fun setColorFilter(filter: ColorFilter?) {
        paint.colorFilter = filter
        invalidateSelf()
    }

    @Deprecated("Deprecated in Android graphics API")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT

    private fun withAlpha(color: Int, fraction: Float): Int = Color.argb(
        (Color.alpha(color) * fraction).roundToInt().coerceIn(0, 255),
        Color.red(color), Color.green(color), Color.blue(color),
    )
}

class MainActivity : Activity() {
    // The legacy-theme key remains "lollipop" for preference compatibility, but
    // its appearance now follows Android 2.3 Gingerbread rather than Material.
    private val PIXEL_BACKGROUND = Color.rgb(7, 15, 28)
    private val PIXEL_PANEL = Color.rgb(15, 27, 43)
    private val PIXEL_PANEL_INSET = Color.rgb(34, 50, 70)
    private val PIXEL_BORDER = Color.rgb(102, 121, 146)
    private val PIXEL_BORDER_LIGHT = Color.rgb(224, 222, 207)
    private val PIXEL_BORDER_SHADOW = Color.rgb(53, 68, 88)
    private val PIXEL_TEXT = Color.rgb(244, 240, 225)
    private val PIXEL_CREAM = Color.rgb(244, 232, 203)
    private val PIXEL_INK = Color.rgb(20, 30, 43)
    private val PIXEL_BLUE = Color.rgb(29, 136, 238)
    private val PIXEL_GREEN = Color.rgb(74, 203, 111)
    private val PIXEL_RED = Color.rgb(236, 91, 91)
    private val pixelFrameBitmapCache = mutableMapOf<Int, Bitmap>()
    private val pixelIconResourceIds = setOf(
        R.drawable.pixel_about, R.drawable.pixel_chat, R.drawable.pixel_check,
        R.drawable.pixel_connection, R.drawable.pixel_delete, R.drawable.pixel_display,
        R.drawable.pixel_edit, R.drawable.pixel_file_add, R.drawable.pixel_folder,
        R.drawable.pixel_language, R.drawable.pixel_match, R.drawable.pixel_notifications,
        R.drawable.pixel_pause, R.drawable.pixel_refresh, R.drawable.pixel_search,
        R.drawable.pixel_send, R.drawable.pixel_settings, R.drawable.pixel_terminal,
        R.drawable.pixel_theme,
    )
    private val pixelTypeface: Typeface by lazy(LazyThreadSafetyMode.NONE) {
        runCatching {
            val assetPath = "fonts/FusionPixel12pxProportionalZhHans.ttf"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val pixelFont = android.graphics.fonts.Font.Builder(assets, assetPath)
                    .setWeight(android.graphics.fonts.FontStyle.FONT_WEIGHT_NORMAL)
                    .build()
                val pixelFamily = android.graphics.fonts.FontFamily.Builder(pixelFont).build()
                Typeface.CustomFallbackBuilder(pixelFamily)
                    .setSystemFallback("sans-serif")
                    .setStyle(android.graphics.fonts.FontStyle(
                        android.graphics.fonts.FontStyle.FONT_WEIGHT_NORMAL,
                        android.graphics.fonts.FontStyle.FONT_SLANT_UPRIGHT,
                    ))
                    .build()
            } else Typeface.createFromAsset(assets, assetPath)
        }.getOrElse { Typeface.create("sans-serif", Typeface.NORMAL) }
    }
    private val pixelTheme get() = themeName == "pixel"
    private val retroTheme get() = themeName == "lollipop" || pixelTheme
    private val LOLLIPOP_PRIMARY: Int get() = if (pixelTheme) PIXEL_BLUE else Color.rgb(160, 171, 174)
    private val LOLLIPOP_PRIMARY_DARK: Int get() = if (pixelTheme) PIXEL_BACKGROUND else Color.rgb(185, 185, 185)
    private val LOLLIPOP_PRIMARY_LIGHT: Int get() = if (pixelTheme) PIXEL_PANEL_INSET else Color.rgb(48, 60, 68)
    private val LOLLIPOP_TEXT_SECONDARY: Int get() = if (pixelTheme) Color.rgb(190, 201, 216) else Color.rgb(184, 190, 188)
    private val ANDROID1_TITLE_TEXT: Int get() = if (pixelTheme) PIXEL_TEXT else Color.rgb(28, 28, 28)
    private val ANDROID1_ADDED_COLOR: Int get() = if (pixelTheme) PIXEL_GREEN else Color.rgb(145, 151, 111)
    private val ANDROID1_DELETED_COLOR: Int get() = if (pixelTheme) PIXEL_RED else Color.rgb(177, 99, 92)
    private val android1Typeface: Typeface by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) runCatching {
            val regular = android.graphics.fonts.Font.Builder(assets, "fonts/DroidSans.ttf")
                .setWeight(android.graphics.fonts.FontStyle.FONT_WEIGHT_NORMAL)
                .build()
            val bold = android.graphics.fonts.Font.Builder(assets, "fonts/DroidSans-Bold.ttf")
                .setWeight(android.graphics.fonts.FontStyle.FONT_WEIGHT_BOLD)
                .build()
            val latin = android.graphics.fonts.FontFamily.Builder(regular).addFont(bold).build()
            val cjkFont = android.graphics.fonts.Font.Builder(assets, "fonts/DroidSansFallback.ttf").build()
            val cjk = android.graphics.fonts.FontFamily.Builder(cjkFont).build()
            Typeface.CustomFallbackBuilder(latin)
                .addCustomFallback(cjk)
                .setSystemFallback("sans-serif")
                .setStyle(android.graphics.fonts.FontStyle(
                    android.graphics.fonts.FontStyle.FONT_WEIGHT_NORMAL,
                    android.graphics.fonts.FontStyle.FONT_SLANT_UPRIGHT,
                ))
                .build()
        }.getOrElse { Typeface.createFromAsset(assets, "fonts/DroidSans.ttf") }
        else Typeface.createFromAsset(assets, "fonts/DroidSans.ttf")
    }
    private val android1BoldTypeface: Typeface by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) Typeface.create(android1Typeface, Typeface.BOLD)
        else Typeface.createFromAsset(assets, "fonts/DroidSans-Bold.ttf")
    }
    private val prefs by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }
    private val themeName: String get() = (prefs.getString(KEY_THEME, if (prefs.getBoolean(KEY_LIGHT_THEME, false)) "light" else "dark") ?: "dark")
        .let { if (it == "oreo" || it == "gingerbread" || it == "android23") "lollipop" else it }
    private val lightTheme get() = when (themeName) {
        "light", "warm" -> true
        "pixel" -> false
        "custom" -> Color.luminance(parseThemeColor(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND)) > .46f
        else -> false
    }
    private val DARK: Int get() = when (themeName) {
        "light" -> Color.rgb(247, 248, 250)
        "warm" -> Color.rgb(247, 240, 230)
        "lollipop" -> Color.rgb(19, 22, 23)
        "pixel" -> PIXEL_BACKGROUND
        "custom" -> parseThemeColor(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND)
        else -> Color.rgb(16, 17, 20)
    }
    private val PANEL: Int get() = when (themeName) {
        "warm" -> Color.rgb(255, 250, 243)
        "lollipop" -> Color.rgb(29, 33, 34)
        "pixel" -> PIXEL_PANEL
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND), .9f)
        else -> if (lightTheme) Color.rgb(255, 255, 255) else Color.rgb(23, 25, 30)
    }
    private val OPAQUE_PANEL: Int get() = when (themeName) {
        "custom" -> parseThemeColor(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND)
        else -> PANEL
    }
    private val PANEL_INSET: Int get() = when (themeName) {
        "warm" -> Color.rgb(241, 231, 216)
        "lollipop" -> Color.rgb(39, 44, 45)
        "pixel" -> PIXEL_PANEL_INSET
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND), .78f)
        else -> if (lightTheme) Color.rgb(241, 243, 246) else Color.rgb(30, 32, 38)
    }
    private val BORDER: Int get() = when (themeName) {
        "warm" -> Color.rgb(225, 211, 194)
        "lollipop" -> Color.rgb(73, 79, 80)
        "pixel" -> PIXEL_BORDER
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT), .3f)
        else -> if (lightTheme) Color.rgb(213, 217, 224) else Color.rgb(52, 55, 63)
    }
    private val USER_BUBBLE: Int get() = when (themeName) {
        "warm" -> Color.rgb(240, 226, 208)
        "lollipop" -> Color.rgb(39, 51, 59)
        "pixel" -> Color.rgb(35, 55, 80)
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_BACKGROUND, DEFAULT_CUSTOM_BACKGROUND), .68f)
        else -> if (lightTheme) Color.rgb(232, 236, 244) else Color.rgb(29, 31, 37)
    }
    private val TEXT: Int get() = when (themeName) {
        "warm" -> Color.rgb(66, 53, 40)
        "lollipop" -> Color.rgb(237, 239, 236)
        "pixel" -> PIXEL_TEXT
        "custom" -> parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT)
        else -> if (lightTheme) Color.rgb(35, 38, 43) else Color.rgb(239, 241, 246)
    }
    private val SUBTLE: Int get() = when (themeName) {
        "warm" -> Color.rgb(109, 91, 71)
        "lollipop" -> Color.rgb(190, 195, 193)
        "pixel" -> Color.rgb(199, 207, 220)
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT), .84f)
        else -> if (lightTheme) Color.rgb(77, 83, 93) else Color.rgb(194, 198, 208)
    }
    private val MUTED: Int get() = when (themeName) {
        "warm" -> Color.rgb(139, 121, 100)
        "lollipop" -> Color.rgb(142, 149, 147)
        "pixel" -> Color.rgb(154, 169, 189)
        "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT), .64f)
        else -> if (lightTheme) Color.rgb(105, 112, 123) else Color.rgb(139, 145, 156)
    }
    private val ACCENT: Int get() = when {
        currentMode == "claude-code" -> if (lightTheme) Color.rgb(205, 102, 67) else Color.rgb(240, 141, 108)
        themeName == "lollipop" -> Color.rgb(111, 157, 197)
        pixelTheme -> PIXEL_BLUE
        themeName == "warm" -> Color.rgb(146, 114, 83)
        themeName == "custom" -> parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT)
        lightTheme -> Color.rgb(75, 96, 157)
        else -> Color.rgb(170, 186, 255)
    }
    private val CODEX_MODE_ACCENT: Int get() = if (themeName == "lollipop") Color.rgb(111, 157, 197) else if (pixelTheme) PIXEL_BLUE else if (lightTheme) Color.rgb(57, 75, 132) else Color.rgb(199, 208, 255)
    private val CODEX_MODE_ACCENT_FOREGROUND: Int get() = when (themeName) {
        "lollipop" -> Color.rgb(28, 31, 33)
        "pixel" -> Color.WHITE
        else -> if (lightTheme) Color.WHITE else Color.rgb(24, 27, 37)
    }
    private val ACCENT_WARM: Int get() = if (lightTheme) Color.rgb(205, 102, 67) else Color.rgb(240, 141, 108)
    private val CLAUDE_MODE_ACCENT = Color.rgb(238, 140, 109)
    private val DARK_THEME_CODEX_ACCENT = Color.rgb(170, 186, 255)
    private val DARK_THEME_CLAUDE_ACCENT = Color.rgb(240, 141, 108)
    private val CODEX_USER_MESSAGE_FILL: Int get() = when (themeName) {
        "lollipop" -> Color.rgb(43, 56, 65)
        "pixel" -> Color.rgb(37, 61, 89)
        else -> Color.rgb(159, 166, 203)
    }
    private val CLAUDE_USER_MESSAGE_FILL = Color.rgb(110, 69, 57)
    private val CODEX_USER_MESSAGE_TEXT: Int get() = when (themeName) {
        "lollipop" -> Color.rgb(230, 235, 238)
        "pixel" -> PIXEL_TEXT
        else -> Color.rgb(24, 27, 37)
    }
    private val CLAUDE_USER_MESSAGE_TEXT = Color.WHITE
    private val CLAUDE_USER_MESSAGE_SURFACE: Int get() = if (retroTheme) Color.rgb(75, 48, 39) else CLAUDE_USER_MESSAGE_FILL
    private val CLAUDE_USER_MESSAGE_FOREGROUND: Int get() = if (retroTheme) Color.rgb(255, 224, 209) else CLAUDE_USER_MESSAGE_TEXT
    private val ASSISTANT_NAME_ACCENT: Int get() = when {
        themeName == "warm" || themeName == "custom" -> if (currentMode == "claude-code") DARK_THEME_CLAUDE_ACCENT else DARK_THEME_CODEX_ACCENT
        else -> ACCENT
    }
    private val WARNING: Int get() = when {
        pixelTheme -> Color.rgb(201, 208, 219)
        themeName == "lollipop" -> Color.rgb(169, 178, 180)
        lightTheme -> Color.rgb(135, 91, 28)
        else -> Color.rgb(232, 190, 112)
    }
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
    private val pixelTextBitmapCache = object : LruCache<String, Bitmap>(8 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = (value.byteCount / 1024).coerceAtLeast(1)
    }
    private val pixelTextDrawFilter = PaintFlagsDrawFilter(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG, 0)
    private var nextPixelTextViewId = 0L

    @Suppress("DEPRECATION")
    private inner class PixelRasterTextView(context: Context, private val cacheId: Long) : TextView(context) {
        private var rasterRevision = 0L
        private var activeCacheKey: String? = null
        private val nearestNeighborPaint = Paint().apply {
            isAntiAlias = false
            isFilterBitmap = false
            isDither = false
        }
        private val destination = Rect()

        private fun invalidateRaster() {
            activeCacheKey?.let(pixelTextBitmapCache::remove)
            activeCacheKey = null
            rasterRevision++
        }

        override fun invalidate() {
            invalidateRaster()
            super.invalidate()
        }

        override fun invalidate(dirty: Rect?) {
            invalidateRaster()
            super.invalidate(dirty)
        }

        override fun invalidate(left: Int, top: Int, right: Int, bottom: Int) {
            invalidateRaster()
            super.invalidate(left, top, right, bottom)
        }

        override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
            invalidateRaster()
            super.onSizeChanged(width, height, oldWidth, oldHeight)
        }

        override fun onDraw(canvas: Canvas) {
            if (width <= 0 || height <= 0) {
                super.onDraw(canvas)
                return
            }

            val rasterWidth = ceil(width * PIXEL_TEXT_RASTER_SCALE).toInt().coerceAtLeast(1)
            val rasterHeight = ceil(height * PIXEL_TEXT_RASTER_SCALE).toInt().coerceAtLeast(1)
            val key = "$cacheId:$rasterRevision:${rasterWidth}x$rasterHeight:${text?.hashCode()}:${textSize}:${paint.color}:${typeface?.hashCode()}:${paint.shader?.hashCode()}:${gravity}:${maxLines}:${paddingLeft},${paddingTop},${paddingRight},${paddingBottom}"
            val bitmap = pixelTextBitmapCache.get(key) ?: runCatching {
                Bitmap.createBitmap(rasterWidth, rasterHeight, Bitmap.Config.ARGB_8888).also { raster ->
                    val lowResolutionCanvas = Canvas(raster)
                    lowResolutionCanvas.setDrawFilter(pixelTextDrawFilter)
                    lowResolutionCanvas.scale(PIXEL_TEXT_RASTER_SCALE, PIXEL_TEXT_RASTER_SCALE)
                    super.onDraw(lowResolutionCanvas)
                    activeCacheKey = key
                    pixelTextBitmapCache.put(key, raster)
                }
            }.getOrNull()

            if (bitmap == null) {
                super.onDraw(canvas)
                return
            }
            destination.set(0, 0, width, height)
            canvas.drawBitmap(bitmap, null, destination, nearestNeighborPaint)
        }
    }

    private var endpoint = ""
    private var token = ""
    private data class ConnectionProfile(val id: String, val name: String, val endpoint: String, val token: String)
    private val connectionProfiles = mutableListOf<ConnectionProfile>()
    private val draftFilesByScope = mutableMapOf<String, MutableList<JSONObject>>()
    private val pendingUserMessages = mutableMapOf<String, MutableList<JSONObject>>()
    private var activeConnectionId = ""
    @Volatile private var connectionGeneration = 0L
    @Volatile private var backgroundThreadDirty = false
    @Volatile private var backgroundListDirty = false
    @Volatile private var backgroundQueueDirty = false
    private var currentMode = "codex"
    private var activeThreadId: String? = null
    private var activeThread: JSONObject? = null
    private val displayedThreadTitles = mutableMapOf<String, String>()
    private var runtime = JSONObject()
    private var threads = JSONArray()
    internal var models = JSONArray()
    private var queuedMessages = JSONArray()
    private var syncRevisions = mutableMapOf<String, String>()
    private val threadReadsInFlight = mutableSetOf<String>()
    private val pendingThreadReads = mutableSetOf<String>()
    private val pinnedThreadIds = mutableSetOf<String>()
    private val selectedSidebarThreadIds = mutableSetOf<String>()
    private var sidebarSelectionMode = false
    private var sidebarSelectionBusy = false
    private var visibleSidebarThreadIds = emptyList<String>()
    private var running = false
    private val pausedThreadKeys = mutableSetOf<String>()
    @Volatile private var foreground = false
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
    private val expandedSettingsSections = mutableSetOf("主题")
    private var settingsScroll: ScrollView? = null
    private var settingsDialog: Dialog? = null
    private var settingsNotificationButton: TextView? = null
    private var notificationPermissionRequestedFromSettings = false
    private var preferencePopup: PopupWindow? = null
    private var webPreviewPopup: PopupWindow? = null
    private var webPreviewView: WebView? = null
    private var webPreviewRelayout: (() -> Unit)? = null
    private var webPreviewCleanup: (() -> Unit)? = null
    private var pendingWebDownload: PendingWebDownload? = null
    private var sidebarHost: EdgeDrawerHost? = null
    private var sidebarLongPressActive = false
    private var sidebarTouchActive = false
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
    private var queueTouchActive = false
    private var queueRenderDirty = false
    private var expandedOperationIds = mutableSetOf<String>()
    private var fullyExpandedOperationIds = mutableSetOf<String>()
    private var expandedFileChangeIds = mutableSetOf<String>()
    private var visibleHistoryTurnCount = DEFAULT_VISIBLE_HISTORY_TURNS
    private var selectedFiles = mutableListOf<JSONObject>()
    private var queueEditItem: JSONObject? = null
    private var queueEditThreadId: String? = null
    private var queueEditOwnerId: String? = null
    private var queueEditPending = false
    private var queueEditGeneration = 0L
    private var queueEditRenewRunnable: Runnable? = null
    private var sendBusy = false
    private var queueEditDraft = ""
    private var queueEditDraftFiles = mutableListOf<JSONObject>()
    private val queueEditPreferences = mutableMapOf<String, String?>()
    private var workspaceClipboard = mutableListOf<String>()
    private var workspaceClipboardMode = "copy"
    @Volatile private var socket: WebSocket? = null
    @Volatile private var socketConnected = false
    private var outstandingSocketPing: String? = null
    private var socketPingSentAt = 0L
    @Volatile private var lastSocketActivityAt = 0L
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
    private var attachmentPickerScope: String? = null
    private var restoreImeAfterAttachment = false
    private val deliveredQueueIds = mutableSetOf<String>()
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
    private var messageNearBottomBeforeIme = false
    private var messageTouchActive = false
    private var followMessageBottom = true
    private var completionNoticeThreadId: String? = null
    private var completionNoticeEngine: String? = null
    private var completionNoticeDismissRunnable: Runnable? = null
    private var pendingCompletionNoticeThreadId: String? = null
    private var modeSwitchDismissRunnable: Runnable? = null
    private var themeBackgroundPickerActive = false
    private var previewFontAdjustment: Int? = null
    private var previewBackgroundTransparency: Int? = null
    private val themeWallpaperDrawables = mutableListOf<WeakReference<ThemeWallpaperDrawable>>()
    private var cachedThemeBackgroundUri: String? = null
    private var cachedThemeBackgroundBitmap: Bitmap? = null
    private var activeThreadRefreshScheduled = false
    private var lastActiveThreadRefreshAt = 0L
    private val historyMemoryCache = object : LinkedHashMap<String, JSONObject>(12, .75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JSONObject>?): Boolean = size > 12
    }

    private lateinit var root: FrameLayout
    private lateinit var page: LinearLayout
    private lateinit var headerView: LinearLayout
    private lateinit var composerDock: LinearLayout
    private lateinit var composerSurface: LinearLayout
    private lateinit var composerFileChanges: LinearLayout
    private var expandedComposerFileChangesTurnId: String? = null
    private lateinit var composerGlowDrawable: ComposerGlowDrawable
    private var composerGlowAnimator: ValueAnimator? = null
    private var composerGlowRunning = false
    private lateinit var titleView: TextView
    private lateinit var modeButton: ImageButton
    private lateinit var statusView: TextView
    private lateinit var messageScroll: ScrollView
    private lateinit var messageList: LinearLayout
    private var activeActivityText: TextView? = null
    private var activeActivityTimer: TextView? = null
    private var activityShimmerAnimator: ValueAnimator? = null
    private var activeActivityStartedAt = 0L
    private var liveActivityItem: JSONObject? = null
    private var liveActivityItemCompleted = false
    private var liveActivityTurnId: String? = null
    private var liveActivityLabel: String? = null
    private val activityTick = object : Runnable {
        override fun run() {
            if (!running || activeActivityTimer == null) return
            val elapsed = ((System.currentTimeMillis() - activeActivityStartedAt).coerceAtLeast(0L) / 1000L)
            activeActivityTimer?.text = "已用 ${elapsed / 60L}分${elapsed % 60L}秒"
            handler.postDelayed(this, 1000L)
        }
    }
    private lateinit var welcomeTitleView: TextView
    private lateinit var scrollToBottomButton: ImageButton
    private lateinit var queuePanel: LinearLayout
    private lateinit var queueContent: LinearLayout
    private lateinit var completionNotice: LinearLayout
    private lateinit var modeSwitchNotice: LinearLayout
    private lateinit var composerInput: EditText
    private lateinit var queueEditBar: LinearLayout
    private lateinit var attachmentScroll: HorizontalScrollView
    private lateinit var attachmentStrip: LinearLayout
    private lateinit var sidebarNewThreadButton: LinearLayout
    private lateinit var sidebarNewThreadIcon: ImageView
    private lateinit var sidebarNewThreadLabel: TextView
    private val sidebarActionAccentViews = mutableListOf<Pair<ImageView, TextView>>()
    private lateinit var sidebarBrandMark: ImageView
    private lateinit var sendButton: ImageView
    private lateinit var modelButton: TextView
    private lateinit var effortButton: TextView
    private lateinit var permissionButton: TextView
    private lateinit var drawer: LinearLayout
    private lateinit var drawerSearch: EditText
    private lateinit var drawerThreads: LinearLayout
    private lateinit var sidebarSelectionBar: LinearLayout
    private var welcomeAnimationText = ""
    private var welcomeCharacterIndex = 0
    private var welcomeCaretBlinkCount = 0
    private var welcomeCaretVisible = true
    private var welcomeAnimationActive = false
    private var welcomeAnimationScheduled = false
    private val welcomeTypingRunnable = object : Runnable {
        override fun run() = animateWelcomeTitleStep()
    }

    private data class EdgeDrawerHost(
        val overlay: FrameLayout,
        val scrim: View,
        val panel: LinearLayout,
        val gravity: Int,
        val wallpaper: ThemeWallpaperDrawable?,
    )

    private val socketHeartbeatRunnable = object : Runnable {
        override fun run() {
            if ((!foreground && !prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)) || !socketConnected) return
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
        applySystemBarTheme()

        endpoint = prefs.getString(KEY_ENDPOINT, "").orEmpty()
        token = prefs.getString(KEY_TOKEN, "").orEmpty()
        loadConnectionProfiles()
        currentMode = prefs.getString(KEY_MODE, "codex") ?: "codex"
        if (endpoint.isNotBlank() && token.isNotBlank()) {
            openChatHome()
            verifySavedConnection(homeAlreadyOpen = true)
        } else showConnectionPage()
        intent?.takeIf { it.hasExtra(EXTRA_THREAD_ID) }?.let { launchIntent ->
            handler.post { navigateNotification(launchIntent) }
        }
    }

    private fun applySystemBarTheme() {
        val lollipop = themeName == "lollipop"
        val retro = retroTheme
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.statusBarColor = if (retro) LOLLIPOP_PRIMARY_DARK else Color.TRANSPARENT
            window.navigationBarColor = when {
                lollipop -> Color.BLACK
                pixelTheme -> PIXEL_BACKGROUND
                else -> Color.TRANSPARENT
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.isStatusBarContrastEnforced = false
                window.isNavigationBarContrastEnforced = false
            }
        } else {
            window.statusBarColor = if (retro) LOLLIPOP_PRIMARY_DARK else DARK
            window.navigationBarColor = if (lollipop) Color.BLACK else DARK
        }
        window.decorView.setBackgroundColor(DARK)
        window.decorView.systemUiVisibility = if (lollipop) View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR else if (lightTheme) {
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        } else 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false
    }

    override fun onResume() {
        super.onResume()
        webPreviewView?.onResume()
        foreground = true
        activeActivityText?.let(::startActivityShimmer)
        if (token.isNotBlank()) {
            val now = System.currentTimeMillis()
            val wasBackgrounded = backgroundedAt > 0L
            val backgroundDuration = if (wasBackgrounded) now - backgroundedAt else 0L
            val socketIsStale = lastSocketActivityAt > 0L && now - lastSocketActivityAt > 45_000L
            if (socket != null && (!socketConnected || socketIsStale)) {
                socket?.cancel()
                socket = null
                socketConnected = false
                outstandingSocketPing = null
            }
            val shouldCatchUp = wasBackgrounded &&
                (backgroundDuration > 5_000L || backgroundThreadDirty || backgroundListDirty || backgroundQueueDirty || !socketConnected)
            backgroundedAt = 0L
            connectSocket()
            handler.removeCallbacks(socketHeartbeatRunnable)
            handler.postDelayed(socketHeartbeatRunnable, 20_000)
            if (shouldCatchUp) {
                if (activeThreadId != null) refreshActiveThread(false)
                refreshThreads(false)
                if (backgroundListDirty) refreshPins()
                if (activeThreadId != null) refreshQueue(false)
            }
            backgroundThreadDirty = false
            backgroundListDirty = false
            backgroundQueueDirty = false
            handler.removeCallbacks(refreshRunnable)
            handler.postDelayed(refreshRunnable, if (socketConnected) 30_000L else 15_000L)
        }
    }

    override fun onPause() {
        webPreviewView?.onPause()
        activityShimmerAnimator?.cancel()
        activityShimmerAnimator = null
        persistCurrentDraft()
        if (!imeInsetVisible) parkActivityInputFocus()
        foreground = false
        backgroundedAt = System.currentTimeMillis()
        handler.removeCallbacks(refreshRunnable)
        handler.removeCallbacks(activeThreadRefreshRunnable)
        activeThreadRefreshScheduled = false
        if (!prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)) {
            handler.removeCallbacks(socketHeartbeatRunnable)
            outstandingSocketPing = null
        }
        if (socket == null && prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)) scheduleSocketReconnect()
        super.onPause()
    }

    private fun parkActivityInputFocus() {
        if (!::root.isInitialized) return
        val focusedInput = window.currentFocus as? EditText ?: return
        if (!focusedInput.isAttachedToWindow) return
        root.isFocusableInTouchMode = true
        root.requestFocus()
    }

    override fun onDestroy() {
        closeWebPreview()
        activityShimmerAnimator?.cancel()
        activityShimmerAnimator = null
        composerGlowAnimator?.cancel()
        composerGlowAnimator = null
        stopQueueEditRenewal()
        handler.removeCallbacksAndMessages(null)
        val closingSocket = socket
        socket = null
        closingSocket?.close(1000, "activity destroyed")
        terminalSocket?.close(1000, "terminal closed")
        io.shutdownNow()
        super.onDestroy()
    }

    @Deprecated("Native back handling is kept compatible with Android versions supported by this app")
    override fun onBackPressed() {
        when {
            settingsDialog?.isShowing == true -> settingsDialog?.dismiss()
            preferencePopup?.isShowing == true -> preferencePopup?.dismiss()
            settingsOverlay != null -> closeSettings(animated = true)
            webPreviewPopup?.isShowing == true && webPreviewView?.canGoBack() == true -> webPreviewView?.goBack()
            webPreviewPopup?.isShowing == true -> closeWebPreview()
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
            queueEditItem != null -> finishQueueEdit(false)
            else -> moveTaskToBack(true)
        }
    }

    private fun loadConnectionProfiles() {
        connectionProfiles.clear()
        val saved = runCatching { JSONArray(prefs.getString(KEY_CONNECTION_PROFILES, "[]")) }.getOrDefault(JSONArray())
        for (index in 0 until saved.length()) {
            val entry = saved.optJSONObject(index) ?: continue
            val id = entry.optString("id")
            val address = entry.optString("endpoint")
            if (id.isBlank() || address.isBlank()) continue
            connectionProfiles += ConnectionProfile(id, entry.optString("name").ifBlank { connectionName(address) }, address, entry.optString("token"))
        }
        if (connectionProfiles.isEmpty() && endpoint.isNotBlank()) {
            val legacy = ConnectionProfile(UUID.randomUUID().toString(), connectionName(endpoint), endpoint, token)
            connectionProfiles += legacy
            prefs.edit().putString(KEY_LEGACY_CONNECTION_ID, legacy.id).apply()
        }
        val requestedId = prefs.getString(KEY_ACTIVE_CONNECTION_ID, null)
        val selected = connectionProfiles.firstOrNull { it.id == requestedId }
            ?: connectionProfiles.firstOrNull { it.endpoint == endpoint }
            ?: connectionProfiles.firstOrNull()
        activeConnectionId = selected?.id.orEmpty()
        if (selected != null) {
            endpoint = selected.endpoint
            token = selected.token
            persistConnectionProfiles()
        }
    }

    private fun connectionName(address: String): String = Uri.parse(address).authority?.takeIf { it.isNotBlank() } ?: address

    private fun persistConnectionProfiles() {
        val saved = JSONArray()
        connectionProfiles.forEach { profile ->
            saved.put(JSONObject().put("id", profile.id).put("name", profile.name)
                .put("endpoint", profile.endpoint).put("token", profile.token))
        }
        prefs.edit().putString(KEY_CONNECTION_PROFILES, saved.toString())
            .putString(KEY_ACTIVE_CONNECTION_ID, activeConnectionId)
            .putString(KEY_ENDPOINT, endpoint).putString(KEY_TOKEN, token).apply()
    }

    private fun saveConnectionProfile(address: String, pairedToken: String, requestedName: String = ""): String {
        val existingIndex = connectionProfiles.indexOfFirst { it.endpoint == address }
        val previous = connectionProfiles.getOrNull(existingIndex)
        val profile = ConnectionProfile(previous?.id ?: UUID.randomUUID().toString(),
            requestedName.trim().ifBlank { previous?.name ?: connectionName(address) }, address, pairedToken)
        if (existingIndex >= 0) connectionProfiles[existingIndex] = profile else connectionProfiles += profile
        return profile.id
    }

    private fun updateActiveConnectionToken(newToken: String) {
        token = newToken
        val index = connectionProfiles.indexOfFirst { it.id == activeConnectionId }
        if (index >= 0) connectionProfiles[index] = connectionProfiles[index].copy(token = newToken)
        persistConnectionProfiles()
    }

    private fun switchConnection(profileId: String, restoreSettingsScrollY: Int? = null) {
        if (queueEditPending || queueEditItem != null) { showStatus("请先结束排队消息编辑"); return }
        val profile = connectionProfiles.firstOrNull { it.id == profileId } ?: return
        if (profile.id == activeConnectionId && token == profile.token && ::composerInput.isInitialized) {
            closeSettings()
            if (restoreSettingsScrollY != null) showSettings(restoreSettingsScrollY)
            return
        }
        persistCurrentDraft()
        connectionGeneration++
        sidebarSelectionMode = false
        selectedSidebarThreadIds.clear()
        setSendBusy(false)
        activeConnectionId = profile.id
        endpoint = profile.endpoint
        token = profile.token
        activeThreadId = null
        activeThread = null
        selectedFiles = draftFilesByScope[draftStorageKey()]?.toMutableList() ?: mutableListOf()
        persistConnectionProfiles()
        closeSettings()
        pinnedThreadIds.clear()
        historyMemoryCache.clear()
        messageImageCache.evictAll()
        threadReadsInFlight.clear()
        pendingThreadReads.clear()
        if (token.isBlank()) showConnectionPage("这个连接需要重新配对。") else {
            openChatHome()
            if (restoreSettingsScrollY != null) showSettings(restoreSettingsScrollY)
        }
    }

    private fun connectionScopedKey(base: String): String =
        if (activeConnectionId.isBlank() || activeConnectionId == prefs.getString(KEY_LEGACY_CONNECTION_ID, null)) base
        else "${activeConnectionId}_$base"

    private fun activeThreadStorageKey(mode: String): String = connectionScopedKey("$KEY_ACTIVE_THREAD_PREFIX$mode")

    private fun showConnectionPage(message: String? = null) {
        closeWebPreview()
        root = FrameLayout(this)
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

        connectionProfiles.filter { it.token.isNotBlank() }.forEach { profile ->
            card.addView(settingsActionRow("切换到 ${profile.name}", profile.endpoint) { switchConnection(profile.id) }, widthWrap())
        }

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
                        switchConnection(saveConnectionProfile(normalized, newToken))
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
        val generation = connectionGeneration
        val api = RemoteApi(endpoint, token)
        io.execute {
            try {
                api.get("/api/v1/codex/status")
                if (!homeAlreadyOpen) handler.post { if (generation == connectionGeneration) openChatHome() }
            } catch (error: Exception) {
                if (error is RemoteApiException && error.statusCode == 401) {
                    handler.post {
                        if (generation != connectionGeneration) return@post
                        updateActiveConnectionToken("")
                        showConnectionPage(error.message ?: "配对已失效，请重新输入匹配码。")
                    }
                } else {
                    handler.post {
                        if (generation != connectionGeneration) return@post
                        if (!homeAlreadyOpen) openChatHome()
                        showStatus("电脑服务暂时无法连接，已保留配对信息，正在重试。")
                    }
                }
            }
        }
    }

    private fun openChatHome() {
        abandonQueueEditForHome()
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
        running = false
        pendingApproval = null
        pendingCompletionNoticeThreadId = null
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
        workspaceCurrentPath = ""
        workspaceRootPath = ""
        workspaceGestureActive = false
        workspacePendingRender = null
        closeTerminal()
        messageRenderDeferred = false
        deferredMessageScrollToEnd = false
        deferredMessageRequiresFullRender = false
        deferredMessageTurnIds.clear()
        syncRevisions.clear()
        renderHome()
        prefs.getString(activeThreadStorageKey(currentMode), null)
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
        handler.postDelayed(refreshRunnable, 15_000L)
    }

    private fun installWindowInsets(view: View, content: View? = null) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        var overlaysInitialized = false
        var imeAnimationDepth = 0
        val update = { insets: WindowInsets ->
            val systemBars = insets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsets.Type.ime())
            val keyboardVisible = insets.isVisible(WindowInsets.Type.ime()) || ime.bottom > systemBars.bottom
            val keyboardJustOpened = keyboardVisible && !imeInsetVisible
            val bottom = max(systemBars.bottom, ime.bottom)
            imeInsetVisible = keyboardVisible
            if (content == null) {
                view.setPadding(systemBars.left, systemBars.top, systemBars.right, bottom)
            } else {
                if (keyboardJustOpened && ::messageScroll.isInitialized) {
                    imeFollowMessageBottom = ::composerInput.isInitialized &&
                        composerInput.hasFocus() && messageNearBottomBeforeIme
                }
                val systemInsetsChanged = !overlaysInitialized ||
                    systemInsetLeft != systemBars.left || systemInsetTop != systemBars.top ||
                    systemInsetRight != systemBars.right || systemInsetBottom != systemBars.bottom
                systemInsetLeft = systemBars.left
                systemInsetTop = systemBars.top
                systemInsetRight = systemBars.right
                systemInsetBottom = systemBars.bottom
                if (view.paddingLeft != 0 || view.paddingTop != 0 ||
                    view.paddingRight != 0 || view.paddingBottom != 0
                ) view.setPadding(0, 0, 0, 0)
                if (content.paddingLeft != 0 || content.paddingTop != 0 ||
                    content.paddingRight != 0 || content.paddingBottom != bottom
                ) {
                    content.setPadding(0, 0, 0, bottom)
                }
                if (systemInsetsChanged) {
                    updateInsetAwareOverlays()
                    overlaysInitialized = true
                }
                val terminalKeyboardVisible = keyboardVisible && terminalDraftInput?.hasFocus() == true
                terminalImeHiddenUntil = when {
                    terminalKeyboardVisible -> 0L
                    terminalImeVisible -> System.currentTimeMillis() + 500L
                    else -> terminalImeHiddenUntil
                }
                terminalImeVisible = terminalKeyboardVisible
                if (keyboardJustOpened && imeFollowMessageBottom) {
                    scheduleImeMessageBottomFollow()
                } else if (!keyboardVisible) {
                    imeFollowMessageBottom = false
                    imeFollowScrollQueued = false
                }
            }
        }
        view.setOnApplyWindowInsetsListener { _, insets ->
            if (imeAnimationDepth == 0) update(insets)
            insets
        }
        view.setWindowInsetsAnimationCallback(object : WindowInsetsAnimation.Callback(
            WindowInsetsAnimation.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE,
        ) {
            override fun onPrepare(animation: WindowInsetsAnimation) {
                if ((animation.typeMask and WindowInsets.Type.ime()) != 0) imeAnimationDepth++
            }

            override fun onProgress(
                insets: WindowInsets,
                runningAnimations: MutableList<WindowInsetsAnimation>,
            ): WindowInsets {
                update(insets)
                return insets
            }

            override fun onEnd(animation: WindowInsetsAnimation) {
                if ((animation.typeMask and WindowInsets.Type.ime()) != 0) {
                    imeAnimationDepth = (imeAnimationDepth - 1).coerceAtLeast(0)
                    if (imeAnimationDepth == 0) {
                        view.rootWindowInsets?.let(update)
                        if (imeInsetVisible && imeFollowMessageBottom) scheduleImeMessageBottomFollow()
                    }
                }
            }
        })
        view.requestApplyInsets()
    }

    private fun isMessageListNearBottom(): Boolean {
        if (!::messageScroll.isInitialized || !::messageList.isInitialized) return false
        val distanceToBottom = messageList.height - messageScroll.scrollY - messageScroll.height
        return distanceToBottom <= dp(180)
    }

    private fun scheduleImeMessageBottomFollow() {
        if (imeFollowScrollQueued || !::messageScroll.isInitialized || !::messageList.isInitialized) return
        imeFollowScrollQueued = true
        messageScroll.postOnAnimation {
            imeFollowScrollQueued = false
            if (imeInsetVisible && imeFollowMessageBottom) {
                messageScroll.scrollTo(0, messageList.height)
            }
        }
    }

    private fun updateInsetAwareOverlays() {
        if (::headerView.isInitialized) {
            headerView.setPadding(dp(10) + systemInsetLeft, systemInsetTop + dp(2), dp(8) + systemInsetRight, dp(2))
            headerView.layoutParams?.let { params ->
                val targetHeight = systemInsetTop + dp(44)
                if (params.height != targetHeight) {
                    params.height = targetHeight
                    headerView.layoutParams = params
                }
            }
        }
        if (::statusView.isInitialized) statusView.setPadding(dp(16) + systemInsetLeft, 0, dp(16) + systemInsetRight, dp(4))
        if (::messageScroll.isInitialized) messageScroll.setPadding(dp(12) + systemInsetLeft, dp(8), dp(12) + systemInsetRight, dp(8))
        if (::welcomeTitleView.isInitialized) welcomeTitleView.setPadding(dp(12) + systemInsetLeft, dp(24), dp(12) + systemInsetRight, dp(24))
        if (::scrollToBottomButton.isInitialized) {
            (scrollToBottomButton.layoutParams as? FrameLayout.LayoutParams)?.let { params ->
                params.rightMargin = dp(16) + systemInsetRight
                scrollToBottomButton.layoutParams = params
            }
        }
        if (::composerSurface.isInitialized) composerSurface.setPadding(
            dp(11) + systemInsetLeft,
            dp(8),
            dp(11) + systemInsetRight,
            dp(6),
        )
        if (::composerFileChanges.isInitialized) composerFileChanges.setPadding(systemInsetLeft, 0, systemInsetRight, 0)
        fun applyNoticeInsets(view: View) {
            (view.layoutParams as? LinearLayout.LayoutParams)?.let { params ->
                params.leftMargin = dp(12) + systemInsetLeft
                params.rightMargin = dp(12) + systemInsetRight
                view.layoutParams = params
            }
        }
        if (::completionNotice.isInitialized) applyNoticeInsets(completionNotice)
        if (::modeSwitchNotice.isInitialized) applyNoticeInsets(modeSwitchNotice)
        applyEdgeDrawerInsets(sidebarHost)
        applyEdgeDrawerInsets(workspaceHost)
        (settingsOverlay?.findViewWithTag<View>(TAG_INSET_CONTENT))?.setPadding(
            systemInsetLeft,
            systemInsetTop,
            systemInsetRight,
            systemInsetBottom,
        )
        positionTerminalOverlay()
        webPreviewRelayout?.invoke()
    }

    private fun renderHome() {
        closeWebPreview()
        root = ChatRootLayout(this).apply { isFocusableInTouchMode = true }
        installThemeBackground(root)
        page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = when {
                themeName == "custom" -> ColorDrawable(Color.TRANSPARENT)
                retroTheme -> lollipopSystemBarsBackground(DARK)
                else -> ColorDrawable(DARK)
            }
        }
        root.addView(page, FrameLayout.LayoutParams(MATCH, MATCH))
        buildHeader()
        statusView = label("正在连接…", 11, MUTED).apply {
            setPadding(dp(16) + systemInsetLeft, 0, dp(16) + systemInsetRight, dp(4))
            visibility = View.GONE
        }
        page.addView(statusView, widthWrap())
        messageScroll = ScrollView(this).apply {
            isFillViewport = false
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            clipToPadding = false
            setPadding(dp(12) + systemInsetLeft, dp(8), dp(12) + systemInsetRight, dp(8))
        }
        messageList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        messageScroll.addView(messageList, FrameLayout.LayoutParams(MATCH, WRAP))
        val chatArea = FrameLayout(this).apply {
            clipChildren = false
            setBackgroundColor(if (themeName == "custom") Color.TRANSPARENT else DARK)
        }
        chatArea.addView(messageScroll, FrameLayout.LayoutParams(MATCH, MATCH))
        welcomeTitleView = label("", 18, TEXT, true).apply {
            gravity = Gravity.CENTER
            textAlignment = View.TEXT_ALIGNMENT_CENTER
            breakStrategy = Layout.BREAK_STRATEGY_BALANCED
            maxLines = 2
            setPadding(dp(12) + systemInsetLeft, dp(24), dp(12) + systemInsetRight, dp(24))
            visibility = View.GONE
        }
        chatArea.addView(welcomeTitleView, FrameLayout.LayoutParams(MATCH, MATCH, Gravity.CENTER))
        scrollToBottomButton = iconButton("chevron_down", "回到底部") {
            followMessageBottom = true
            messageScroll.post { messageScroll.smoothScrollTo(0, messageList.height) }
        }.apply {
            imageTintList = retroIconTint(TEXT)
            setPadding(dp(10), dp(10), dp(10), dp(10))
            background = rounded(PANEL, dp(21), BORDER, dp(1))
            elevation = dp(3).toFloat()
            visibility = View.GONE
        }
        chatArea.addView(scrollToBottomButton, FrameLayout.LayoutParams(dp(42), dp(42), Gravity.END or Gravity.BOTTOM).apply {
            rightMargin = dp(16) + systemInsetRight
            bottomMargin = dp(12)
        })
        messageScroll.setOnScrollChangeListener { _, _, _, _, _ ->
            if (!imeInsetVisible) messageNearBottomBeforeIme = isMessageListNearBottom()
            if (messageTouchActive && !isMessageListNearBottom()) followMessageBottom = false
            updateScrollToBottomButton()
        }
        messageScroll.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    messageTouchActive = true
                    if (imeInsetVisible) imeFollowMessageBottom = false
                    else messageNearBottomBeforeIme = isMessageListNearBottom()
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    messageTouchActive = false
                    messageScroll.post { if (isMessageListNearBottom()) followMessageBottom = true }
                }
            }
            false
        }
        page.addView(chatArea, LinearLayout.LayoutParams(MATCH, 0, 1f))
        buildQueuePanel()
        buildCompletionNotice()
        buildModeSwitchNotice()
        buildComposer()
        buildSidebar()
        setContentView(root)
        root.requestFocus()
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
            background = if (retroTheme) lollipopActionBarBackground() else ColorDrawable(Color.TRANSPARENT)
        }
        val menu = iconButton("menu", "打开对话列表") { setSidebarVisible(true) }.apply {
            if (retroTheme) {
                imageTintList = null
                background = android1SegmentButtonBackground()
            }
        }
        val actionSize = if (retroTheme) dp(42) else dp(40)
        if (pixelTheme) menu.setPadding(dp(5), dp(5), dp(5), dp(5))
        headerView.addView(menu, LinearLayout.LayoutParams(actionSize, actionSize))
        val titleColumn = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(4), 0, dp(4), 0) }
        titleView = label("Codex Remote", if (retroTheme) 20 else 14, if (retroTheme) ANDROID1_TITLE_TEXT else TEXT, true).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        titleColumn.addView(titleView, widthWrap())
        val path = label("本机项目", if (retroTheme) 12 else 10, if (retroTheme && !pixelTheme) Color.rgb(72, 72, 72) else MUTED).apply { tag = "workspace_path"; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE }
        titleColumn.addView(path, widthWrap())
        headerView.addView(titleColumn, LinearLayout.LayoutParams(0, WRAP, 1f))
        val targetMode = modeSwitchTarget()
        modeButton = iconButton(if (targetMode == "claude-code") "claude" else "codex", modeSwitchDescription()) { switchMode() }
        if (retroTheme) modeButton.background = android1SegmentButtonBackground()
        headerView.addView(modeButton, LinearLayout.LayoutParams(actionSize, actionSize))
        headerView.addView(iconButton("terminal", "打开终端") { showTerminal() }.apply {
            if (retroTheme) {
                imageTintList = null
                background = android1SegmentButtonBackground()
            }
            if (pixelTheme) setPadding(dp(5), dp(5), dp(5), dp(5))
        }, LinearLayout.LayoutParams(actionSize, actionSize))
        headerView.addView(iconButton("folder", "打开文件树") { showWorkspaceBrowser() }.apply {
            if (retroTheme) {
                imageTintList = null
                background = android1SegmentButtonBackground()
            }
            if (pixelTheme) setPadding(dp(5), dp(5), dp(5), dp(5))
        }, LinearLayout.LayoutParams(actionSize, actionSize))
        page.addView(headerView, LinearLayout.LayoutParams(MATCH, dp(if (pixelTheme) 48 else if (retroTheme) 42 else 44)))
    }

    private fun buildQueuePanel() {
        queueTouchActive = false
        queueRenderDirty = false
        queuePanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(2), dp(2), dp(2), 0)
            visibility = View.GONE
        }
        queueContent = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
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
            imageTintList = ColorStateList.valueOf(brandIconTint(engine))
            contentDescription = if (engine == "claude-code") "Claude Code" else "Codex"
        }
        completionNotice.addView(brand, LinearLayout.LayoutParams(dp(22), dp(22)).apply { rightMargin = dp(9) })
        val thread = findThread(threadId)
        val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        copy.addView(label(thread?.let(::threadTitle)?.let { "“$it”${tr("已完成回复")}" } ?: tr("另一模式的对话已完成回复"), 12, TEXT, true, translateUi = false), widthWrap())
        copy.addView(label("${if (engine == "claude-code") "Claude Code" else "Codex"} 已完成 · 点击查看", 10, MUTED), widthWrap())
        completionNotice.addView(copy, LinearLayout.LayoutParams(0, WRAP, 1f))
        completionNotice.addView(ImageView(this).apply {
            val activeClaude = currentMode == "claude-code"
            setImageResource(if (activeClaude) R.drawable.ic_brand_claude else R.drawable.ic_brand_codex)
            imageTintList = ColorStateList.valueOf(brandIconTint(if (activeClaude) "claude-code" else "codex"))
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
                imageTintList = ColorStateList.valueOf(brandIconTint(if (claude) "claude-code" else "codex"))
                contentDescription = if (claude) "Claude Code" else "Codex"
            }, LinearLayout.LayoutParams(dp(19), dp(19)).apply { if (index == 0) rightMargin = dp(4) else leftMargin = dp(4) })
            if (index == 0) {
                if (retroTheme) modeSwitchNotice.addView(ImageView(this).apply {
                    setPixelAwareImageResource(iconResource("chevron_right"))
                    imageTintList = null
                }, LinearLayout.LayoutParams(dp(16), dp(16)))
                else modeSwitchNotice.addView(label("→", 13, MUTED, true), LinearLayout.LayoutParams(WRAP, WRAP))
            }
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
        composerGlowAnimator?.cancel()
        composerGlowAnimator = null
        composerGlowRunning = false
        composerDock = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(2), dp(12), dp(12))
            background = ColorDrawable(Color.TRANSPARENT)
            clipChildren = false
            clipToPadding = false
        }
        composerFileChanges = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        composerDock.addView(composerFileChanges, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(3) })
        val composer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(11) + systemInsetLeft, dp(8), dp(11) + systemInsetRight, dp(6))
            composerGlowDrawable = ComposerGlowDrawable(composerGlowColor(), dp(if (retroTheme) 10 else 18).toFloat(), composerGlowOpacity())
            if (retroTheme) {
                background = if (pixelTheme) pixelFrameBackground(R.drawable.pixel_frame_strip, PANEL)
                    else rounded(PANEL, dp(2), BORDER, dp(1))
                elevation = 0f
            } else {
                background = LayerDrawable(arrayOf(composerGlassBackground(), composerGlowDrawable))
            }
        }
        composerSurface = composer
        composer.addView(queuePanel, LinearLayout.LayoutParams(MATCH, WRAP))
        composer.addView(queueContent, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(2) })
        queueEditBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            visibility = View.GONE
        }
        queueEditBar.addView(label("正在修改排队消息", 12, SUBTLE, true), LinearLayout.LayoutParams(0, dp(32), 1f))
        queueEditBar.addView(iconButton("close", "取消修改排队消息") { finishQueueEdit(false) }, LinearLayout.LayoutParams(dp(32), dp(32)))
        composer.addView(queueEditBar, LinearLayout.LayoutParams(MATCH, dp(32)))
        composerInput = editField("发送消息…", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_MULTI_LINE).apply {
            minHeight = dp(44)
            maxLines = 5
            gravity = Gravity.TOP or Gravity.START
            imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_ACTION_SEND
            setPadding(dp(2), dp(5), dp(2), dp(4))
            setLineSpacing(dp(2).toFloat(), 1.25f)
            background = null
            setOnFocusChangeListener { _, hasFocus ->
                if (hasFocus && !imeInsetVisible) messageNearBottomBeforeIme = isMessageListNearBottom()
            }
            setOnTouchListener { _, event ->
                if (event.actionMasked == MotionEvent.ACTION_DOWN && !imeInsetVisible) {
                    messageNearBottomBeforeIme = isMessageListNearBottom()
                }
                false
            }
            setOnEditorActionListener { _, action, event ->
                val enter = event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER && event.isShiftPressed != true
                if (action == EditorInfo.IME_ACTION_SEND || enter) {
                    sendCurrentMessage()
                    true
                } else false
            }
            addTextChangedListener(SimpleTextWatcher { value ->
                if (queueEditItem == null) prefs.edit().putString(draftStorageKey(), value).apply()
                updateSendButton()
            })
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

        if (retroTheme) {
            composer.addView(View(this).apply { setBackgroundColor(BORDER) }, LinearLayout.LayoutParams(MATCH, dp(1)).apply {
                topMargin = dp(4)
                bottomMargin = dp(3)
            })
        }
        val footer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val preferenceScroll = HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_NEVER }
        val preferenceRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        modelButton = preferenceButton("模型") { showModelOptions() }
        effortButton = preferenceButton("思考") { showEffortOptions() }
        permissionButton = preferenceButton("权限") { showPermissionOptions() }
        val footerHeight = if (retroTheme) 46 else 40
        preferenceRow.addView(modelButton, LinearLayout.LayoutParams(WRAP, dp(footerHeight)))
        preferenceRow.addView(effortButton, LinearLayout.LayoutParams(WRAP, dp(footerHeight)).apply { leftMargin = dp(4) })
        preferenceRow.addView(permissionButton, LinearLayout.LayoutParams(WRAP, dp(footerHeight)).apply { leftMargin = dp(4) })
        preferenceScroll.addView(preferenceRow)
        footer.addView(preferenceScroll, LinearLayout.LayoutParams(0, dp(footerHeight), 1f))
        val footerActionSize = if (retroTheme) dp(36) else dp(34)
        footer.addView(iconButton("add", "添加图片或文件") { chooseAttachment() }.apply {
            setPadding(dp(6), dp(6), dp(6), dp(6))
        }, LinearLayout.LayoutParams(footerActionSize, dp(34)).apply {
            rightMargin = dp(4)
            gravity = Gravity.CENTER_VERTICAL
        })
        sendButton = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            setPadding(dp(6), dp(6), dp(6), dp(6))
            background = if (retroTheme) lollipopFabBackground(LOLLIPOP_PRIMARY)
                else rounded(if (lightTheme) Color.rgb(35, 38, 43) else Color.rgb(228, 230, 235), dp(17))
            isClickable = true
            isFocusable = true
            setOnClickListener {
                when {
                    queueEditItem != null -> finishQueueEdit(true)
                    running -> interruptTurn()
                    activeThreadId?.let { threadTitleKey(it) in pausedThreadKeys } == true -> continueInterruptedTurn()
                    else -> sendCurrentMessage()
                }
            }
            contentDescription = "发送消息"
        }
        val sendSize = if (retroTheme) dp(32) else dp(28)
        footer.addView(sendButton, LinearLayout.LayoutParams(sendSize, sendSize).apply {
            leftMargin = dp(if (retroTheme) 2 else 6)
            gravity = Gravity.CENTER_VERTICAL
        })
        composer.addView(footer, LinearLayout.LayoutParams(MATCH, dp(footerHeight)))
        composerDock.addView(composer, LinearLayout.LayoutParams(MATCH, WRAP))
        page.addView(composerDock, LinearLayout.LayoutParams(MATCH, WRAP))
        if (queueEditItem != null) {
            queueEditBar.visibility = View.VISIBLE
            composerInput.hint = tr("编辑排队消息…")
        }
        renderAttachmentStrip()
        updateComposerPreferences()
        updateSendButton()
        updateComposerRunningGlow(running)
        updateComposerFileChanges()
    }

    private fun composerGlassBackground(): Drawable {
        val fills = when (themeName) {
            "pixel" -> intArrayOf(PIXEL_PANEL_INSET, PIXEL_PANEL)
            "lollipop" -> intArrayOf(
                Color.rgb(40, 45, 46),
                Color.rgb(28, 32, 33),
            )
            "light" -> intArrayOf(
                Color.rgb(250, 251, 253),
                Color.rgb(245, 247, 250),
                Color.rgb(248, 249, 252),
            )
            "warm" -> intArrayOf(
                colorWithAlpha(Color.rgb(255, 251, 245), .94f),
                colorWithAlpha(Color.rgb(246, 235, 221), .95f),
            )
            "custom" -> intArrayOf(
                colorWithAlpha(OPAQUE_PANEL, .58f),
                colorWithAlpha(OPAQUE_PANEL, .68f),
                colorWithAlpha(OPAQUE_PANEL, .72f),
            )
            else -> intArrayOf(
                colorWithAlpha(Color.rgb(40, 44, 54), .9f),
                colorWithAlpha(Color.rgb(24, 26, 32), .94f),
                colorWithAlpha(Color.rgb(18, 20, 25), .97f),
            )
        }
        val highlight = when (themeName) {
            "pixel" -> PIXEL_BORDER_LIGHT
            "lollipop" -> Color.rgb(70, 78, 81)
            "warm" -> Color.rgb(255, 249, 238)
            "custom" -> parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT)
            else -> Color.rgb(229, 234, 249)
        }
        val border = when (themeName) {
            "pixel" -> PIXEL_BORDER
            "lollipop" -> Color.rgb(84, 98, 103)
            "custom" -> colorWithAlpha(parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT), .28f)
            "warm" -> Color.rgb(216, 202, 182)
            "light" -> Color.rgb(214, 216, 220)
            else -> Color.rgb(43, 46, 52)
        }
        val cornerRadius = when {
            pixelTheme -> 0
            retroTheme -> 10
            else -> 18
        }
        return ComposerGlassDrawable(fills, highlight, border, dp(cornerRadius).toFloat())
    }

    private fun composerGlowColor(): Int = when (themeName) {
        "pixel" -> PIXEL_BLUE
        "lollipop" -> Color.rgb(111, 157, 197)
        "light" -> Color.rgb(65, 88, 135)
        "warm" -> Color.rgb(143, 113, 86)
        "custom" -> parseThemeColor(KEY_CUSTOM_TEXT, DEFAULT_CUSTOM_TEXT)
        else -> Color.WHITE
    }

    private fun composerGlowOpacity(): Float = when (themeName) {
        "pixel" -> 0f
        "lollipop" -> 0f
        "light" -> .30f
        "warm", "custom" -> .29f
        else -> .38f
    }

    private fun updateComposerRunningGlow(isRunning: Boolean) {
        if (!::composerGlowDrawable.isInitialized || composerGlowRunning == isRunning) return
        composerGlowRunning = isRunning
        composerGlowAnimator?.cancel()
        composerGlowAnimator = null
        if (retroTheme) {
            composerGlowDrawable.setIntensity(0f)
            return
        }
        if (!isRunning) {
            composerGlowAnimator = ValueAnimator.ofFloat(composerGlowDrawable.currentIntensity(), 0f).apply {
                duration = 220L
                addUpdateListener { animator -> composerGlowDrawable.setIntensity(animator.animatedValue as Float) }
                start()
            }
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ValueAnimator.areAnimatorsEnabled()) {
            composerGlowDrawable.setIntensity(.68f)
            return
        }
        composerGlowDrawable.setIntensity(.24f)
        composerGlowAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 2_800L
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            interpolator = android.view.animation.AccelerateDecelerateInterpolator()
            addUpdateListener { animator ->
                val phase = animator.animatedValue as Float
                composerGlowDrawable.setIntensity(.24f + phase * .68f)
            }
            start()
        }
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
        sidebarBrandMark = ImageView(this).apply {
            setImageResource(R.drawable.codex_remote)
            imageTintList = null
            background = if (pixelTheme) pixelFrameBackground(R.drawable.pixel_frame_square, PANEL_INSET)
                else rounded(PANEL_INSET, dp(10))
            val markPadding = if (pixelTheme) dp(6) else dp(8)
            setPadding(markPadding, markPadding, markPadding, markPadding)
            contentDescription = "Codex Remote"
        }
        brand.addView(sidebarBrandMark, LinearLayout.LayoutParams(dp(if (retroTheme) 40 else 36), dp(if (retroTheme) 40 else 36)).apply { rightMargin = dp(10) })
        val brandCopy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL }
        brandCopy.addView(label("Codex Remote", if (retroTheme) 18 else 15, TEXT, true), widthWrap())
        brandCopy.addView(label("对话工作台", if (retroTheme) 12 else 10, MUTED), widthWrap())
        brand.addView(brandCopy, LinearLayout.LayoutParams(0, WRAP, 1f))
        drawer.addView(brand, LinearLayout.LayoutParams(MATCH, dp(44)))

        val searchBox = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), 0, dp(8), 0)
            background = rounded(PANEL_INSET, dp(10), BORDER, dp(1))
        }
        val searchIcon = ImageView(this).apply {
            setPixelAwareImageResource(sidebarIconResource("search"))
            imageTintList = retroIconTint(MUTED)
            contentDescription = "搜索"
        }
        searchBox.addView(searchIcon, LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(8) })
        drawerSearch = EditText(this).apply {
            hint = tr("搜索聊天记录")
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
            setSingleLine(true)
            textSize = adjustedTextSize(13)
            typeface = themedTypeface()
            setTag(R.id.base_text_size, 13f)
            setTextColor(TEXT)
            setHintTextColor(MUTED)
            background = null
            setPadding(0, 0, 0, 0)
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            addTextChangedListener(SimpleTextWatcher { renderSidebar(force = true) })
        }
        searchBox.addView(drawerSearch, LinearLayout.LayoutParams(0, MATCH, 1f))
        searchBox.addView(sidebarIconButton("close", "清除搜索") { drawerSearch.setText("") }.apply {
            setPadding(dp(10), dp(10), dp(10), dp(10))
            visibility = View.GONE
            tag = "sidebar_search_clear"
        }, LinearLayout.LayoutParams(dp(32), dp(32)))
        drawerSearch.addTextChangedListener(SimpleTextWatcher { value ->
            searchBox.findViewWithTag<View>("sidebar_search_clear")?.visibility = if (value.isBlank()) View.GONE else View.VISIBLE
        })
        drawer.addView(searchBox, LinearLayout.LayoutParams(MATCH, dp(if (retroTheme) 44 else 42)).apply { topMargin = dp(9) })

        sidebarNewThreadButton = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, dp(12), 0)
            isClickable = true
            isFocusable = true
            contentDescription = "新建对话"
            setOnClickListener { createThread() }
        }
        sidebarNewThreadIcon = ImageView(this).apply {
            setPixelAwareImageResource(sidebarIconResource("add"))
            val iconInset = if (pixelTheme) 0 else dp(4)
            setPadding(iconInset, iconInset, iconInset, iconInset)
        }
        val newThreadIconSize = if (pixelTheme) 30 else 27
        sidebarNewThreadButton.addView(sidebarNewThreadIcon, LinearLayout.LayoutParams(dp(newThreadIconSize), dp(newThreadIconSize)).apply { rightMargin = dp(if (pixelTheme) 8 else 10) })
        sidebarNewThreadLabel = label("新建对话", if (pixelTheme) 14 else 13, TEXT, true)
        sidebarNewThreadButton.addView(sidebarNewThreadLabel, widthWrap())
        drawer.addView(sidebarNewThreadButton, LinearLayout.LayoutParams(MATCH, dp(if (retroTheme) 44 else 43)).apply { topMargin = dp(7) })
        updateSidebarModeAccent()

        val recentHeading = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(3), 0, 0, 0)
        }
        if (retroTheme) recentHeading.addView(ImageView(this).apply {
            setPixelAwareImageResource(iconResource("history"))
            imageTintList = null
            contentDescription = "聊天记录"
        }, LinearLayout.LayoutParams(dp(17), dp(17)).apply { rightMargin = dp(6) })
        recentHeading.addView(label("聊天记录", if (pixelTheme) 12 else 11, MUTED, true), LinearLayout.LayoutParams(0, dp(34), 1f))
        recentHeading.addView(label("选择", if (pixelTheme) 12 else 11, SUBTLE, true).apply {
            tag = "sidebar_selection_toggle"
            gravity = Gravity.CENTER
            isClickable = true
            contentDescription = "批量选择聊天"
            setOnClickListener {
                if (sidebarSelectionBusy) return@setOnClickListener
                sidebarSelectionMode = !sidebarSelectionMode
                selectedSidebarThreadIds.clear()
                renderSidebar(force = true)
            }
        }, LinearLayout.LayoutParams(dp(48), dp(34)))
        recentHeading.addView(sidebarIconButton("refresh", "刷新对话列表") { refreshThreads(true); refreshPins() }, LinearLayout.LayoutParams(dp(34), dp(34)))
        drawer.addView(recentHeading, LinearLayout.LayoutParams(MATCH, dp(if (retroTheme) 40 else 36)).apply { topMargin = dp(8) })
        sidebarSelectionBar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        drawer.addView(sidebarSelectionBar, LinearLayout.LayoutParams(MATCH, WRAP))
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
        val footerHeight = if (pixelTheme) 68 else 40
        footer.addView(sidebarAction("设置", "settings") { showSettings() }, LinearLayout.LayoutParams(0, dp(footerHeight), 1f))
        footer.addView(sidebarAction("切换配置", "link") { showConnectionPicker() }, LinearLayout.LayoutParams(0, dp(footerHeight), 1f))
        footer.addView(sidebarAction("重连", "refresh") { reconnect() }, LinearLayout.LayoutParams(0, dp(footerHeight), 1f))
        drawer.addView(footer, LinearLayout.LayoutParams(MATCH, dp(footerHeight)))

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
        val wallpaper = if (retroTheme) null else wallpaperBackground(
            OPAQUE_PANEL,
            viewportWidthPx = availableWidth,
            viewportHeightPx = root.height.takeIf { it > 0 } ?: resources.displayMetrics.heightPixels,
        ) as? ThemeWallpaperDrawable
        panel.apply {
            background = when {
                pixelTheme -> pixelFrameBackground(R.drawable.pixel_frame_panel, PANEL)
                retroTheme -> ColorDrawable(PANEL)
                else -> wallpaper ?: ColorDrawable(OPAQUE_PANEL)
            }
            elevation = dp(if (pixelTheme) 0 else if (retroTheme) 8 else 5).toFloat()
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
        }
        overlay.addView(panel, FrameLayout.LayoutParams(panelWidth, MATCH, gravity))
        root.addView(overlay, FrameLayout.LayoutParams(MATCH, MATCH))
        return EdgeDrawerHost(overlay, scrim, panel, gravity, wallpaper).also { applyEdgeDrawerProgress(it, 0f, false) }
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
        val screenX = if (host.gravity == Gravity.START) {
            host.panel.translationX
        } else {
            root.width - width + host.panel.translationX
        }
        host.wallpaper?.setViewportOffset(screenX, host.panel.top.toFloat() + host.panel.translationY)
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
        val actionColor = if (pixelTheme) PIXEL_TEXT else SUBTLE
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(dp(1), dp(2), dp(1), dp(2))
        clipChildren = false
        clipToPadding = false
        background = if (retroTheme) android1SegmentButtonBackground() else rounded(Color.TRANSPARENT, dp(8))
        isClickable = true
        isFocusable = true
        contentDescription = tr(title)
        setOnClickListener { action() }
        val iconView = ImageView(this@MainActivity).apply {
            setPixelAwareImageResource(sidebarIconResource(icon))
            imageTintList = retroIconTint(actionColor)
        }
        val labelView = label(title, if (pixelTheme) 12 else 11, actionColor, true, pixelize = false).apply {
            setSingleLine(true)
            ellipsize = android.text.TextUtils.TruncateAt.END
            gravity = Gravity.CENTER
            if (pixelTheme) {
                // Respect the active UI font scale so larger text cannot clip.
                includeFontPadding = true
                minHeight = dp(24)
            }
        }
        sidebarActionAccentViews += iconView to labelView
        val iconSize = if (pixelTheme) 22 else 17
        addView(iconView, LinearLayout.LayoutParams(dp(iconSize), dp(iconSize)))
        addView(labelView, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(2) })
    }

    private fun renderHeader() {
        if (!::titleView.isInitialized) return
        val title = activeThread?.let { threadTitle(it) }
            ?: if (activeThreadId == null) "新对话" else "Codex Remote"
        titleView.text = title
        titleView.setTextColor(if (retroTheme) ANDROID1_TITLE_TEXT else TEXT)
        if (::modeButton.isInitialized) {
            setBrandIcon(modeButton, modeSwitchTarget())
            modeButton.contentDescription = modeSwitchDescription()
        }
        updateSidebarBrand()
        updateSidebarModeAccent()
        val path = page.findViewWithTag<TextView>("workspace_path")
        path?.setTextColor(if (retroTheme && !pixelTheme) Color.rgb(72, 72, 72) else MUTED)
        path?.text = activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" }
            ?: runtime.optString("workspace", "本机项目")
        statusView.visibility = if (runtime.optBoolean("connected", false)) View.GONE else View.VISIBLE
        statusView.text = runtime.optString("error").takeIf { it.isNotBlank() && it != "null" }
            ?: tr(if (runtime.optBoolean("available", false)) "Codex 已连接" else "正在连接 Codex…")
        statusView.setTextColor(if (runtime.optBoolean("connected", false)) MUTED else WARNING)
        updateSendButton()
        updateComposerPreferences()
    }

    private fun modeSwitchTarget(): String = if (currentMode == "codex") "claude-code" else "codex"

    private fun modeSwitchDescription(): String = if (modeSwitchTarget() == "claude-code") "切换到 Claude Code" else "切换到 Codex"

    private fun updateSidebarBrand() {
        if (!::sidebarBrandMark.isInitialized) return
        sidebarBrandMark.setImageResource(R.drawable.codex_remote)
        sidebarBrandMark.imageTintList = null
        sidebarBrandMark.contentDescription = "Codex Remote"
    }

    private fun threadTitleKey(threadId: String) = "$activeConnectionId:$threadId"

    private fun threadTitle(thread: JSONObject): String {
        val title = listOf(thread.optString("name"), thread.optString("preview"))
            .firstOrNull { it.isNotBlank() && it != "null" } ?: "新对话"
        val threadId = thread.optString("id")
        if (threadId.isBlank()) return title
        val key = threadTitleKey(threadId)
        displayedThreadTitles[key]?.let { return it }
        if (title != "新对话" && title != threadId) displayedThreadTitles[key] = title
        return title
    }

    private fun updateSidebarModeAccent() {
        if (!::sidebarNewThreadButton.isInitialized) return
        val claudeMode = currentMode == "claude-code"
        val fill = if (claudeMode) CLAUDE_MODE_ACCENT else CODEX_MODE_ACCENT
        val foreground = if (claudeMode) Color.rgb(24, 27, 37) else CODEX_MODE_ACCENT_FOREGROUND
        val newThreadShape = rounded(fill, dp(if (retroTheme) 2 else 10))
        sidebarNewThreadButton.background = when {
            pixelTheme -> pixelSidebarNewThreadBackground()
            retroTheme -> lollipopRipple(android1MetalButtonBackground())
            else -> newThreadShape
        }
        sidebarNewThreadButton.elevation = if (retroTheme && !pixelTheme) dp(2).toFloat() else 0f
        val newThreadForeground = when {
            pixelTheme -> PIXEL_INK
            retroTheme -> ANDROID1_TITLE_TEXT
            else -> foreground
        }
        sidebarNewThreadIcon.imageTintList = retroIconTint(newThreadForeground)
        sidebarNewThreadIcon.background = if (pixelTheme) ColorDrawable(Color.TRANSPARENT) else rounded(
            if (retroTheme) Color.rgb(178, 181, 181)
            else if (lightTheme) Color.argb(40, 255, 255, 255) else Color.argb(38, 24, 27, 37),
            dp(if (retroTheme) 2 else 7),
        )
        sidebarNewThreadLabel.setTextColor(newThreadForeground)
        val actionColor = if (pixelTheme) PIXEL_TEXT else SUBTLE
        sidebarActionAccentViews.forEach { (icon, label) ->
            icon.imageTintList = retroIconTint(actionColor)
            label.setTextColor(actionColor)
        }
    }

    private fun threadLastActiveMillis(thread: JSONObject): Long {
        val value = firstJsonValue(thread, "updatedAt", "updated_at", "lastMessageAt", "last_message_at", "createdAt", "created_at")
        return when (value) {
            is Number -> value.toLong().let { if (it in -9_999_999_999L..9_999_999_999L) it * 1000L else it }
            is String -> value.toLongOrNull()?.let { if (it in -9_999_999_999L..9_999_999_999L) it * 1000L else it }
                ?: runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
                ?: runCatching { OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()
                ?: 0L
            else -> 0L
        }
    }

    private fun sidebarDateSection(thread: JSONObject): String {
        if (thread.optString("id") in pinnedThreadIds) return "置顶"
        val updatedAt = threadLastActiveMillis(thread)
        if (updatedAt <= 0L) return "更早"
        val zone = ZoneId.systemDefault()
        val days = (LocalDate.now(zone).toEpochDay() - Instant.ofEpochMilli(updatedAt).atZone(zone).toLocalDate().toEpochDay()).coerceAtLeast(0)
        return when {
            days == 0L -> "今天"
            days < 7L -> "最近 7 天"
            days < 15L -> "15 天内"
            days < 30L -> "30 天内"
            else -> "更早"
        }
    }

    private fun bulkSelectedThreads(): List<JSONObject> = (0 until threads.length()).mapNotNull { threads.optJSONObject(it) }
        .filter { it.optString("engine", "codex") == currentMode && it.optString("id") in selectedSidebarThreadIds }

    private fun sidebarSelectionAction(title: String, color: Int = SUBTLE, action: () -> Unit): TextView =
        label(title, 11, color, true).apply {
            gravity = Gravity.CENTER
            isClickable = true
            isFocusable = true
            setOnClickListener { if (!sidebarSelectionBusy) action() }
        }

    private fun renderSidebarSelectionBar() {
        if (!::sidebarSelectionBar.isInitialized) return
        (drawer.findViewWithTag<TextView>("sidebar_selection_toggle"))?.text = if (sidebarSelectionMode) "取消" else "选择"
        sidebarSelectionBar.removeAllViews()
        sidebarSelectionBar.visibility = if (sidebarSelectionMode) View.VISIBLE else View.GONE
        if (!sidebarSelectionMode) return
        val count = bulkSelectedThreads().size
        val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        top.addView(label("已选 $count 个聊天", 11, MUTED), LinearLayout.LayoutParams(0, dp(32), 1f))
        top.addView(sidebarSelectionAction("全选") {
            selectedSidebarThreadIds.addAll(visibleSidebarThreadIds)
            renderSidebar(force = true)
        }, LinearLayout.LayoutParams(dp(48), dp(32)))
        top.addView(sidebarSelectionAction("清空") {
            selectedSidebarThreadIds.clear()
            renderSidebar(force = true)
        }, LinearLayout.LayoutParams(dp(48), dp(32)))
        sidebarSelectionBar.addView(top, LinearLayout.LayoutParams(MATCH, dp(32)))
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        actions.addView(sidebarSelectionAction("置顶", ACCENT) { bulkPinSelectedThreads() }, LinearLayout.LayoutParams(0, dp(35), 1f))
        actions.addView(sidebarSelectionAction("删除", ERROR) { bulkDeleteSelectedThreads() }, LinearLayout.LayoutParams(0, dp(35), 1f))
        sidebarSelectionBar.addView(actions, LinearLayout.LayoutParams(MATCH, dp(35)))
    }

    private fun bulkPinSelectedThreads() {
        val selected = bulkSelectedThreads()
        if (selected.isEmpty()) return
        val ids = selected.map { it.optString("id") }
        val generation = connectionGeneration
        val api = RemoteApi(endpoint, token)
        sidebarSelectionBusy = true
        io.execute {
            val completed = mutableListOf<String>()
            ids.forEach { id ->
                runCatching {
                    api.post("/api/v1/codex/threads/${RemoteApi.encodePath(id)}/pin", JSONObject().put("pinned", true))
                }.onSuccess { completed += id }
            }
            handler.post {
                sidebarSelectionBusy = false
                if (generation != connectionGeneration) return@post
                pinnedThreadIds.addAll(completed)
                selectedSidebarThreadIds.removeAll(completed.toSet())
                if (selectedSidebarThreadIds.isEmpty()) sidebarSelectionMode = false
                renderSidebar(force = true)
                if (completed.size != ids.size) showStatus("${ids.size - completed.size} 个聊天置顶失败")
            }
        }
    }

    private fun bulkDeleteSelectedThreads() {
        val selected = bulkSelectedThreads()
        if (selected.isEmpty()) return
        val ids = selected.map { it.optString("id") }
        val selectedMode = currentMode
        showConfirmDialog("批量删除聊天", "删除选中的 ${ids.size} 个聊天？此操作无法撤销。", "删除", destructive = true) {
            val generation = connectionGeneration
            val api = RemoteApi(endpoint, token)
            sidebarSelectionBusy = true
            io.execute {
                val completed = mutableListOf<String>()
                ids.forEach { id ->
                    runCatching { api.delete("/api/v1/codex/threads/${RemoteApi.encodePath(id)}") }
                        .onSuccess { completed += id }
                }
                handler.post {
                    sidebarSelectionBusy = false
                    if (generation != connectionGeneration) return@post
                    val removed = completed.toSet()
                    selectedSidebarThreadIds.removeAll(removed)
                    pinnedThreadIds.removeAll(removed)
                    removed.forEach { id ->
                        syncRevisions.remove(id)
                        displayedThreadTitles.remove(threadTitleKey(id))
                        pausedThreadKeys.remove(threadTitleKey(id))
                        draftFilesByScope.remove(connectionScopedKey("draft_${selectedMode}_$id"))
                        pendingUserMessages.remove(connectionScopedKey("draft_${selectedMode}_$id"))
                    }
                    if (activeThreadId?.let { it in removed } == true) {
                        prefs.edit().remove(activeThreadStorageKey(currentMode)).apply()
                        activeThreadId = null
                        activeThread = null
                        queuedMessages = JSONArray()
                        running = false
                        selectedFiles.clear()
                        composerInput.setText("")
                        renderAttachmentStrip()
                        renderQueue()
                        renderMessages(false)
                        renderHeader()
                    }
                    threads = JSONArray().also { result ->
                        for (index in 0 until threads.length()) {
                            threads.optJSONObject(index)?.takeIf { it.optString("id") !in removed }?.let(result::put)
                        }
                    }
                    if (selectedSidebarThreadIds.isEmpty()) sidebarSelectionMode = false
                    renderSidebar(force = true)
                    refreshThreads(false)
                    if (completed.size != ids.size) showStatus("${ids.size - completed.size} 个聊天删除失败")
                }
            }
        }
    }

    private fun renderSidebar(force: Boolean = false) {
        if (!::drawerThreads.isInitialized) return
        updateSidebarModeAccent()
        if (!force && !sidebarRenderDirty) return
        if (sidebarGestureActive || sidebarAnimator?.isRunning == true || sidebarTouchActive ||
            (sidebarVisible && preferencePopup?.isShowing == true)
        ) {
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
            .thenByDescending { threadLastActiveMillis(it) })
        val visibleThreads = filtered.take(MAX_VISIBLE_SIDEBAR_THREADS)
        visibleSidebarThreadIds = visibleThreads.map { it.optString("id") }
        renderSidebarSelectionBar()
        if (filtered.isEmpty()) {
            val empty = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(dp(12), dp(28), dp(12), dp(28))
            }
            empty.addView(ImageView(this).apply {
                setImageResource(if (currentMode == "claude-code") R.drawable.ic_brand_claude else R.drawable.ic_brand_codex)
                setColorFilter(if (currentMode == "claude-code") CLAUDE_MODE_ACCENT else codexBrandAccent())
                alpha = .55f
            }, LinearLayout.LayoutParams(dp(24), dp(24)).apply { bottomMargin = dp(9) })
            empty.addView(label(if (query.isBlank()) "当前模式暂无对话" else "没有匹配的对话", 12, MUTED).apply { gravity = Gravity.CENTER }, widthWrap())
            drawerThreads.addView(empty, widthWrap())
        }
        val sections = linkedMapOf<String, MutableList<JSONObject>>()
        listOf("置顶", "今天", "最近 7 天", "15 天内", "30 天内", "更早").forEach { sections[it] = mutableListOf() }
        visibleThreads.forEach { thread -> sections.getValue(sidebarDateSection(thread)).add(thread) }
        sections.forEach { (section, entries) ->
            if (entries.isEmpty()) return@forEach
            drawerThreads.addView(label(section, if (pixelTheme) 12 else 11, MUTED, true).apply {
                setPadding(dp(9), dp(if (retroTheme) 13 else 11), 0, dp(5))
            }, LinearLayout.LayoutParams(MATCH, WRAP))
            entries.forEach { thread ->
            val id = thread.optString("id")
            val selected = if (sidebarSelectionMode) id in selectedSidebarThreadIds else id == activeThreadId
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(if (retroTheme) 0 else dp(9), if (retroTheme) dp(2) else dp(8), dp(5), if (retroTheme) dp(2) else dp(8))
                minimumHeight = dp(if (pixelTheme) 48 else if (retroTheme) 44 else 0)
                val selectedAccent = if (currentMode == "claude-code") CLAUDE_MODE_ACCENT else ACCENT
                background = if (retroTheme) {
                    if (pixelTheme && selected) pixelFrameBackground(R.drawable.pixel_frame_active, Color.rgb(25, 43, 64))
                    else if (selected) ColorDrawable(if (currentMode == "claude-code") Color.rgb(70, 45, 37) else LOLLIPOP_PRIMARY_LIGHT) else lollipopRipple()
                } else if (selected) rounded(PANEL_INSET, dp(9), colorWithAlpha(selectedAccent, if (lightTheme) .52f else .42f), dp(1)) else rounded(Color.TRANSPARENT, dp(9))
                isClickable = true
                isFocusable = true
                contentDescription = threadTitle(thread)
            }
            val engine = thread.optString("engine", "codex")
            if (retroTheme && !pixelTheme) {
                val selectedAccent = if (currentMode == "claude-code") CLAUDE_MODE_ACCENT else codexBrandAccent()
                row.addView(View(this).apply {
                    setBackgroundColor(if (selected) selectedAccent else Color.TRANSPARENT)
                }, LinearLayout.LayoutParams(dp(3), MATCH).apply { rightMargin = dp(8) })
            }
            val icon = ImageView(this).apply {
                if (sidebarSelectionMode) {
                    setPixelAwareImageResource(if (retroTheme) iconResource(if (selected) "checked" else "unchecked") else if (selected) R.drawable.ic_selection_checked else R.drawable.ic_selection_unchecked)
                    imageTintList = retroIconTint(if (selected) (if (engine == "claude-code") CLAUDE_MODE_ACCENT else ACCENT) else MUTED)
                    contentDescription = if (selected) "已勾选" else "未勾选"
                } else if (retroTheme) {
                    // A conversation row is a chat destination, not another copy of the model logo.
                    // Branded marks remain in the mode switch and cross-mode completion notices.
                    setPixelAwareImageResource(iconResource("chat"))
                    imageTintList = null
                    contentDescription = if (engine == "claude-code") "Claude Code 对话" else "Codex 对话"
                } else {
                    setImageResource(if (engine == "claude-code") R.drawable.ic_brand_claude else R.drawable.ic_brand_codex)
                    setColorFilter(if (engine == "claude-code") CLAUDE_MODE_ACCENT else codexBrandAccent())
                    contentDescription = if (engine == "claude-code") "Claude Code" else "Codex"
                }
            }
            val threadIconSize = 22
            if (pixelTheme) icon.setPadding(dp(2), dp(2), dp(2), dp(2))
            row.addView(icon, LinearLayout.LayoutParams(dp(threadIconSize), dp(threadIconSize)).apply { rightMargin = dp(if (pixelTheme) 8 else 9) })
            val title = threadTitle(thread)
            val titleView = label(title, if (pixelTheme) 14 else 13, if (selected) TEXT else SUBTLE, selected, translateUi = false).apply {
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            }
            row.addView(titleView, LinearLayout.LayoutParams(0, WRAP, 1f))
            val choose = {
                if (id in selectedSidebarThreadIds) selectedSidebarThreadIds.remove(id) else selectedSidebarThreadIds.add(id)
                renderSidebar(force = true)
            }
            row.setOnClickListener { if (sidebarSelectionMode) choose() else selectThread(thread) }
            row.setOnLongClickListener { if (sidebarSelectionMode) choose() else showThreadActions(row, thread); true }
            var downX = 0f
            var downY = 0f
            var longPressed = false
            var pressTask: Runnable? = null
            val pressSlop = ViewConfiguration.get(this).scaledTouchSlop * 1.5f
            row.setOnTouchListener { view, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        sidebarTouchActive = true
                        downX = event.x
                        downY = event.y
                        longPressed = false
                        pressTask?.let(handler::removeCallbacks)
                        pressTask = Runnable {
                            if (view.isAttachedToWindow) {
                                longPressed = true
                                sidebarLongPressActive = true
                                view.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
                            }
                        }.also { handler.postDelayed(it, ViewConfiguration.getLongPressTimeout().toLong()) }
                        view.parent?.requestDisallowInterceptTouchEvent(true)
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        if (!longPressed && (abs(event.x - downX) > pressSlop || abs(event.y - downY) > pressSlop)) {
                            pressTask?.let(handler::removeCallbacks)
                            pressTask = null
                            sidebarTouchActive = false
                            view.parent?.requestDisallowInterceptTouchEvent(false)
                        }
                        true
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        pressTask?.let(handler::removeCallbacks)
                        pressTask = null
                        view.parent?.requestDisallowInterceptTouchEvent(false)
                        sidebarLongPressActive = false
                        sidebarTouchActive = false
                        if (event.actionMasked == MotionEvent.ACTION_UP) {
                            if (longPressed) view.performLongClick()
                            else if (abs(event.x - downX) <= pressSlop && abs(event.y - downY) <= pressSlop) view.performClick()
                        }
                        if (sidebarRenderDirty && preferencePopup?.isShowing != true) view.post { renderSidebar(force = true) }
                        true
                    }
                    else -> true
                }
            }
            drawerThreads.addView(row, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(5) })
            }
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
        if (visible && (imeInsetVisible || window.currentFocus is EditText)) {
            val focused = window.currentFocus
            (getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
                ?.hideSoftInputFromWindow((focused ?: composerInput).windowToken, 0)
            parkActivityInputFocus()
        }
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
        private var selectableTextGesture = false
        private var edgeSwipeOrigin = false
        private var velocityTracker: VelocityTracker? = null

        override fun dispatchTouchEvent(event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    sidebarLongPressActive = false
                    startX = event.x
                    startY = event.y
                    velocityTracker?.recycle()
                    velocityTracker = VelocityTracker.obtain().apply { addMovement(event) }
                    selectableTextGesture = touchesSelectableText(event.x, event.y)
                    edgeSwipeOrigin = event.x <= dp(40) || event.x >= width - dp(40)
                    swipeTarget = when {
                        settingsOverlay != null || terminalOverlay != null -> null
                        sidebarVisible || sidebarProgress > .02f -> if (event.x <= (drawer.width.takeIf { it > 0 } ?: dp(320))) "sidebar" else null
                        workspaceVisible || workspaceProgress > .02f -> "workspace"
                        !isChatSwipeOrigin(event.y) -> null
                        isGestureProtectedTouchTarget(event.x, event.y) -> null
                        edgeSwipeOrigin && event.x < width / 2f -> "sidebar"
                        edgeSwipeOrigin -> "workspace"
                        event.x < width / 2f -> "sidebar"
                        event.x >= width / 2f -> "workspace"
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
            if (sidebarLongPressActive) return false
            if (selectableTextGesture && event.eventTime - event.downTime >= ViewConfiguration.getLongPressTimeout()) return false
            val dx = event.x - startX
            val dy = event.y - startY
            val horizontal = abs(dx) > touchSlop && abs(dx) > abs(dy) * (if (edgeSwipeOrigin) .85f else 1.25f)
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
            selectableTextGesture = false
            edgeSwipeOrigin = false
            velocityTracker?.recycle()
            velocityTracker = null
        }

        private fun isGestureProtectedTouchTarget(x: Float, y: Float): Boolean {
            var target = deepestTouchTarget(this, x, y)
            while (target != null && target !== this) {
                if (target is EditText || target is SeekBar || target is HorizontalScrollView) return true
                target = target.parent as? View
            }
            return false
        }

        private fun touchesSelectableText(x: Float, y: Float): Boolean {
            var target = deepestTouchTarget(this, x, y)
            while (target != null && target !== this) {
                if (target is TextView && target.isTextSelectable) return true
                target = target.parent as? View
            }
            return false
        }

        private fun deepestTouchTarget(view: View, localX: Float, localY: Float): View? {
            if (view.visibility != View.VISIBLE || localX < 0f || localY < 0f ||
                localX >= view.width || localY >= view.height
            ) return null
            if (view is ViewGroup) {
                for (index in view.childCount - 1 downTo 0) {
                    val child = view.getChildAt(index)
                    val childX = localX + view.scrollX - child.left - child.translationX
                    val childY = localY + view.scrollY - child.top - child.translationY
                    deepestTouchTarget(child, childX, childY)?.let { return it }
                }
            }
            return view
        }

        private fun isChatSwipeOrigin(y: Float): Boolean = y >= dp(48) && y <= height - dp(145)
    }

    private fun refreshRuntime() {
        val generation = connectionGeneration
        val api = RemoteApi(endpoint, token)
        runApi({ api.get("/api/v1/codex/status") }, { result ->
            if (generation != connectionGeneration) return@runApi
            runtime = result
            renderHeader()
        }, { error -> if (generation == connectionGeneration) showStatus(error.message ?: "Codex 连接失败") })
    }

    private fun refreshModels() {
        val generation = connectionGeneration
        val api = RemoteApi(endpoint, token)
        io.execute {
            try {
                val result = api.getArray("/api/v1/codex/models")
                handler.post { if (generation == connectionGeneration) { models = result; updateComposerPreferences() } }
            } catch (_: Exception) { }
        }
    }

    private fun refreshPins() {
        val generation = connectionGeneration
        val api = RemoteApi(endpoint, token)
        io.execute {
            try {
                val result = api.get("/api/v1/codex/pins").optJSONArray("thread_ids") ?: JSONArray()
                handler.post {
                    if (generation != connectionGeneration) return@post
                    pinnedThreadIds.clear()
                    for (index in 0 until result.length()) pinnedThreadIds += result.optString(index)
                    renderSidebar(force = true)
                }
            } catch (_: Exception) { }
        }
    }

    private fun refreshClaudeStatus() {
        val generation = connectionGeneration
        val api = RemoteApi(endpoint, token)
        io.execute {
            try {
                val result = api.get("/api/v1/claude/status")
                handler.post {
                    if (generation != connectionGeneration) return@post
                    claudeAvailable = result.optBoolean("available")
                    claudeStatusMessage = result.optString("error").ifBlank { "Claude Code 不可用" }
                    renderHeader()
                }
            } catch (error: Exception) {
                handler.post { if (generation == connectionGeneration) {
                    claudeAvailable = false; claudeStatusMessage = error.message ?: "Claude Code 不可用"
                } }
            }
        }
    }

    private fun refreshThreads(showErrors: Boolean) {
        if (token.isBlank()) return
        val generation = connectionGeneration
        val api = RemoteApi(endpoint, token)
        io.execute {
            try {
                val result = api.getArray("/api/v1/codex/threads")
                handler.post {
                    if (generation != connectionGeneration) return@post
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
                            .firstOrNull { it.optString("id") == prefs.getString(activeThreadStorageKey(currentMode), null) }
                            ?: (0 until result.length()).mapNotNull { result.optJSONObject(it) }
                                .firstOrNull { it.optString("engine", "codex") == currentMode }
                        if (first != null) selectThread(first)
                    }
                }
            } catch (error: Exception) {
                if (showErrors) handler.post { if (generation == connectionGeneration) showStatus(error.message ?: "读取对话列表失败") }
            }
        }
    }

    private fun findThread(id: String): JSONObject? = (0 until threads.length())
        .mapNotNull { threads.optJSONObject(it) }
        .firstOrNull { it.optString("id") == id }

    private fun selectThread(thread: JSONObject, eagerDiskCache: Boolean = false) {
        if (queueEditPending || queueEditItem != null) { showStatus("请先保存或取消排队消息编辑"); return }
        val id = thread.optString("id")
        if (id.isBlank()) return
        val existingHistory = activeThread?.takeIf { activeThreadId == id && it.optJSONArray("turns") != null }
        val memoryHistory = historyMemoryCache[id]
        val diskHistory = if (eagerDiskCache && existingHistory == null && memoryHistory == null) {
            readThreadHistoryCache(id, MAX_EAGER_HISTORY_CACHE_BYTES)
        } else null
        persistCurrentDraft()
        if (activeThreadId != id) clearLiveActivity()
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
        prefs.edit().putString(KEY_MODE, currentMode).putString(activeThreadStorageKey(currentMode), id).apply()
        running = isThreadRunning(activeThread ?: thread)
        pendingApproval = null
        queuedMessages = JSONArray()
        setSidebarVisible(false)
        renderHeader()
        renderSidebar(force = true)
        composerInput.setText(prefs.getString(draftStorageKey(), ""))
        restoreCurrentDraftFiles()
        followMessageBottom = true
        renderMessages(true)
        if (hasCachedHistory) refreshActiveThread(false) else loadThreadHistoryCacheThenRefresh(id)
        refreshQueue(true)
        socket?.send(JSONObject().put("type", "thread.subscribe").put("thread_id", id).toString())
    }

    private fun loadThreadHistoryCacheThenRefresh(threadId: String) {
        val generation = historySelectionGeneration
        val connection = connectionGeneration
        io.execute {
            if (connection != connectionGeneration) return@execute
            val cached = readThreadHistoryCache(threadId)
            handler.post {
                if (connection != connectionGeneration || activeThreadId != threadId || historySelectionGeneration != generation) return@post
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

    private fun historyCacheFile(threadId: String, profileId: String = activeConnectionId): File {
        val cacheId = if (profileId.isBlank() || profileId == prefs.getString(KEY_LEGACY_CONNECTION_ID, null)) threadId
            else "${profileId}_$threadId"
        val digest = MessageDigest.getInstance("SHA-256").digest(cacheId.toByteArray(StandardCharsets.UTF_8))
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

    private fun writeThreadHistoryCache(threadId: String, thread: JSONObject, revision: String?, profileId: String = activeConnectionId) {
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
            val file = historyCacheFile(threadId, profileId)
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
        val connection = connectionGeneration
        val profileId = activeConnectionId
        val api = RemoteApi(endpoint, token)
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
                val encodedId = RemoteApi.encodePath(threadId)
                val lightweightQuery = buildString {
                    append("?include_images=false")
                    if (!revision.isNullOrBlank()) append("&since=${RemoteApi.encodePath(revision)}")
                    if (boundedHistory) append("&tail_turns=$DEFAULT_VISIBLE_HISTORY_TURNS")
                }
                var response = api.get("/api/v1/codex/threads/$encodedId$lightweightQuery")
                if (connection != connectionGeneration) return@execute
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
                val workspaceChanged = response.optJSONObject("historySync")?.optJSONArray("workspaceTurnIds")?.length()?.let { it > 0 } == true
                val incrementalTurnId = (changedTurnIds.singleOrNull() ?: lastTurnId?.takeIf { workspaceChanged && changedTurnIds.isEmpty() })
                    ?.takeIf { usedDelta && it == lastTurnId }
                val historyChanged = !usedDelta || changedTurnIds.isNotEmpty() || workspaceChanged
                val sync = resolved.optJSONObject("historySync") ?: response.optJSONObject("historySync")
                val newRevision = sync?.optString("revision")?.takeIf { !it.isNullOrBlank() && it != "null" }
                if (resolved.optString("id") != threadId) throw IOException("服务器返回了不匹配的聊天记录。")
                if (connection != connectionGeneration) return@execute
                writeThreadHistoryCache(threadId, resolved, newRevision, profileId)
                handler.post {
                    if (connection != connectionGeneration) return@post
                    finishThreadRead(threadId)
                    if (activeThreadId != threadId) return@post
                    if (newRevision != null) syncRevisions[threadId] = newRevision
                    activeThread = resolved
                    historyMemoryCache[threadId] = resolved
                    historyLoadingThreadId = null
                    historyLoadError = null
                    running = isThreadRunning(resolved)
                    renderHeader()
                    if (historyChanged) renderMessages(false, incrementalTurnId)
                    updateComposerFileChanges()
                }
            } catch (error: Exception) {
                handler.post {
                    if (connection != connectionGeneration) return@post
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
        val connection = connectionGeneration
        val api = RemoteApi(endpoint, token)
        io.execute {
            try {
                val response = api.get("/api/v1/codex/queue/${RemoteApi.encodePath(threadId)}")
                val next = response.optJSONArray("queue") ?: JSONArray()
                handler.post {
                    if (connection != connectionGeneration || activeThreadId != threadId) return@post
                    queuedMessages = withoutDeliveredQueueItems(next)
                    if (response.optBoolean("paused", false)) pausedThreadKeys += threadTitleKey(threadId)
                    else pausedThreadKeys.remove(threadTitleKey(threadId))
                    renderQueue()
                    updateSendButton()
                }
            } catch (error: Exception) {
                if (showErrors) handler.post { if (connection == connectionGeneration) showStatus(error.message ?: "读取排队消息失败") }
            }
        }
    }

    private fun updateWelcomeTitle(visible: Boolean) {
        if (!::welcomeTitleView.isInitialized) return
        if (!visible) {
            welcomeTitleView.visibility = View.GONE
            welcomeAnimationActive = false
            welcomeAnimationScheduled = false
            handler.removeCallbacks(welcomeTypingRunnable)
            return
        }

        val text = if (currentMode == "claude-code") {
            "与 Claude Code 完成一个伟大项目"
        } else {
            "与 Codex 完成一个伟大项目"
        }
        welcomeTitleView.visibility = View.VISIBLE
        val localizedText = tr(text)
        welcomeTitleView.contentDescription = localizedText
        if (!welcomeAnimationActive || welcomeAnimationText != localizedText) {
            handler.removeCallbacks(welcomeTypingRunnable)
            welcomeAnimationText = localizedText
            welcomeCharacterIndex = 0
            welcomeCaretBlinkCount = 0
            welcomeCaretVisible = true
            welcomeAnimationActive = true
            welcomeAnimationScheduled = false
            welcomeTitleView.text = "_"
        }
        if (!welcomeAnimationScheduled) scheduleWelcomeTitleStep(160L)
    }

    private fun scheduleWelcomeTitleStep(delayMillis: Long) {
        welcomeAnimationScheduled = true
        handler.postDelayed(welcomeTypingRunnable, delayMillis)
    }

    private fun animateWelcomeTitleStep() {
        welcomeAnimationScheduled = false
        if (!welcomeAnimationActive || !::welcomeTitleView.isInitialized || welcomeTitleView.visibility != View.VISIBLE) return

        if (welcomeCharacterIndex < welcomeAnimationText.length) {
            welcomeCharacterIndex += 1
            welcomeTitleView.text = welcomeAnimationText.substring(0, welcomeCharacterIndex) + "_"
            scheduleWelcomeTitleStep(if (welcomeCharacterIndex == welcomeAnimationText.length) 440L else 72L)
            return
        }

        if (welcomeCaretBlinkCount < 3) {
            welcomeCaretVisible = !welcomeCaretVisible
            if (welcomeCaretVisible) welcomeCaretBlinkCount += 1
            welcomeTitleView.text = welcomeAnimationText + if (welcomeCaretVisible) "_" else " "
            scheduleWelcomeTitleStep(320L)
            return
        }

        welcomeCharacterIndex = 0
        welcomeCaretBlinkCount = 0
        welcomeCaretVisible = true
        welcomeTitleView.text = "_"
        scheduleWelcomeTitleStep(220L)
    }

    private fun renderMessages(scrollToEnd: Boolean, incrementalTurnId: String? = null) {
        if (!::messageList.isInitialized) return
        if (sidebarVisible || workspaceVisible || sidebarGestureActive || workspaceGestureActive || sidebarAnimator?.isRunning == true || workspaceAnimator?.isRunning == true) {
            messageRenderDeferred = true
            deferredMessageScrollToEnd = deferredMessageScrollToEnd || scrollToEnd
            if (incrementalTurnId == null) deferredMessageRequiresFullRender = true else deferredMessageTurnIds.add(incrementalTurnId)
            return
        }
        val previousScrollY = messageScroll.scrollY
        val wasNearEnd = followMessageBottom && isMessageListNearBottom()
        if (scrollToEnd) followMessageBottom = true
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
                if (tag == turnTag || tag == TAG_MESSAGE_DYNAMIC ||
                    (tag is String && tag.startsWith("${TAG_MESSAGE_TURN_PREFIX}pending-"))) messageList.removeViewAt(childIndex)
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
        appendPendingUserMessages(messages)
        val hasConversationMessages = messages.any { it.first == "user" || it.first == "assistant" }
        val showWelcomeTitle = effectiveIncrementalTurnId == null && !hasConversationMessages && (
            activeThreadId == null || (
                historyLoadingThreadId != activeThreadId &&
                    historyLoadError.isNullOrBlank() &&
                    turns.length() == 0
                )
            )
        updateWelcomeTitle(showWelcomeTitle)
        if (effectiveIncrementalTurnId == null && !hasConversationMessages && activeThreadId != null) {
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
                    Unit
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

        val renderedFileChangeTurns = mutableSetOf<String>()
        fun appendTurnSummary(turnId: String) {
            if (!renderedFileChangeTurns.add(turnId)) return
            if (running && turnId == turns.optJSONObject(turns.length() - 1)?.optString("id")) return
            val entries = fileChangesForTurn(turnId, turnsById[turnId], thread)
            addFileChangeSummary(turnId, entries)
        }
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
                if (messageIndex == messages.size || messages[messageIndex].second.optString("_turnId") != turnId) appendTurnSummary(turnId)
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
                if (role == "user") {
                    val bubbleColor = if (currentMode == "claude-code") CLAUDE_USER_MESSAGE_SURFACE else CODEX_USER_MESSAGE_FILL
                    background = rounded(bubbleColor, dp(if (retroTheme) 5 else 12))
                }
            }
            if (role == "assistant") {
                val meta = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }
                meta.addView(
                    label(if (currentMode == "claude-code") "Claude" else "Codex", 11, ASSISTANT_NAME_ACCENT, true),
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
                if (role == "assistant") {
                    addAssistantMarkdown(bubble, text, (maxBubbleWidth - dp(6)).coerceAtLeast(dp(120)))
                } else {
                    val contentColor = if (currentMode == "claude-code") CLAUDE_USER_MESSAGE_FOREGROUND else CODEX_USER_MESSAGE_TEXT
                    val content = label(text.ifBlank { tr("（附件消息）") }, 14, contentColor, translateUi = false).apply {
                        setTextIsSelectable(true)
                        setLineSpacing(dp(3).toFloat(), 1.3f)
                        typeface = themedTypeface()
                        setHorizontallyScrolling(false)
                        breakStrategy = android.text.Layout.BREAK_STRATEGY_SIMPLE
                        hyphenationFrequency = android.text.Layout.HYPHENATION_FREQUENCY_NONE
                        maxWidth = (maxBubbleWidth - dp(22)).coerceAtLeast(dp(120))
                    }
                    Linkify.addLinks(content, Linkify.WEB_URLS)
                    content.setLinkTextColor(ACCENT)
                    enableChatLinkClicks(content)
                    val maxTextWidth = (maxBubbleWidth - bubble.paddingLeft - bubble.paddingRight).coerceAtLeast(dp(80))
                    val contentWidth = naturalTextBlockWidth(content, text.ifBlank { "（附件消息）" }, maxTextWidth)
                    bubble.addView(content, LinearLayout.LayoutParams(contentWidth, WRAP))
                }
            }
            addMessageImages(bubble, item, maxBubbleWidth)
            if (role == "user") {
                val messageColumn = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.END
                }
                messageColumn.addView(bubble, LinearLayout.LayoutParams(WRAP, WRAP))
                if (item.optBoolean("_pending", false)) {
                    messageColumn.addView(label(item.optString("_pendingState", "发送中…"), 10, MUTED).apply {
                        gravity = Gravity.END
                        setPadding(0, dp(3), dp(2), 0)
                    }, LinearLayout.LayoutParams(WRAP, WRAP))
                }
                item.optString("_displayTime").takeIf { it.isNotBlank() }?.let { displayTime ->
                    messageColumn.addView(label(displayTime, 10, MUTED).apply {
                        gravity = Gravity.END
                        setPadding(0, dp(3), dp(2), 0)
                    }, LinearLayout.LayoutParams(WRAP, WRAP))
                }
                messageCopyAction(text)?.let { action ->
                    messageColumn.addView(action, LinearLayout.LayoutParams(WRAP, dp(30)).apply { topMargin = dp(2) })
                }
                row.addView(messageColumn, LinearLayout.LayoutParams(WRAP, WRAP))
            } else {
                val messageColumn = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.START
                }
                messageColumn.addView(bubble, LinearLayout.LayoutParams(WRAP, WRAP))
                messageCopyAction(text)?.let { action ->
                    messageColumn.addView(action, LinearLayout.LayoutParams(WRAP, dp(30)).apply { topMargin = dp(2) })
                }
                row.addView(messageColumn, LinearLayout.LayoutParams(WRAP, WRAP))
            }
            val turnId = item.optString("_turnId")
            row.tag = "$TAG_MESSAGE_TURN_PREFIX$turnId"
            if (item.optBoolean("_animate", false)) {
                row.alpha = 0f
                row.translationY = dp(6).toFloat()
                row.animate().alpha(1f).translationY(0f).setDuration(170).start()
                item.put("_animate", false)
            }
            messageList.addView(row, LinearLayout.LayoutParams(MATCH, WRAP))

            messageIndex++
            if (messageIndex == messages.size || messages[messageIndex].second.optString("_turnId") != turnId) appendTurnSummary(turnId)
        }
        val approval = pendingApproval
        if (approval != null) renderApproval(approval)
        activityShimmerAnimator?.cancel()
        activityShimmerAnimator = null
        if (running && !(messages.isEmpty() && !historyLoadError.isNullOrBlank())) {
            val activityColor = if (lightTheme) Color.rgb(80, 80, 80) else Color.rgb(180, 180, 180)
            val activity = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12), dp(8), dp(12), dp(8))
                if (pixelTheme) background = pixelFrameBackground(R.drawable.pixel_frame_active, PANEL)
                tag = TAG_MESSAGE_DYNAMIC
            }
            activity.addView(ProgressBar(this, null, android.R.attr.progressBarStyleSmall).apply {
                isIndeterminate = true
                indeterminateTintList = ColorStateList.valueOf(activityColor)
                contentDescription = "正在思考"
            }, LinearLayout.LayoutParams(dp(16), dp(16)).apply { rightMargin = dp(7) })
            val lastTurn = turns.optJSONObject(turns.length() - 1)
            activeActivityStartedAt = parseMessageInstant(firstJsonValue(lastTurn ?: JSONObject(), "startedAt", "started_at", "createdAt"))?.toEpochMilli()
                ?: System.currentTimeMillis()
            val lastItems = lastTurn?.optJSONArray("items") ?: JSONArray()
            val turnId = lastTurn?.optString("id").orEmpty()
            val activityText = activityLineText(turnId, lastItems)
            activeActivityText = label(activityText, 12, activityColor).apply {
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            }
            activity.addView(activeActivityText, LinearLayout.LayoutParams(0, WRAP, 1f))
            activeActivityTimer = label("已用 0分0秒", 10, activityColor).apply {
                setPadding(dp(8), 0, 0, 0)
                contentDescription = "本轮思考时间"
            }
            activity.addView(activeActivityTimer, LinearLayout.LayoutParams(WRAP, WRAP))
            messageList.addView(activity, LinearLayout.LayoutParams(MATCH, WRAP))
            activeActivityText?.let(::startActivityShimmer)
            handler.removeCallbacks(activityTick)
            handler.post(activityTick)
        } else {
            handler.removeCallbacks(activityTick)
            activeActivityText = null
            activeActivityTimer = null
        }
        messageScroll.post {
            if (scrollToEnd || wasNearEnd) messageScroll.scrollTo(0, messageList.height)
            else messageScroll.scrollTo(0, previousScrollY)
            updateScrollToBottomButton()
        }
        updateComposerRunningGlow(running)
        updateComposerFileChanges()
    }

    private fun startActivityShimmer(view: TextView) {
        activityShimmerAnimator?.cancel()
        activityShimmerAnimator = null
        if (!foreground) return
        view.post {
            if (!foreground || activeActivityText !== view || !view.isAttachedToWindow) return@post
            activityShimmerAnimator?.cancel()
            val base = if (lightTheme) Color.rgb(105, 105, 105) else Color.rgb(155, 155, 155)
            val highlight = if (lightTheme) Color.BLACK else Color.WHITE
            val sweepWidth = minOf(view.width.toFloat(), view.paint.measureText(view.text.toString()))
                .coerceAtLeast(dp(48).toFloat())
            val gradient = LinearGradient(
                0f, 0f, sweepWidth, 0f,
                intArrayOf(base, base, highlight, base, base),
                floatArrayOf(0f, .35f, .5f, .65f, 1f),
                Shader.TileMode.CLAMP,
            )
            val matrix = Matrix()
            view.paint.shader = gradient
            activityShimmerAnimator = ValueAnimator.ofFloat(-1f, 1f).apply {
                duration = 2600L
                repeatCount = ValueAnimator.INFINITE
                interpolator = android.view.animation.LinearInterpolator()
                addUpdateListener { animator ->
                    matrix.setTranslate((animator.animatedValue as Float) * sweepWidth, 0f)
                    gradient.setLocalMatrix(matrix)
                    view.invalidate()
                }
                start()
            }
        }
    }

    private fun updateScrollToBottomButton() {
        if (!::scrollToBottomButton.isInitialized || !::messageScroll.isInitialized || !::messageList.isInitialized) return
        val distanceToBottom = messageList.height - messageScroll.scrollY - messageScroll.height
        scrollToBottomButton.visibility = if (distanceToBottom > dp(96)) View.VISIBLE else View.GONE
    }

    private fun addPendingUserMessage(scope: String, payload: JSONObject, files: List<JSONObject>) {
        val knownIds = JSONArray()
        activeThread?.optJSONArray("turns")?.let { turns ->
            for (turnIndex in 0 until turns.length()) {
                val items = turns.optJSONObject(turnIndex)?.optJSONArray("items") ?: continue
                for (itemIndex in 0 until items.length()) {
                    val item = items.optJSONObject(itemIndex) ?: continue
                    if (normalizedType(item.optString("type")) == "usermessage") {
                        item.optString("id").takeIf { it.isNotBlank() }?.let(knownIds::put)
                    }
                }
            }
        }
        val content = JSONArray()
        payload.optString("text").takeIf { it.isNotBlank() }?.let { content.put(JSONObject().put("type", "text").put("text", it)) }
        files.filter { it.optString("kind") == "image" }.forEach { file ->
            content.put(JSONObject().put("type", "localImage")
                .put("data", file.optString("thumbnail").ifBlank { file.optString("data") })
                .put("name", file.optString("name")))
        }
        val item = JSONObject().put("id", payload.optString("id"))
            .put("content", content).put("_turnId", "pending-${payload.optString("id")}")
            .put("_displayTime", formatMessageTime(payload.optString("createdAt")))
            .put("_matchText", payload.optString("requestText").trim())
            .put("_imageCount", files.count { it.optString("kind") == "image" })
            .put("_knownUserIds", knownIds).put("_pending", true)
            .put("_pendingState", "发送中…").put("_accepted", false).put("_animate", true)
        pendingUserMessages.getOrPut(scope) { mutableListOf() }.add(item)
        if (draftStorageKey() == scope) appendPendingBubble(item)
    }

    private fun appendPendingBubble(item: JSONObject) {
        if (!::messageList.isInitialized) return
        updateWelcomeTitle(false)
        val viewportWidth = messageScroll.width.takeIf { it > 0 }
            ?: root.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels
        val maxBubbleWidth = ((viewportWidth - messageScroll.paddingLeft - messageScroll.paddingRight - dp(4)) * .92f).toInt()
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            setPadding(dp(2), dp(5), dp(2), dp(5))
            tag = "$TAG_MESSAGE_TURN_PREFIX${item.optString("_turnId")}"
            alpha = 0f
            translationY = dp(6).toFloat()
        }
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.END }
        val bubble = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(11), dp(7), dp(11), dp(7))
            background = rounded(if (currentMode == "claude-code") CLAUDE_USER_MESSAGE_SURFACE else CODEX_USER_MESSAGE_FILL, dp(if (retroTheme) 5 else 12))
        }
        val text = messageText(item, "user")
        if (text.isNotBlank()) {
            val content = label(text, 14, if (currentMode == "claude-code") CLAUDE_USER_MESSAGE_TEXT else CODEX_USER_MESSAGE_TEXT, translateUi = false).apply {
                setTextIsSelectable(true)
                maxWidth = (maxBubbleWidth - dp(22)).coerceAtLeast(dp(120))
                setLineSpacing(dp(2).toFloat(), 1.08f)
            }
            bubble.addView(content, LinearLayout.LayoutParams(
                naturalTextBlockWidth(content, text, (maxBubbleWidth - dp(22)).coerceAtLeast(dp(80))), WRAP))
        }
        addMessageImages(bubble, item, maxBubbleWidth)
        column.addView(bubble, LinearLayout.LayoutParams(WRAP, WRAP))
        column.addView(label("发送中…", 10, MUTED).apply {
            gravity = Gravity.END
            setPadding(0, dp(3), dp(2), 0)
        }, LinearLayout.LayoutParams(WRAP, WRAP))
        row.addView(column, LinearLayout.LayoutParams(WRAP, WRAP))
        messageList.addView(row, LinearLayout.LayoutParams(MATCH, WRAP))
        row.animate().alpha(1f).translationY(0f).setDuration(170).start()
        item.put("_animate", false)
        followMessageBottom = true
        messageScroll.post { messageScroll.smoothScrollTo(0, messageList.height) }
    }

    private fun appendPendingUserMessages(messages: MutableList<Pair<String, JSONObject>>) {
        val scope = draftStorageKey()
        val pending = pendingUserMessages[scope] ?: return
        val claimed = mutableSetOf<String>()
        val realUsers = messages.filter { it.first == "user" }.map { it.second }
        val remaining = pending.filterNot { local ->
            if (!local.optBoolean("_accepted", false)) return@filterNot false
            val known = local.optJSONArray("_knownUserIds")
            realUsers.any { real ->
                val id = real.optString("id")
                if (id.isBlank() || id in claimed || (0 until (known?.length() ?: 0)).any { known?.optString(it) == id }) return@any false
                val realText = messageText(real, "user").trim()
                val matchText = local.optString("_matchText")
                val realImages = real.optJSONArray("content")?.let { parts ->
                    (0 until parts.length()).count { index ->
                        normalizedType(parts.optJSONObject(index)?.optString("type").orEmpty()) in setOf("image", "localimage")
                    }
                } ?: 0
                val sameMessage = id == local.optString("id") ||
                    (matchText.isNotBlank() && realText == matchText) ||
                    (matchText.isBlank() && local.optInt("_imageCount") > 0 && realImages >= local.optInt("_imageCount"))
                if (sameMessage) claimed += id
                sameMessage
            }
        }
        if (remaining.isEmpty()) pendingUserMessages.remove(scope) else pendingUserMessages[scope] = remaining.toMutableList()
        remaining.forEach { messages += "user" to it }
    }

    private fun removePendingUserMessage(scope: String, requestId: String) {
        pendingUserMessages[scope]?.removeAll { it.optString("id") == requestId }
        if (pendingUserMessages[scope]?.isEmpty() == true) pendingUserMessages.remove(scope)
        if (draftStorageKey() == scope) renderMessages(false)
    }

    private fun markPendingUserMessageAccepted(scope: String, requestId: String) {
        pendingUserMessages[scope]?.firstOrNull { it.optString("id") == requestId }?.apply {
            put("_accepted", true)
            put("_pendingState", "同步中…")
        }
        if (draftStorageKey() == scope) renderMessages(false)
    }

    private fun runningActivityText(operation: JSONObject?): String {
        if (operation == null) return "正在思考"
        val type = normalizedType(operation.optString("type"))
        val operationName = operationLabel(operation)
        val statusLabel = when (operationName) {
            "思考" -> "正在思考"
            "整理计划" -> "正在整理执行计划"
            "生成回复" -> "正在生成回复"
            "查看文件" -> "正在读取"
            "搜索文件" -> "正在搜索文件"
            "执行命令" -> "正在运行"
            "修改文件" -> "正在修改文件"
            "搜索资料" -> "正在搜索文件"
            "查看图片" -> "正在查看图片"
            "生成图片" -> "正在生成图片"
            "读取技能" -> when (type) {
                "mcptoolcall" -> "正在调用 MCP 工具"
                "collabagenttoolcall" -> "正在协调子任务"
                else -> "正在调用工具"
            }
            "运行子任务" -> if (type == "collabagenttoolcall") "正在协调子任务" else "正在运行子任务"
            "调用 MCP 工具" -> "正在调用 MCP 工具"
            "调用工具" -> "正在调用工具"
            else -> "正在处理"
        }
        val detail = when {
            type == "filechange" -> operation.optJSONArray("changes")?.length()
                ?.takeIf { it > 0 }?.let { "$it 个文件" }
            type == "commandexecution" && operationName == "查看文件" -> operationDisplayPath(operation)
            type == "mcptoolcall" -> listOf(operation.optString("server"), operation.optString("tool"))
                .filter(String::isNotBlank).joinToString(" · ").takeIf(String::isNotBlank)
            type == "dynamictoolcall" -> listOf(operation.optString("tool"), operation.optString("name"))
                .firstOrNull(String::isNotBlank)
            else -> operationDisplayPath(operation) ?: operationDetail(operation).takeIf(String::isNotBlank)
        }
        return detail?.let { "$statusLabel $it" } ?: statusLabel
    }

    private fun latestRunningActivityItem(items: JSONArray?, excludedItemId: String?, operationOnly: Boolean?): JSONObject? {
        if (items == null) return null
        for (index in items.length() - 1 downTo 0) {
            val item = items.optJSONObject(index) ?: continue
            if (normalizedType(item.optString("type")) == "usermessage") continue
            if (!excludedItemId.isNullOrBlank() && item.optString("id") == excludedItemId) continue
            if (operationOnly != null && isOperationActivityItem(item) != operationOnly) continue
            if (normalizedOperationStatus(item) == "running") return item
        }
        return null
    }

    private fun isOperationActivityItem(item: JSONObject): Boolean = normalizedType(item.optString("type")) in setOf(
        "commandexecution", "filechange", "mcptoolcall", "dynamictoolcall", "collabagenttoolcall",
        "websearch", "imageview", "imagegeneration", "subagentactivity",
    )

    private fun activityLabelForItem(item: JSONObject?): String {
        if (item == null) return "正在思考"
        return when (normalizedType(item.optString("type"))) {
            "reasoning" -> "正在思考"
            "plan" -> "正在整理执行计划"
            "agentmessage" -> "正在生成回复"
            "commandexecution" -> "正在执行命令"
            "filechange" -> "正在修改文件"
            "mcptoolcall" -> "正在调用 MCP 工具"
            "dynamictoolcall" -> "正在调用工具"
            "websearch" -> "正在搜索资料"
            "imageview" -> "正在查看图片"
            "imagegeneration" -> "正在生成图片"
            "collabagenttoolcall" -> "正在协调子任务"
            "subagentactivity" -> "正在运行子任务"
            else -> "正在处理"
        }
    }

    private fun activityLineText(turnId: String, items: JSONArray?): String {
        val liveMatchesTurn = liveActivityTurnId == turnId
        val completedLiveItemId = liveActivityItem
            ?.takeIf { liveMatchesTurn && liveActivityItemCompleted }
            ?.optString("id")
            ?.takeIf(String::isNotBlank)
        val liveItem = liveActivityItem?.takeIf { liveMatchesTurn && !liveActivityItemCompleted }
        val activeOperation = liveItem?.takeIf(::isOperationActivityItem)
            ?: latestRunningActivityItem(items, completedLiveItemId, operationOnly = true)
        if (activeOperation != null) return runningActivityText(activeOperation)
        if (liveMatchesTurn && !liveActivityLabel.isNullOrBlank()) return liveActivityLabel.orEmpty()
        if (liveItem != null) return activityLabelForItem(liveItem)
        return activityLabelForItem(latestRunningActivityItem(items, null, operationOnly = false))
    }

    private fun updateActiveActivityText() {
        val turns = activeThread?.optJSONArray("turns")
        val turn = turns?.let { allTurns ->
            if (!liveActivityTurnId.isNullOrBlank()) {
                (0 until allTurns.length()).mapNotNull { allTurns.optJSONObject(it) }
                    .lastOrNull { it.optString("id") == liveActivityTurnId }
            } else allTurns.optJSONObject(allTurns.length() - 1)
        }
        val turnId = turn?.optString("id").orEmpty().ifBlank { liveActivityTurnId.orEmpty() }
        activeActivityText?.let { textView ->
            textView.text = tr(activityLineText(turnId, turn?.optJSONArray("items")))
            startActivityShimmer(textView)
        }
    }

    private var assistantMarkdownAppearance = ""
    private var assistantMarkdownCache: Markwon? = null
    private val localInstallerLink = Regex("""\[([^\]]+)]\(<?(/[^)>\n]+\.(?:apk|exe|msi|dmg))>?\)""", RegexOption.IGNORE_CASE)

    private data class AssistantMarkdownPart(
        val markdown: String? = null,
        val code: String? = null,
        val language: String = "",
    )

    private fun addAssistantMarkdown(container: LinearLayout, text: String, maximumWidth: Int) {
        splitAssistantMarkdown(text).forEach { part ->
            if (part.code != null) {
                container.addView(
                    assistantCodeBlockView(part.language, part.code, maximumWidth),
                    LinearLayout.LayoutParams(maximumWidth, WRAP).apply { topMargin = dp(4); bottomMargin = dp(4) },
                )
                return@forEach
            }
            val markdown = part.markdown.orEmpty()
            if (markdown.isBlank()) return@forEach
            val content = label("", 14, TEXT, translateUi = false).apply {
                setTextIsSelectable(true)
                setLineSpacing(dp(3).toFloat(), 1.3f)
                typeface = themedTypeface()
                setHorizontallyScrolling(false)
                breakStrategy = android.text.Layout.BREAK_STRATEGY_SIMPLE
                hyphenationFrequency = android.text.Layout.HYPHENATION_FREQUENCY_NONE
                maxWidth = maximumWidth
            }
            assistantMarkdown.setMarkdown(content, displayLocalInstallerPaths(markdown))
            enableChatLinkClicks(content)
            container.addView(content, LinearLayout.LayoutParams(WRAP, WRAP))
        }
    }

    private fun splitAssistantMarkdown(text: String): List<AssistantMarkdownPart> {
        val parts = mutableListOf<AssistantMarkdownPart>()
        val markdown = StringBuilder()
        var code: StringBuilder? = null
        var fenceCharacter: Char? = null
        var fenceLength = 0
        var language = ""

        fun flushMarkdown() {
            if (markdown.isNotEmpty()) parts += AssistantMarkdownPart(markdown = markdown.toString())
            markdown.setLength(0)
        }

        fun openingFence(line: String): Pair<String, String>? {
            val indentation = line.takeWhile { it == ' ' }.length
            if (indentation > 3) return null
            val remainder = line.drop(indentation)
            val character = remainder.firstOrNull()?.takeIf { it == '`' || it == '~' } ?: return null
            val length = remainder.takeWhile { it == character }.length
            if (length < 3) return null
            val info = remainder.drop(length)
            if (character == '`' && '`' in info) return null
            val languageName = info.trim().split(Regex("\\s+")).firstOrNull().orEmpty()
                .removePrefix("{.").removeSuffix("}")
            return character.toString().repeat(length) to languageName
        }

        fun closesFence(line: String, character: Char, minimumLength: Int): Boolean {
            val indentation = line.takeWhile { it == ' ' }.length
            if (indentation > 3) return false
            val remainder = line.drop(indentation)
            val runLength = remainder.takeWhile { it == character }.length
            return runLength >= minimumLength && remainder.drop(runLength).all { it == ' ' || it == '\t' }
        }

        val lines = text.split('\n')
        lines.forEachIndexed { index, rawLine ->
            val line = rawLine.removeSuffix("\r")
            val lineEnding = if (index < lines.lastIndex) "\n" else ""
            val currentCode = code
            if (currentCode == null) {
                val opening = openingFence(line)
                if (opening == null) {
                    markdown.append(line).append(lineEnding)
                } else {
                    flushMarkdown()
                    fenceCharacter = opening.first.first()
                    fenceLength = opening.first.length
                    language = opening.second
                    code = StringBuilder()
                }
            } else if (fenceCharacter?.let { closesFence(line, it, fenceLength) } == true) {
                parts += AssistantMarkdownPart(code = currentCode.toString().removeSuffix("\n"), language = language)
                code = null
                fenceCharacter = null
                fenceLength = 0
                language = ""
            } else {
                currentCode.append(line).append(lineEnding)
            }
        }

        val unfinishedCode = code
        if (unfinishedCode != null) {
            parts += AssistantMarkdownPart(code = unfinishedCode.toString(), language = language)
        } else {
            flushMarkdown()
        }
        return parts
    }

    private fun assistantCodeBlockView(language: String, code: String, maximumWidth: Int): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(9), dp(5), dp(9), dp(8))
            background = rounded(PANEL_INSET, dp(if (retroTheme) 4 else 8), BORDER, dp(1))
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(
            label(language.ifBlank { "代码" }, 10, MUTED, translateUi = language.isNotBlank()).apply {
                if (language.isNotBlank()) text = language
            },
            LinearLayout.LayoutParams(0, dp(30), 1f),
        )
        header.addView(copyActionButton("复制代码", "代码", code), LinearLayout.LayoutParams(WRAP, dp(30)))
        card.addView(header, LinearLayout.LayoutParams(MATCH, WRAP))

        val codeText = label(code, 12, TEXT, translateUi = false, pixelize = false).apply {
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
            setHorizontallyScrolling(true)
            setLineSpacing(dp(1).toFloat(), 1.15f)
        }
        val horizontalScroll = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = true
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
            addView(codeText, FrameLayout.LayoutParams(WRAP, WRAP))
        }
        card.addView(horizontalScroll, LinearLayout.LayoutParams(MATCH, WRAP))
        card.layoutParams = LinearLayout.LayoutParams(maximumWidth, WRAP)
        return card
    }

    private fun messageCopyAction(text: String): View? =
        text.takeIf { it.isNotBlank() }?.let { copyActionButton("复制消息", "聊天消息", it) }

    private fun copyActionButton(actionLabel: String, clipboardLabel: String, text: String): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(dp(5), 0, dp(7), 0)
            minimumWidth = dp(40)
            minimumHeight = dp(30)
            background = lollipopRipple()
            isClickable = true
            isFocusable = true
            contentDescription = tr(actionLabel)
            tooltipText = tr(actionLabel)
            setOnClickListener { copyChatText(clipboardLabel, text) }

            addView(ImageView(this@MainActivity).apply {
                setPixelAwareImageResource(iconResource("copy"))
                imageTintList = if (retroTheme) null else ColorStateList.valueOf(iconTint("copy"))
                scaleType = ImageView.ScaleType.FIT_CENTER
            }, LinearLayout.LayoutParams(dp(15), dp(15)))
            addView(label(actionLabel, 10, MUTED), LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = dp(4) })
        }

    private fun copyChatText(clipboardLabel: String, text: String) {
        if (text.isBlank()) return
        val clipboard = getSystemService(ClipboardManager::class.java) ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText(tr(clipboardLabel), text))
        showToast("已复制")
    }

    private fun displayLocalInstallerPaths(text: String): String = localInstallerLink.replace(text) { match ->
        "${match.groupValues[1]}：${match.groupValues[2]}"
    }

    private fun enableChatLinkClicks(textView: TextView) {
        textView.linksClickable = true
        textView.movementMethod = object : LinkMovementMethod() {
            private var pressedUrl: URLSpan? = null
            private var touchStartX = 0f
            private var touchStartY = 0f

            override fun onTouchEvent(widget: TextView, buffer: Spannable, event: MotionEvent): Boolean {
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        touchStartX = event.x
                        touchStartY = event.y
                        pressedUrl = urlSpanAt(widget, buffer, event)
                    }
                    MotionEvent.ACTION_UP -> {
                        val candidate = urlSpanAt(widget, buffer, event)
                        val stayedOnLink = pressedUrl != null && candidate?.url == pressedUrl?.url
                        val touchSlop = ViewConfiguration.get(widget.context).scaledTouchSlop
                        val stayedInPlace = kotlin.math.abs(event.x - touchStartX) <= touchSlop &&
                            kotlin.math.abs(event.y - touchStartY) <= touchSlop
                        if (stayedOnLink && stayedInPlace) {
                            val webUrl = normalizeWebUrl(candidate?.url.orEmpty())
                            if (webUrl != null) {
                                pressedUrl = null
                                Selection.removeSelection(buffer)
                                openWebPreview(webUrl)
                                return true
                            }
                        }
                    }
                }
                val handled = try {
                    super.onTouchEvent(widget, buffer, event)
                } catch (_: ActivityNotFoundException) {
                    Toast.makeText(this@MainActivity, "没有可用的应用打开此链接", Toast.LENGTH_SHORT).show()
                    true
                }
                if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) pressedUrl = null
                return handled
            }
        }
    }

    private fun urlSpanAt(textView: TextView, text: Spannable, event: MotionEvent): URLSpan? {
        if (text.isEmpty()) return null
        val layout = textView.layout ?: return null
        val x = event.x - textView.totalPaddingLeft + textView.scrollX
        val y = event.y - textView.totalPaddingTop + textView.scrollY
        if (x < 0 || y < 0 || y > layout.height) return null
        val line = layout.getLineForVertical(y.toInt())
        val offset = layout.getOffsetForHorizontal(line, x).coerceIn(0, text.length - 1)
        return text.getSpans(offset, offset + 1, URLSpan::class.java)
            .firstOrNull { offset >= text.getSpanStart(it) && offset < text.getSpanEnd(it) }
    }

    private fun normalizeWebUrl(value: String): String? {
        val address = value.trim()
        if (address.isBlank()) return null
        if (address.startsWith("//")) return "https:$address"
        val scheme = runCatching { Uri.parse(address).scheme?.lowercase(Locale.ROOT) }.getOrNull()
        return when (scheme) {
            "http", "https" -> address
            null -> if (Patterns.WEB_URL.matcher(address).matches()) "https://$address" else null
            else -> null
        }
    }

    private data class PendingWebDownload(
        val url: String,
        val userAgent: String?,
        val contentDisposition: String?,
        val mimeType: String?,
    )

    private data class WebDownloadRateSample(val bytes: Long, val timestamp: Long)

    private data class WebDownloadRowUi(
        val container: LinearLayout,
        val title: TextView,
        val details: TextView,
        val progress: ProgressBar,
    )

    private fun showWebAddressDialog(currentAddress: String, onLoad: (String) -> Unit) {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(10))
            background = rounded(OPAQUE_PANEL, dp(14), BORDER, dp(1))
        }
        layout.addView(label("输入网页地址", 15, TEXT, true), LinearLayout.LayoutParams(MATCH, WRAP).apply {
            bottomMargin = dp(12)
        })
        val addressInput = EditText(this).apply {
            setTextColor(TEXT)
            setHintTextColor(MUTED)
            textSize = adjustedTextSize(14)
            setTag(R.id.base_text_size, 14f)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setSingleLine(true)
            setSelectAllOnFocus(true)
            hint = "https://example.com"
            setText(currentAddress)
            background = rounded(PANEL_INSET, dp(8), BORDER, dp(1))
            setPadding(dp(10), dp(8), dp(10), dp(8))
        }
        layout.addView(addressInput, LinearLayout.LayoutParams(MATCH, dp(44)))
        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
        }
        val submit = {
            val target = normalizeWebUrl(addressInput.text.toString())
            if (target == null) {
                addressInput.error = "请输入有效的网址"
            } else {
                onLoad(target)
                dialog.dismiss()
            }
        }
        actions.addView(dialogTextButton("取消", MUTED) { dialog.dismiss() }, LinearLayout.LayoutParams(WRAP, dp(42)))
        actions.addView(dialogTextButton("前往", ACCENT) { submit() }, LinearLayout.LayoutParams(WRAP, dp(42)))
        layout.addView(actions, LinearLayout.LayoutParams(MATCH, dp(46)).apply { topMargin = dp(5) })
        addressInput.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO) {
                submit()
                true
            } else false
        }
        dialog.setContentView(layout)
        dialog.setCanceledOnTouchOutside(true)
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout((resources.displayMetrics.widthPixels - dp(32)).coerceAtLeast(dp(260)), WRAP)
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        addressInput.requestFocus()
        addressInput.post {
            addressInput.selectAll()
            (getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
                ?.showSoftInput(addressInput, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun beginWebDownload(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        val scheme = runCatching { Uri.parse(url).scheme?.lowercase(Locale.ROOT) }.getOrNull()
        if (scheme !in setOf("http", "https")) {
            showToast("此网页的下载链接暂不支持")
            return
        }
        val download = PendingWebDownload(url, userAgent, contentDisposition, mimeType)
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingWebDownload = download
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQUEST_WEB_DOWNLOAD_STORAGE)
            return
        }
        enqueueWebDownload(download)
    }

    private fun enqueueWebDownload(download: PendingWebDownload) {
        val manager = getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
        if (manager == null) {
            showToast("系统下载服务不可用")
            return
        }
        val fileName = URLUtil.guessFileName(download.url, download.contentDisposition, download.mimeType)
        val request = DownloadManager.Request(Uri.parse(download.url)).apply {
            setTitle(fileName)
            setDescription("网页文件下载")
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            download.mimeType?.takeIf { it.isNotBlank() }?.let { setMimeType(it) }
            download.userAgent?.takeIf { it.isNotBlank() }?.let { addRequestHeader("User-Agent", it) }
            CookieManager.getInstance().getCookie(download.url)?.takeIf { it.isNotBlank() }?.let {
                addRequestHeader("Cookie", it)
            }
            webPreviewView?.url?.takeIf { it.isNotBlank() }?.let { addRequestHeader("Referer", it) }
        }
        runCatching { manager.enqueue(request) }
            .onSuccess { showToast("已开始下载：$fileName") }
            .onFailure { showToast("下载启动失败：${it.message ?: "请稍后重试"}") }
    }

    private fun showWebDownloadsDialog() {
        val manager = getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
        if (manager == null) {
            showToast("系统下载服务不可用")
            return
        }
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(9), dp(14), dp(10))
            background = rounded(OPAQUE_PANEL, dp(14), BORDER, dp(1))
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(label("下载", 16, TEXT, true), LinearLayout.LayoutParams(0, dp(42), 1f))
        header.addView(iconButton("close", "关闭下载列表") { dialog.dismiss() }, LinearLayout.LayoutParams(dp(36), dp(36)))
        content.addView(header, LinearLayout.LayoutParams(MATCH, dp(42)))
        val rows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val emptyState = label("暂无下载。打开网页并点击下载链接后会显示在这里。", 13, MUTED).apply {
            gravity = Gravity.CENTER
            setPadding(dp(18), dp(34), dp(18), dp(34))
        }
        rows.addView(emptyState, LinearLayout.LayoutParams(MATCH, WRAP))
        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            addView(rows, ViewGroup.LayoutParams(MATCH, WRAP))
        }
        content.addView(scroll, LinearLayout.LayoutParams(MATCH, 0, 1f))
        dialog.setContentView(content)
        dialog.setCanceledOnTouchOutside(true)
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout((resources.displayMetrics.widthPixels - dp(28)).coerceAtLeast(dp(270)),
                (resources.displayMetrics.heightPixels * .72f).toInt())
            setGravity(Gravity.CENTER)
        }

        val rowViews = mutableMapOf<Long, WebDownloadRowUi>()
        val samples = mutableMapOf<Long, WebDownloadRateSample>()
        val updateDownloads = object : Runnable {
            override fun run() {
                if (!dialog.isShowing) return
                val cursor = runCatching { manager.query(DownloadManager.Query()) }.getOrNull()
                if (cursor == null) {
                    emptyState.text = "无法读取下载列表"
                    emptyState.visibility = View.VISIBLE
                    handler.postDelayed(this, 1000L)
                    return
                }
                val now = SystemClock.elapsedRealtime()
                val visibleIds = mutableSetOf<Long>()
                cursor.use { result ->
                    val idColumn = result.getColumnIndexOrThrow(DownloadManager.COLUMN_ID)
                    val titleColumn = result.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)
                    val statusColumn = result.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)
                    val reasonColumn = result.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)
                    val bytesColumn = result.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
                    val totalColumn = result.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
                    val mimeColumn = result.getColumnIndexOrThrow(DownloadManager.COLUMN_MEDIA_TYPE)
                    while (result.moveToNext()) {
                        val id = result.getLong(idColumn)
                        visibleIds += id
                        val title = result.getString(titleColumn)?.takeIf { it.isNotBlank() } ?: "网页文件下载"
                        val status = result.getInt(statusColumn)
                        val reason = result.getInt(reasonColumn)
                        val bytes = result.getLong(bytesColumn).coerceAtLeast(0L)
                        val total = result.getLong(totalColumn)
                        val mimeType = result.getString(mimeColumn).orEmpty()
                        val previous = samples[id]
                        val elapsed = previous?.let { (now - it.timestamp).coerceAtLeast(1L) } ?: 1L
                        val rate = if (status == DownloadManager.STATUS_RUNNING && previous != null) {
                            ((bytes - previous.bytes).coerceAtLeast(0L) * 1000L / elapsed)
                        } else 0L
                        samples[id] = WebDownloadRateSample(bytes, now)

                        val row = rowViews.getOrPut(id) {
                            val titleView = label(title, 13, TEXT, true, translateUi = false).apply {
                                maxLines = 1
                                ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                            }
                            val detailsView = label("", 11, MUTED, translateUi = false)
                            val progressView = ProgressBar(this@MainActivity, null, android.R.attr.progressBarStyleHorizontal).apply {
                                max = 100
                                progressTintList = ColorStateList.valueOf(ACCENT)
                                progressBackgroundTintList = ColorStateList.valueOf(BORDER)
                            }
                            val rowContent = LinearLayout(this@MainActivity).apply {
                                orientation = LinearLayout.VERTICAL
                                setPadding(dp(3), dp(10), dp(3), dp(10))
                                addView(titleView, LinearLayout.LayoutParams(MATCH, WRAP))
                                addView(detailsView, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(4) })
                                addView(progressView, LinearLayout.LayoutParams(MATCH, dp(3)).apply { topMargin = dp(7) })
                            }
                            rows.addView(rowContent, LinearLayout.LayoutParams(MATCH, WRAP))
                            rows.addView(View(this@MainActivity).apply { setBackgroundColor(BORDER) }, LinearLayout.LayoutParams(MATCH, dp(1)))
                            WebDownloadRowUi(rowContent, titleView, detailsView, progressView)
                        }
                        row.title.text = title
                        val statusText = when (status) {
                            DownloadManager.STATUS_PENDING -> "等待下载"
                            DownloadManager.STATUS_RUNNING -> "正在下载"
                            DownloadManager.STATUS_PAUSED -> when (reason) {
                                DownloadManager.PAUSED_WAITING_TO_RETRY -> "网络波动，稍后重试"
                                DownloadManager.PAUSED_WAITING_FOR_NETWORK -> "等待网络"
                                DownloadManager.PAUSED_QUEUED_FOR_WIFI -> "等待 Wi-Fi"
                                else -> "已暂停"
                            }
                            DownloadManager.STATUS_SUCCESSFUL -> "下载完成 · 点击打开"
                            DownloadManager.STATUS_FAILED -> "下载失败（$reason）"
                            else -> "状态未知"
                        }
                        val totalText = if (total > 0L) formatDownloadSize(total) else "大小未知"
                        val speedText = if (status == DownloadManager.STATUS_RUNNING) {
                            if (previous != null) " · ${formatDownloadRate(rate)}" else " · 计算速度中…"
                        } else ""
                        row.details.text = "$statusText · ${formatDownloadSize(bytes)} / $totalText$speedText"
                        row.progress.isIndeterminate = total <= 0L && status in setOf(DownloadManager.STATUS_PENDING, DownloadManager.STATUS_RUNNING)
                        row.progress.progress = if (total > 0L) ((bytes * 100L / total).toInt()).coerceIn(0, 100) else 0
                        row.container.contentDescription = if (status == DownloadManager.STATUS_SUCCESSFUL) "打开下载文件：$title" else title
                        row.container.setOnClickListener(if (status == DownloadManager.STATUS_SUCCESSFUL) {
                            View.OnClickListener { openDownloadedWebFile(manager, id, mimeType) }
                        } else null)
                    }
                }
                emptyState.visibility = if (visibleIds.isEmpty()) View.VISIBLE else View.GONE
                (rowViews.keys - visibleIds).forEach { id ->
                    rowViews.remove(id)?.let { row -> rows.removeView(row.container) }
                    samples.remove(id)
                }
                handler.postDelayed(this, 1000L)
            }
        }
        dialog.setOnDismissListener { handler.removeCallbacks(updateDownloads) }
        handler.post(updateDownloads)
    }

    private fun formatDownloadSize(bytes: Long): String {
        if (bytes < 1024L) return "$bytes B"
        val units = arrayOf("KB", "MB", "GB", "TB")
        var value = bytes.toDouble()
        var unit = -1
        do {
            value /= 1024.0
            unit++
        } while (value >= 1024.0 && unit < units.lastIndex)
        return String.format(Locale.getDefault(), "%.1f %s", value, units[unit])
    }

    private fun formatDownloadRate(bytesPerSecond: Long): String = "${formatDownloadSize(bytesPerSecond)}/s"

    private fun openDownloadedWebFile(manager: DownloadManager, id: Long, mimeType: String) {
        val uri = manager.getUriForDownloadedFile(id)
        if (uri == null) {
            showToast("找不到已下载的文件")
            return
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mimeType.ifBlank { "*/*" })
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        runCatching { startActivity(intent) }
            .onFailure { showToast("没有可用的应用打开此文件") }
    }

    private data class WebPreviewFrame(
        val x: Int,
        val y: Int,
        val width: Int,
        val height: Int,
        val availableWidth: Int,
        val availableHeight: Int,
    )

    private fun webPreviewFrame(): WebPreviewFrame {
        val left = systemInsetLeft + dp(6)
        val right = (root.width - systemInsetRight - dp(6)).coerceAtLeast(left + dp(160))
        val availableWidth = (right - left).coerceAtLeast(dp(160))
        val rootLocation = IntArray(2)
        val composerLocation = IntArray(2)
        root.getLocationOnScreen(rootLocation)
        composerDock.getLocationOnScreen(composerLocation)
        val composerTop = composerLocation[1] - rootLocation[1]
        val top = systemInsetTop + dp(8)
        val bottom = (composerTop - dp(8)).coerceAtLeast(top + dp(160))
        val availableHeight = (bottom - top).coerceAtLeast(dp(160))
        val widthRatio = prefs.getFloat(KEY_WEB_PREVIEW_WIDTH_RATIO, .94f).coerceIn(.45f, 1f)
        val heightRatio = prefs.getFloat(KEY_WEB_PREVIEW_HEIGHT_RATIO, .76f).coerceIn(.4f, 1f)
        val width = (availableWidth * widthRatio).roundToInt().coerceIn(dp(240).coerceAtMost(availableWidth), availableWidth)
        val height = (availableHeight * heightRatio).roundToInt().coerceIn(dp(220).coerceAtMost(availableHeight), availableHeight)
        val x = left + (availableWidth - width) / 2
        val y = top + (availableHeight - height) / 2
        return WebPreviewFrame(x, y, width, height, availableWidth, availableHeight)
    }

    private fun openWebPreview(rawUrl: String) {
        val url = normalizeWebUrl(rawUrl) ?: return openExternalChatLink(rawUrl)
        if (webPreviewPopup?.isShowing == true) {
            webPreviewView?.loadUrl(url)
            return
        }
        if (!::root.isInitialized || !::composerDock.isInitialized || root.width <= 0) {
            openExternalChatLink(url)
            return
        }

        val focused = window.currentFocus
        if (focused is EditText) {
            (getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
                ?.hideSoftInputFromWindow(focused.windowToken, 0)
        }
        parkActivityInputFocus()

        val webView = WebView(this).apply {
            setBackgroundColor(Color.WHITE)
            scrollBarStyle = View.SCROLLBARS_INSIDE_OVERLAY
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }
        }
        webPreviewView = webView

        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(OPAQUE_PANEL, dp(14), BORDER, dp(1))
            clipToOutline = true
        }
        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(5), dp(2), dp(5), dp(2))
            background = if (retroTheme) lollipopActionBarBackground() else ColorDrawable(PANEL)
        }
        val addressView = label(url, 10, MUTED, translateUi = false).apply {
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
            setPadding(dp(9), 0, dp(9), 0)
            isClickable = true
            contentDescription = "输入网页地址"
        }
        val progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            progressTintList = ColorStateList.valueOf(ACCENT)
            progressBackgroundTintList = ColorStateList.valueOf(BORDER)
            visibility = View.GONE
        }
        val backButton = iconButton("back", "网页后退") { if (webView.canGoBack()) webView.goBack() }
        val forwardButton = iconButton("chevron_right", "网页前进") { if (webView.canGoForward()) webView.goForward() }
        val refreshButton = iconButton("refresh", "刷新网页") { webView.reload() }
        val downloadButton = iconButton("download", "查看下载") { showWebDownloadsDialog() }
        val externalButton = iconButton("open", "用浏览器打开") {
            openExternalChatLink(webView.url ?: url)
        }
        val closeButton = iconButton("close", "关闭网页预览") { closeWebPreview() }
        listOf(backButton, forwardButton, refreshButton, downloadButton, externalButton, closeButton).forEach { button ->
            button.minimumWidth = dp(34)
            button.minimumHeight = dp(36)
            toolbar.addView(button, LinearLayout.LayoutParams(dp(36), dp(38)))
        }
        toolbar.addView(addressView, LinearLayout.LayoutParams(0, dp(36), 1f))
        addressView.setOnClickListener {
            showWebAddressDialog(webView.url ?: url) { target -> webView.loadUrl(target) }
        }

        val resizeHeader = FrameLayout(this).apply {
            isClickable = true
            setOnClickListener { }
            addView(View(this@MainActivity).apply {
                background = rounded(MUTED, dp(3))
                alpha = .72f
            }, FrameLayout.LayoutParams(dp(38), dp(4), Gravity.CENTER))
        }
        panel.addView(resizeHeader, LinearLayout.LayoutParams(MATCH, dp(18)))
        panel.addView(toolbar, LinearLayout.LayoutParams(MATCH, dp(42)))
        panel.addView(progress, LinearLayout.LayoutParams(MATCH, dp(2)))
        panel.addView(webView, LinearLayout.LayoutParams(MATCH, 0, 1f))

        val resizeFooter = FrameLayout(this).apply {
            isClickable = true
            setOnClickListener { }
            addView(View(this@MainActivity).apply {
                background = rounded(MUTED, dp(3))
                alpha = .72f
            }, FrameLayout.LayoutParams(dp(38), dp(4), Gravity.CENTER))
        }
        panel.addView(resizeFooter, LinearLayout.LayoutParams(MATCH, dp(26)))
        val popupContent = FrameLayout(this).apply {
            addView(panel, FrameLayout.LayoutParams(MATCH, MATCH))
        }
        val widthResizeHandle = FrameLayout(this).apply {
            isClickable = true
            setOnClickListener { }
            addView(View(this@MainActivity).apply {
                background = rounded(MUTED, dp(3))
                alpha = .72f
            }, FrameLayout.LayoutParams(dp(4), dp(38), Gravity.CENTER))
        }
        popupContent.addView(widthResizeHandle, FrameLayout.LayoutParams(dp(24), dp(76), Gravity.END or Gravity.CENTER_VERTICAL))

        val initialFrame = webPreviewFrame()
        val popup = PopupWindow(popupContent, initialFrame.width, initialFrame.height, false).apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            elevation = dp(12).toFloat()
            isTouchable = true
            isFocusable = false
            isOutsideTouchable = false
            isClippingEnabled = true
            inputMethodMode = PopupWindow.INPUT_METHOD_NOT_NEEDED
        }
        webPreviewPopup = popup

        val updateHistoryButtons = {
            backButton.isEnabled = webView.canGoBack()
            backButton.alpha = if (backButton.isEnabled) 1f else .45f
            forwardButton.isEnabled = webView.canGoForward()
            forwardButton.alpha = if (forwardButton.isEnabled) 1f else .45f
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                routeWebPreviewNavigation(request.url)

            override fun onPageStarted(view: WebView, address: String?, favicon: Bitmap?) {
                address?.let { addressView.text = it }
                progress.progress = 0
                progress.visibility = View.VISIBLE
                updateHistoryButtons()
            }

            override fun onPageFinished(view: WebView, address: String?) {
                addressView.text = view.url ?: address.orEmpty()
                updateHistoryButtons()
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
                handler.cancel()
                showToast("网页证书验证失败，已停止加载")
            }
        }
        webView.setDownloadListener { downloadUrl, userAgent, contentDisposition, mimeType, _ ->
            beginWebDownload(downloadUrl, userAgent, contentDisposition, mimeType)
        }

        var popupX = initialFrame.x
        var popupY = initialFrame.y
        fun applySavedFrame(anchorX: Int? = null, anchorY: Int? = null) {
            if (!popup.isShowing) return
            val frame = webPreviewFrame()
            val rootLocation = IntArray(2)
            val composerLocation = IntArray(2)
            root.getLocationOnScreen(rootLocation)
            composerDock.getLocationOnScreen(composerLocation)
            val composerTop = composerLocation[1] - rootLocation[1]
            val minX = systemInsetLeft + dp(6)
            val maxX = (root.width - systemInsetRight - dp(6) - frame.width).coerceAtLeast(minX)
            val minY = systemInsetTop + dp(8)
            val maxY = (composerTop - dp(8) - frame.height).coerceAtLeast(minY)
            popupX = (anchorX ?: popupX).coerceIn(minX, maxX)
            popupY = (anchorY ?: popupY).coerceIn(minY, maxY)
            popup.update(popupX, popupY, frame.width, frame.height)
        }
        webPreviewRelayout = { applySavedFrame() }

        fun resizeHandler(
            resizeWidth: Boolean,
            resizeHeight: Boolean,
            anchorBottom: Boolean = false,
        ): View.OnTouchListener {
            var startX = 0f
            var startY = 0f
            var startWidth = 0
            var startHeight = 0
            var startPopupX = 0
            var startPopupY = 0
            return View.OnTouchListener { view, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        startX = event.rawX
                        startY = event.rawY
                        startWidth = popup.width
                        startHeight = popup.height
                        startPopupX = popupX
                        startPopupY = popupY
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val available = webPreviewFrame()
                        val width = if (resizeWidth) {
                            (startWidth + (event.rawX - startX).roundToInt())
                                .coerceIn(dp(240).coerceAtMost(available.availableWidth), available.availableWidth)
                        } else startWidth
                        val height = if (resizeHeight) {
                            val deltaY = (event.rawY - startY).roundToInt()
                            (startHeight + (if (anchorBottom) -deltaY else deltaY))
                                .coerceIn(dp(220).coerceAtMost(available.availableHeight), available.availableHeight)
                        } else startHeight
                        val editor = prefs.edit()
                        if (resizeWidth) editor.putFloat(KEY_WEB_PREVIEW_WIDTH_RATIO, width.toFloat() / available.availableWidth)
                        if (resizeHeight) editor.putFloat(KEY_WEB_PREVIEW_HEIGHT_RATIO, height.toFloat() / available.availableHeight)
                        editor.apply()
                        applySavedFrame(
                            anchorX = if (resizeWidth) startPopupX else popupX,
                            anchorY = if (resizeHeight && anchorBottom) {
                                startPopupY + startHeight - height
                            } else if (resizeHeight) startPopupY else popupY,
                        )
                        true
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        view.performClick()
                        true
                    }
                    else -> false
                }
            }
        }
        widthResizeHandle.setOnTouchListener(resizeHandler(resizeWidth = true, resizeHeight = false))
        resizeFooter.setOnTouchListener(resizeHandler(resizeWidth = false, resizeHeight = true))
        resizeHeader.setOnTouchListener(resizeHandler(resizeWidth = false, resizeHeight = true, anchorBottom = true))

        var cleanedUp = false
        val rootLayoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applySavedFrame() }
        root.addOnLayoutChangeListener(rootLayoutListener)
        val cleanup = {
            if (!cleanedUp) {
                cleanedUp = true
                root.removeOnLayoutChangeListener(rootLayoutListener)
                webView.stopLoading()
                webView.loadUrl("about:blank")
                webView.removeAllViews()
                webView.destroy()
                if (webPreviewView === webView) webPreviewView = null
                if (webPreviewPopup === popup) webPreviewPopup = null
                webPreviewRelayout = null
                webPreviewCleanup = null
            }
        }
        webPreviewCleanup = cleanup
        popup.setOnDismissListener { cleanup() }

        popup.showAtLocation(root, Gravity.TOP or Gravity.START, initialFrame.x, initialFrame.y)
        backButton.isEnabled = false
        backButton.alpha = .45f
        forwardButton.isEnabled = false
        forwardButton.alpha = .45f
        webView.loadUrl(url)
    }

    private fun routeWebPreviewNavigation(uri: Uri): Boolean {
        return when (uri.scheme?.lowercase(Locale.ROOT)) {
            "http", "https" -> false
            "javascript", "file", "content", "data", "blob", "about" -> true
            else -> {
                openExternalChatLink(uri.toString())
                true
            }
        }
    }

    private fun openExternalChatLink(value: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(value)))
        } catch (_: ActivityNotFoundException) {
            showToast("没有可用的应用打开此链接")
        }
    }

    private fun closeWebPreview() {
        val popup = webPreviewPopup
        if (popup?.isShowing == true) popup.dismiss() else webPreviewCleanup?.invoke()
    }

    private val assistantMarkdown: Markwon
        get() {
            val appearance = "$TEXT:$PANEL_INSET:$BORDER:$ACCENT"
            assistantMarkdownCache?.takeIf { assistantMarkdownAppearance == appearance }?.let { return it }
            return Markwon.builder(this)
                .usePlugin(object : AbstractMarkwonPlugin() {
                    override fun configureTheme(builder: MarkwonTheme.Builder) {
                        builder.linkColor(ACCENT)
                            .blockMargin(dp(12))
                            .blockQuoteColor(MUTED)
                            .blockQuoteWidth(dp(2))
                            .codeTextColor(TEXT)
                            .codeBlockTextColor(TEXT)
                            .codeBackgroundColor(PANEL_INSET)
                            .codeBlockBackgroundColor(PANEL_INSET)
                            .codeBlockMargin(dp(9))
                            .headingBreakHeight(dp(4))
                    }
                })
                .usePlugin(TablePlugin.create { table ->
                    table.tableCellPadding(dp(7))
                        .tableBorderColor(BORDER)
                        .tableBorderWidth(dp(1))
                        .tableHeaderRowBackgroundColor(PANEL_INSET)
                        .tableOddRowBackgroundColor(PANEL)
                        .tableEvenRowBackgroundColor(PANEL_INSET)
                })
                .usePlugin(LinkifyPlugin.create(Linkify.WEB_URLS))
                .build().also { assistantMarkdownCache = it; assistantMarkdownAppearance = appearance }
        }

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
                    addAssistantMarkdown(container, text, maximumWidth)
                }
                "operation" -> block.optJSONObject("item")?.let { operation ->
                    pendingOperations.add(operation)
                }
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

    private fun operationDisplayPath(operation: JSONObject): String? {
        val path = operationPaths(operation).firstOrNull() ?: run {
            val command = operation.optString("command")
            if (!VIEW_COMMAND_PATTERN.containsMatchIn(command)) null else
                Regex("(?:^|\\s)(?:cat|sed|head|tail)\\s+(?:-n\\s+['\"]?[^'\"\\s]+['\"]?\\s+)?['\"]?([^'\"\\s;|]+)")
                    .find(command)?.groupValues?.getOrNull(1)?.takeUnless { it.startsWith("-") }
        }
        return path?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
    }

    private fun clearLiveActivity() {
        liveActivityItem = null
        liveActivityItemCompleted = false
        liveActivityTurnId = null
        liveActivityLabel = null
    }

    private fun inlineFileChangeView(entry: FileChangeEntry, compact: Boolean = false): LinearLayout {
        val line = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(if (compact) 3 else 10), dp(if (compact) 4 else 5), dp(if (compact) 3 else 9), dp(if (compact) 4 else 5))
            setOnClickListener { showDiffPreview(entry) }
            contentDescription = "查看更改 ${entry.path}"
        }
        line.addView(ImageView(this).apply {
            setImageResource(fileDisplayIconResource(entry.path))
            if (retroTheme) imageTintList = null
        }, LinearLayout.LayoutParams(dp(16), dp(16)).apply { rightMargin = dp(7) })
        line.addView(label("${if (compact) "" else "已更改 "}${entry.path.substringAfterLast('/')}", 11, ACCENT, true).apply {
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        }, LinearLayout.LayoutParams(0, WRAP, 1f))
        if (entry.additions > 0) line.addView(label("+${entry.additions}", 10, if (retroTheme) ANDROID1_ADDED_COLOR else if (lightTheme) Color.rgb(22, 130, 63) else Color.rgb(91, 201, 123), true))
        if (entry.deletions > 0) line.addView(label("-${entry.deletions}", 10, if (retroTheme) ANDROID1_DELETED_COLOR else if (lightTheme) Color.rgb(190, 48, 57) else Color.rgb(239, 102, 113), true).apply { setPadding(dp(7), 0, 0, 0) })
        return line
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
            imageTintList = retroIconTint(MUTED)
        }
        header.addView(chevron, LinearLayout.LayoutParams(dp(15), dp(15)).apply { rightMargin = dp(6) })
        header.addView(ImageView(this).apply {
            setPixelAwareImageResource(iconResource("history"))
            imageTintList = retroIconTint(ACCENT)
            contentDescription = "操作记录"
        }, LinearLayout.LayoutParams(dp(17), dp(17)).apply { rightMargin = dp(6) })
        header.addView(label("操作记录", 12, SUBTLE, true), LinearLayout.LayoutParams(WRAP, dp(25)))
        header.addView(label(statusText, 11, if (failed > 0) ERROR else MUTED).apply { gravity = Gravity.END or Gravity.CENTER_VERTICAL }, LinearLayout.LayoutParams(0, dp(25), 1f))
        container.addView(header, LinearLayout.LayoutParams(maximumWidth, WRAP))

        lateinit var refreshDetails: () -> Unit
        refreshDetails = {
            val expanded = logId in expandedOperationIds
            chevron.setPixelAwareImageResource(iconResource(if (expanded) "chevron_up" else "chevron_down"))
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
            val isFileChange = normalizedType(operation.optString("type")) == "filechange"
            val changedFiles = if (isFileChange) parseFileChanges(operation.opt("changes")) else emptyList()
            val status = normalizedOperationStatus(operation)
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.TOP
                setPadding(0, dp(3), 0, dp(3))
            }
            val statusTint = when (status) {
                "failed" -> ERROR
                "running" -> if (retroTheme) codexBrandAccent() else ACCENT
                "stopped" -> WARNING
                else -> when {
                    retroTheme -> ANDROID1_ADDED_COLOR
                    lightTheme -> Color.rgb(52, 132, 75)
                    else -> Color.rgb(119, 174, 132)
                }
            }
            val statusIcon: View = if (retroTheme && status == "running") {
                ProgressBar(this, null, android.R.attr.progressBarStyleSmall).apply {
                    isIndeterminate = true
                    indeterminateTintList = ColorStateList.valueOf(statusTint)
                }
            } else {
                ImageView(this).apply {
                    setPixelAwareImageResource(when (status) {
                        "failed" -> iconResource("alert")
                        "running" -> R.drawable.ic_progress
                        "stopped" -> iconResource("stop")
                        else -> iconResource("check")
                    })
                    imageTintList = retroIconTint(statusTint)
                }
            }
            row.addView(statusIcon, LinearLayout.LayoutParams(dp(14), dp(14)).apply { topMargin = dp(3); rightMargin = dp(7) })
            val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            copy.addView(label(operationLabel(operation), 12, TEXT, true), widthWrap())
            val paths = operationPaths(operation)
            val detail = if (changedFiles.isNotEmpty()) "" else operationDetail(operation, paths)
            if (detail.isNotBlank()) copy.addView(label(detail, 10, MUTED, translateUi = false).apply {
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                maxWidth = (maximumWidth - dp(42)).coerceAtLeast(dp(110))
            }, widthWrap())
            if (paths.isNotEmpty() && changedFiles.isEmpty()) {
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
            changedFiles.forEach { entry ->
                list.addView(inlineFileChangeView(entry, compact = true), LinearLayout.LayoutParams(maximumWidth - dp(28), WRAP).apply {
                    leftMargin = dp(21)
                })
            }
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
        if (type in setOf("mcptoolcall", "dynamictoolcall", "collabagenttoolcall")) {
            val toolType = listOf(operation.optString("server"), operation.optString("tool"), operation.optString("name"))
                .filter(String::isNotBlank)
                .joinToString(" ")
            return when {
                SEARCH_TOOL_PATTERN.containsMatchIn(toolType) -> "搜索文件"
                FILE_TOOL_PATTERN.containsMatchIn(toolType) && !SKILL_TOOL_PATTERN.containsMatchIn(toolType) -> "查看文件"
                SKILL_TOOL_PATTERN.containsMatchIn(toolType) -> "读取技能"
                type == "collabagenttoolcall" -> "运行子任务"
                type == "mcptoolcall" -> "调用 MCP 工具"
                else -> "调用工具"
            }
        }
        return when (type) {
            "filechange" -> "修改文件"
            "subagentactivity" -> "运行子任务"
            "websearch" -> "搜索资料"
            "imageview" -> "查看图片"
            "imagegeneration" -> "生成图片"
            "reasoning" -> "思考"
            "plan" -> "整理计划"
            "agentmessage" -> "生成回复"
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
        parkActivityInputFocus()
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val frame = FrameLayout(this).apply {
            isFocusableInTouchMode = true
            background = rounded(OPAQUE_PANEL, dp(14), BORDER, dp(1))
        }
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
        frame.requestFocus()
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
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

    private fun updateComposerFileChanges() {
        if (!::composerFileChanges.isInitialized) return
        composerFileChanges.removeAllViews()
        val turns = activeThread?.optJSONArray("turns") ?: JSONArray()
        val turn = turns.optJSONObject(turns.length() - 1)
        val turnId = turn?.optString("id").orEmpty()
        val entries = if (running && turnId.isNotBlank()) fileChangesForTurn(turnId, turn, activeThread) else emptyList()
        composerFileChanges.visibility = if (entries.isEmpty()) View.GONE else View.VISIBLE
        if (entries.isEmpty()) return
        val additions = entries.sumOf { it.additions }
        val deletions = entries.sumOf { it.deletions }
        val heading = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(3), dp(5), dp(3), dp(5))
        }
        if (retroTheme) heading.addView(ImageView(this).apply {
            setPixelAwareImageResource(iconResource("file"))
            imageTintList = null
            contentDescription = "正在编辑的文件"
        }, LinearLayout.LayoutParams(dp(16), dp(16)).apply { rightMargin = dp(6) })
        heading.addView(label("正在编辑 ${entries.size} 个文件", 11, SUBTLE, true), LinearLayout.LayoutParams(0, WRAP, 1f))
        if (additions > 0) heading.addView(label("+$additions", 10, if (retroTheme) ANDROID1_ADDED_COLOR else if (lightTheme) Color.rgb(22, 130, 63) else Color.rgb(91, 201, 123), true))
        if (deletions > 0) heading.addView(label("-$deletions", 10, if (retroTheme) ANDROID1_DELETED_COLOR else if (lightTheme) Color.rgb(190, 48, 57) else Color.rgb(239, 102, 113), true).apply { setPadding(dp(7), 0, 0, 0) })
        val chevron = ImageView(this).apply {
            imageTintList = retroIconTint(MUTED)
            setPixelAwareImageResource(iconResource(if (expandedComposerFileChangesTurnId == turnId) "chevron_up" else "chevron_down"))
        }
        heading.addView(chevron, LinearLayout.LayoutParams(dp(15), dp(15)).apply { leftMargin = dp(7) })
        composerFileChanges.addView(heading, LinearLayout.LayoutParams(MATCH, WRAP))
        val details = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        entries.forEach { entry -> details.addView(inlineFileChangeView(entry, compact = true), LinearLayout.LayoutParams(MATCH, WRAP)) }
        val detailsScroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = entries.size > 3
            overScrollMode = View.OVER_SCROLL_NEVER
            visibility = if (expandedComposerFileChangesTurnId == turnId) View.VISIBLE else View.GONE
            addView(details, FrameLayout.LayoutParams(MATCH, WRAP))
        }
        composerFileChanges.addView(detailsScroll, LinearLayout.LayoutParams(MATCH, if (entries.size > 3) dp(110) else WRAP))
        heading.setOnClickListener {
            expandedComposerFileChangesTurnId = if (expandedComposerFileChangesTurnId == turnId) null else turnId
            detailsScroll.visibility = if (expandedComposerFileChangesTurnId == turnId) View.VISIBLE else View.GONE
            chevron.setPixelAwareImageResource(iconResource(if (detailsScroll.visibility == View.VISIBLE) "chevron_up" else "chevron_down"))
        }
    }

    private fun addFileChangeSummary(turnId: String, entries: List<FileChangeEntry>) {
        if (entries.isEmpty()) return
        val summaryId = "files:$turnId"
        val additions = entries.sumOf { it.additions }
        val deletions = entries.sumOf { it.deletions }
        val cardBorder = if (lightTheme) Color.rgb(227, 227, 230) else Color.rgb(70, 70, 74)
        val divider = if (lightTheme) Color.rgb(237, 237, 238) else Color.rgb(69, 69, 73)
        val controlSurface = if (lightTheme) Color.rgb(250, 250, 251) else Color.rgb(56, 56, 59)
        val controlBorder = if (lightTheme) Color.rgb(226, 226, 229) else Color.rgb(75, 75, 80)
        val copyColor = if (lightTheme) Color.rgb(88, 88, 94) else Color.rgb(199, 199, 203)
        val addedColor = if (retroTheme) ANDROID1_ADDED_COLOR else if (lightTheme) Color.rgb(51, 139, 67) else Color.rgb(121, 201, 141)
        val deletedColor = if (retroTheme) ANDROID1_DELETED_COLOR else if (lightTheme) Color.rgb(211, 79, 73) else Color.rgb(239, 119, 111)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(1), dp(1), dp(1), dp(1))
            background = rounded(PANEL, dp(11), cardBorder, dp(1))
            clipToOutline = true
            tag = "$TAG_MESSAGE_TURN_PREFIX$turnId"
            if (retroTheme) elevation = dp(2).toFloat()
        }
        val heading = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(61)
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        val iconFrame = FrameLayout(this).apply {
            background = rounded(if (retroTheme) LOLLIPOP_PRIMARY_LIGHT else if (lightTheme) Color.rgb(247, 247, 248) else Color.rgb(39, 39, 41), dp(10), cardBorder, dp(1))
        }
        iconFrame.addView(ImageView(this).apply {
            setPixelAwareImageResource(iconResource("file"))
            imageTintList = retroIconTint(if (lightTheme) Color.rgb(105, 105, 111) else Color.rgb(189, 189, 193))
        }, FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER))
        heading.addView(iconFrame, LinearLayout.LayoutParams(dp(38), dp(38)).apply { rightMargin = dp(10) })
        val summary = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        summary.addView(label("本次已编辑 ${entries.size} 个文件", 13, TEXT, true).apply {
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }, widthWrap())
        if (additions > 0 || deletions > 0) {
            val stats = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            if (additions > 0) stats.addView(label("+$additions", 11, addedColor))
            if (deletions > 0) stats.addView(label("-$deletions", 11, deletedColor).apply { setPadding(dp(7), 0, 0, 0) })
            summary.addView(stats, widthWrap())
        }
        heading.addView(summary, LinearLayout.LayoutParams(0, WRAP, 1f))
        val details = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val detailsScroll = object : ScrollView(this) {
            var limitHeight = false

            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                val maxHeight = minOf(dp(400), (messageScroll.height * .55f).toInt().coerceAtLeast(dp(180)))
                val measuredHeight = if (limitHeight) View.MeasureSpec.makeMeasureSpec(maxHeight, View.MeasureSpec.AT_MOST) else heightMeasureSpec
                super.onMeasure(widthMeasureSpec, measuredHeight)
            }
        }.apply {
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            isNestedScrollingEnabled = true
            addView(details, FrameLayout.LayoutParams(MATCH, WRAP))
            var previousY = 0f
            setOnTouchListener { view, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        previousY = event.y
                        view.parent?.requestDisallowInterceptTouchEvent(true)
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val direction = if (event.y < previousY) 1 else -1
                        view.parent?.requestDisallowInterceptTouchEvent(view.canScrollVertically(direction))
                        previousY = event.y
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> view.parent?.requestDisallowInterceptTouchEvent(false)
                }
                false
            }
        }
        val footer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val review = label("审核", 11, copyColor).apply {
            gravity = Gravity.CENTER
            setPadding(dp(10), 0, dp(10), 0)
            background = rounded(controlSurface, dp(8), controlBorder, dp(1))
        }
        heading.addView(review, LinearLayout.LayoutParams(WRAP, dp(32)).apply { leftMargin = dp(8) })
        card.addView(heading, LinearLayout.LayoutParams(MATCH, WRAP))
        card.addView(detailsScroll, LinearLayout.LayoutParams(MATCH, WRAP))
        card.addView(footer, LinearLayout.LayoutParams(MATCH, WRAP))
        var reviewing = false
        lateinit var refreshRows: () -> Unit
        refreshRows = {
            details.removeAllViews()
            footer.removeAllViews()
            val expanded = summaryId in expandedFileChangeIds
            detailsScroll.limitHeight = expanded || reviewing
            detailsScroll.requestLayout()
            val visible = if (expanded || reviewing) entries else entries.take(1)
            visible.forEach { entry ->
                details.addView(View(this).apply { setBackgroundColor(divider) }, LinearLayout.LayoutParams(MATCH, dp(1)))
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    minimumHeight = dp(44)
                    setPadding(dp(12), dp(4), dp(12), dp(4))
                    setBackgroundColor(if (lightTheme) Color.WHITE else Color.rgb(57, 57, 60))
                }
                row.addView(label(entry.path, 11, copyColor, translateUi = false).apply {
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                    setOnClickListener { showDiffPreview(entry) }
                }, LinearLayout.LayoutParams(0, WRAP, 1f))
                if (entry.additions > 0) row.addView(label("+${entry.additions}", 10, addedColor).apply { setPadding(dp(5), 0, 0, 0) })
                if (entry.deletions > 0) row.addView(label("-${entry.deletions}", 10, deletedColor).apply { setPadding(dp(5), 0, 0, 0) })
                val insert = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER
                    setPadding(dp(7), 0, dp(7), 0)
                    background = rounded(controlSurface, dp(7), controlBorder, dp(1))
                    setOnClickListener { insertWorkspacePathIntoComposer(entry.path) }
                    contentDescription = "插入 ${entry.path} 到对话"
                }
                insert.addView(ImageView(this).apply {
                    setPixelAwareImageResource(if (retroTheme) iconResource("add") else R.drawable.ic_insert_conversation)
                    imageTintList = retroIconTint(copyColor)
                }, LinearLayout.LayoutParams(dp(13), dp(13)).apply { rightMargin = dp(3) })
                insert.addView(label("插入对话", 10, copyColor), LinearLayout.LayoutParams(WRAP, WRAP))
                row.addView(insert, LinearLayout.LayoutParams(WRAP, dp(28)).apply { leftMargin = dp(8) })
                details.addView(row, LinearLayout.LayoutParams(MATCH, WRAP))
                if (reviewing) details.addView(label("", 10, MUTED, translateUi = false, pixelize = false).apply {
                    text = highlightedReviewDiff(entry.diff.ifBlank { "文件已更新，点击文件名查看文件" })
                    typeface = Typeface.MONOSPACE
                    maxLines = 10
                    setPadding(dp(12), dp(7), dp(12), dp(7))
                    setBackgroundColor(if (lightTheme) Color.rgb(250, 250, 250) else Color.rgb(37, 37, 39))
                    setOnClickListener { showDiffPreview(entry) }
                }, LinearLayout.LayoutParams(MATCH, WRAP))
            }
            if (entries.size > 1) {
                footer.addView(View(this).apply { setBackgroundColor(divider) }, LinearLayout.LayoutParams(MATCH, dp(1)))
                val more = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    minimumHeight = dp(36)
                    setPadding(dp(12), 0, dp(12), 0)
                    setOnClickListener {
                        if (expanded || reviewing) expandedFileChangeIds.remove(summaryId) else expandedFileChangeIds.add(summaryId)
                        reviewing = false
                        review.text = "审核"
                        refreshRows()
                        detailsScroll.scrollTo(0, 0)
                    }
                }
                more.addView(label(if (expanded || reviewing) "收起文件" else "查看另外 ${entries.size - 1} 个文件", 11, copyColor), LinearLayout.LayoutParams(WRAP, WRAP))
                more.addView(ImageView(this).apply {
                    setPixelAwareImageResource(iconResource(if (expanded || reviewing) "chevron_up" else "chevron_down"))
                    imageTintList = retroIconTint(copyColor)
                }, LinearLayout.LayoutParams(dp(14), dp(14)).apply { leftMargin = dp(5) })
                footer.addView(more, LinearLayout.LayoutParams(MATCH, WRAP))
            }
        }
        review.setOnClickListener {
            reviewing = !reviewing
            review.text = if (reviewing) "收起审核" else "审核"
            refreshRows()
            detailsScroll.scrollTo(0, 0)
        }
        refreshRows()
        messageList.addView(card, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(3); bottomMargin = dp(4) })
    }

    private fun highlightedReviewDiff(diff: String): SpannableStringBuilder {
        val result = SpannableStringBuilder()
        diff.lineSequence().forEachIndexed { index, line ->
            if (index > 0) result.append('\n')
            val start = result.length
            result.append(line)
            val kind = when {
                line.startsWith("+") && !line.startsWith("+++") -> "added"
                line.startsWith("-") && !line.startsWith("---") -> "deleted"
                line.startsWith("@@") -> "hunk"
                else -> "context"
            }
            val colors = when (kind) {
                "added" -> Pair(if (retroTheme) ANDROID1_ADDED_COLOR else if (lightTheme) Color.rgb(12, 119, 53) else Color.rgb(92, 218, 128), if (lightTheme) Color.rgb(223, 246, 228) else Color.rgb(24, 58, 36))
                "deleted" -> Pair(if (retroTheme) ANDROID1_DELETED_COLOR else if (lightTheme) Color.rgb(184, 35, 47) else Color.rgb(255, 104, 116), if (lightTheme) Color.rgb(252, 226, 229) else Color.rgb(67, 31, 38))
                "hunk" -> Pair(ACCENT, if (lightTheme) Color.rgb(231, 236, 250) else Color.rgb(36, 43, 63))
                else -> null
            }
            if (colors != null && result.length > start) {
                result.setSpan(ForegroundColorSpan(colors.first), start, result.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                result.setSpan(BackgroundColorSpan(colors.second), start, result.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        return result
    }

    private fun renderApproval(approval: JSONObject) {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(9))
            background = rounded(
                if (retroTheme) PANEL_INSET else if (lightTheme) Color.rgb(250, 245, 232) else Color.rgb(43, 37, 27),
                dp(12),
                if (retroTheme) BORDER else if (lightTheme) Color.rgb(224, 205, 163) else Color.rgb(98, 77, 44),
                dp(1),
            )
            tag = TAG_MESSAGE_DYNAMIC
        }
        box.addView(label("需要批准", 13, WARNING, true), widthWrap())
        val params = approval.optJSONObject("params") ?: JSONObject()
        box.addView(label(params.optString("reason").ifBlank { params.optString("command") }.ifBlank { tr("Codex 请求执行一项需要批准的操作。") }, 12, TEXT, translateUi = false).apply {
            setPadding(0, dp(5), 0, dp(7)); setTextIsSelectable(true)
        }, widthWrap())
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END }
        actions.addView(textIconAction("拒绝", "close", "拒绝") { respondApproval("decline") }, LinearLayout.LayoutParams(WRAP, dp(34)).apply { rightMargin = dp(6) })
        actions.addView(textIconAction("允许一次", "check", "允许一次") { respondApproval("accept") }, LinearLayout.LayoutParams(WRAP, dp(34)))
        box.addView(actions, widthWrap())
        messageList.addView(box, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(7); bottomMargin = dp(7) })
    }

    private fun renderQueue() {
        if (!::queuePanel.isInitialized || !::queueContent.isInitialized) return
        if (queueTouchActive) {
            queueRenderDirty = true
            return
        }
        queueRenderDirty = false
        queuePanel.removeAllViews()
        val visibleQueue = (0 until queuedMessages.length()).mapNotNull { queuedMessages.optJSONObject(it) }
            .filter { item ->
                val state = item.optString("deliveryState")
                state != "submitting" && state != "sending"
            }
        val count = visibleQueue.size
        if (count == 0) {
            queuePanel.visibility = View.GONE
            queueContent.visibility = View.GONE
            return
        }
        queuePanel.visibility = View.VISIBLE
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        if (retroTheme) header.addView(ImageView(this).apply {
            setPixelAwareImageResource(iconResource("send"))
            imageTintList = null
            contentDescription = "排队消息"
        }, LinearLayout.LayoutParams(dp(17), dp(17)).apply { rightMargin = dp(6) })
        header.addView(label("排队消息 · $count", 12, SUBTLE, true), LinearLayout.LayoutParams(0, dp(24), 1f))
        header.addView(iconButton(if (queueExpanded) "chevron_up" else "chevron_down", if (queueExpanded) "收起排队消息" else "展开排队消息") {
            queueExpanded = !queueExpanded
            renderQueue()
        }.apply { setPadding(dp(5), dp(5), dp(5), dp(5)) }, LinearLayout.LayoutParams(dp(24), dp(24)))
        queuePanel.addView(header, widthWrap())
        queueContent.removeAllViews()
        queueContent.visibility = if (queueExpanded) View.VISIBLE else View.GONE
        if (!queueExpanded) return
        for (index in 0 until count) {
            val item = visibleQueue[index]
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(if (retroTheme) 10 else 4), dp(if (retroTheme) 8 else 5), dp(if (retroTheme) 10 else 4), dp(if (retroTheme) 8 else 5))
                if (retroTheme) {
                    background = rounded(Color.WHITE, dp(2), BORDER, dp(1))
                    elevation = dp(1).toFloat()
                }
            }
            val text = item.optString("text").ifBlank { item.optString("requestText") }
            card.addView(label("${index + 1}.  ${text.ifBlank { tr("（附件消息）") }}", 12, TEXT, translateUi = false).apply {
                maxLines = 3; ellipsize = android.text.TextUtils.TruncateAt.END; setTextIsSelectable(true)
            }, widthWrap())
            val images = item.optJSONArray("images")
            if (images != null && images.length() > 0) {
                val previews = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
                for (imageIndex in 0 until images.length()) {
                    val image = images.optJSONObject(imageIndex) ?: continue
                    previews.addView(queuedImageThumbnail(image), LinearLayout.LayoutParams(dp(48), dp(48)).apply {
                        rightMargin = dp(5)
                    })
                }
                val imageScroll = HorizontalScrollView(this).apply {
                    isHorizontalScrollBarEnabled = false
                    overScrollMode = View.OVER_SCROLL_NEVER
                    addView(previews, FrameLayout.LayoutParams(WRAP, MATCH))
                }
                card.addView(imageScroll, LinearLayout.LayoutParams(MATCH, dp(48)).apply { topMargin = dp(5) })
            }
            val queueNotice = when {
                item.optBoolean("editing") -> "正在编辑 · 自动发送已暂停，可点铅笔取回编辑"
                item.has("sendAttempt") && !item.isNull("sendAttempt") -> "送达状态待核对，请先查看聊天记录"
                item.optString("blockedReason").isNotBlank() -> item.optString("blockedReason")
                index == 0 && running -> "当前回复结束后自动发送；可点箭头尝试立即发送"
                else -> null
            }
            if (queueNotice != null) card.addView(label(queueNotice, 10, WARNING), LinearLayout.LayoutParams(MATCH, WRAP))
            val claudeQueueItem = item.has("claudeModel") || item.has("claudeEffort") || currentMode == "claude-code"
            val rawModel = item.optString(if (claudeQueueItem) "claudeModel" else "model")
            val rawEffort = item.optString(if (claudeQueueItem) "claudeEffort" else "effort")
            val queuedModel = if (rawModel.isBlank() || rawModel == "default") "默认模型"
                else if (claudeQueueItem) claudeModelLabel(rawModel) else modelLabel(rawModel)
            val queuedEffort = if (rawEffort.isBlank() || rawEffort == "default") "默认"
                else effortLabel(rawEffort)
            val details = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            details.addView(label("模型：$queuedModel  ·  思考：$queuedEffort", 10, MUTED).apply {
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            }, LinearLayout.LayoutParams(0, dp(44), 1f))
            val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END or Gravity.CENTER_VERTICAL }
            controls.addView(iconButton("edit", "修改排队消息") { editQueuedMessage(item) }.apply {
                setPixelAwareImageResource(if (retroTheme) iconResource("edit") else R.drawable.ic_queue_edit)
                setPadding(dp(if (retroTheme) 10 else 12), dp(if (retroTheme) 10 else 12), dp(if (retroTheme) 10 else 12), dp(if (retroTheme) 10 else 12))
                installQueueActionTouchGuard(this)
            }, LinearLayout.LayoutParams(dp(44), dp(44)).apply { rightMargin = dp(8) })
            controls.addView(iconButton("check", "立即发送") { sendQueuedNow(item) }.apply {
                setPixelAwareImageResource(if (retroTheme) iconResource("send") else R.drawable.ic_queue_send)
                imageTintList = retroIconTint(iconTint("send"))
                setPadding(dp(if (retroTheme) 10 else 12), dp(if (retroTheme) 10 else 12), dp(if (retroTheme) 10 else 12), dp(if (retroTheme) 10 else 12))
                installQueueActionTouchGuard(this)
            }, LinearLayout.LayoutParams(dp(44), dp(44)).apply { rightMargin = dp(8) })
            controls.addView(iconButton("delete", "删除排队消息") { removeQueuedMessage(item) }.apply {
                setPixelAwareImageResource(if (retroTheme) iconResource("delete") else R.drawable.ic_queue_delete)
                setPadding(dp(if (retroTheme) 10 else 12), dp(if (retroTheme) 10 else 12), dp(if (retroTheme) 10 else 12), dp(if (retroTheme) 10 else 12))
                installQueueActionTouchGuard(this)
            }, LinearLayout.LayoutParams(dp(44), dp(44)))
            details.addView(controls, LinearLayout.LayoutParams(WRAP, dp(44)))
            card.addView(details, LinearLayout.LayoutParams(MATCH, dp(44)))
            queueContent.addView(card, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(3) })
        }
    }

    private fun installQueueActionTouchGuard(button: View) {
        button.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> queueTouchActive = true
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    queueTouchActive = false
                    if (queueRenderDirty) view.post { renderQueue() }
                }
            }
            false
        }
    }

    private fun withoutDeliveredQueueItems(queue: JSONArray): JSONArray = JSONArray().also { result ->
        val serverIds = mutableSetOf<String>()
        for (index in 0 until queue.length()) {
            val item = queue.optJSONObject(index) ?: continue
            serverIds += item.optString("id")
            if (item.optString("id") !in deliveredQueueIds) result.put(item)
        }
        deliveredQueueIds.retainAll(serverIds)
    }

    private fun queuedImageThumbnail(file: JSONObject): ImageView {
        val encoded = file.optString("data")
        val cacheKey = "attachment:${file.optString("name")}:${encoded.length}:${encoded.take(40).hashCode()}"
        val image = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = rounded(PANEL, dp(8), BORDER, dp(1))
            setPixelAwareImageResource(if (retroTheme) iconResource("image") else android.R.drawable.ic_menu_gallery)
            imageTintList = retroIconTint(MUTED)
            clipToOutline = true
            contentDescription = file.optString("name").ifBlank { "排队图片" }
            tag = cacheKey
        }
        fun display(bitmap: Bitmap) {
            image.imageTintList = null
            image.setImageBitmap(bitmap)
            image.setOnClickListener { showImageDialog(bitmap) }
        }
        messageImageCache.get(cacheKey)?.let { display(it); return image }
        io.execute {
            val bitmap = runCatching {
                decodeSampledBitmap(android.util.Base64.decode(encoded, android.util.Base64.DEFAULT), 160)
            }.getOrNull()
            if (bitmap != null) handler.post {
                messageImageCache.put(cacheKey, bitmap)
                if (image.tag == cacheKey && image.parent != null) display(bitmap)
            }
        }
        return image
    }

    private fun sendCurrentMessage() {
        if (queueEditPending || sendBusy) return
        if (queueEditItem != null) { finishQueueEdit(true); return }
        android.view.inputmethod.BaseInputConnection.removeComposingSpans(composerInput.text)
        val text = composerInput.text.toString().trim()
        if (text.isBlank() && selectedFiles.isEmpty()) return
        val threadId = activeThreadId
        val requestId = UUID.randomUUID().toString()
        val payload = queuedPayload(text, requestId)
        val outgoingFiles = selectedFiles.toList()
        val outgoingScope = draftStorageKey()
        val sendConnection = connectionGeneration
        val sendEndpoint = endpoint
        val sendToken = token
        val sendMode = currentMode
        setSendBusy(true)
        (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(composerInput.windowToken, 0)
        composerInput.setText("")
        selectedFiles.clear()
        draftFilesByScope.remove(outgoingScope)
        renderAttachmentStrip()
        addPendingUserMessage(outgoingScope, payload, outgoingFiles)
        if (threadId == null) {
            io.execute {
                try {
                    val created = RemoteApi(sendEndpoint, sendToken).post("/api/v1/codex/threads", JSONObject()
                        .put("engine", sendMode)
                        .put("request_id", requestId)
                        .putOpt("model", payload.optString(if (sendMode == "codex") "model" else "claudeModel").takeIf { it.isNotBlank() })
                        .putOpt("approval_policy", if (sendMode == "codex") payload.optString("approvalPolicy") else null))
                    handler.post {
                        val createdScope = outgoingScope.removeSuffix("_new") + "_${created.optString("id")}"
                        pendingUserMessages.remove(outgoingScope)?.let { pendingUserMessages[createdScope] = it }
                        if (sendConnection == connectionGeneration) {
                            threads = JSONArray().put(created).also { old ->
                                for (index in 0 until threads.length()) if (threads.optJSONObject(index)?.optString("id") != created.optString("id")) old.put(threads.optJSONObject(index))
                            }
                            if (draftStorageKey() == outgoingScope) selectThread(created)
                        }
                        submitPayload(created.optString("id"), payload, outgoingFiles, createdScope, sendConnection, sendEndpoint, sendToken)
                    }
                } catch (error: Exception) {
                    handler.post {
                        removePendingUserMessage(outgoingScope, requestId)
                        restoreFailedMessage(outgoingScope, text, outgoingFiles)
                        if (sendConnection == connectionGeneration) setSendBusy(false)
                        showStatus(error.message ?: "新建对话失败")
                    }
                }
            }
        } else submitPayload(threadId, payload, outgoingFiles, outgoingScope, sendConnection, sendEndpoint, sendToken)
    }

    private fun restoreFailedMessage(scope: String, text: String, files: List<JSONObject>) {
        val stored = draftFilesByScope[scope]?.toMutableList() ?: mutableListOf()
        stored.addAll(0, files)
        if (stored.isNotEmpty()) draftFilesByScope[scope] = stored
        if (draftStorageKey() == scope && ::composerInput.isInitialized) {
            if (composerInput.text.isBlank()) composerInput.setText(text)
            selectedFiles = stored.toMutableList()
            renderAttachmentStrip()
        } else if (prefs.getString(scope, "").isNullOrBlank()) {
            prefs.edit().putString(scope, text).apply()
        }
    }

    private fun queuedPayload(text: String, id: String, files: List<JSONObject> = selectedFiles): JSONObject {
        val images = JSONArray()
        val documents = JSONArray()
        files.forEach { file ->
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
            .put("text", text)
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

    private fun submitPayload(threadId: String, payload: JSONObject, outgoingFiles: List<JSONObject>,
                              outgoingScope: String, sendConnection: Long, sendEndpoint: String, sendToken: String) {
        if (sendConnection == connectionGeneration) setSendBusy(true)
        io.execute {
            try {
                val response = RemoteApi(sendEndpoint, sendToken).post("/api/v1/codex/queue/${RemoteApi.encodePath(threadId)}/submit", payload)
                handler.post {
                    if (!response.optBoolean("sent", false)) removePendingUserMessage(outgoingScope, payload.optString("id"))
                    else markPendingUserMessageAccepted(outgoingScope, payload.optString("id"))
                    if (sendConnection != connectionGeneration) return@post
                    if (response.optBoolean("sent", false)) deliveredQueueIds += payload.optString("id")
                    if (activeThreadId == threadId) {
                        running = response.optBoolean("sent", false) || running
                        renderHeader()
                        queuedMessages = withoutDeliveredQueueItems(response.optJSONArray("queue") ?: JSONArray())
                        renderQueue()
                        refreshActiveThread(false)
                    }
                    if (response.optBoolean("sent", false)) pausedThreadKeys.remove(threadTitleKey(threadId))
                    setSendBusy(false)
                    refreshThreads(false)
                }
            } catch (error: Exception) {
                handler.post {
                    removePendingUserMessage(outgoingScope, payload.optString("id"))
                    restoreFailedMessage(outgoingScope, payload.optString("text"), outgoingFiles)
                    if (sendConnection == connectionGeneration) {
                        showStatus(error.message ?: "发送失败")
                        setSendBusy(false)
                    }
                }
            }
        }
    }

    private fun setSendBusy(busy: Boolean) {
        sendBusy = busy
        updateSendButton()
    }

    private fun updateSendButton() {
        updateComposerRunningGlow(running)
        if (!::sendButton.isInitialized) return
        val editingQueue = queueEditItem != null
        val hasDraft = ::composerInput.isInitialized && (composerInput.text.isNotBlank() || selectedFiles.isNotEmpty())
        val canContinue = activeThreadId?.let { threadTitleKey(it) in pausedThreadKeys } == true
        sendButton.isEnabled = !sendBusy
        sendButton.setPixelAwareImageResource(if (retroTheme) iconResource(when {
            sendBusy -> "refresh"
            editingQueue -> "check"
            running -> "pause"
            canContinue -> "play"
            else -> "send"
        }) else when {
            sendBusy -> R.drawable.ic_composer_wait
            editingQueue -> R.drawable.ic_composer_confirm
            running -> R.drawable.ic_composer_pause
            canContinue -> R.drawable.ic_composer_continue
            hasDraft -> R.drawable.ic_composer_send
            else -> R.drawable.ic_composer_send
        })
        sendButton.contentDescription = tr(when {
            editingQueue -> "确认修改排队消息"
            running -> "暂停当前回复"
            canContinue -> "继续刚才中断的回复"
            hasDraft -> "发送消息"
            else -> "发送消息"
        })
        sendButton.imageTintList = retroIconTint(if (lightTheme) Color.WHITE else Color.rgb(35, 38, 43))
        sendButton.background = if (retroTheme) lollipopFabBackground(LOLLIPOP_PRIMARY)
            else rounded(if (lightTheme) Color.rgb(35, 38, 43) else Color.rgb(228, 230, 235), dp(17))
    }

    private fun interruptTurn() {
        val threadId = activeThreadId ?: return
        if (sendBusy) return
        val key = threadTitleKey(threadId)
        val api = RemoteApi(endpoint, token)
        setSendBusy(true)
        io.execute {
            try {
                val response = api.post("/api/v1/codex/threads/${RemoteApi.encodePath(threadId)}/interrupt", JSONObject())
                handler.post {
                    if (!response.optBoolean("interrupted", false)) {
                        setSendBusy(false)
                        showStatus("当前回复已经结束，无法暂停")
                        refreshActiveThread(false)
                        return@post
                    }
                    pausedThreadKeys += key
                    if (activeThreadId == threadId && threadTitleKey(threadId) == key) {
                        showStatus("已暂停回复；点继续可从中断处续接")
                        running = false
                        setSendBusy(false)
                        renderHeader()
                        refreshActiveThread(false)
                    } else setSendBusy(false)
                }
            } catch (error: Exception) { handler.post { setSendBusy(false); showStatus(error.message ?: "暂停失败") } }
        }
    }

    private fun continueInterruptedTurn() {
        val threadId = activeThreadId ?: return
        val key = threadTitleKey(threadId)
        if (key !in pausedThreadKeys) return
        val payload = if (threadId.startsWith("claude:")) {
            val text = if (appLanguage == "en")
                "Continue the interrupted reply from where it stopped. Do not repeat earlier content. Keep the conversation's language."
            else "请继续刚才被中断的回复，从停止处接着回答，避免重复已经说过的内容，并保持原对话语言。"
            queuedPayload(text, UUID.randomUUID().toString(), emptyList())
        } else JSONObject()
        val api = RemoteApi(endpoint, token)
        setSendBusy(true)
        io.execute {
            try {
                val response = api.post("/api/v1/codex/threads/${RemoteApi.encodePath(threadId)}/continue", payload)
                handler.post {
                    if (response.optBoolean("continued", false)) pausedThreadKeys.remove(key)
                    setSendBusy(false)
                    if (activeThreadId == threadId && threadTitleKey(threadId) == key) {
                        queuedMessages = response.optJSONArray("queue") ?: JSONArray()
                        running = response.optBoolean("continued", false)
                        renderQueue()
                        renderHeader()
                        refreshActiveThread(false)
                    }
                }
            } catch (error: Exception) {
                handler.post { setSendBusy(false); showStatus(error.message ?: "继续回复失败") }
            }
        }
    }

    private fun stopQueueEditRenewal() {
        queueEditRenewRunnable?.let(handler::removeCallbacks)
        queueEditRenewRunnable = null
    }

    private fun startQueueEditRenewal() {
        stopQueueEditRenewal()
        val itemId = queueEditItem?.optString("id") ?: return
        val threadId = queueEditThreadId ?: return
        val ownerId = queueEditOwnerId ?: return
        val editGeneration = queueEditGeneration
        val api = RemoteApi(endpoint, token)
        val task = object : Runnable {
            override fun run() {
                if (queueEditGeneration != editGeneration || queueEditItem?.optString("id") != itemId || queueEditOwnerId != ownerId) return
                io.execute {
                    runCatching {
                        api.post("/api/v1/codex/queue/${RemoteApi.encodePath(threadId)}/edit/renew", JSONObject()
                            .put("message_id", itemId).put("owner_id", ownerId))
                    }
                    handler.post {
                        if (queueEditGeneration == editGeneration && queueEditItem?.optString("id") == itemId && queueEditOwnerId == ownerId) {
                            handler.postDelayed(this, 60_000L)
                        }
                    }
                }
            }
        }
        queueEditRenewRunnable = task
        handler.postDelayed(task, 60_000L)
    }

    private fun abandonQueueEditForHome() {
        queueEditGeneration++
        stopQueueEditRenewal()
        val itemId = queueEditItem?.optString("id")
        val threadId = queueEditThreadId
        val ownerId = queueEditOwnerId
        if (!itemId.isNullOrBlank() && !threadId.isNullOrBlank() && !ownerId.isNullOrBlank()) {
            val api = RemoteApi(endpoint, token)
            io.execute { runCatching {
                api.post("/api/v1/codex/queue/${RemoteApi.encodePath(threadId)}/edit/end", JSONObject()
                    .put("message_id", itemId).put("owner_id", ownerId))
            } }
        }
        queueEditItem = null
        queueEditThreadId = null
        queueEditOwnerId = null
        queueEditPending = false
        queueEditDraftFiles.clear()
        queueEditPreferences.clear()
    }

    private fun editQueuedMessage(item: JSONObject, recoverEditing: Boolean = false) {
        val threadId = activeThreadId ?: return
        if (queueEditPending) { showStatus("正在处理排队消息，请稍候"); return }
        if (queueEditItem != null) { showStatus("已有一条排队消息在输入框中编辑"); return }
        if (item.optString("deliveryState", "pending") != "pending" || item.has("sendAttempt") && !item.isNull("sendAttempt")) {
            showStatus("这条消息的送达状态待核对，暂不能编辑")
            return
        }
        if (item.optBoolean("editing") && !recoverEditing) {
            showConfirmDialog("取回排队编辑", "这条消息可能正在另一设备编辑。取回后，原编辑页面将无法再保存。", "取回") {
                editQueuedMessage(item, recoverEditing = true)
            }
            return
        }
        val ownerId = "android-${UUID.randomUUID()}"
        val editConnection = connectionGeneration
        val editGeneration = queueEditGeneration
        val editEndpoint = endpoint
        val editToken = token
        queueEditPending = true
        io.execute {
            try {
                val base = "/api/v1/codex/queue/${RemoteApi.encodePath(threadId)}"
                val api = RemoteApi(editEndpoint, editToken)
                if (recoverEditing) api.post("$base/edit/end", JSONObject()
                    .put("message_id", item.optString("id")).put("owner_id", ownerId))
                api.post("$base/edit/begin", JSONObject()
                    .put("message_id", item.optString("id")).put("owner_id", ownerId))
                handler.post {
                    queueEditPending = false
                    if (editConnection != connectionGeneration || editGeneration != queueEditGeneration || activeThreadId != threadId) {
                        io.execute { runCatching { api.post("$base/edit/end", JSONObject()
                            .put("message_id", item.optString("id")).put("owner_id", ownerId)) } }
                        return@post
                    }
                    queueEditItem = shallowCopyObject(item)
                    queueEditThreadId = threadId
                    queueEditOwnerId = ownerId
                    startQueueEditRenewal()
                    queueEditDraft = composerInput.text.toString()
                    queueEditDraftFiles = selectedFiles.toMutableList()
                    queueEditPreferences.clear()
                    listOf("model", "effort", "claudeModel", "claudeEffort", "approvalPolicy", "claudePermissionMode").forEach { key ->
                        queueEditPreferences[key] = item.optString(key).takeIf { it.isNotBlank() }
                    }
                    composerInput.setText(item.optString("text"))
                    selectedFiles.clear()
                    item.optJSONArray("images")?.let { images ->
                        for (index in 0 until images.length()) images.optJSONObject(index)?.let { image ->
                            selectedFiles.add(shallowCopyObject(image).put("kind", "image"))
                        }
                    }
                    item.optJSONArray("documents")?.let { documents ->
                        for (index in 0 until documents.length()) documents.optJSONObject(index)?.let { document ->
                            selectedFiles.add(shallowCopyObject(document).put("kind", "document"))
                        }
                    }
                    composerInput.hint = tr("编辑排队消息…")
                    queueEditBar.visibility = View.VISIBLE
                    renderAttachmentStrip()
                    updateComposerPreferences()
                    setSendBusy(false)
                    renderQueue()
                }
            } catch (error: Exception) { handler.post {
                queueEditPending = false
                showStatus(error.message ?: "无法编辑这条排队消息")
                refreshQueue(false)
            } }
        }
    }

    private fun finishQueueEdit(save: Boolean) {
        val item = queueEditItem ?: return
        val threadId = queueEditThreadId ?: return
        val ownerId = queueEditOwnerId ?: return
        if (queueEditPending || attachRequestActive) return
        val text = composerInput.text.toString().trim()
        if (save && text.isBlank() && selectedFiles.isEmpty()) {
            showStatus("消息内容和附件不能同时为空")
            return
        }
        val updated = if (save) {
            val payload = queuedPayload(text, item.optString("id"))
            shallowCopyObject(item).apply {
                put("text", text)
                put("requestText", payload.optString("requestText"))
                put("images", payload.optJSONArray("images"))
                put("documents", payload.optJSONArray("documents"))
                listOf("model", "effort", "claudeModel", "claudeEffort", "approvalPolicy", "claudePermissionMode").forEach { key ->
                    if (payload.has(key)) put(key, payload.opt(key)) else remove(key)
                }
                remove("editing")
                remove("sendAttempt")
            }
        } else null
        queueEditPending = true
        setSendBusy(true)
        io.execute {
            try {
                val api = RemoteApi(endpoint, token)
                val base = "/api/v1/codex/queue/${RemoteApi.encodePath(threadId)}"
                if (updated != null) api.post("$base/edit/update", updated)
                api.post("$base/edit/end", JSONObject().put("message_id", item.optString("id")).put("owner_id", ownerId))
                handler.post {
                    queueEditPending = false
                    stopQueueEditRenewal()
                    queueEditItem = null
                    queueEditThreadId = null
                    queueEditOwnerId = null
                    queueEditPreferences.clear()
                    composerInput.setText(queueEditDraft)
                    selectedFiles = queueEditDraftFiles
                    queueEditDraftFiles = mutableListOf()
                    composerInput.hint = tr("发送消息…")
                    queueEditBar.visibility = View.GONE
                    renderAttachmentStrip()
                    updateComposerPreferences()
                    setSendBusy(false)
                    refreshQueue(false)
                }
            } catch (error: Exception) { handler.post {
                queueEditPending = false
                setSendBusy(false)
                showStatus(error.message ?: "修改排队消息失败")
                refreshQueue(false)
            } }
        }
    }

    private fun sendQueuedNow(item: JSONObject) {
        if (queueEditPending || queueEditItem != null) {
            showStatus("请先保存或取消正在编辑的排队消息")
            return
        }
        if (item.has("sendAttempt") && !item.isNull("sendAttempt")) {
            showStatus("这条消息可能已经发送，请先核对聊天记录")
            return
        }
        if (item.optBoolean("editing")) {
            showConfirmDialog("结束排队编辑", "这条消息正在编辑。结束旧编辑并按原内容立即发送？", "结束并发送") {
                queueAction("edit/end", item) { queueAction("send-now", item) { refreshActiveThread(false) } }
            }
            return
        }
        queueAction("send-now", item) { refreshActiveThread(false) }
    }

    private fun removeQueuedMessage(item: JSONObject) = queueAction("remove", item) { }

    private fun queueAction(action: String, item: JSONObject, after: () -> Unit) {
        val threadId = activeThreadId ?: return
        val actionConnection = connectionGeneration
        io.execute {
            try {
                val result = RemoteApi(endpoint, token).post("/api/v1/codex/queue/${RemoteApi.encodePath(threadId)}/$action", queueIdBody(item))
                handler.post {
                    if (actionConnection != connectionGeneration || activeThreadId != threadId) return@post
                    queuedMessages = result.optJSONArray("queue") ?: JSONArray()
                    if (action == "send-now" && result.optBoolean("sent", false)) pausedThreadKeys.remove(threadTitleKey(threadId))
                    renderQueue()
                    updateSendButton()
                    if (result.optBoolean("sent", false)) refreshActiveThread(false)
                    if (action == "send-now" && !result.optBoolean("sent", false)) {
                        val first = queuedMessages.optJSONObject(0)
                        showStatus(first?.optString("blockedReason")?.takeIf { it.isNotBlank() }
                            ?: if (running) "当前回复仍在运行，暂未发送；消息保留在队列中" else "暂未确认发送，消息保留在队列中")
                    }
                    if (action != "send-now" || result.optBoolean("sent", false)) after()
                }
            } catch (error: Exception) { handler.post { showStatus(error.message ?: "队列操作失败") } }
        }
    }

    private fun queueIdBody(item: JSONObject) = JSONObject()
        .put("message_id", item.optString("id"))
        .put("owner_id", "android-${UUID.randomUUID()}")

    private fun createThread() {
        if (queueEditPending || queueEditItem != null) { showStatus("请先保存或取消排队消息编辑"); return }
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
        if (queueEditPending || queueEditItem != null) { showStatus("请先保存或取消排队消息编辑"); return }
        val previousMode = currentMode
        val targetMode = if (currentMode == "codex") "claude-code" else "codex"
        if (targetMode == "claude-code" && !claudeAvailable) {
            showToast(claudeStatusMessage)
            return
        }
        persistCurrentDraft()
        activeThreadId?.let { prefs.edit().putString(activeThreadStorageKey(previousMode), it).apply() }
        currentMode = targetMode
        sidebarSelectionMode = false
        selectedSidebarThreadIds.clear()
        prefs.edit().putString(KEY_MODE, currentMode).apply()
        updateSidebarBrand()
        val rememberedId = prefs.getString(activeThreadStorageKey(targetMode), null)?.takeIf { it.isNotBlank() }
        val rememberedThread = rememberedId?.let { id ->
            findThread(id)?.takeIf { it.optString("engine", "codex") == targetMode }
                ?: if (threads.length() == 0) JSONObject().put("id", id).put("engine", targetMode) else null
        }
        activeThreadId = null
        activeThread = null
        queuedMessages = JSONArray()
        historyLoadingThreadId = null
        historyLoadError = null
        historySelectionGeneration += 1
        running = false
        if (::composerInput.isInitialized) composerInput.setText(prefs.getString(draftStorageKey(), ""))
        restoreCurrentDraftFiles()
        if (rememberedThread != null) {
            selectThread(rememberedThread, eagerDiskCache = true)
        } else {
            renderMessages(false)
            renderQueue()
            renderHeader()
            renderSidebar(force = true)
        }
        showModeSwitchNotice(previousMode, currentMode)
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
                displayedThreadTitles[threadTitleKey(thread.optString("id"))] = name
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
                    prefs.edit().remove(activeThreadStorageKey(currentMode)).apply()
                    activeThreadId = null
                    activeThread = null
                    historyLoadingThreadId = null
                    historyLoadError = null
                    historySelectionGeneration += 1
                    queuedMessages = JSONArray()
                    running = false
                    selectedFiles.clear()
                    renderAttachmentStrip()
                    renderMessages(false)
                    renderQueue()
                    renderHeader()
                }
                syncRevisions.remove(id)
                draftFilesByScope.remove(connectionScopedKey("draft_${thread.optString("engine", currentMode)}_$id"))
                pendingUserMessages.remove(connectionScopedKey("draft_${thread.optString("engine", currentMode)}_$id"))
                displayedThreadTitles.remove(threadTitleKey(id))
                pausedThreadKeys.remove(threadTitleKey(id))
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
        modelButton.text = tr(modelLabel)
        effortButton.text = tr(effortLabel(preference(effortKey)))
        permissionButton.text = tr(when (currentMode) {
            "codex" -> approvalLabel(preference("approvalPolicy"))
            else -> claudePermissionLabel(preference("claudePermissionMode"))
        })
    }

    private fun preference(key: String): String? {
        if (queueEditItem != null && queueEditPreferences.containsKey(key)) return queueEditPreferences[key]
        val scope = connectionScopedKey(activeThreadId?.let { "$PREF_THREAD_PREFIX$it" } ?: PREF_DEFAULT)
        val value = prefs.getString("$scope:$key", null)
        return value?.takeIf { it.isNotBlank() && it != "null" }
    }

    private fun draftStorageKey(): String = connectionScopedKey("draft_${currentMode}_${activeThreadId ?: "new"}")

    private fun restoreCurrentDraftFiles() {
        selectedFiles = draftFilesByScope[draftStorageKey()]?.toMutableList() ?: mutableListOf()
        renderAttachmentStrip()
    }

    private fun persistCurrentDraft() {
        if (::composerInput.isInitialized && queueEditItem == null) {
            val scope = draftStorageKey()
            prefs.edit().putString(scope, composerInput.text.toString()).apply()
            if (selectedFiles.isEmpty()) draftFilesByScope.remove(scope)
            else draftFilesByScope[scope] = selectedFiles.toMutableList()
        }
    }

    private fun savePreference(key: String, value: String?) {
        if (queueEditItem != null && key in listOf("model", "effort", "claudeModel", "claudeEffort", "approvalPolicy", "claudePermissionMode")) {
            queueEditPreferences[key] = value
            updateComposerPreferences()
            return
        }
        val scope = connectionScopedKey(activeThreadId?.let { "$PREF_THREAD_PREFIX$it" } ?: PREF_DEFAULT)
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
            } else listOf("minimal" to "Minimal", "low" to "Low", "medium" to "Medium", "high" to "High", "xhigh" to "Extra High")
        } else listOf("default" to "Default", "low" to "Low", "medium" to "Medium", "high" to "High", "xhigh" to "Extra High", "max" to "Max")
        val key = if (currentMode == "codex") "effort" else "claudeEffort"
        showChoicePopup(effortButton, "Reasoning Effort", listOf("default" to "Default") + choices, preference(key) ?: "default") { savePreference(key, it.takeIf { value -> value != "default" }) }
    }

    private fun showPermissionOptions() {
        if (currentMode == "codex") {
            showChoicePopup(permissionButton, "授权", listOf("on-request" to "请求批准", "untrusted" to "帮我批准", "never" to "完全访问"), preference("approvalPolicy") ?: "on-request") {
                savePreference("approvalPolicy", it)
                val threadId = activeThreadId
                if (threadId != null && queueEditItem == null) runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/threads/${RemoteApi.encodePath(threadId)}/settings", JSONObject().put("approval_policy", it)) })
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
                setPixelAwareImageResource(iconResource("check"))
                imageTintList = retroIconTint(ACCENT)
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
                background = if (retroTheme) lollipopRipple() else ColorDrawable(Color.TRANSPARENT)
                isClickable = true
                isFocusable = false
                contentDescription = action.title
                setOnClickListener {
                    preferencePopup?.dismiss()
                    onChoice(index)
                }
            }
            row.addView(ImageView(this).apply {
                setPixelAwareImageResource(iconResource(action.icon))
                imageTintList = retroIconTint(if (action.destructive) ERROR else SUBTLE)
            }, LinearLayout.LayoutParams(dp(17), dp(17)).apply { rightMargin = dp(9) })
            row.addView(label(action.title, 12, if (action.destructive) ERROR else TEXT), LinearLayout.LayoutParams(0, WRAP, 1f))
            menu.addView(row, LinearLayout.LayoutParams(MATCH, dp(38)))
        }
        val popup = PopupWindow(menu, popupWidth, WRAP, true).apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            elevation = dp(12).toFloat()
            animationStyle = R.style.SidebarMenuAnimation
            isOutsideTouchable = true
            isClippingEnabled = true
            setOnDismissListener {
                if (preferencePopup === this) preferencePopup = null
                if (sidebarRenderDirty && sidebarVisible) root.post {
                    if (sidebarRenderDirty && preferencePopup?.isShowing != true) renderSidebar(force = true)
                }
            }
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
            background = rounded(OPAQUE_PANEL, dp(14), BORDER, dp(1))
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
            background = rounded(OPAQUE_PANEL, dp(14), BORDER, dp(1))
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

    private fun showSettings(restoreScrollY: Int = 0) {
        if (settingsOverlay != null) return
        if (sidebarVisible) setSidebarVisible(false)

        val overlay = FrameLayout(this).apply {
            background = if (retroTheme) lollipopSystemBarsBackground(DARK) else wallpaperBackground(DARK)
            elevation = dp(16).toFloat()
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.TRANSPARENT)
            tag = TAG_INSET_CONTENT
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(4), dp(14), dp(4))
            background = if (retroTheme) android1SettingsActionBarBackground() else ColorDrawable(Color.TRANSPARENT)
        }
        header.addView(iconButton("back", "返回聊天") { closeSettings(animated = true) }.apply {
            if (retroTheme) {
                imageTintList = null
                background = android1SegmentButtonBackground()
            }
        }, LinearLayout.LayoutParams(dp(if (retroTheme) 48 else 40), dp(if (retroTheme) 48 else 40)))
        val titleCopy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(8), 0, 0, 0) }
            titleCopy.addView(label("设置", if (retroTheme) 20 else 17, if (pixelTheme) PIXEL_TEXT else if (retroTheme) Color.WHITE else TEXT, true), widthWrap())
        titleCopy.addView(label("偏好保存在本机", if (retroTheme) 12 else 10, if (retroTheme) Color.rgb(205, 211, 209) else MUTED), widthWrap())
        header.addView(titleCopy, LinearLayout.LayoutParams(0, WRAP, 1f))
        layout.addView(header, LinearLayout.LayoutParams(MATCH, dp(if (retroTheme) 48 else 56)))

        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            clipToPadding = false
            setPadding(dp(14), dp(5), dp(14), dp(18))
        }
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(content, LinearLayout.LayoutParams(MATCH, WRAP))
        settingsScroll = scroll
        layout.addView(scroll, LinearLayout.LayoutParams(MATCH, 0, 1f))
        overlay.addView(layout, FrameLayout.LayoutParams(MATCH, MATCH))
        root.addView(overlay, FrameLayout.LayoutParams(MATCH, MATCH))
        settingsOverlay = overlay
        updateInsetAwareOverlays()

        val settingsAccent = if (retroTheme) LOLLIPOP_PRIMARY else ASSISTANT_NAME_ACCENT
        fun section(title: String, description: String): LinearLayout {
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(5), dp(12), dp(5))
                background = if (retroTheme) rounded(PANEL, dp(2), BORDER, dp(1)).also { elevation = 0f }
                else rounded(if (themeName == "custom") colorWithAlpha(OPAQUE_PANEL, .72f) else PANEL, dp(18))
            }
            val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            val expanded = title in expandedSettingsSections
            val heading = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                isClickable = true
                isFocusable = true
                contentDescription = "$title，${if (expanded) "收起" else "展开"}"
            }
            if (retroTheme) {
                heading.addView(ImageView(this).apply {
                    setPixelAwareImageResource(iconResource(settingsSectionIcon(title)))
                    imageTintList = null
                    contentDescription = "$title 设置"
                }, LinearLayout.LayoutParams(dp(22), dp(22)).apply { rightMargin = dp(12) })
            }
            heading.addView(label(title, 14, TEXT, true), LinearLayout.LayoutParams(0, WRAP, 1f))
            val arrow = ImageView(this).apply {
                setPixelAwareImageResource(iconResource(if (expanded) "chevron_up" else "chevron_down"))
                imageTintList = retroIconTint(MUTED)
            }
            heading.addView(arrow, LinearLayout.LayoutParams(dp(18), dp(18)))
            heading.setOnClickListener {
                val open = body.visibility != View.VISIBLE
                body.visibility = if (open) View.VISIBLE else View.GONE
                arrow.setPixelAwareImageResource(iconResource(if (open) "chevron_up" else "chevron_down"))
                heading.contentDescription = "$title，${if (open) "收起" else "展开"}"
                if (open) expandedSettingsSections += title else expandedSettingsSections -= title
            }
            card.addView(heading, LinearLayout.LayoutParams(MATCH, dp(if (retroTheme) 48 else 44)))
            body.addView(label(description, 11, MUTED).apply {
                setPadding(if (retroTheme) dp(34) else 0, 0, 0, dp(7))
            }, widthWrap())
            body.visibility = if (expanded) View.VISIBLE else View.GONE
            card.addView(body, widthWrap())
            content.addView(card, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(8) })
            return body
        }

        val appearance = section("主题", "选择工作区色彩；自定义主题支持背景图片与颜色。")
        listOf(
            Triple("light", "白色", "清爽明亮"),
            Triple("dark", "黑色", "低光阅读"),
            Triple("warm", "暖色", "柔和纸感"),
            Triple("lollipop", "旧经典", "银灰金属与早期 Droid 经典样式"),
            Triple("pixel", "像素风", "深蓝像素面板与独立像素图标"),
            Triple("custom", "自定义主题", "颜色、图片与透明度"),
        ).forEach { (theme, title, description) ->
            val selected = themeName == theme
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(11), dp(8), dp(11), dp(8))
                background = if (retroTheme) lollipopSelectableRow(selected) else if (selected) {
                    rounded(colorWithAlpha(settingsAccent, if (lightTheme) .12f else .18f), dp(10))
                } else rounded(Color.TRANSPARENT, dp(10))
                isClickable = true
                isFocusable = false
                setOnClickListener { applyThemeFromSettings(theme) }
            }
            val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            copy.addView(label(title, 13, TEXT, selected), widthWrap())
            copy.addView(label(description, 10, MUTED), widthWrap())
            row.addView(copy, LinearLayout.LayoutParams(0, WRAP, 1f))
            row.addView(ImageView(this).apply {
                setPixelAwareImageResource(iconResource("check"))
                imageTintList = retroIconTint(settingsAccent)
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
            val transparencyLabel = label("$transparencyValue%", 12, TEXT, true)
            transparencyHeader.addView(transparencyLabel, widthWrap())
            transparencyRow.addView(transparencyHeader, widthWrap())
            transparencyRow.addView(label("数值越高，全局背景图片越透明。", 10, MUTED), widthWrap())
            val transparencySeek = SeekBar(this).apply {
                max = 100
                progress = transparencyValue
                progressTintList = ColorStateList.valueOf(ACCENT)
                thumbTintList = ColorStateList.valueOf(ACCENT)
                progressBackgroundTintList = ColorStateList.valueOf(BORDER)
                contentDescription = "背景透明度"
            }
            transparencySeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar, progress: Int, fromUser: Boolean) {
                    transparencyLabel.text = "$progress%"
                    if (fromUser) {
                        previewBackgroundTransparency = progress
                        updateCustomThemeBackgroundPreview()
                    }
                }
                override fun onStartTrackingTouch(seekBar: SeekBar) = Unit
                override fun onStopTrackingTouch(seekBar: SeekBar) {
                    prefs.edit().putInt(KEY_BACKGROUND_TRANSPARENCY, seekBar.progress).apply()
                    previewBackgroundTransparency = null
                    updateCustomThemeBackgroundPreview()
                }
            })
            transparencyRow.addView(transparencySeek, LinearLayout.LayoutParams(MATCH, dp(38)))
            appearance.addView(transparencyRow, widthWrap())
        }

        val display = section("显示", "字体大小会同时影响聊天、输入框、侧栏、文件区和设置页面。")
        val sizeRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val currentFontAdjustment = globalFontAdjustment()
        val sizeLabel = label(if (currentFontAdjustment == 0) "标准" else "${if (currentFontAdjustment > 0) "+" else ""}${currentFontAdjustment} px", 13, TEXT, true)
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

        val languageSection = section("语言", "选择 APP 界面使用的语言；聊天和文件内容保持原文。")
        listOf("zh" to "简体中文", "en" to "English").forEach { (code, title) ->
            val selected = appLanguage == code
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12), 0, dp(12), 0)
                background = if (retroTheme) lollipopSelectableRow(selected) else rounded(if (selected) colorWithAlpha(settingsAccent, .12f) else Color.TRANSPARENT, dp(9))
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    if (appLanguage != code) {
                        prefs.edit().putString(KEY_APP_LANGUAGE, code).apply()
                        rerenderAppKeepSettings()
                    }
                }
            }
            row.addView(label(title, 13, TEXT, selected), LinearLayout.LayoutParams(0, WRAP, 1f))
            if (selected) row.addView(ImageView(this).apply {
                setPixelAwareImageResource(iconResource("check"))
                imageTintList = retroIconTint(settingsAccent)
                contentDescription = tr("已选择")
            }, LinearLayout.LayoutParams(dp(18), dp(18)))
            languageSection.addView(row, LinearLayout.LayoutParams(MATCH, dp(42)).apply { topMargin = dp(5) })
        }

        val notifications = section("系统通知", "应用在后台时提醒回复完成；通知不包含聊天正文。")
        val notificationRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(2), dp(2), dp(2), dp(2))
            isClickable = true
            isFocusable = false
            setOnClickListener { toggleSystemNotifications() }
        }
        notificationRow.addView(label("回复完成提醒", 12, SUBTLE), LinearLayout.LayoutParams(0, WRAP, 1f))
        settingsNotificationButton = label("", 12, TEXT, true).apply { gravity = Gravity.CENTER; minWidth = dp(72) }
        notificationRow.addView(settingsNotificationButton, LinearLayout.LayoutParams(dp(72), WRAP))
        notifications.addView(notificationRow, LinearLayout.LayoutParams(MATCH, dp(40)))
        refreshSettingsNotificationControl()
        notifications.addView(settingsActionRow("发送测试通知", "检查手机是否允许 APP 显示通知") {
            if (prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)) showSystemNotification(activeThreadId, test = true)
            else showToast("请先开启系统通知")
        }, widthWrap())

        val connection = section("连接", "保存多台电脑，点击即可切换。")
        connection.addView(label(if (runtime.optBoolean("connected", false)) "电脑服务已连接" else "电脑服务等待连接", 12, if (runtime.optBoolean("connected", false)) TEXT else MUTED, true), widthWrap())
        connectionProfiles.toList().forEach { profile ->
            val selected = profile.id == activeConnectionId
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(7), dp(5), dp(2), dp(5))
                background = if (retroTheme) lollipopSelectableRow(selected) else rounded(if (selected) colorWithAlpha(ACCENT, .12f) else Color.TRANSPARENT, dp(10))
            }
            val copy = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                isClickable = true
                contentDescription = if (selected) "当前连接 ${profile.name}" else "切换到 ${profile.name}"
                setOnClickListener { switchConnection(profile.id) }
            }
            copy.addView(label(if (selected) "${profile.name} · ${tr("当前")}" else profile.name, 12, TEXT, selected, translateUi = false), widthWrap())
            copy.addView(label(profile.endpoint, 10, MUTED, translateUi = false).apply {
                maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
            }, widthWrap())
            row.addView(copy, LinearLayout.LayoutParams(0, dp(42), 1f))
            row.addView(iconButton("edit", "重命名 ${profile.name}") { renameConnection(profile.id) }.apply {
                setPadding(dp(8), dp(8), dp(8), dp(8))
            }, LinearLayout.LayoutParams(dp(38), dp(38)))
            row.addView(iconButton("delete", "删除 ${profile.name}") { removeConnection(profile.id) }.apply {
                setPadding(dp(8), dp(8), dp(8), dp(8))
            }, LinearLayout.LayoutParams(dp(38), dp(38)))
            connection.addView(row, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(6) })
        }
        connection.addView(settingsActionRow("添加电脑连接", "输入地址和匹配码") {
            showChangeConnectionDialog()
        }, widthWrap())

        val account = section("本机配对", "管理当前电脑的配对凭据。")
        account.addView(settingsActionRow("解除当前连接配对", "其它已保存的连接仍可切换") {
            showConfirmDialog("解除配对", "解除当前电脑的配对？", "解除", destructive = true) {
                runApi({ RemoteApi(endpoint, token).post("/api/v1/unpair") }, {
                    closeSettings()
                    updateActiveConnectionToken("")
                    socket?.close(1000, "unpaired")
                    showConnectionPage()
                })
            }
        }, widthWrap())
        val about = section("关于", "项目介绍、源代码与更新。")
        about.addView(label("Code Agent Remote", 13, TEXT, true), widthWrap())
        about.addView(label("在手机上连接本机的代码助手，查看对话、文件和终端。", 11, MUTED).apply {
            setPadding(0, dp(4), 0, dp(5))
        }, widthWrap())
        val projectUrl = "https://github.com/sevencnup/wotty-codex-remote"
        about.addView(settingsActionRow("GitHub 项目地址", projectUrl) {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(projectUrl)))
        }, widthWrap())
        about.addView(settingsActionRow("检查更新", "当前版本 ${BuildConfig.VERSION_NAME}") { checkForUpdates() }, widthWrap())
        if (restoreScrollY > 0) scroll.post { scroll.scrollTo(0, restoreScrollY) }
    }

    private fun closeSettings(animated: Boolean = false) {
        val overlay = settingsOverlay ?: return
        if (animated) {
            overlay.isClickable = false
            overlay.animate().alpha(0f).translationX(dp(24).toFloat()).setDuration(190)
                .setInterpolator(DecelerateInterpolator())
                .withEndAction { if (settingsOverlay === overlay) closeSettings() }.start()
            return
        }
        overlay.animate().cancel()
        if (::root.isInitialized) root.removeView(overlay)
        settingsOverlay = null
        settingsScroll = null
        settingsNotificationButton = null
    }

    private fun checkForUpdates() {
        showToast(tr("正在检查更新…"))
        io.execute {
            try {
                val client = socketClient.newBuilder().callTimeout(10, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).build()
                val request = Request.Builder()
                    .url("https://api.github.com/repos/sevencnup/wotty-codex-remote/releases?per_page=30")
                    .header("Accept", "application/vnd.github+json")
                    .header("User-Agent", "CAR-Android/${BuildConfig.VERSION_NAME}")
                    .build()
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
                    val releases = JSONArray(response.body?.string().orEmpty())
                    val candidates = (0 until releases.length()).mapNotNull { releases.optJSONObject(it) }
                        .filter { !it.optBoolean("draft", false) }
                        .mapNotNull { release ->
                            val tag = release.optString("tag_name")
                            if (parseAppVersion(tag) == null) null else tag to release.optString("html_url")
                        }
                    val latest = candidates.maxWithOrNull { a, b -> compareAppVersions(a.first, b.first) }
                    handler.post {
                        if (isFinishing || isDestroyed) return@post
                        when {
                            latest == null -> showToast(tr("尚无公开发布的 Android 版本"))
                            compareAppVersions(latest.first, BuildConfig.VERSION_NAME) <= 0 -> showToast(tr("当前已是最新发布版本"))
                            else -> showConfirmDialog(
                                tr("发现新版本"),
                                tr("发现版本 ${latest.first}。打开发布页面查看安装包？"),
                                tr("查看发布页"),
                            ) {
                                val url = latest.second
                                if (url.startsWith("https://github.com/")) {
                                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                                }
                            }
                        }
                    }
                }
            } catch (error: Exception) {
                handler.post { if (!isFinishing && !isDestroyed) showToast(tr("检查更新失败，请稍后重试")) }
            }
        }
    }

    private fun parseAppVersion(value: String): List<Int>? {
        val match = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-(dev|beta)\\.(\\d+))?$").matchEntire(value) ?: return null
        val stage = when (match.groupValues[4]) { "dev" -> 0; "beta" -> 1; else -> 2 }
        return listOf(match.groupValues[1].toInt(), match.groupValues[2].toInt(), match.groupValues[3].toInt(), stage,
            match.groupValues[5].toIntOrNull() ?: 0)
    }

    private fun compareAppVersions(left: String, right: String): Int {
        val a = parseAppVersion(left) ?: return -1
        val b = parseAppVersion(right) ?: return 1
        for (index in a.indices) {
            val difference = a[index].compareTo(b[index])
            if (difference != 0) return difference
        }
        return 0
    }

    private fun settingsActionRow(title: String, description: String, action: () -> Unit): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(2), dp(7), dp(2), dp(7))
        background = if (retroTheme) lollipopRipple() else ColorDrawable(Color.TRANSPARENT)
        isClickable = true
        isFocusable = false
        setOnClickListener { action() }
        val copy = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
        copy.addView(label(title, 12, SUBTLE, true), widthWrap())
        copy.addView(label(description, 10, MUTED), widthWrap())
        addView(copy, LinearLayout.LayoutParams(0, WRAP, 1f))
        addView(ImageView(this@MainActivity).apply {
            setPixelAwareImageResource(iconResource("chevron_right"))
            imageTintList = retroIconTint(MUTED)
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
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(15), dp(18), dp(12))
            background = rounded(OPAQUE_PANEL, dp(14), BORDER, dp(1))
        }
        card.addView(label(title, 15, TEXT, true), widthWrap())
        val previewRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        previewRow.addView(label("当前颜色", 12, SUBTLE), LinearLayout.LayoutParams(0, WRAP, 1f))
        val preview = View(this).apply {
            background = rounded(runCatching { Color.parseColor(current) }.getOrElse { Color.parseColor(fallback) }, dp(9), BORDER, dp(1))
            contentDescription = "颜色预览"
        }
        previewRow.addView(preview, LinearLayout.LayoutParams(dp(56), dp(28)))
        card.addView(previewRow, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(10) })
        card.addView(input, LinearLayout.LayoutParams(MATCH, dp(46)).apply { topMargin = dp(6) })
        card.addView(label("常用色阶", 12, TEXT, true), LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(10) })
        card.addView(label("点选色卡，或输入 #RRGGBB。", 10, MUTED), LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(3) })

        val paletteColors = listOf(
            "#101114", "#2B2F38", "#4B5563", "#7B8492", "#C9CED6", "#F5F6F8",
            "#142447", "#233B72", "#394B84", "#4B609D", "#7F93D3", "#C7D0FF",
            "#40231C", "#6E4539", "#9F563F", "#CD6643", "#EE8C6D", "#F7C7B7",
            "#163B32", "#276652", "#3F8B6F", "#7CB79B", "#B8D9C8", "#E7F3EC",
            "#271F49", "#483B79", "#6253A0", "#8D7CCC", "#C1B6E6", "#EFEAFA",
        )
        val swatchViews = mutableListOf<Pair<String, View>>()
        fun refreshPalette(selectedValue: String) {
            val selectedHex = selectedValue.trim().uppercase(Locale.ROOT)
            swatchViews.forEach { (hex, swatch) ->
                val selected = hex == selectedHex
                swatch.background = rounded(
                    Color.parseColor(hex), dp(7),
                    if (selected) ASSISTANT_NAME_ACCENT else colorWithAlpha(BORDER, .85f),
                    dp(if (selected) 2 else 1),
                )
                swatch.contentDescription = if (selected) "$hex，已选择" else hex
            }
            val parsed = runCatching { Color.parseColor(selectedValue.trim()) }.getOrNull()
            if (parsed != null) preview.background = rounded(parsed, dp(9), BORDER, dp(1))
        }
        val palette = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        paletteColors.chunked(6).forEach { colors ->
            val paletteRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            colors.forEach { hex ->
                val swatch = View(this).apply {
                    isClickable = true
                    isFocusable = true
                    setOnClickListener {
                        input.setText(hex)
                        input.setSelection(input.text.length)
                    }
                }
                swatchViews += hex to swatch
                paletteRow.addView(swatch, LinearLayout.LayoutParams(0, dp(32), 1f).apply {
                    leftMargin = dp(3)
                    rightMargin = dp(3)
                    bottomMargin = dp(6)
                })
            }
            palette.addView(paletteRow, widthWrap())
        }
        card.addView(palette, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(8) })
        input.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = refreshPalette(s?.toString().orEmpty())
            override fun afterTextChanged(s: android.text.Editable?) = Unit
        })
        refreshPalette(current)

        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END }
        actions.addView(dialogTextButton("取消", MUTED) { dialog.dismiss() }, LinearLayout.LayoutParams(WRAP, dp(38)))
        actions.addView(dialogTextButton("应用", TEXT) {
            val value = input.text.toString().trim()
            if (!Regex("^#[0-9a-fA-F]{6}$").matches(value)) {
                showToast("请输入 #RRGGBB 格式的颜色")
            } else {
                prefs.edit().putString(key, value.uppercase(Locale.ROOT)).apply()
                dialog.dismiss()
                rerenderAppKeepSettings()
            }
        }, LinearLayout.LayoutParams(WRAP, dp(38)).apply { leftMargin = dp(8) })
        card.addView(actions, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(8) })
        dialog.setContentView(card)
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout(min(dp(360), resources.displayMetrics.widthPixels - dp(28)), WRAP)
            setGravity(Gravity.CENTER)
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        }
        input.clearFocus()
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
        val settingsScrollY = settingsScroll?.scrollY ?: 0
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
        applySystemBarTheme()
        renderHome()
        composerInput.setText(draft)
        if (reopenSettings) showSettings(settingsScrollY)
    }

    private fun refreshSettingsNotificationControl() {
        settingsNotificationButton?.apply {
            text = tr(if (prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)) "已开启" else "已关闭")
            setTextColor(if (prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)) TEXT else MUTED)
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
        prefs.edit().putBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, true).apply()
        refreshSettingsNotificationControl()
        showToast("系统通知已开启")
    }

    private fun showConnectionPicker() {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(15), dp(16), dp(12))
            background = rounded(OPAQUE_PANEL, dp(14), BORDER, dp(1))
        }
        card.addView(label("切换电脑连接", 15, TEXT, true), widthWrap())
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        connectionProfiles.toList().forEach { profile ->
            val selected = profile.id == activeConnectionId
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12), dp(7), dp(12), dp(7))
                background = rounded(if (selected) colorWithAlpha(ACCENT, .13f) else PANEL_INSET, dp(9))
                isClickable = true
                isFocusable = true
                contentDescription = if (selected) "当前连接 ${profile.name}" else "切换到 ${profile.name}"
                setOnClickListener {
                    dialog.dismiss()
                    if (!selected) {
                        setSidebarVisible(false)
                        switchConnection(profile.id)
                    }
                }
            }
            row.addView(label(if (selected) "${profile.name} · ${tr("当前")}" else profile.name, 12, if (selected) ACCENT else TEXT, selected, translateUi = false), widthWrap())
            row.addView(label(profile.endpoint, 10, MUTED, translateUi = false).apply {
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
            }, widthWrap())
            list.addView(row, LinearLayout.LayoutParams(MATCH, dp(54)).apply { topMargin = dp(7) })
        }
        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            addView(list)
        }
        val listHeight = min(connectionProfiles.size * dp(61), min(dp(320), resources.displayMetrics.heightPixels / 2))
        card.addView(scroll, LinearLayout.LayoutParams(MATCH, listHeight).apply { topMargin = dp(6) })
        card.addView(settingsActionRow("添加电脑连接", "填写地址和匹配码") {
            dialog.dismiss()
            setSidebarVisible(false)
            showChangeConnectionDialog()
        }, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(9) })
        dialog.setContentView(card)
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout(min(dp(360), resources.displayMetrics.widthPixels - dp(28)), WRAP)
            setGravity(Gravity.CENTER)
        }
    }

    private fun renameConnection(profileId: String) {
        val profile = connectionProfiles.firstOrNull { it.id == profileId } ?: return
        val input = editField("连接名称", profile.name, InputType.TYPE_CLASS_TEXT).apply { setSingleLine(true) }
        showInputDialog("重命名连接", input, "保存") {
            val name = input.text.toString().trim()
            if (name.isBlank()) { showToast("请输入连接名称"); return@showInputDialog false }
            val index = connectionProfiles.indexOfFirst { it.id == profileId }
            if (index >= 0) {
                connectionProfiles[index] = connectionProfiles[index].copy(name = name)
                persistConnectionProfiles()
                val scrollY = settingsScroll?.scrollY ?: 0
                closeSettings()
                showSettings(scrollY)
            }
            true
        }
    }

    private fun removeConnection(profileId: String) {
        if (queueEditPending || queueEditItem != null) { showStatus("请先结束排队消息编辑"); return }
        val profile = connectionProfiles.firstOrNull { it.id == profileId } ?: return
        showConfirmDialog("删除连接", "从本机删除“${profile.name}”的连接配置？", "删除", destructive = true) {
            connectionProfiles.removeAll { it.id == profileId }
            draftFilesByScope.keys.removeAll { it.startsWith("${profileId}_draft_") }
            if (profileId == activeConnectionId) {
                val next = connectionProfiles.firstOrNull { it.token.isNotBlank() } ?: connectionProfiles.firstOrNull()
                if (next != null) switchConnection(next.id)
                else {
                    persistCurrentDraft()
                    connectionGeneration++
                    activeConnectionId = ""
                    endpoint = ""
                    token = ""
                    persistConnectionProfiles()
                    closeSettings()
                    socket?.close(1000, "connection removed")
                    socket = null
                    showConnectionPage()
                }
            } else {
                persistConnectionProfiles()
                val scrollY = settingsScroll?.scrollY ?: 0
                closeSettings()
                showSettings(scrollY)
            }
        }
    }

    private fun showChangeConnectionDialog() {
        if (queueEditPending || queueEditItem != null) { showStatus("请先结束排队消息编辑"); return }
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(11), 0, 0)
        }
        val name = editField("连接名称（可选）", "", InputType.TYPE_CLASS_TEXT).apply { setSingleLine(true) }
        val address = editField("电脑 IP 或网页地址", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI).apply { setSingleLine(true) }
        val code = editField("电脑终端显示的匹配码", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD).apply { setSingleLine(true) }
        form.addView(label("连接名称", 11, SUBTLE, true), widthWrap())
        form.addView(name, LinearLayout.LayoutParams(MATCH, dp(48)).apply { topMargin = dp(4); bottomMargin = dp(12) })
        form.addView(label("电脑网页地址 · 只填 IP 时默认使用 4173 端口", 11, SUBTLE, true), widthWrap())
        form.addView(address, LinearLayout.LayoutParams(MATCH, dp(48)).apply { topMargin = dp(4); bottomMargin = dp(12) })
        form.addView(label("匹配码", 11, SUBTLE, true), widthWrap())
        form.addView(code, LinearLayout.LayoutParams(MATCH, dp(48)).apply { topMargin = dp(4) })
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(15), dp(18), dp(12))
            background = rounded(OPAQUE_PANEL, dp(14), BORDER, dp(1))
        }
        card.addView(label("添加电脑连接", 15, TEXT, true), widthWrap())
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
                            val scrollY = settingsScroll?.scrollY
                            dialog.dismiss()
                            switchConnection(saveConnectionProfile(normalized, newToken, name.text.toString()), scrollY)
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
        if (endpoint.isBlank() || token.isBlank()) {
            showConnectionPage("当前连接没有有效的配对信息，请重新配对。")
            return
        }
        val savedEndpoint = endpoint
        val savedToken = token
        val generation = connectionGeneration
        socket?.cancel()
        socket = null
        socketConnected = false
        outstandingSocketPing = null
        handler.removeCallbacks(socketHeartbeatRunnable)
        handler.removeCallbacks(refreshRunnable)
        renderHeader()
        showStatus("正在使用已保存的连接信息重新连接…")
        io.execute {
            try {
                val refreshedRuntime = RemoteApi(savedEndpoint, savedToken).get("/api/v1/codex/status")
                handler.post {
                    if (generation != connectionGeneration || savedToken != token) return@post
                    runtime = refreshedRuntime
                    renderHeader()
                    connectSocket()
                    refreshThreads(true)
                    refreshPins()
                    refreshClaudeStatus()
                    refreshModels()
                    if (activeThreadId != null) {
                        refreshActiveThread(false)
                        refreshQueue(false)
                    }
                    handler.postDelayed(refreshRunnable, 15_000L)
                }
            } catch (error: Exception) {
                handler.post {
                    if (generation != connectionGeneration || savedToken != token) return@post
                    if (error is RemoteApiException && error.statusCode == 401) {
                        updateActiveConnectionToken("")
                        showConnectionPage(error.message ?: "配对已失效，请重新输入匹配码。")
                    } else {
                        showStatus("电脑服务暂时无法连接，已保留配对信息，正在自动重试。")
                        connectSocket()
                        refreshThreads(false)
                        if (activeThreadId != null) {
                            refreshActiveThread(false)
                            refreshQueue(false)
                        }
                        handler.postDelayed(refreshRunnable, 15_000L)
                    }
                }
            }
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
        var manualRoot = prefs.getString(connectionScopedKey(KEY_WORKSPACE_EXPLORER_ROOT), null)?.takeIf { it.isNotBlank() }
        val expandedDirectories = linkedSetOf<String>()
        val directoryChildren = linkedMapOf<String, JSONArray>()
        val directoryTruncated = mutableSetOf<String>()
        val directoryErrors = mutableMapOf<String, String>()
        val loadingDirectories = mutableSetOf<String>()
        var loadedWorkspaceKey: String? = null
        lateinit var renderTree: () -> Unit
        lateinit var dispatchRender: () -> Unit
        lateinit var loadDirectory: (String, Boolean) -> Unit
        lateinit var addDirectoryRows: (String, Int) -> Unit
        lateinit var rootInput: EditText

        fun currentCwd(): String? = activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" }
        fun browsingCwd(): String? = manualRoot ?: currentCwd()
            ?: runtime.optString("workspace").takeIf { it.isNotBlank() && it != "null" }
        fun workspaceKey(): String = browsingCwd() ?: "<default>"
        fun absolutePath(relativePath: String): String = listOf(workspaceRootPath.trimEnd('/'), relativePath.trimStart('/'))
            .filter { it.isNotBlank() }.joinToString("/")
        fun parentDirectory(value: String): String {
            val drive = Regex("^([a-zA-Z]:)[/\\\\]*(.*)$").matchEntire(value)
            val separator = if (value.contains('\\') && !value.contains('/')) '\\' else '/'
            if (drive != null) {
                val segments = drive.groupValues[2].split(Regex("[/\\\\]+"))
                    .filter { it.isNotBlank() }.toMutableList()
                if (segments.isEmpty()) return "${drive.groupValues[1]}$separator"
                segments.removeAt(segments.lastIndex)
                return "${drive.groupValues[1]}$separator${segments.joinToString(separator.toString())}"
            }
            val normalized = value.replace(Regex("[/\\\\]+$"), "")
            if (normalized.isBlank()) return if (value.startsWith('\\')) "\\" else "/"
            val lastSeparator = maxOf(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
            if (lastSeparator < 0) return value
            if (lastSeparator == 0) return normalized.substring(0, 1)
            return normalized.substring(0, lastSeparator)
        }
        fun selectWorkspaceRoot(rawRoot: String?) {
            val nextRoot = rawRoot?.trim()?.takeIf { it.isNotBlank() }
            if (nextRoot == null) {
                showToast("请输入目录路径")
                return
            }
            (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)
                ?.hideSoftInputFromWindow(rootInput.windowToken, 0)
            manualRoot = nextRoot
            prefs.edit().putString(connectionScopedKey(KEY_WORKSPACE_EXPLORER_ROOT), nextRoot).apply()
            rootInput.setText(nextRoot)
            workspaceRootPath = ""
            workspaceCurrentPath = ""
            expandedDirectories.clear()
            workspaceClipboard.clear()
            workspaceClipboardMode = "copy"
            workspaceLoadedPath = null
            loadDirectory("*", false)
        }
        fun followChatWorkspaceRoot() {
            (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)
                ?.hideSoftInputFromWindow(rootInput.windowToken, 0)
            manualRoot = null
            prefs.edit().remove(connectionScopedKey(KEY_WORKSPACE_EXPLORER_ROOT)).apply()
            rootInput.setText((currentCwd() ?: runtime.optString("workspace")).takeUnless { it == "null" }.orEmpty())
            workspaceRootPath = ""
            workspaceCurrentPath = ""
            expandedDirectories.clear()
            workspaceClipboard.clear()
            workspaceClipboardMode = "copy"
            workspaceLoadedPath = null
            loadDirectory("*", false)
        }
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        val host = createEdgeDrawer(panel, Gravity.END) { setWorkspaceVisible(false) }
        val overlay = host.overlay
        val scrim = host.scrim

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), 0, dp(4), 0)
            if (retroTheme) background = lollipopActionBarBackground()
        }
        val pathTitle = label("文件", if (retroTheme) 18 else 14, if (retroTheme) ANDROID1_TITLE_TEXT else TEXT, true).apply {
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        }
        header.addView(pathTitle, LinearLayout.LayoutParams(0, dp(if (retroTheme) 42 else 48), 1f))
        val refreshButton = sidebarIconButton("refresh", "刷新文件树") { workspaceRefresher?.invoke(workspaceCurrentPath) }
        if (retroTheme) {
            refreshButton.imageTintList = null
            refreshButton.background = android1SegmentButtonBackground()
        }
        header.addView(refreshButton, LinearLayout.LayoutParams(dp(if (retroTheme) 40 else 32), dp(if (retroTheme) 40 else 32)))
        val createButton = sidebarIconButton("add", "新建文件或文件夹") { }
        createButton.setOnClickListener {
            showCreateEntry(createButton, workspaceCurrentPath, browsingCwd()) {
                workspaceRefresher?.invoke(workspaceCurrentPath)
            }
        }
        if (retroTheme) {
            createButton.imageTintList = null
            createButton.background = android1SegmentButtonBackground()
        }
        header.addView(createButton, LinearLayout.LayoutParams(dp(if (retroTheme) 40 else 32), dp(if (retroTheme) 40 else 32)))
        panel.addView(header, LinearLayout.LayoutParams(MATCH, if (retroTheme) dp(42) else WRAP))

        val pathNavigation = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        rootInput = editField("输入服务端目录路径", manualRoot ?: currentCwd() ?: runtime.optString("workspace"), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS).apply {
            setSingleLine(true)
            textSize = adjustedTextSize(11)
            setTag(R.id.base_text_size, 11f)
            imeOptions = EditorInfo.IME_ACTION_GO
            setPadding(dp(8), 0, dp(7), 0)
            setOnEditorActionListener { _, action, _ ->
                if (action == EditorInfo.IME_ACTION_GO) { selectWorkspaceRoot(text.toString()); true } else false
            }
        }
        pathNavigation.addView(rootInput, LinearLayout.LayoutParams(0, dp(34), 1f).apply { rightMargin = dp(4) })
        pathNavigation.addView(textIconAction("打开", "open", "打开") {
            selectWorkspaceRoot(rootInput.text.toString())
        }, LinearLayout.LayoutParams(WRAP, dp(30)))
        panel.addView(pathNavigation, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(2) })

        val parentButton = textIconAction("上级", "arrow_up", "↑ 上级") {
            val currentRoot = workspaceRootPath.ifBlank { browsingCwd().orEmpty() }
            val parent = parentDirectory(currentRoot)
            if (currentRoot.isNotBlank() && parent != currentRoot) selectWorkspaceRoot(parent)
        }
        val followChatButton = textIconAction("跟随聊天", "chat", "↻ 跟随聊天") { followChatWorkspaceRoot() }
        val rootActions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(parentButton, LinearLayout.LayoutParams(WRAP, dp(30)))
            addView(View(this@MainActivity), LinearLayout.LayoutParams(0, 1, 1f))
            addView(followChatButton, LinearLayout.LayoutParams(WRAP, dp(30)))
        }
        panel.addView(rootActions, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(2) })

        val entries = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            addView(entries)
        }
        panel.addView(scroll, LinearLayout.LayoutParams(MATCH, 0, 1f).apply { topMargin = dp(3); bottomMargin = dp(3) })
        val footer = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        footer.addView(label("点按文件夹展开 · 长按查看更多操作", 10, MUTED), LinearLayout.LayoutParams(0, WRAP, 1f))
        footer.addView(textIconAction("粘贴", "paste", "粘贴") {
            pasteWorkspaceEntries(workspaceCurrentPath, browsingCwd()) { workspaceRefresher?.invoke(workspaceCurrentPath) }
        })
        panel.addView(footer, widthWrap())

        workspaceOverlay = overlay
        workspacePanel = panel
        workspaceScrim = scrim
        workspaceHost = host
        updateInsetAwareOverlays()

        dispatchRender = {
            if (workspaceGestureActive || workspaceAnimator?.isRunning == true) workspacePendingRender = renderTree
            else renderTree()
        }

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
                    background = if (retroTheme) lollipopRipple() else rounded(Color.TRANSPARENT, dp(7))
                }
                if (isDirectory) {
                    row.addView(ImageView(this).apply {
                        setPixelAwareImageResource(iconResource(if (relativePath in expandedDirectories) "chevron_down" else "chevron_right"))
                        imageTintList = retroIconTint(MUTED)
                        contentDescription = if (relativePath in expandedDirectories) "已展开" else "已收起"
                    }, LinearLayout.LayoutParams(dp(14), dp(14)).apply { rightMargin = dp(3) })
                } else {
                    row.addView(View(this), LinearLayout.LayoutParams(dp(17), dp(1)))
                }
                row.addView(ImageView(this).apply {
                    val fileIcon = fileDisplayIconResource(entry.optString("name"))
                    setPixelAwareImageResource(if (isDirectory) iconResource("folder") else fileIcon)
                    imageTintList = if (isDirectory && !retroTheme) ColorStateList.valueOf(ACCENT) else null
                    contentDescription = if (isDirectory) "文件夹" else fileGlyph(entry.optString("name"))
                }, LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(7) })
                row.addView(label(entry.optString("name"), 13, TEXT, translateUi = false).apply {
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                }, LinearLayout.LayoutParams(0, WRAP, 1f))
                if (!isDirectory) row.addView(
                    label(formatFileSize(entry.optLong("size")), 9, MUTED),
                    LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = dp(4) },
                )
                val fullPath = absolutePath(relativePath)
                if (fullPath.isNotBlank() && !composerInput.text.toString().contains(fullPath)) {
                    row.addView(sidebarIconButton("add", "加入输入框 ${entry.optString("name")}") {
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
                    } else showFilePreview(relativePath, browsingCwd())
                }
                row.setOnLongClickListener {
                    showWorkspaceEntryActions(row, entry, browsingCwd()) { changedDirectory ->
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
            val displayedRoot = workspaceRootPath.ifBlank { browsingCwd().orEmpty() }
            pathTitle.text = displayedRoot.ifBlank { "工作区" }
            if (currentPath.isNotBlank()) pathTitle.text = "$currentPath · ${pathTitle.text}"
            if (!rootInput.hasFocus()) rootInput.setText(displayedRoot)
            parentButton.isEnabled = displayedRoot.isNotBlank() && parentDirectory(displayedRoot) != displayedRoot
            parentButton.alpha = if (parentButton.isEnabled) 1f else .45f
            followChatButton.isEnabled = manualRoot != null
            followChatButton.alpha = if (followChatButton.isEnabled) 1f else .45f
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
            val cwd = browsingCwd()
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

    private fun showCreateEntry(anchor: View, parentPath: String, cwd: String?, refresh: () -> Unit) {
        showActionPopup(anchor, "新建", listOf(MenuAction("新建文件", "file_add"), MenuAction("新建文件夹", "folder_add"))) { index ->
            val kind = if (index == 0) "file" else "directory"
            showCreateWorkspaceEntryDialog(kind, parentPath, cwd, refresh)
        }
    }

    private fun showCreateWorkspaceEntryDialog(kind: String, parentPath: String, cwd: String?, refresh: () -> Unit) {
        val input = editField("名称", "", InputType.TYPE_CLASS_TEXT).apply { setSingleLine(true) }
        showInputDialog(if (kind == "file") "新建文件" else "新建文件夹", input, "创建") {
            val name = input.text.toString().trim()
            if (name.isBlank()) return@showInputDialog false
            val path = listOf(parentPath.trim('/'), name).filter { it.isNotBlank() }.joinToString("/")
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
                "新建文件" -> showCreateWorkspaceEntryDialog("file", path, cwd) { refreshed(path) }
                "新建文件夹" -> showCreateWorkspaceEntryDialog("directory", path, cwd) { refreshed(path) }
                "重命名" -> {
                    val input = editField("名称", entry.optString("name"), InputType.TYPE_CLASS_TEXT).apply { setSingleLine(true) }
                    showInputDialog("重命名", input, "确定") {
                        if (input.text.toString().trim().isBlank()) return@showInputDialog false
                        runApi({ RemoteApi(endpoint, token).patch("/api/v1/codex/workspace/entry", JSONObject().put("path", path).put("name", input.text.toString().trim()).putOpt("cwd", cwd)) }, { refreshed(parentPath) })
                        true
                    }
                }
                "复制", "剪切" -> { workspaceClipboard.clear(); workspaceClipboard += path; workspaceClipboardMode = if (actions[which].title == "复制") "copy" else "move"; showToast(if (workspaceClipboardMode == "copy") "已复制" else "已剪切") }
                "粘贴到此处" -> pasteWorkspaceEntries(path, cwd) { refreshed("*") }
                "删除" -> showConfirmDialog("删除所选内容", "永久删除 ${entry.optString("name")}？非空文件夹也会一并删除，此操作无法恢复。", "删除", destructive = true) {
                    runApi({ RemoteApi(endpoint, token).post("/api/v1/codex/workspace/delete", JSONObject().put("paths", JSONArray().put(path)).putOpt("cwd", cwd)) }, { refreshed(parentPath) })
                }
            }
        }
    }

    private fun pasteWorkspaceEntries(destination: String, cwd: String?, refreshed: () -> Unit) {
        if (workspaceClipboard.isEmpty()) { showToast("剪贴板为空"); return }
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
        val stringColor = if (retroTheme) Color.rgb(139, 157, 125) else if (lightTheme) Color.rgb(20, 118, 91) else Color.rgb(126, 211, 176)
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
            setPadding(if (retroTheme) 0 else dp(10), if (retroTheme) 0 else dp(8), if (retroTheme) 0 else dp(10), dp(8))
            background = rounded(OPAQUE_PANEL, dp(14), BORDER, dp(1))
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            if (retroTheme) {
                setPadding(dp(12), 0, dp(4), 0)
                background = lollipopActionBarBackground()
            }
        }
        header.addView(ImageView(this).apply {
            setImageResource(fileDisplayIconResource(entry.path))
            imageTintList = null
            contentDescription = fileGlyph(entry.path)
        }, LinearLayout.LayoutParams(dp(20), dp(20)).apply { rightMargin = dp(8) })
        header.addView(label(entry.path.substringAfterLast('/'), if (retroTheme) 17 else 13, if (retroTheme) ANDROID1_TITLE_TEXT else TEXT, true, translateUi = false).apply {
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        }, LinearLayout.LayoutParams(0, dp(34), 1f))
        if (entry.additions > 0) header.addView(label("+${entry.additions}", 11, if (retroTheme) ANDROID1_ADDED_COLOR else if (lightTheme) Color.rgb(12, 119, 53) else Color.rgb(92, 218, 128), true))
        if (entry.deletions > 0) header.addView(label("-${entry.deletions}", 11, if (retroTheme) ANDROID1_DELETED_COLOR else if (lightTheme) Color.rgb(184, 35, 47) else Color.rgb(255, 104, 116), true).apply { setPadding(dp(7), 0, dp(3), 0) })
        header.addView(iconButton("close", "关闭修改预览") { dialog.dismiss() }.apply {
            if (retroTheme) {
                imageTintList = null
                background = android1SegmentButtonBackground()
            }
        }, LinearLayout.LayoutParams(dp(if (retroTheme) 48 else 32), dp(if (retroTheme) 48 else 32)))
        layout.addView(header, LinearLayout.LayoutParams(MATCH, if (retroTheme) dp(48) else WRAP))

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
            val codeView = label("", 11, TEXT, pixelize = false).apply {
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
        parkActivityInputFocus()
        val effectiveCwd = cwd?.takeIf { it.isNotBlank() && it != "null" }
            ?: activeThread?.optString("cwd")?.takeIf { it.isNotBlank() && it != "null" }
            ?: runtime.optString("workspace").takeIf { it.isNotBlank() && it != "null" }
        val requestPath = workspaceRelativePath(effectiveCwd, path)
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            isFocusableInTouchMode = true
            setPadding(if (retroTheme) 0 else dp(12), if (retroTheme) 0 else dp(9), if (retroTheme) 0 else dp(12), dp(10))
            background = rounded(OPAQUE_PANEL, dp(14), BORDER, dp(1))
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
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            if (retroTheme) {
                setPadding(dp(12), 0, dp(4), 0)
                background = lollipopActionBarBackground()
            }
        }
        header.addView(ImageView(this).apply {
            setImageResource(fileDisplayIconResource(path))
            imageTintList = null
            contentDescription = fileGlyph(path)
        }, LinearLayout.LayoutParams(dp(20), dp(20)).apply { rightMargin = dp(8) })
        header.addView(label(path.substringAfterLast('/'), if (retroTheme) 17 else 13, if (retroTheme) ANDROID1_TITLE_TEXT else TEXT, true, translateUi = false).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE }, LinearLayout.LayoutParams(0, dp(48), 1f))
        val saveButton = textIconAction("保存", "save", "保存") { savePreviewFile(requestPath, effectiveCwd, previewInput.text.toString(), previewInput.tag?.toString().orEmpty(), previewInput) }.apply {
            visibility = View.GONE
        }
        header.addView(saveButton)
        header.addView(iconButton("close", "关闭文件预览") { dialog.dismiss() }.apply {
            if (retroTheme) {
                imageTintList = null
                background = android1SegmentButtonBackground()
            }
        }, LinearLayout.LayoutParams(dp(if (retroTheme) 48 else 32), dp(if (retroTheme) 48 else 32)))
        layout.addView(header, LinearLayout.LayoutParams(MATCH, if (retroTheme) dp(48) else WRAP))
        val loadingStatus = label("正在加载文件…", 12, MUTED).apply {
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(80), dp(12), dp(18))
        }
        val retryButton = textIconAction("重新加载", "refresh", "重新加载") { }.apply { visibility = View.GONE }
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
        layout.requestFocus()
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
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
            setPadding(if (retroTheme) 0 else dp(10), 0, if (retroTheme) 0 else dp(10), dp(8))
            background = wallpaperBackground(
                if (themeName == "custom") OPAQUE_PANEL else if (lightTheme) Color.rgb(250, 250, 251) else Color.rgb(12, 14, 17),
                viewportWidthPx = root.width,
                viewportHeightPx = root.height,
            )
            elevation = dp(18).toFloat()
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, systemInsetTop, 0, 0)
            if (retroTheme) background = lollipopActionBarBackground()
        }
        header.addView(ImageView(this).apply {
            setPixelAwareImageResource(iconResource("terminal"))
            imageTintList = retroIconTint(SUBTLE)
            contentDescription = "本机终端"
        }, LinearLayout.LayoutParams(dp(if (retroTheme) 22 else 18), dp(if (retroTheme) 22 else 18)).apply { rightMargin = dp(7) })
        header.addView(label("本机终端", if (retroTheme) 18 else 13, if (retroTheme) ANDROID1_TITLE_TEXT else TEXT, true), LinearLayout.LayoutParams(0, dp(48), 1f))
        header.addView(iconButton("close", "关闭终端") { closeTerminal() }.apply {
            if (retroTheme) {
                imageTintList = null
                background = android1SegmentButtonBackground()
            }
        }, LinearLayout.LayoutParams(dp(if (retroTheme) 48 else 40), dp(if (retroTheme) 48 else 40)))
        header.addView(View(this), LinearLayout.LayoutParams(dp(40), dp(1)))
        shell.addView(header, LinearLayout.LayoutParams(MATCH, systemInsetTop + dp(if (retroTheme) 48 else 44)))
        terminalStatusView = label("正在连接终端…", 10, MUTED).apply {
            setPadding(dp(3), 0, dp(3), dp(4))
        }
        shell.addView(terminalStatusView, widthWrap())
        terminalOutput = label("", 12, if (lightTheme) SUBTLE else Color.rgb(207, 214, 226), pixelize = false).apply {
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
        inputRow.addView(textIconAction("发送", "arrow_up", "发送") { sendTerminalLine() }, LinearLayout.LayoutParams(WRAP, dp(38)).apply { leftMargin = dp(5) })
        shell.addView(inputRow, LinearLayout.LayoutParams(MATCH, dp(44)).apply { topMargin = dp(5) })
        val transferRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END or Gravity.CENTER_VERTICAL }
        transferRow.addView(textIconAction("复制到输入框", "paste", "复制到输入框") {
            val output = terminalOutput ?: return@textIconAction
            val fullText = output.text.toString()
            val start = output.selectionStart
            val end = output.selectionEnd
            val value = if (start >= 0 && end > start && end <= fullText.length) fullText.substring(start, end) else fullText
            if (value.isNotBlank()) {
                composerInput.append(value.takeLast(120_000))
                closeTerminal()
            }
        }, LinearLayout.LayoutParams(WRAP, dp(36)))
        shell.addView(transferRow, LinearLayout.LayoutParams(MATCH, dp(38)))
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
            val target = systemInsetTop + dp(if (retroTheme) 48 else 44)
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
                            updateTerminalStatus("${event.optString("shell")} · ${event.optString("cwd")}", if (retroTheme) ANDROID1_ADDED_COLOR else if (lightTheme) Color.rgb(44, 126, 70) else Color.rgb(119, 174, 132))
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
        (output.parent as? ScrollView)?.let { scroll ->
            scroll.post { scroll.scrollTo(0, output.height) }
        }
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

    private fun fileDisplayIconResource(path: String): Int = fileIconResource(path)

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
        attachmentPickerScope = draftStorageKey()
        restoreImeAfterAttachment = imeInsetVisible && ::composerInput.isInitialized && composerInput.hasFocus()
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try { startActivityForResult(intent, REQUEST_ATTACH) } catch (_: Exception) {
            attachmentPickerScope = null
            restoreImeAfterAttachment = false
            showToast("没有可用的文件选择器")
        }
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
        if (requestCode != REQUEST_ATTACH) return
        val pickerScope = attachmentPickerScope ?: draftStorageKey()
        attachmentPickerScope = null
        val restoreKeyboard = restoreImeAfterAttachment
        restoreImeAfterAttachment = false
        if (restoreKeyboard && ::composerInput.isInitialized) composerInput.postDelayed({
            if (!isFinishing && !isDestroyed && settingsOverlay == null && !sidebarVisible && draftStorageKey() == pickerScope) {
                composerInput.requestFocus()
                (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)
                    ?.showSoftInput(composerInput, InputMethodManager.SHOW_IMPLICIT)
            }
        }, 120)
        if (resultCode != RESULT_OK || data == null) return
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris += clip.getItemAt(i).uri }
        if (uris.isEmpty()) data.data?.let(uris::add)
        processAttachments(uris, pickerScope)
    }

    private fun processAttachments(uris: List<Uri>, scope: String) {
        if (uris.isEmpty()) return
        attachRequestActive = true
        io.execute {
            try {
                val result = uris.map { readAttachment(it) }
                handler.post {
                    if (draftStorageKey() == scope) {
                        selectedFiles.addAll(result)
                        renderAttachmentStrip()
                    }
                    val stored = draftFilesByScope[scope]?.toMutableList() ?: mutableListOf()
                    stored.addAll(result)
                    draftFilesByScope[scope] = stored
                    attachRequestActive = false
                }
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

    private fun scheduleSocketReconnect() {
        val generation = connectionGeneration
        val delay = if (foreground) 1_200L else 5_000L
        if (!foreground && !prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)) return
        handler.postDelayed({
            if (generation == connectionGeneration && token.isNotBlank() &&
                (foreground || prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false))) connectSocket()
        }, delay)
    }

    private fun connectSocket() {
        if (token.isBlank() || socket != null) return
        val generation = connectionGeneration
        val socketToken = token
        val url = endpoint.replaceFirst(Regex("^http"), "ws") + "/api/v1/codex/ws"
        val request = Request.Builder().url(url).build()
        socket = socketClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (socket !== webSocket || generation != connectionGeneration) { webSocket.close(1000, "connection changed"); return }
                socketConnected = true
                outstandingSocketPing = null
                lastSocketActivityAt = System.currentTimeMillis()
                webSocket.send(JSONObject().put("type", "codex.client.hello").put("protocol_version", 1)
                    .put("token", socketToken).put("thread_id", activeThreadId).toString())
                handler.post {
                    handler.removeCallbacks(socketHeartbeatRunnable)
                    handler.postDelayed(socketHeartbeatRunnable, 20_000)
                    renderHeader()
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (socket !== webSocket || generation != connectionGeneration) return
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
                        scheduleSocketReconnect()
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (socket === webSocket) {
                    socketConnected = false
                    socket = null
                    outstandingSocketPing = null
                    handler.removeCallbacks(socketHeartbeatRunnable)
                    handler.post { renderHeader(); scheduleSocketReconnect() }
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
            "threads.changed" -> {
                if (foreground) handler.post { refreshThreads(false) }
                else backgroundListDirty = true
            }
            "remote.queue.changed" -> {
                if (event.optString("threadId") == activeThreadId) {
                    if (foreground) handler.post { refreshQueue(false) }
                    else backgroundQueueDirty = true
                }
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
                if (eventThread != null) handler.post { pausedThreadKeys.remove(threadTitleKey(eventThread)) }
                if (eventThread == activeThreadId) {
                    running = true
                    clearLiveActivity()
                    liveActivityTurnId = params.optString("turnId").ifBlank { params.optJSONObject("turn")?.optString("id").orEmpty() }
                        .takeIf(String::isNotBlank)
                    if (foreground) handler.post { renderHeader(); renderMessages(false) }
                    else backgroundThreadDirty = true
                }
            }
            "turn/completed" -> {
                val eventThread = eventThreadId(params)
                if (eventThread == activeThreadId) {
                    running = false
                    clearLiveActivity()
                    if (foreground) handler.post { renderHeader(); refreshActiveThread(false); refreshQueue(false) }
                    else { backgroundThreadDirty = true; backgroundQueueDirty = true }
                } else if (eventThread != null) {
                    pendingCompletionNoticeThreadId = eventThread
                }
                if (!foreground && eventThread != null) showSystemNotification(eventThread)
                if (foreground) handler.post { refreshThreads(false) }
                else backgroundListDirty = true
            }
            "item/agentMessage/delta" -> {
                val eventThread = eventThreadId(params)
                if (eventThread == activeThreadId) {
                    if (foreground) handler.post {
                        if (eventThread != activeThreadId) return@post
                        val turnId = params.optString("turnId").ifBlank {
                            activeThread?.optJSONArray("turns")?.let { turns -> turns.optJSONObject(turns.length() - 1)?.optString("id") }.orEmpty()
                        }
                        if (turnId.isNotBlank()) {
                            val itemId = params.optString("itemId").ifBlank { "agent-message-live" }
                            liveActivityItem = JSONObject().put("id", itemId).put("type", "agentMessage").put("status", "inProgress")
                            liveActivityItemCompleted = false
                            liveActivityTurnId = turnId
                            liveActivityLabel = "正在回复"
                            updateActiveActivityText()
                        }
                        scheduleActiveThreadRefresh()
                    }
                    else backgroundThreadDirty = true
                }
            }
            "turn/plan/updated", "reasoning/summaryTextDelta" -> {
                val eventThread = eventThreadId(params)
                if (eventThread == activeThreadId) {
                    if (foreground) handler.post {
                        if (eventThread != activeThreadId) return@post
                        val turnId = params.optString("turnId").ifBlank {
                            liveActivityTurnId.orEmpty().ifBlank {
                                activeThread?.optJSONArray("turns")?.let { turns -> turns.optJSONObject(turns.length() - 1)?.optString("id") }.orEmpty()
                            }
                        }
                        if (turnId.isNotBlank()) {
                            if (!liveActivityTurnId.isNullOrBlank() && liveActivityTurnId != turnId) {
                                liveActivityItem = null
                                liveActivityItemCompleted = false
                            }
                            liveActivityTurnId = turnId
                            liveActivityLabel = if (method == "turn/plan/updated") "正在整理执行计划" else "正在思考"
                            updateActiveActivityText()
                        }
                    }
                    else backgroundThreadDirty = true
                }
            }
            "item/started", "item/completed", "item/fileChange/patchUpdated", "turn/workspaceChanges" -> {
                val eventThread = eventThreadId(params)
                if (eventThread == activeThreadId) {
                    if (foreground) handler.post {
                        if (eventThread != activeThreadId) return@post
                        if (method == "item/started" || method == "item/completed") {
                            val item = params.optJSONObject("item")
                            val type = normalizedType(item?.optString("type").orEmpty())
                            if (item != null && type != "usermessage") {
                                val turnId = params.optString("turnId").ifBlank {
                                    activeThread?.optJSONArray("turns")?.let { turns -> turns.optJSONObject(turns.length() - 1)?.optString("id") }.orEmpty()
                                }
                                if (turnId.isNotBlank()) {
                                    if (method == "item/started") {
                                        liveActivityItem = item
                                        liveActivityItemCompleted = false
                                        liveActivityTurnId = turnId
                                        liveActivityLabel = activityLabelForItem(item)
                                        updateActiveActivityText()
                                    } else if (liveActivityTurnId == turnId && liveActivityItem?.optString("id") == item.optString("id")) {
                                        liveActivityItem = item
                                        liveActivityItemCompleted = true
                                        if (type != "agentmessage") liveActivityLabel = "正在思考"
                                        updateActiveActivityText()
                                    }
                                }
                            }
                        } else if (method == "item/fileChange/patchUpdated") {
                            val turnId = params.optString("turnId").ifBlank {
                                activeThread?.optJSONArray("turns")?.let { turns -> turns.optJSONObject(turns.length() - 1)?.optString("id") }.orEmpty()
                            }
                            if (turnId.isNotBlank()) {
                                val itemId = params.optString("itemId").ifBlank { "file-change-live" }
                                liveActivityItem = JSONObject()
                                    .put("id", itemId)
                                    .put("type", "fileChange")
                                    .put("status", "inProgress")
                                    .put("changes", params.optJSONArray("changes") ?: JSONArray())
                                liveActivityItemCompleted = false
                                liveActivityTurnId = turnId
                                liveActivityLabel = "正在修改文件"
                                updateActiveActivityText()
                            }
                        }
                        scheduleActiveThreadRefresh()
                    }
                    else backgroundThreadDirty = true
                }
            }
            "thread/name/updated" -> {
                handler.post {
                    eventThreadId(params)?.let { threadId ->
                        val name = params.optString("threadName")
                        if (name.isNotBlank()) displayedThreadTitles[threadTitleKey(threadId)] = name
                        else displayedThreadTitles.remove(threadTitleKey(threadId))
                    }
                    if (foreground) refreshThreads(false) else backgroundListDirty = true
                }
            }
            "thread/deleted" -> {
                handler.post {
                    eventThreadId(params)?.let { displayedThreadTitles.remove(threadTitleKey(it)) }
                    if (foreground) refreshThreads(false) else backgroundListDirty = true
                }
            }
            "remote.pins.changed" -> {
                if (foreground) handler.post { refreshThreads(false) }
                else backgroundListDirty = true
            }
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

    private fun showSystemNotification(threadId: String?, test: Boolean = false) {
        if (!prefs.getBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, false)) return
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            if (test) handler.post { showToast("手机尚未授予通知权限") }
            return
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (!manager.areNotificationsEnabled()) {
            if (test) handler.post { showToast("手机系统已关闭此 APP 的通知") }
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Codex Remote", NotificationManager.IMPORTANCE_DEFAULT))
            if (manager.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) {
                if (test) handler.post { showToast("手机系统已关闭此通知类别") }
                return
            }
        }
        val thread = threadId?.let(::findThread)
        val profileName = connectionProfiles.firstOrNull { it.id == activeConnectionId }?.name ?: "CAR"
        val threadName = thread?.optString("name")?.takeIf { !it.isNullOrBlank() && it != "null" } ?: "回复完成"
        val title = if (test) "$profileName · 测试通知" else "$profileName · $threadName"
        val intent = Intent(this, MainActivity::class.java).apply {
            action = "$packageName.NOTIFICATION.$activeConnectionId.$threadId"
            if (threadId != null) putExtra(EXTRA_THREAD_ID, threadId)
            putExtra(EXTRA_CONNECTION_ID, activeConnectionId)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val notificationId = "$activeConnectionId:${threadId ?: "test"}".hashCode()
        val pending = PendingIntent.getActivity(this, notificationId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
        manager.notify(notificationId, notification.setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title)
            .setContentText(if (test) "通知通道已就绪。" else "有一条新的回复。打开查看对话。")
            .setContentIntent(pending).setAutoCancel(true).build())
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_WEB_DOWNLOAD_STORAGE) {
            val pending = pendingWebDownload
            pendingWebDownload = null
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED && pending != null) {
                enqueueWebDownload(pending)
            } else {
                showToast("未获得存储权限，无法保存到下载目录")
            }
            return
        }
        if (requestCode != REQUEST_NOTIFICATIONS || !notificationPermissionRequestedFromSettings) return
        notificationPermissionRequestedFromSettings = false
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        prefs.edit().putBoolean(KEY_SYSTEM_NOTIFICATIONS_ENABLED, granted).apply()
        refreshSettingsNotificationControl()
        showToast(if (granted) "系统通知已开启" else "未获得通知权限")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handler.post { navigateNotification(intent) }
    }

    private fun navigateNotification(intent: Intent) {
        val threadId = intent.getStringExtra(EXTRA_THREAD_ID) ?: return
        val targetConnection = intent.getStringExtra(EXTRA_CONNECTION_ID)
        if (!targetConnection.isNullOrBlank() && targetConnection != activeConnectionId) switchConnection(targetConnection)
        if (!targetConnection.isNullOrBlank() && targetConnection != activeConnectionId) return
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

    private fun showStatus(message: String) {
        if (::statusView.isInitialized) {
            statusView.visibility = View.VISIBLE
            val displayMessage = tr(message)
            statusView.text = displayMessage
            statusView.setTextColor(WARNING)
            handler.postDelayed({ if (::statusView.isInitialized && statusView.text == displayMessage && runtime.optBoolean("connected", false)) statusView.visibility = View.GONE }, 5000)
        } else showToast(message)
    }

    private fun showToast(message: String) = Toast.makeText(this, tr(message), Toast.LENGTH_SHORT).show()

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

    private fun parseMessageInstant(value: Any?): Instant? = try {
        when (value) {
            is Number -> value.toLong().let { Instant.ofEpochMilli(if (it in -9_999_999_999L..9_999_999_999L) it * 1000L else it) }
            is String -> value.trim().toLongOrNull()?.let { Instant.ofEpochMilli(if (it in -9_999_999_999L..9_999_999_999L) it * 1000L else it) }
                ?: runCatching { Instant.parse(value) }.getOrNull()
                ?: runCatching { OffsetDateTime.parse(value).toInstant() }.getOrNull()
            else -> null
        }
    } catch (_: Exception) { null }

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
        updateSendButton()
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
                    isClickable = true
                    setOnClickListener {
                        val full = runCatching {
                            decodeSampledBitmap(android.util.Base64.decode(file.optString("data"), android.util.Base64.DEFAULT), 2048)
                        }.getOrNull()
                        if (full != null) showImageDialog(full)
                    }
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
                chip.addView(label(file.optString("name"), 10, SUBTLE, translateUi = false).apply {
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
        "minimal" -> "Minimal"
        "low" -> "Low"
        "medium" -> "Medium"
        "high" -> "High"
        "xhigh" -> "Extra High"
        "max" -> "Max"
        null, "default" -> "Effort"
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
        hint = tr(hintText)
        setText(value)
        inputType = inputTypeValue
        typeface = themedTypeface()
        setTextColor(TEXT)
        setHintTextColor(MUTED)
        textSize = adjustedTextSize(14)
        setTag(R.id.base_text_size, 14f)
        setPadding(dp(12), dp(7), dp(12), dp(7))
        background = rounded(if (lightTheme) Color.rgb(255, 255, 255) else Color.rgb(18, 20, 24), dp(if (retroTheme) 4 else 9), BORDER, dp(1))
    }

    private val appLanguage: String get() = prefs.getString(KEY_APP_LANGUAGE, "zh") ?: "zh"

    private fun tr(value: String): String = if (appLanguage == "en") UiEnglish.translate(value) else value

    private fun label(
        value: String,
        size: Int,
        color: Int,
        bold: Boolean = false,
        translateUi: Boolean = true,
        pixelize: Boolean = true,
    ): TextView = (if (pixelTheme && pixelize) PixelRasterTextView(this, nextPixelTextViewId++) else TextView(this)).apply {
        text = if (translateUi) tr(value) else value
        textSize = adjustedTextSize(size)
        setTag(R.id.base_text_size, size.toFloat())
        setTextColor(color)
        if (retroTheme) typeface = themedTypeface(bold) else if (bold) setTypeface(typeface, Typeface.BOLD)
        gravity = Gravity.CENTER_VERTICAL
    }

    private fun themedTypeface(bold: Boolean = false): Typeface = when {
        pixelTheme -> Typeface.create("monospace", if (bold) Typeface.BOLD else Typeface.NORMAL)
        !retroTheme -> Typeface.create("sans-serif", if (bold) Typeface.BOLD else Typeface.NORMAL)
        bold -> android1BoldTypeface
        else -> android1Typeface
    }

    private fun iconButton(icon: String, description: String, action: () -> Unit): ImageButton = ImageButton(this).apply {
        setPixelAwareImageResource(iconResource(icon))
        val pixelArtIcon = pixelTheme && iconResource(icon) in pixelIconResourceIds
        imageTintList = if (pixelArtIcon || retroTheme && !pixelTheme && icon != "codex" && icon != "claude") null
            else ColorStateList.valueOf(iconTint(icon))
        scaleType = ImageView.ScaleType.FIT_CENTER
        val iconPadding = if (retroTheme) dp(12) else dp(9)
        setPadding(iconPadding, iconPadding, iconPadding, iconPadding)
        contentDescription = tr(description)
        background = if (retroTheme) android1SegmentButtonBackground() else ColorDrawable(Color.TRANSPARENT)
        foreground = null
        stateListAnimator = null
        setDefaultFocusHighlightEnabled(false)
        isFocusable = true
        isClickable = true
        setOnClickListener { action() }
    }

    private fun sidebarIconButton(icon: String, description: String, action: () -> Unit): ImageButton =
        iconButton(icon, description, action).apply {
            val resource = sidebarIconResource(icon)
            setPixelAwareImageResource(resource)
            imageTintList = if (pixelTheme && resource in pixelIconResourceIds) null
                else if (retroTheme && !pixelTheme && icon != "codex" && icon != "claude") null
                else ColorStateList.valueOf(iconTint(icon))
            setPadding(dp(6), dp(6), dp(6), dp(6))
            tooltipText = description
        }

    private fun iconTint(icon: String): Int = when {
        icon == "codex" -> codexBrandAccent()
        icon == "claude" -> if (themeName == "lollipop") Color.rgb(177, 112, 83) else ACCENT_WARM
        pixelTheme -> when (icon) {
            "add", "arrow_up", "check", "download", "refresh", "play", "pause", "link", "notifications" -> PIXEL_BLUE
            "delete", "stop" -> PIXEL_RED
            "folder", "folder_add", "pin", "file", "file_add", "copy", "paste", "open", "display", "language" -> Color.rgb(116, 180, 230)
            "image", "palette" -> Color.rgb(201, 168, 255)
            "chat", "history" -> PIXEL_BLUE
            else -> PIXEL_TEXT
        }
        retroTheme -> when (icon) {
            "add", "arrow_up", "check", "download", "refresh", "play", "pause" -> LOLLIPOP_PRIMARY
            "delete", "stop" -> Color.rgb(164, 76, 65)
            "folder", "folder_add", "pin" -> Color.rgb(111, 157, 197)
            "file", "file_add", "copy", "paste", "open", "display", "language", "link" -> Color.rgb(111, 157, 197)
            "image", "palette" -> Color.rgb(159, 119, 144)
            "chat" -> Color.rgb(111, 157, 197)
            "history" -> Color.rgb(154, 171, 181)
            "notifications" -> LOLLIPOP_PRIMARY
            "lock" -> Color.rgb(154, 166, 169)
            "terminal", "settings", "search", "more", "back", "close", "info" -> LOLLIPOP_TEXT_SECONDARY
            "menu" -> Color.rgb(66, 66, 66)
            else -> LOLLIPOP_TEXT_SECONDARY
        }
        else -> SUBTLE
    }

    private fun retroIconTint(color: Int): ColorStateList? =
        if (retroTheme) null else ColorStateList.valueOf(color)

    private fun ImageView.setPixelAwareImageResource(resourceId: Int) {
        setImageResource(resourceId)
        if (pixelTheme && resourceId in pixelIconResourceIds) {
            (drawable as? BitmapDrawable)?.setFilterBitmap(false)
        }
    }

    private fun pixelIconResource(icon: String): Int? = when (icon) {
        "search" -> R.drawable.pixel_search
        "refresh" -> R.drawable.pixel_refresh
        "chat", "menu" -> R.drawable.pixel_chat
        "settings" -> R.drawable.pixel_settings
        "link", "connection" -> R.drawable.pixel_connection
        "terminal" -> R.drawable.pixel_terminal
        "folder" -> R.drawable.pixel_folder
        "add", "file_add", "folder_add" -> R.drawable.pixel_file_add
        "arrow_up", "send" -> R.drawable.pixel_send
        "pause" -> R.drawable.pixel_pause
        "edit" -> R.drawable.pixel_edit
        "check", "checked" -> R.drawable.pixel_check
        "delete" -> R.drawable.pixel_delete
        "palette", "theme" -> R.drawable.pixel_theme
        "display" -> R.drawable.pixel_display
        "language" -> R.drawable.pixel_language
        "notifications" -> R.drawable.pixel_notifications
        "lock", "match" -> R.drawable.pixel_match
        "info", "about" -> R.drawable.pixel_about
        else -> null
    }

    private fun pixelBlockBackground(fillColor: Int): Drawable {
        return pixelFrameBackground(R.drawable.pixel_frame_active, fillColor)
    }

    private fun pixelSidebarNewThreadBackground(): Drawable = android.graphics.drawable.StateListDrawable().apply {
        addState(
            intArrayOf(android.R.attr.state_pressed),
            pixelFrameBackground(R.drawable.pixel_frame_active, Color.rgb(225, 213, 183)),
        )
        addState(
            intArrayOf(android.R.attr.state_focused),
            pixelFrameBackground(R.drawable.pixel_frame_square, Color.rgb(250, 240, 216)),
        )
        addState(
            intArrayOf(),
            pixelFrameBackground(R.drawable.pixel_frame_square, PIXEL_CREAM),
        )
    }

    private fun pixelFrameBackground(frameResource: Int, fillColor: Int): Drawable {
        val bitmap = pixelFrameBitmapCache[frameResource]
            ?: BitmapFactory.decodeResource(resources, frameResource)?.also { decoded ->
                decoded.density = Bitmap.DENSITY_NONE
                pixelFrameBitmapCache[frameResource] = decoded
            }
            ?: return ColorDrawable(fillColor)
        val sourceCorners = when (frameResource) {
            R.drawable.pixel_frame_square -> 54 to 52
            R.drawable.pixel_frame_strip -> 56 to 48
            R.drawable.pixel_frame_active -> 56 to 56
            else -> 54 to 52
        }
        val frame = PixelFrameNineSliceDrawable(
            bitmap = bitmap,
            sourceCornerWidth = sourceCorners.first,
            sourceCornerHeight = sourceCorners.second,
            targetCornerSize = dp(10),
        )
        return LayerDrawable(arrayOf(ColorDrawable(fillColor), frame)).apply {
            // Leave the frame's stepped outer silhouette transparent while the
            // frame itself covers the panel's inner edge.
            setLayerInset(0, dp(3), dp(3), dp(3), dp(3))
        }
    }

    private fun android1SegmentButtonBackground(): Drawable = android.graphics.drawable.StateListDrawable().apply {
        if (pixelTheme) {
            addState(intArrayOf(android.R.attr.state_pressed), pixelBlockBackground(PIXEL_BLUE))
            addState(intArrayOf(android.R.attr.state_focused), pixelFrameBackground(R.drawable.pixel_frame_square, PIXEL_PANEL_INSET))
            addState(intArrayOf(android.R.attr.state_selected), pixelBlockBackground(PIXEL_BLUE))
            addState(intArrayOf(), pixelFrameBackground(R.drawable.pixel_frame_square, PIXEL_PANEL_INSET))
        } else {
            addState(intArrayOf(android.R.attr.state_pressed), android1MetalButtonBackground())
            addState(intArrayOf(android.R.attr.state_focused), android1MetalButtonBackground())
            addState(intArrayOf(android.R.attr.state_selected), android1MetalButtonBackground())
            addState(intArrayOf(), gingerbreadButtonBackground())
        }
    }

    private fun lollipopRipple(
        content: Drawable = ColorDrawable(Color.TRANSPARENT),
        rippleColor: Int = Color.argb(56, 111, 157, 197),
    ): Drawable {
        if (!retroTheme) return content
        if (pixelTheme) return android.graphics.drawable.StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), pixelBlockBackground(PIXEL_PANEL_INSET))
            addState(intArrayOf(android.R.attr.state_focused), pixelBlockBackground(PIXEL_PANEL_INSET))
            addState(intArrayOf(), content)
        }
        val pressed = ColorDrawable(rippleColor)
        return android.graphics.drawable.StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), android.graphics.drawable.LayerDrawable(arrayOf(content, pressed)))
            addState(intArrayOf(android.R.attr.state_focused), android.graphics.drawable.LayerDrawable(arrayOf(content, pressed)))
            addState(intArrayOf(), content)
        }
    }

    private fun lollipopSelectableRow(selected: Boolean, selectedColor: Int = LOLLIPOP_PRIMARY_LIGHT): Drawable = when {
        pixelTheme && selected -> pixelBlockBackground(selectedColor)
        selected -> ColorDrawable(selectedColor)
        else -> lollipopRipple()
    }

    private fun sidebarIconResource(icon: String): Int = when {
        retroTheme -> iconResource(icon)
        else -> when (icon) {
        "add" -> R.drawable.ic_sidebar_add
        "back" -> R.drawable.ic_sidebar_back
        "open" -> R.drawable.ic_sidebar_open
        "close" -> R.drawable.ic_sidebar_close
        "search" -> R.drawable.ic_sidebar_search
        "settings" -> R.drawable.ic_sidebar_settings
        else -> iconResource(icon)
        }
    }

    private fun brandIconTint(engine: String): Int = when {
        engine != "claude-code" -> codexBrandAccent()
        themeName == "lollipop" -> Color.rgb(177, 112, 83)
        pixelTheme -> Color.rgb(238, 140, 109)
        else -> ACCENT_WARM
    }

    private fun setBrandIcon(view: ImageView, engine: String) {
        val claude = engine == "claude-code"
        view.setImageResource(if (claude) R.drawable.ic_brand_claude else R.drawable.ic_brand_codex)
        view.imageTintList = ColorStateList.valueOf(brandIconTint(engine))
    }

    private fun codexBrandAccent(): Int = when (themeName) {
        "lollipop" -> Color.rgb(111, 157, 197)
        "pixel" -> PIXEL_BLUE
        else -> if (lightTheme) Color.rgb(75, 96, 157) else Color.rgb(170, 186, 255)
    }

    private fun settingsSectionIcon(title: String): String = when (title) {
        "主题" -> "palette"
        "显示" -> "display"
        "语言" -> "language"
        "系统通知" -> "notifications"
        "连接" -> "link"
        "本机配对" -> "lock"
        "关于" -> "info"
        else -> "settings"
    }

    private fun iconResource(icon: String): Int {
        if (pixelTheme) pixelIconResource(icon)?.let { return it }
        if (themeName == "lollipop") return when (icon) {
            "codex" -> R.drawable.ic_brand_codex
            "claude" -> R.drawable.ic_brand_claude
            "chat" -> R.drawable.ic_android1_chat
            "save" -> R.drawable.ic_android1_save
            "menu" -> R.drawable.ic_android1_menu
            "terminal" -> R.drawable.ic_android1_terminal
            "folder" -> R.drawable.ic_android1_folder
            "add" -> R.drawable.ic_android1_add
            "close" -> R.drawable.ic_android1_close
            "more" -> R.drawable.ic_android1_more
            "search" -> R.drawable.ic_android1_search
            "settings" -> R.drawable.ic_android1_settings
            "refresh" -> R.drawable.ic_android1_refresh
            "download" -> R.drawable.ic_android1_save
            "arrow_up" -> R.drawable.ic_android1_arrow_up
            "send" -> R.drawable.ic_android1_send
            "file" -> R.drawable.ic_android1_file
            "image" -> R.drawable.ic_android1_image
            "file_add" -> R.drawable.ic_android1_file_add
            "folder_add" -> R.drawable.ic_android1_folder_add
            "paste" -> R.drawable.ic_android1_paste
            "open" -> R.drawable.ic_android1_open
            "edit" -> R.drawable.ic_android1_edit
            "pin" -> R.drawable.ic_android1_pin
            "copy" -> R.drawable.ic_android1_copy
            "cut" -> R.drawable.ic_android1_cut
            "delete" -> R.drawable.ic_android1_delete
            "link" -> R.drawable.ic_android1_link
            "check" -> R.drawable.ic_android1_check
            "chevron_down" -> R.drawable.ic_android1_chevron_down
            "chevron_up" -> R.drawable.ic_android1_chevron_up
            "chevron_right" -> R.drawable.ic_android1_chevron_right
            "back" -> R.drawable.ic_android1_back
            "history" -> R.drawable.ic_android1_history
            "notifications" -> R.drawable.ic_android1_notifications
            "language" -> R.drawable.ic_android1_language
            "info" -> R.drawable.ic_android1_info
            "palette" -> R.drawable.ic_android1_palette
            "display" -> R.drawable.ic_android1_display
            "lock" -> R.drawable.ic_android1_lock
            "checked" -> R.drawable.ic_android1_checked
            "unchecked" -> R.drawable.ic_android1_unchecked
            "alert" -> R.drawable.ic_android1_alert
            "stop" -> R.drawable.ic_android1_stop
            "pause" -> R.drawable.ic_android1_pause
            "play" -> R.drawable.ic_android1_play
            else -> R.drawable.ic_android1_add
        }
        return when (icon) {
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
        "download" -> R.drawable.ic_download
        "arrow_up" -> R.drawable.ic_arrow_up
        "send" -> R.drawable.ic_arrow_up
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
        "chevron_right" -> R.drawable.ic_chevron_right
        "back" -> R.drawable.ic_back
        else -> R.drawable.ic_add
        }
    }

    private fun preferenceButton(value: String, action: () -> Unit): TextView = label(value, 12, SUBTLE, true).apply {
        gravity = Gravity.CENTER
        setPadding(dp(4), 0, dp(4), 0)
        minWidth = dp(36)
        minHeight = dp(40)
        background = if (retroTheme) lollipopRipple() else ColorDrawable(Color.TRANSPARENT)
        foreground = null
        stateListAnimator = null
        setDefaultFocusHighlightEnabled(false)
        setOnClickListener { action() }
    }

    private fun smallButton(value: String, action: () -> Unit): TextView = label(value, 12, SUBTLE, true).apply {
        gravity = Gravity.CENTER
        setPadding(dp(9), 0, dp(9), 0)
        background = if (retroTheme) android1SegmentButtonBackground() else rounded(PANEL_INSET, dp(7))
        setOnClickListener { action() }
    }

    private fun textIconAction(value: String, icon: String, fallbackLabel: String, action: () -> Unit): View {
        if (!retroTheme) return smallButton(fallbackLabel, action)
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(dp(8), 0, dp(8), 0)
            background = lollipopRipple(rounded(PANEL, dp(2)))
            isClickable = true
            isFocusable = false
            contentDescription = tr(value)
            setOnClickListener { action() }
            addView(ImageView(this@MainActivity).apply {
                val resource = iconResource(icon)
                setPixelAwareImageResource(resource)
                imageTintList = if (themeName == "lollipop" || pixelTheme && resource in pixelIconResourceIds) null
                    else ColorStateList.valueOf(iconTint(icon))
            }, LinearLayout.LayoutParams(dp(15), dp(15)).apply { rightMargin = dp(5) })
            addView(label(value, 11, SUBTLE, true), widthWrap())
        }
    }

    private fun dialogTextButton(value: String, color: Int, action: () -> Unit): TextView = label(value, 12, color, true).apply {
        gravity = Gravity.CENTER
        setPadding(dp(10), 0, dp(10), 0)
        background = if (retroTheme) lollipopRipple() else ColorDrawable(Color.TRANSPARENT)
        setOnClickListener { action() }
    }

    private fun actionButton(value: String): Button = Button(this).apply {
        text = tr(value)
        if (retroTheme) typeface = themedTypeface(true)
        textSize = adjustedTextSize(13)
        setTag(R.id.base_text_size, 13f)
        setTextColor(if (pixelTheme) PIXEL_TEXT else if (retroTheme) Color.rgb(28, 31, 33) else DARK)
        isAllCaps = false
        background = if (retroTheme) gingerbreadButtonBackground()
            else rounded(if (lightTheme) Color.rgb(35, 38, 43) else Color.rgb(224, 226, 231), dp(9))
    }

    private fun rounded(color: Int, radius: Int, strokeColor: Int? = null, strokeWidth: Int = 0): Drawable {
        if (pixelTheme) {
            if (Color.alpha(color) == 0) return ColorDrawable(color)
            val frameResource = if (radius >= dp(10)) R.drawable.pixel_frame_panel else R.drawable.pixel_frame_square
            return pixelFrameBackground(frameResource, color)
        }
        return GradientDrawable().apply {
            setColor(color)
            cornerRadius = when {
                retroTheme && radius < dp(20) -> dp(2).toFloat()
                else -> radius.toFloat()
            }
            if (strokeColor != null && strokeWidth > 0) setStroke(strokeWidth, strokeColor)
        }
    }

    private fun lollipopActionBarBackground(): Drawable {
        if (pixelTheme) return pixelFrameBackground(R.drawable.pixel_frame_strip, PIXEL_PANEL)
        return GradientDrawable().apply {
            orientation = GradientDrawable.Orientation.TOP_BOTTOM
            setColors(intArrayOf(Color.rgb(248, 248, 248), Color.rgb(220, 220, 220), Color.rgb(169, 169, 169)))
            setStroke(dp(1), Color.rgb(107, 107, 107))
            cornerRadius = 0f
        }
    }

    private fun android1SettingsActionBarBackground(): Drawable {
        if (pixelTheme) return pixelFrameBackground(R.drawable.pixel_frame_strip, PIXEL_BACKGROUND)
        return GradientDrawable().apply {
            orientation = GradientDrawable.Orientation.TOP_BOTTOM
            setColors(intArrayOf(Color.rgb(86, 86, 86), Color.rgb(50, 50, 50), Color.rgb(24, 24, 24)))
            setStroke(dp(1), Color.rgb(116, 116, 116))
            cornerRadius = 0f
        }
    }

    private fun gingerbreadButtonBackground(accent: Boolean = false): Drawable {
        if (pixelTheme) return pixelFrameBackground(
            R.drawable.pixel_frame_square,
            if (accent) PIXEL_BLUE else PIXEL_PANEL_INSET,
        )
        return GradientDrawable().apply {
            orientation = GradientDrawable.Orientation.TOP_BOTTOM
            setColors(if (accent) intArrayOf(Color.rgb(213, 218, 219), Color.rgb(160, 171, 174), Color.rgb(111, 121, 124))
                else intArrayOf(Color.rgb(91, 97, 97), Color.rgb(58, 64, 65), Color.rgb(39, 44, 45)))
            setStroke(dp(1), if (accent) Color.rgb(225, 229, 230) else Color.rgb(112, 119, 119))
            cornerRadius = dp(3).toFloat()
        }
    }

    private fun android1MetalButtonBackground(): GradientDrawable = GradientDrawable().apply {
        orientation = GradientDrawable.Orientation.TOP_BOTTOM
        setColors(intArrayOf(Color.rgb(245, 245, 245), Color.rgb(205, 205, 205), Color.rgb(157, 157, 157)))
        setStroke(dp(1), Color.rgb(248, 248, 248))
        cornerRadius = dp(3).toFloat()
    }

    private fun lollipopFabBackground(color: Int): Drawable {
        if (pixelTheme) return pixelFrameBackground(R.drawable.pixel_frame_square, color)
        return GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            orientation = GradientDrawable.Orientation.TOP_BOTTOM
            setColors(intArrayOf(Color.rgb(213, 218, 219), color, Color.rgb(111, 121, 124)))
            setStroke(dp(1), Color.rgb(225, 229, 230))
        }
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

    private fun backgroundTransparency(): Int =
        (previewBackgroundTransparency ?: prefs.getInt(KEY_BACKGROUND_TRANSPARENCY, 0)).coerceIn(0, 100)

    private fun updateCustomThemeBackgroundPreview() {
        if (themeName != "custom") return
        val opacity = (100 - backgroundTransparency()) / 100f
        val iterator = themeWallpaperDrawables.iterator()
        while (iterator.hasNext()) {
            val drawable = iterator.next().get()
            if (drawable == null) iterator.remove() else drawable.setImageOpacity(opacity)
        }
    }

    private fun colorWithAlpha(color: Int, opacity: Float): Int = Color.argb(
        (Color.alpha(color) * opacity.coerceIn(0f, 1f)).toInt(),
        Color.red(color),
        Color.green(color),
        Color.blue(color),
    )

    private fun blendColors(base: Int, tint: Int, tintRatio: Float): Int {
        val ratio = tintRatio.coerceIn(0f, 1f)
        fun blend(baseChannel: Int, tintChannel: Int) = (baseChannel * (1f - ratio) + tintChannel * ratio + .5f).toInt()
        return Color.argb(
            Color.alpha(base),
            blend(Color.red(base), Color.red(tint)),
            blend(Color.green(base), Color.green(tint)),
            blend(Color.blue(base), Color.blue(tint)),
        )
    }

    private fun wallpaperBackground(
        baseColor: Int,
        cornerRadiusDp: Int = 0,
        strokeColor: Int? = null,
        strokeWidthDp: Int = 0,
        viewportWidthPx: Int = 0,
        viewportHeightPx: Int = 0,
        viewportOffsetXpx: Float = 0f,
        viewportOffsetYpx: Float = 0f,
    ): Drawable {
        val bitmap = if (themeName == "custom") customThemeBackgroundBitmap() else null
        if (bitmap != null) {
            return ThemeWallpaperDrawable(
                bitmap = bitmap,
                baseColor = baseColor,
                imageOpacity = (100 - backgroundTransparency()) / 100f,
                cornerRadius = dp(cornerRadiusDp).toFloat(),
                strokeColor = strokeColor,
                strokeWidth = dp(strokeWidthDp).toFloat(),
                viewportWidth = viewportWidthPx.toFloat(),
                viewportHeight = viewportHeightPx.toFloat(),
                viewportOffsetX = viewportOffsetXpx,
                viewportOffsetY = viewportOffsetYpx,
            ).also { themeWallpaperDrawables += WeakReference(it) }
        }
        return if (cornerRadiusDp > 0 || strokeColor != null && strokeWidthDp > 0) {
            rounded(baseColor, dp(cornerRadiusDp), strokeColor, dp(strokeWidthDp))
        } else ColorDrawable(baseColor)
    }

    private fun customThemeBackgroundBitmap(): Bitmap? {
        val storedUri = prefs.getString(KEY_CUSTOM_BACKGROUND_IMAGE, null).orEmpty()
        if (storedUri.isBlank()) {
            cachedThemeBackgroundUri = null
            cachedThemeBackgroundBitmap = null
            return null
        }
        if (cachedThemeBackgroundUri == storedUri) {
            return cachedThemeBackgroundBitmap?.takeUnless { it.isRecycled }
        }
        val bitmap = runCatching { decodeThemeBackground(Uri.parse(storedUri)) }.getOrNull()
        cachedThemeBackgroundUri = storedUri
        cachedThemeBackgroundBitmap = bitmap
        return bitmap
    }

    private fun installThemeBackground(target: FrameLayout) {
        target.background = if (retroTheme) lollipopSystemBarsBackground(DARK) else wallpaperBackground(DARK)
    }

    private fun lollipopSystemBarsBackground(contentColor: Int): Drawable = LollipopSystemBarsDrawable(
        contentColor = contentColor,
        statusBarColor = LOLLIPOP_PRIMARY_DARK,
        navigationBarColor = if (pixelTheme) PIXEL_BACKGROUND else Color.BLACK,
        statusBarHeight = { systemInsetTop },
        navigationBarHeight = { systemInsetBottom },
    )

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
        private const val KEY_CONNECTION_PROFILES = "native_connection_profiles"
        private const val KEY_ACTIVE_CONNECTION_ID = "native_active_connection_id"
        private const val KEY_LEGACY_CONNECTION_ID = "native_legacy_connection_id"
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
        private const val REQUEST_WEB_DOWNLOAD_STORAGE = 4104
        private const val CHANNEL_ID = "codex_remote_native"
        private const val EXTRA_THREAD_ID = "notification_thread_id"
        private const val EXTRA_CONNECTION_ID = "notification_connection_id"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        private const val KEY_LIGHT_THEME = "native_light_theme"
        private const val KEY_SYSTEM_NOTIFICATIONS_ENABLED = "native_system_notifications_enabled"
        private const val KEY_APP_LANGUAGE = "native_app_language"
        private const val KEY_WORKSPACE_EXPLORER_ROOT = "native_workspace_explorer_root"
        private const val KEY_WEB_PREVIEW_WIDTH_RATIO = "native_web_preview_width_ratio"
        private const val KEY_WEB_PREVIEW_HEIGHT_RATIO = "native_web_preview_height_ratio"
        private const val TAG_INSET_CONTENT = "inset_content"
        private const val TAG_MESSAGE_TURN_PREFIX = "message_turn:"
        private const val TAG_MESSAGE_DYNAMIC = "message_dynamic"
        private const val DEFAULT_VISIBLE_HISTORY_TURNS = 12
        private const val MAX_VISIBLE_SIDEBAR_THREADS = 80
        private val OPERATION_PATH_KEYS = setOf(
            "path", "filepath", "file_path", "filename", "target_path", "source_path", "imagepath", "image_path",
        )
        private val SEARCH_COMMAND_PATTERN = Regex("""(?:^|[\s"'|;&])(?:\S*/)?(?:rg|grep|find|fd|ag|ack)(?=$|[\s"';&|])""", RegexOption.IGNORE_CASE)
        private val VIEW_COMMAND_PATTERN = Regex("""(?:^|[\s"'|;&])(?:\S*/)?(?:cat|less|more|head|tail|sed|awk|bat|xxd|file)(?=$|[\s"';&|])""", RegexOption.IGNORE_CASE)
        private val SEARCH_TOOL_PATTERN = Regex("(?:search|find|grep|query)", RegexOption.IGNORE_CASE)
        private val FILE_TOOL_PATTERN = Regex("(?:read|file|directory|folder|list)", RegexOption.IGNORE_CASE)
        private val SKILL_TOOL_PATTERN = Regex("skill", RegexOption.IGNORE_CASE)
        private val CONTROL_CHARACTER_PATTERN = Regex("[\\u0000-\\u001f\\u007f]+")
        private val WHITESPACE_PATTERN = Regex("\\s+")
        private const val MAX_CACHED_THREADS = 32
        private const val MAX_EAGER_HISTORY_CACHE_BYTES = 1024L * 1024L
        private const val MAX_SINGLE_HISTORY_CACHE_BYTES = 24L * 1024 * 1024
        private const val MAX_TOTAL_HISTORY_CACHE_BYTES = 64L * 1024 * 1024
        private const val MAX_HISTORY_CACHE_JSON_BYTES = 12 * 1024 * 1024
        private const val MAX_HISTORY_CACHE_STRING_CHARS = 3 * 1024 * 1024
        private const val MAX_HISTORY_CACHE_DEPTH = 64
        private const val PIXEL_TEXT_RASTER_SCALE = 0.5f
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
    "minimal" -> "Minimal"
    "low" -> "Low"
    "medium" -> "Medium"
    "high" -> "High"
    "xhigh" -> "Extra High"
    "max" -> "Max"
    null, "default" -> "Effort"
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

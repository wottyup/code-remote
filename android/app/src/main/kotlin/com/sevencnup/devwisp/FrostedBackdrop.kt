package com.sevencnup.devwisp

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.view.View
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt

/** Capture only the popup area, at most 128 pixels per side, once per opening. */
internal fun captureFrostedBackdrop(root: View, area: Rect, blurRadius: Float): Bitmap? {
    if (area.isEmpty || root.width == 0 || root.height == 0) return null
    return runCatching {
        val scale = (128f / max(area.width(), area.height())).coerceAtMost(.25f)
        val width = ceil(area.width() * scale).toInt().coerceAtLeast(1)
        val height = ceil(area.height() * scale).toInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.scale(scale, scale)
        canvas.translate(-area.left.toFloat(), -area.top.toFloat())
        root.draw(canvas)

        val pixels = IntArray(width * height)
        val scratch = IntArray(pixels.size)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        val radius = (blurRadius * scale).roundToInt().coerceIn(1, 18)
        repeat(3) {
            blurBackdropLines(pixels, scratch, height, width, width, 1, radius)
            blurBackdropLines(scratch, pixels, width, height, 1, width, radius)
        }
        bitmap.setPixels(pixels, 0, width, 0, 0, width, height)
        bitmap
    }.getOrNull()
}

private fun blurBackdropLines(
    source: IntArray,
    target: IntArray,
    lineCount: Int,
    lineLength: Int,
    lineStride: Int,
    pixelStride: Int,
    radius: Int,
) {
    val count = radius * 2 + 1
    for (line in 0 until lineCount) {
        val base = line * lineStride
        var alpha = 0
        var red = 0
        var green = 0
        var blue = 0
        for (offset in -radius..radius) {
            val pixel = source[base + offset.coerceIn(0, lineLength - 1) * pixelStride]
            alpha += pixel ushr 24
            red += pixel ushr 16 and 255
            green += pixel ushr 8 and 255
            blue += pixel and 255
        }
        for (position in 0 until lineLength) {
            target[base + position * pixelStride] = ((alpha / count) shl 24) or
                ((red / count) shl 16) or ((green / count) shl 8) or (blue / count)
            val leaving = source[base + (position - radius).coerceAtLeast(0) * pixelStride]
            val entering = source[base + (position + radius + 1).coerceAtMost(lineLength - 1) * pixelStride]
            alpha += (entering ushr 24) - (leaving ushr 24)
            red += (entering ushr 16 and 255) - (leaving ushr 16 and 255)
            green += (entering ushr 8 and 255) - (leaving ushr 8 and 255)
            blue += (entering and 255) - (leaving and 255)
        }
    }
}

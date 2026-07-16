package com.kolvid.danmaku

import java.util.Locale

enum class HsvAdjustment {
    HUE_DECREASE,
    HUE_INCREASE,
    SATURATION_DECREASE,
    SATURATION_INCREASE,
    VALUE_DECREASE,
    VALUE_INCREASE,
}

data class HsvColorPickerState(
    val hue: Float,
    val saturation: Float,
    val value: Float,
) {
    fun withSaturationValue(
        x: Float,
        y: Float,
        width: Float,
        height: Float,
    ): HsvColorPickerState {
        if (width <= 0f || height <= 0f) return this
        return copy(
            saturation = (x / width).coerceIn(0f, 1f),
            value = (1f - y / height).coerceIn(0f, 1f),
        )
    }

    fun withHue(x: Float, width: Float): HsvColorPickerState {
        if (width <= 0f) return this
        return copy(hue = ((x / width) * 360f).coerceIn(0f, 359f))
    }

    fun adjusted(adjustment: HsvAdjustment): HsvColorPickerState = when (adjustment) {
        HsvAdjustment.HUE_DECREASE -> copy(hue = (hue - 10f + 360f) % 360f)
        HsvAdjustment.HUE_INCREASE -> copy(hue = (hue + 10f) % 360f)
        HsvAdjustment.SATURATION_DECREASE -> copy(saturation = (saturation - 0.05f).coerceIn(0f, 1f))
        HsvAdjustment.SATURATION_INCREASE -> copy(saturation = (saturation + 0.05f).coerceIn(0f, 1f))
        HsvAdjustment.VALUE_DECREASE -> copy(value = (value - 0.05f).coerceIn(0f, 1f))
        HsvAdjustment.VALUE_INCREASE -> copy(value = (value + 0.05f).coerceIn(0f, 1f))
    }
}

object ColorPickerPolicy {
    private val hexPattern = Regex("^[0-9A-Fa-f]{6}$")

    fun normalizeHex(raw: String): String? {
        val body = raw.trim().removePrefix("#")
        if (!hexPattern.matches(body)) return null
        return "#${body.uppercase(Locale.ROOT)}"
    }

    fun resolveStoredHex(raw: String, fallback: String): String =
        normalizeHex(raw) ?: normalizeHex(fallback) ?: "#FFFFFF"

    fun rgbToHex(argb: Int): String =
        String.format(Locale.US, "#%06X", argb and 0x00FFFFFF)
}

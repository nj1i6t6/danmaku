package com.kolvid.danmaku

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HsvColorPickerStateTest {
    @Test
    fun `saturation and value follow the two dimensional picker position`() {
        val state = HsvColorPickerState(hue = 210f, saturation = 0f, value = 0f)
            .withSaturationValue(x = 150f, y = 25f, width = 200f, height = 100f)

        assertEquals(210f, state.hue, 0.001f)
        assertEquals(0.75f, state.saturation, 0.001f)
        assertEquals(0.75f, state.value, 0.001f)
    }

    @Test
    fun `picker coordinates are clamped to valid hsv bounds`() {
        val state = HsvColorPickerState(hue = 0f, saturation = 0.5f, value = 0.5f)
            .withSaturationValue(x = 500f, y = -20f, width = 200f, height = 100f)
            .withHue(x = -10f, width = 300f)

        assertEquals(0f, state.hue, 0.001f)
        assertEquals(1f, state.saturation, 0.001f)
        assertEquals(1f, state.value, 0.001f)
    }

    @Test
    fun `hue follows the horizontal rainbow position`() {
        val state = HsvColorPickerState(hue = 0f, saturation = 1f, value = 1f)
            .withHue(x = 150f, width = 300f)

        assertEquals(180f, state.hue, 0.001f)
    }

    @Test
    fun `hue at the far right stays inside the canonical range`() {
        val state = HsvColorPickerState(hue = 0f, saturation = 1f, value = 1f)
            .withHue(x = 300f, width = 300f)

        assertEquals(359f, state.hue, 0.001f)
    }

    @Test
    fun `accessibility adjustments wrap hue and clamp saturation and value`() {
        val high = HsvColorPickerState(hue = 355f, saturation = 0.98f, value = 0.02f)
        assertEquals(5f, high.adjusted(HsvAdjustment.HUE_INCREASE).hue, 0.001f)
        assertEquals(1f, high.adjusted(HsvAdjustment.SATURATION_INCREASE).saturation, 0.001f)
        assertEquals(0f, high.adjusted(HsvAdjustment.VALUE_DECREASE).value, 0.001f)

        val low = HsvColorPickerState(hue = 5f, saturation = 0f, value = 1f)
        assertEquals(355f, low.adjusted(HsvAdjustment.HUE_DECREASE).hue, 0.001f)
    }

    @Test
    fun `invalid stored colors fall back to the control specific default`() {
        assertEquals(
            DanmakuSettings.DEFAULT_BALL_COLOR,
            ColorPickerPolicy.resolveStoredHex("broken", DanmakuSettings.DEFAULT_BALL_COLOR),
        )
        assertEquals(
            DanmakuSettings.DEFAULT_INPUT_COLOR,
            ColorPickerPolicy.resolveStoredHex("#xyzxyz", DanmakuSettings.DEFAULT_INPUT_COLOR),
        )
    }

    @Test
    fun `hex colors are normalized for storage and display`() {
        assertEquals("#58A6FF", ColorPickerPolicy.normalizeHex("58a6ff"))
        assertEquals("#2EBD85", ColorPickerPolicy.normalizeHex("  #2ebd85 "))
        assertNull(ColorPickerPolicy.normalizeHex("not-a-color"))
        assertEquals("#58A6FF", ColorPickerPolicy.rgbToHex(0x8058A6FF.toInt()))
    }
}

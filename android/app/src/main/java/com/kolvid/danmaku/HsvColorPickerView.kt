package com.kolvid.danmaku

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ComposeShader
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.RectF
import android.graphics.Shader
import android.os.Bundle
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.view.ViewCompat
import kotlin.math.roundToInt

/**
 * Overlay-safe inline HSV picker: saturation/value square plus a hue strip.
 * Uses Android's Color.colorToHSV / HSVToColor APIs without a Dialog or dependency.
 */
class HsvColorPickerView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : View(context, attrs, defStyleAttr) {

    private enum class DragArea { NONE, SATURATION_VALUE, HUE }

    private val density = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val markerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2f * density
    }
    private val saturationValueRect = RectF()
    private val hueRect = RectF()
    private val hueColors = intArrayOf(
        Color.RED,
        Color.YELLOW,
        Color.GREEN,
        Color.CYAN,
        Color.BLUE,
        Color.MAGENTA,
        Color.RED,
    )

    private val gap = 14f * density
    private val hueHeight = 48f * density
    private val cornerRadius = 8f * density
    private var dragArea = DragArea.NONE
    private var state = HsvColorPickerState(hue = 210f, saturation = 0.65f, value = 1f)
    private var colorChangedListener: ((Int) -> Unit)? = null
    private var saturationValueShader: Shader? = null
    private var hueShader: Shader? = null

    init {
        isClickable = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        contentDescription = context.getString(R.string.color_picker_description)
        updateAccessibilityState()
    }

    fun setOnColorChangedListener(listener: ((Int) -> Unit)?) {
        colorChangedListener = listener
    }

    fun setColor(color: Int, notify: Boolean = false) {
        val hsv = FloatArray(3)
        Color.colorToHSV(color, hsv)
        state = HsvColorPickerState(
            hue = hsv[0],
            saturation = hsv[1],
            value = hsv[2],
        )
        rebuildSaturationValueShader()
        updateAccessibilityState()
        invalidate()
        if (notify) notifyColorChanged()
    }

    fun getColor(): Int = Color.HSVToColor(
        floatArrayOf(state.hue, state.saturation, state.value),
    )

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val desiredWidth = (280f * density).toInt()
        val desiredHeight = (238f * density).toInt()
        setMeasuredDimension(
            resolveSize(desiredWidth, widthMeasureSpec),
            resolveSize(desiredHeight, heightMeasureSpec),
        )
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        updateBounds(w, h)
        rebuildShaders()
    }

    private fun updateBounds(w: Int = width, h: Int = height) {
        val left = paddingLeft.toFloat()
        val top = paddingTop.toFloat()
        val right = (w - paddingRight).toFloat().coerceAtLeast(left + 1f)
        val bottom = (h - paddingBottom).toFloat().coerceAtLeast(top + hueHeight + gap + 1f)
        val hueTop = (bottom - hueHeight).coerceAtLeast(top + 1f)
        saturationValueRect.set(left, top, right, (hueTop - gap).coerceAtLeast(top + 1f))
        hueRect.set(left, hueTop, right, bottom)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (saturationValueRect.width() <= 0f || saturationValueRect.height() <= 0f) {
            updateBounds()
            rebuildShaders()
        }
        if (saturationValueShader == null || hueShader == null) rebuildShaders()

        paint.shader = saturationValueShader
        canvas.drawRoundRect(saturationValueRect, cornerRadius, cornerRadius, paint)

        paint.shader = hueShader
        canvas.drawRoundRect(hueRect, cornerRadius, cornerRadius, paint)
        paint.shader = null

        drawMarkers(canvas)
    }

    private fun rebuildShaders() {
        if (saturationValueRect.width() <= 0f || saturationValueRect.height() <= 0f) return
        rebuildSaturationValueShader()
        hueShader = LinearGradient(
            hueRect.left,
            hueRect.top,
            hueRect.right,
            hueRect.top,
            hueColors,
            null,
            Shader.TileMode.CLAMP,
        )
    }

    private fun rebuildSaturationValueShader() {
        if (saturationValueRect.width() <= 0f || saturationValueRect.height() <= 0f) return
        val hueColor = Color.HSVToColor(floatArrayOf(state.hue, 1f, 1f))
        val saturationShader = LinearGradient(
            saturationValueRect.left,
            saturationValueRect.top,
            saturationValueRect.right,
            saturationValueRect.top,
            Color.WHITE,
            hueColor,
            Shader.TileMode.CLAMP,
        )
        val valueShader = LinearGradient(
            saturationValueRect.left,
            saturationValueRect.top,
            saturationValueRect.left,
            saturationValueRect.bottom,
            Color.WHITE,
            Color.BLACK,
            Shader.TileMode.CLAMP,
        )
        saturationValueShader = ComposeShader(
            saturationShader,
            valueShader,
            PorterDuff.Mode.MULTIPLY,
        )
    }

    private fun drawMarkers(canvas: Canvas) {
        val svX = saturationValueRect.left + state.saturation * saturationValueRect.width()
        val svY = saturationValueRect.top + (1f - state.value) * saturationValueRect.height()
        markerPaint.color = Color.BLACK
        markerPaint.strokeWidth = 4f * density
        canvas.drawCircle(svX, svY, 8f * density, markerPaint)
        markerPaint.color = Color.WHITE
        markerPaint.strokeWidth = 2f * density
        canvas.drawCircle(svX, svY, 8f * density, markerPaint)

        val hueFraction = (state.hue / 360f).coerceIn(0f, 1f)
        val hueX = hueRect.left + hueFraction * hueRect.width()
        markerPaint.color = Color.BLACK
        markerPaint.strokeWidth = 5f * density
        canvas.drawLine(hueX, hueRect.top - 2f * density, hueX, hueRect.bottom + 2f * density, markerPaint)
        markerPaint.color = Color.WHITE
        markerPaint.strokeWidth = 2f * density
        canvas.drawLine(hueX, hueRect.top - 2f * density, hueX, hueRect.bottom + 2f * density, markerPaint)
    }

    override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(info)
        info.className = HsvColorPickerView::class.java.name
        info.addAction(
            AccessibilityNodeInfo.AccessibilityAction(
                R.id.accessibility_hue_decrease,
                context.getString(R.string.color_picker_hue_decrease),
            ),
        )
        info.addAction(
            AccessibilityNodeInfo.AccessibilityAction(
                R.id.accessibility_hue_increase,
                context.getString(R.string.color_picker_hue_increase),
            ),
        )
        info.addAction(
            AccessibilityNodeInfo.AccessibilityAction(
                R.id.accessibility_saturation_decrease,
                context.getString(R.string.color_picker_saturation_decrease),
            ),
        )
        info.addAction(
            AccessibilityNodeInfo.AccessibilityAction(
                R.id.accessibility_saturation_increase,
                context.getString(R.string.color_picker_saturation_increase),
            ),
        )
        info.addAction(
            AccessibilityNodeInfo.AccessibilityAction(
                R.id.accessibility_value_decrease,
                context.getString(R.string.color_picker_value_decrease),
            ),
        )
        info.addAction(
            AccessibilityNodeInfo.AccessibilityAction(
                R.id.accessibility_value_increase,
                context.getString(R.string.color_picker_value_increase),
            ),
        )
    }

    override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
        val adjustment = when (action) {
            R.id.accessibility_hue_decrease -> HsvAdjustment.HUE_DECREASE
            R.id.accessibility_hue_increase -> HsvAdjustment.HUE_INCREASE
            R.id.accessibility_saturation_decrease -> HsvAdjustment.SATURATION_DECREASE
            R.id.accessibility_saturation_increase -> HsvAdjustment.SATURATION_INCREASE
            R.id.accessibility_value_decrease -> HsvAdjustment.VALUE_DECREASE
            R.id.accessibility_value_increase -> HsvAdjustment.VALUE_INCREASE
            else -> return super.performAccessibilityAction(action, arguments)
        }
        val previousHue = state.hue
        state = state.adjusted(adjustment)
        if (state.hue != previousHue) rebuildSaturationValueShader()
        updateAccessibilityState()
        invalidate()
        notifyColorChanged()
        announceForAccessibility(accessibilitySummary())
        return true
    }

    private fun accessibilitySummary(): String = context.getString(
        R.string.color_picker_state,
        ColorPickerPolicy.rgbToHex(getColor()),
        state.hue.roundToInt(),
        (state.saturation * 100f).roundToInt(),
        (state.value * 100f).roundToInt(),
    )

    private fun updateAccessibilityState() {
        ViewCompat.setStateDescription(this, accessibilitySummary())
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragArea = when {
                    saturationValueRect.contains(event.x, event.y) -> DragArea.SATURATION_VALUE
                    hueRect.contains(event.x, event.y) -> DragArea.HUE
                    else -> DragArea.NONE
                }
                if (dragArea == DragArea.NONE) return false
                parent?.requestDisallowInterceptTouchEvent(true)
                updateFromTouch(event.x, event.y)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (dragArea == DragArea.NONE) return false
                updateFromTouch(event.x, event.y)
                return true
            }
            MotionEvent.ACTION_UP -> {
                if (dragArea == DragArea.NONE) return false
                updateFromTouch(event.x, event.y)
                dragArea = DragArea.NONE
                parent?.requestDisallowInterceptTouchEvent(false)
                performClick()
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                dragArea = DragArea.NONE
                parent?.requestDisallowInterceptTouchEvent(false)
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    private fun updateFromTouch(x: Float, y: Float) {
        val previousHue = state.hue
        state = when (dragArea) {
            DragArea.SATURATION_VALUE -> state.withSaturationValue(
                x = x - saturationValueRect.left,
                y = y - saturationValueRect.top,
                width = saturationValueRect.width(),
                height = saturationValueRect.height(),
            )
            DragArea.HUE -> state.withHue(
                x = x - hueRect.left,
                width = hueRect.width(),
            )
            DragArea.NONE -> state
        }
        if (state.hue != previousHue) rebuildSaturationValueShader()
        updateAccessibilityState()
        invalidate()
        notifyColorChanged()
    }

    private fun notifyColorChanged() {
        colorChangedListener?.invoke(getColor())
    }

    override fun performClick(): Boolean {
        super.performClick()
        announceForAccessibility(accessibilitySummary())
        return true
    }
}

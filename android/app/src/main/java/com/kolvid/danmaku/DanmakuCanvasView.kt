package com.kolvid.danmaku

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.hardware.input.InputManager
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager

/**
 * 彈幕渲染層 — 全螢幕透明 View，touch-through。
 * Canvas 只負責繪圖；Window alpha 需符合 Android 12+ 不受信任 overlay 的穿透限制。
 */
class DanmakuCanvasView(
    context: Context,
    private val screenWidth: Int,
    private val screenHeight: Int,
) : View(context) {

    private data class DanmakuItem(
        var x: Float,
        val y: Float,
        val speedPxPerMs: Float,
        val paint: Paint,
        val text: String,
        val textWidth: Float,
        val lane: Int,
    )

    private val items = mutableListOf<DanmakuItem>()
    private val maxOnScreen = 120
    private var animating = false
    private var lastFrameNanos = 0L

    private var dmColor: Int = Color.parseColor("#E6EDF3")
    private var dmSize: Float = 20f
    private var dmOpacity: Float = 0.9f

    val layoutParams: WindowManager.LayoutParams = WindowManager.LayoutParams(
        WindowManager.LayoutParams.MATCH_PARENT,
        WindowManager.LayoutParams.MATCH_PARENT,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        android.graphics.PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = 0
        y = 0
        alpha = safeOverlayWindowAlpha(context)
    }

    init {
        setLayerType(LAYER_TYPE_HARDWARE, null)
    }

    fun updateStyle(color: String, size: Float, opacity: Float) {
        dmColor = try {
            Color.parseColor(color)
        } catch (_: Exception) {
            Color.parseColor("#E6EDF3")
        }
        dmSize = size.coerceIn(12f, 48f)
        dmOpacity = opacity.coerceIn(0.1f, 1.0f)
    }

    fun addDanmaku(text: String, nickname: String, colorStr: String) {
        if (items.size >= maxOnScreen) items.removeAt(0)

        val color = try {
            Color.parseColor(colorStr)
        } catch (_: Exception) {
            dmColor
        }
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = color
            textSize = danmakuTextSizePx()
            isFakeBoldText = true
            setShadowLayer(4f, 1f, 1f, 0x99000000.toInt())
            alpha = (dmOpacity * 255).toInt()
        }

        val fullText = "$nickname  $text"
        val textWidth = paint.measureText(fullText)
        val durationMs = 7000f + (0..4000).random()
        val speedPxPerMs = (screenWidth + textWidth + 40f) / durationMs
        val laneCount = currentLaneCount()
        val startX = screenWidth.toFloat() + 40f
        val lane = chooseLane(laneCount, startX, speedPxPerMs)
        val laneHeight = screenHeight.toFloat() / laneCount
        val y = laneHeight * lane + laneHeight * 0.7f

        items.add(
            DanmakuItem(
                x = startX,
                y = y,
                speedPxPerMs = speedPxPerMs,
                paint = paint,
                text = fullText,
                textWidth = textWidth,
                lane = lane,
            ),
        )

        if (!animating) startAnimation() else postInvalidateOnAnimation()
    }

    private fun currentLaneCount(): Int {
        val laneHeight = (danmakuTextSizePx() * 1.35f).coerceAtLeast(1f)
        return (screenHeight / laneHeight).toInt().coerceAtLeast(1)
    }

    private fun danmakuTextSizePx(): Float = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_SP,
        dmSize,
        resources.displayMetrics,
    )

    /**
     * 重用軌道時同時計算初始間距與速度差，避免較快的新彈幕追撞前一則。
     * 若所有軌都忙，選尾端最靠左的一軌；高流量時允許退化但不永久堵軌。
     */
    private fun chooseLane(laneCount: Int, startX: Float, newSpeedPxPerMs: Float): Int {
        val minimumGapPx = 24f * resources.displayMetrics.density
        val rightEdges = FloatArray(laneCount) { Float.NEGATIVE_INFINITY }
        for (item in items) {
            if (item.lane in 0 until laneCount) {
                rightEdges[item.lane] = maxOf(rightEdges[item.lane], item.x + item.textWidth)
            }
        }

        for (lane in 0 until laneCount) {
            val safe = items.asSequence()
                .filter { it.lane == lane }
                .all { item ->
                    DanmakuLanePolicy.canFollow(
                        startX = startX,
                        newSpeedPxPerMs = newSpeedPxPerMs,
                        existingRight = item.x + item.textWidth,
                        existingSpeedPxPerMs = item.speedPxPerMs,
                        minimumGapPx = minimumGapPx,
                    )
                }
            if (safe) return lane
        }

        var bestLane = 0
        for (i in 1 until laneCount) {
            if (rightEdges[i] < rightEdges[bestLane]) bestLane = i
        }
        return bestLane
    }

    fun clearAll() {
        items.clear()
        stopAnimation()
        invalidate()
    }

    fun startAnimation() {
        if (items.isEmpty()) return
        animating = true
        lastFrameNanos = 0L
        postInvalidateOnAnimation()
    }

    fun stopAnimation() {
        animating = false
        lastFrameNanos = 0L
    }

    override fun onDraw(canvas: Canvas) {
        if (!animating || items.isEmpty()) {
            animating = false
            lastFrameNanos = 0L
            return
        }

        val frameNanos = System.nanoTime()
        val deltaMs = if (lastFrameNanos == 0L) {
            16f
        } else {
            ((frameNanos - lastFrameNanos) / 1_000_000f).coerceIn(0f, 50f)
        }
        lastFrameNanos = frameNanos

        val iterator = items.iterator()
        while (iterator.hasNext()) {
            val item = iterator.next()
            item.x -= item.speedPxPerMs * deltaMs
            if (item.x + item.textWidth < 0f) {
                iterator.remove()
            } else {
                canvas.drawText(item.text, item.x, item.y, item.paint)
            }
        }

        if (items.isNotEmpty()) postInvalidateOnAnimation() else stopAnimation()
    }

    companion object {
        private fun safeOverlayWindowAlpha(context: Context): Float {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return 1f
            val inputManager = context.getSystemService(InputManager::class.java)
            val maximum = inputManager?.maximumObscuringOpacityForTouch ?: 0.8f
            return (maximum - 0.01f).coerceIn(0f, 0.79f)
        }
    }
}

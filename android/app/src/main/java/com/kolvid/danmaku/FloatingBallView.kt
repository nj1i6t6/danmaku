package com.kolvid.danmaku

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import kotlin.math.abs

/**
 * 懸浮球 View — 顯示人數 + 連線狀態
 * 手勢：拖曳 / 單擊 / 雙擊 / 長按 3 秒
 */
class FloatingBallView(
    context: Context,
    private val screenSize: Int,
    private val listener: BallListener,
) : View(context) {

    interface BallListener {
        fun onSingleClick()
        fun onDoubleClick()
        fun onDragged(x: Int, y: Int)
        fun onLongPress()
    }

    private var count = 0
    private var connected = false
    private var ballSize = DanmakuSettings.DEFAULT_BALL_SIZE
    private var ballColor = Color.parseColor(DanmakuSettings.DEFAULT_BALL_COLOR)
    private var ballOpacity = DanmakuSettings.DEFAULT_BALL_OPACITY

    private val ballPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 28f
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
        setShadowLayer(2f, 1f, 1f, 0x80000000.toInt())
    }
    private val statusPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF2EBD85.toInt()
        style = Paint.Style.FILL
    }
    private val statusRedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFF6465D.toInt()
        style = Paint.Style.FILL
    }

    // Drag/click state
    private val dragThreshold = 8f * resources.displayMetrics.density
    private val doubleClickMs = 250L
    private val longPressMs = 3000L
    private var startX = 0f
    private var startY = 0f
    private var lastTapTime = 0L
    private var isDragging = false
    private var longPressTriggered = false

    // 長按手勢
    private val handler = Handler(Looper.getMainLooper())
    private val longPressRunnable = Runnable {
        if (!isDragging) {
            longPressTriggered = true
            listener.onLongPress()
        }
    }
    private val singleClickRunnable = Runnable {
        if (lastTapTime != 0L && System.currentTimeMillis() - lastTapTime >= doubleClickMs - 10) {
            lastTapTime = 0L
            performClick()
        }
    }

    val layoutParams: WindowManager.LayoutParams = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        android.graphics.PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = 0
        y = 100
    }

    init {
        isClickable = true
        isFocusable = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        updateSize(ballSize)
        updateContentDescription()
    }

    fun updateStyle(color: String, size: Int, opacity: Float) {
        ballColor = try { Color.parseColor(color) } catch (e: Exception) { ballColor }
        ballSize = size
        ballOpacity = opacity.coerceIn(0.1f, 1.0f)
        updateSize(ballSize)
        invalidate()
    }

    private fun updateSize(size: Int) {
        val px = (size * resources.displayMetrics.density).toInt()
        layoutParams.width = px
        layoutParams.height = px
        textPaint.textSize = px * 0.25f
    }

    fun setCount(c: Int) {
        count = c
        updateContentDescription()
        invalidate()
    }

    fun setConnected(c: Boolean) {
        connected = c
        updateContentDescription()
        invalidate()
    }

    private fun updateContentDescription() {
        val connection = context.getString(
            if (connected) R.string.floating_ball_connected else R.string.floating_ball_disconnected,
        )
        contentDescription = context.getString(R.string.floating_ball_description, connection, count)
    }

    fun getPosition(): Pair<Int, Int> = Pair(layoutParams.x, layoutParams.y)

    fun setPosition(x: Int, y: Int) {
        layoutParams.x = x
        layoutParams.y = y
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val radius = minOf(width, height) / 2f - 2f

        ballPaint.color = ballColor
        ballPaint.alpha = (ballOpacity * 255).toInt()
        ballPaint.setShadowLayer(8f, 0f, 4f, 0x66000000)
        canvas.drawCircle(cx, cy, radius, ballPaint)

        // Count text
        textPaint.alpha = 255
        canvas.drawText(count.toString(), cx, cy + textPaint.textSize / 3f, textPaint)

        // Status dot
        val dotRadius = radius * 0.15f
        val dotX = cx + radius * 0.65f
        val dotY = cy + radius * 0.65f
        val dotPaint = if (connected) statusPaint else statusRedPaint
        canvas.drawCircle(dotX, dotY, dotRadius, dotPaint)
    }

    // Clicks are finalized by singleClickRunnable, which calls performClick().
    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                startX = event.rawX
                startY = event.rawY
                isDragging = false
                longPressTriggered = false
                // 開始長按計時
                handler.postDelayed(longPressRunnable, longPressMs)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = event.rawX - startX
                val dy = event.rawY - startY
                if (abs(dx) > dragThreshold || abs(dy) > dragThreshold) {
                    isDragging = true
                    // 拖曳時取消長按與待確認單擊
                    handler.removeCallbacks(longPressRunnable)
                    handler.removeCallbacks(singleClickRunnable)
                    lastTapTime = 0L
                    layoutParams.gravity = Gravity.TOP or Gravity.START
                    layoutParams.x = event.rawX.toInt() - width / 2
                    layoutParams.y = event.rawY.toInt() - height / 2
                    listener.onDragged(layoutParams.x, layoutParams.y)
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                // 取消長按計時
                handler.removeCallbacks(longPressRunnable)
                if (!isDragging && !longPressTriggered) {
                    val now = System.currentTimeMillis()
                    if (now - lastTapTime < doubleClickMs) {
                        handler.removeCallbacks(singleClickRunnable)
                        lastTapTime = 0L
                        listener.onDoubleClick()
                    } else {
                        lastTapTime = now
                        handler.removeCallbacks(singleClickRunnable)
                        handler.postDelayed(singleClickRunnable, doubleClickMs)
                    }
                } else {
                    // Save position
                    listener.onDragged(layoutParams.x, layoutParams.y)
                }
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                handler.removeCallbacks(longPressRunnable)
                handler.removeCallbacks(singleClickRunnable)
                lastTapTime = 0L
                longPressTriggered = false
                return true
            }
        }
        return false
    }

    override fun performClick(): Boolean {
        super.performClick()
        listener.onSingleClick()
        return true
    }

    override fun onDetachedFromWindow() {
        handler.removeCallbacksAndMessages(null)
        super.onDetachedFromWindow()
    }
}

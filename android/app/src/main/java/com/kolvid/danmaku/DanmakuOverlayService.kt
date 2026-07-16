package com.kolvid.danmaku

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.DisplayMetrics
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.widget.addTextChangedListener
import kotlin.math.abs

/**
 * 核心服務 — 管理 WindowManager overlay views + Socket.IO + 彈幕渲染
 */
class DanmakuOverlayService : Service(), DanmakuSocketClient.Callback,
    FloatingBallView.BallListener {

    private lateinit var windowManager: WindowManager
    private var socketClient: DanmakuSocketClient? = null
    private lateinit var ballView: FloatingBallView
    private lateinit var danmakuView: DanmakuCanvasView
    private var panelView: View? = null
    private var historyView: View? = null
    private var settingsView: View? = null
    private var roomManagementView: View? = null
    private var onboardingView: View? = null

    private var panelVisible = false
    private var danmakuVisible = true
    private var screenWidth = 1080
    private var screenHeight = 1920
    private val historyMessages = mutableListOf<DanmakuMsg>()
    @Volatile private var destroyed = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private fun postIfActive(action: () -> Unit) {
        if (destroyed) return
        mainHandler.post(Runnable {
            if (!destroyed) action()
        })
    }
    private val panelTransition = OverlayPanelTransition(::postIfActive)
    private val sendState = SendStateMachine(connected = false)
    private val connectionNoticeGate = ConnectionNoticeGate(initiallyConnected = false)
    private var lastRenderedSendMode: SendMode? = null
    private var composerDraft = ""
    private var currentNickname = NicknamePolicy.DEFAULT_NICKNAME
    private var currentNicknameChangeDate: String? = null
    private val nicknameRequests = LatestRequestGate()
    private var nicknameRequestPending = false
    private var currentRoom = RoomMetadata(
        "",
        "",
        0,
        0,
        RoomVisibility.PUBLIC,
        requiresPassword = false,
        retentionDays = null,
    )
    private val ownerCredentials by lazy { ownerCredentialStore() }
    private var joinedRoomCode: String? = null
    private var joiningRoomCode: String? = null
    private val defaultRoomRetryGate = BoundedRetryGate(DEFAULT_ROOM_RETRY_MAX)
    private val defaultRoomRequests = LatestRequestGate()
    private var defaultRoomRetryMessage: String? = null
    private val defaultRoomRetry = Runnable {
        if (destroyed) return@Runnable
        if (joinedRoomCode == null) joinDefaultRoom(defaultRoomRetryMessage)
    }
    private val sendStateTicker = object : Runnable {
        override fun run() {
            if (destroyed) return
            renderComposerState(announce = false)
            mainHandler.postDelayed(this, 1_000L)
        }
    }

    // 通知停止與主畫面即時重置指令用 BroadcastReceiver
    private var commandReceiver: BroadcastReceiver? = null

    companion object {
        private const val TAG = "DanmakuService"
        private const val NOTIF_ID = 1001
        private const val CHANNEL_ID = "danmaku_overlay"
        private const val DEFAULT_ROOM_RETRY_MAX = 3
        private const val DEFAULT_ROOM_RETRY_DELAY_MS = 1_000L
        private const val ACTION_STOP_SERVICE = "com.kolvid.danmaku.STOP_SERVICE"
        const val ACTION_RESET_POSITION = "com.kolvid.danmaku.RESET_POSITION"
        const val ACTION_RESET_ALL = "com.kolvid.danmaku.RESET_ALL"
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Service created")

        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        currentNickname = DanmakuSettings.getNickname(this)
        currentNicknameChangeDate = DanmakuSettings.getNicknameChangeDate(this)

        // Get screen size
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        windowManager.defaultDisplay.getMetrics(metrics)
        screenWidth = metrics.widthPixels
        screenHeight = metrics.heightPixels

        createNotificationChannel()
        startForegroundWithType()
        registerCommandReceiver()

        if (!Settings.canDrawOverlays(this)) {
            Log.e(TAG, "Overlay permission missing; stopping service")
            stopSelf()
            return
        }

        val viewsAttached = initViews()
        if (!DanmakuUiPolicy.shouldInitializeSocket(viewsAttached)) return
        initSocket()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (destroyed) return START_NOT_STICKY
        when (intent?.action) {
            ACTION_RESET_POSITION -> resetBallPositionLive()
            ACTION_RESET_ALL -> resetAllLive()
        }
        return START_NOT_STICKY
    }

    private fun initViews(): Boolean {
        // Danmaku canvas (full screen, touch-through)
        danmakuView = DanmakuCanvasView(this, screenWidth, screenHeight)
        danmakuView.updateStyle(
            DanmakuSettings.getDmColor(this),
            DanmakuSettings.getDmSize(this),
            DanmakuSettings.getDmOpacity(this),
        )
        if (!safeAddOverlayView(danmakuView, danmakuView.layoutParams, "danmaku")) return false

        // Floating ball
        ballView = FloatingBallView(this, screenWidth, this)
        ballView.updateStyle(
            DanmakuSettings.getBallColor(this),
            DanmakuSettings.getBallSize(this),
            DanmakuSettings.getBallOpacity(this),
        )
        // Restore position；座標一律使用 TOP|START 的絕對座標。
        val savedX = DanmakuSettings.getBallX(this)
        val savedY = DanmakuSettings.getBallY(this)
        ballView.layoutParams.gravity = Gravity.TOP or Gravity.START
        val defaultX = (screenWidth - ballView.layoutParams.width - dp(20)).coerceAtLeast(0)
        val initialX = if (savedX >= 0) savedX else defaultX
        val (clampedX, clampedY) = clampBallPosition(initialX, savedY)
        ballView.setPosition(clampedX, clampedY)
        if (!safeAddOverlayView(ballView, ballView.layoutParams, "ball")) {
            safeRemoveView(danmakuView, "rollback danmaku")
            return false
        }

        // Show onboarding if first time
        if (!DanmakuSettings.getOnboarded(this)) {
            if (!showOnboarding()) return false
        }

        danmakuVisible = DanmakuSettings.getDmVisible(this)
        if (!danmakuVisible) {
            danmakuView.visibility = View.GONE
            danmakuView.stopAnimation()
        }
        return true
    }

    private fun initSocket() {
        socketClient = DanmakuSocketClient(DanmakuSettings.getOrCreateClientId(this), this)
        socketClient?.connect()
        mainHandler.post(sendStateTicker)
    }

    private fun discoverDefaultRoom(
        retryOnFailure: Boolean = false,
        isCurrent: () -> Boolean = { true },
        result: (RoomMetadata?) -> Unit,
    ) {
        if (!isCurrent()) {
            result(null)
            return
        }
        val client = socketClient
        if (client == null) {
            if (retryOnFailure) {
                scheduleDefaultRoomRetry(SocketError(SocketErrorCode.NOT_CONNECTED, getString(R.string.send_disconnected)))
            }
            result(null)
            return
        }
        client.defaultRoom callback@{ response ->
            if (!isCurrent()) {
                result(null)
                return@callback
            }
            when (response) {
                is SocketResult.Success -> {
                    val room = response.value
                    DanmakuSettings.setDefaultRoomCode(this, room.roomCode)
                    result(room)
                }
                is SocketResult.Failure -> {
                    if (retryOnFailure) {
                        scheduleDefaultRoomRetry(response.error)
                    } else if (response.error.code != SocketErrorCode.NOT_CONNECTED) {
                        toast(getString(R.string.room_error, response.error.message))
                    }
                    result(null)
                }
            }
        }
    }

    private fun joinDefaultRoom(message: String? = null) {
        if (message != null) defaultRoomRetryMessage = message
        if (!defaultRoomRetryGate.tryStart()) return
        val request = defaultRoomRequests.next()
        discoverDefaultRoom(
            retryOnFailure = true,
            isCurrent = { defaultRoomRequests.isCurrent(request) },
        ) { defaultRoom ->
            if (defaultRoom == null) return@discoverDefaultRoom
            DanmakuSettings.setCurrentRoomCode(this, defaultRoom.roomCode)
            val client = socketClient
            if (client == null) {
                scheduleDefaultRoomRetry(SocketError(SocketErrorCode.NOT_CONNECTED, getString(R.string.send_disconnected)))
                return@discoverDefaultRoom
            }
            client.joinRoom(defaultRoom.roomCode) { joinResult ->
                when (joinResult) {
                    is SocketResult.Success -> {
                        defaultRoomRetryGate.succeeded()
                        mainHandler.removeCallbacks(defaultRoomRetry)
                        defaultRoomRetryMessage?.let(::toast)
                        defaultRoomRetryMessage = null
                    }
                    is SocketResult.Failure -> scheduleDefaultRoomRetry(joinResult.error)
                }
            }
        }
    }

    private fun cancelDefaultRoomRecovery() {
        defaultRoomRequests.invalidate()
        mainHandler.removeCallbacks(defaultRoomRetry)
        defaultRoomRetryGate.reset()
        defaultRoomRetryMessage = null
    }

    private fun scheduleDefaultRoomRetry(error: SocketError) {
        val canRetry = defaultRoomRetryGate.failed()
        if (joinedRoomCode != null) return
        val transient = error.code in setOf(SocketErrorCode.TIMEOUT, SocketErrorCode.UNKNOWN)
        if (transient && canRetry) {
            mainHandler.removeCallbacks(defaultRoomRetry)
            mainHandler.postDelayed(defaultRoomRetry, DEFAULT_ROOM_RETRY_DELAY_MS)
            renderComposerState(announce = false)
            return
        }
        if (error.code != SocketErrorCode.NOT_CONNECTED) {
            toast(getString(R.string.room_error, error.message))
        }
    }

    private fun joinCurrentRoom() {
        val roomCode = DanmakuSettings.getCurrentRoomCode(this)
        if (roomCode == null) {
            joinDefaultRoom()
            return
        }
        cancelDefaultRoomRecovery()
        socketClient?.joinRoom(roomCode) { result ->
            if (result is SocketResult.Failure) handleJoinFailure(roomCode, result.error)
        }
    }

    private fun handleJoinFailure(roomCode: String, error: SocketError) {
        if (error.code == SocketErrorCode.NOT_CONNECTED) return
        when (error.code) {
            SocketErrorCode.ROOM_NOT_FOUND -> {
                DanmakuSettings.removeJoinedRoom(this, roomCode)
                runCatching { ownerCredentials.remove(roomCode) }
                joinDefaultRoom(getString(R.string.room_unavailable))
            }
            SocketErrorCode.PASSWORD_REQUIRED, SocketErrorCode.INVALID_PASSWORD, SocketErrorCode.ROOM_FULL -> {
                joinDefaultRoom(getString(R.string.room_reauth_required))
            }
            SocketErrorCode.TIMEOUT, SocketErrorCode.UNKNOWN -> {
                if (roomCode == DanmakuSettings.getDefaultRoomCode(this)) {
                    defaultRoomRetryGate.reset()
                    joinDefaultRoom()
                } else {
                    toast(getString(R.string.room_error, error.message))
                }
            }
            else -> toast(getString(R.string.room_error, error.message))
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun hideKeyboardAndClearFocus(focused: View?) {
        if (focused == null) return
        val inputMethodManager = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        focused.windowToken?.let { inputMethodManager.hideSoftInputFromWindow(it, 0) }
        focused.clearFocus()
    }

    private fun bindDoneAction(input: EditText, onDone: (() -> Unit)? = null) {
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId != EditorInfo.IME_ACTION_DONE) return@setOnEditorActionListener false
            onDone?.invoke()
            hideKeyboardAndClearFocus(input)
            true
        }
    }

    private fun bindColorPickerControl(
        button: Button,
        pickerPanel: View,
        initialColor: String,
        fallbackColor: String,
        beforeOpen: (View) -> Unit,
        onColorApplied: (String) -> Unit,
    ) {
        var committedColor = ColorPickerPolicy.resolveStoredHex(initialColor, fallbackColor)
        val picker = pickerPanel.findViewById<HsvColorPickerView>(R.id.color_picker_surface)
        val preview = pickerPanel.findViewById<View>(R.id.color_picker_preview)
        val hexLabel = pickerPanel.findViewById<TextView>(R.id.color_picker_hex)
        val applyButton = pickerPanel.findViewById<Button>(R.id.color_picker_apply)
        val cancelButton = pickerPanel.findViewById<Button>(R.id.color_picker_cancel)

        fun renderPreview(color: Int) {
            val hex = ColorPickerPolicy.rgbToHex(color)
            preview.setBackgroundColor(color)
            preview.contentDescription = getString(R.string.current_color_description, hex)
            hexLabel.text = hex
        }

        fun resetPicker() {
            val color = Color.parseColor(committedColor)
            picker.setColor(color)
            renderPreview(color)
        }

        fun updateButtonLabel() {
            button.text = getString(R.string.color_button_label, committedColor)
            button.contentDescription = getString(R.string.adjust_color_description, committedColor)
        }

        pickerPanel.visibility = View.GONE
        updateButtonLabel()
        picker.setOnColorChangedListener(::renderPreview)
        button.setOnClickListener {
            if (pickerPanel.visibility == View.VISIBLE) {
                pickerPanel.visibility = View.GONE
            } else {
                beforeOpen(pickerPanel)
                resetPicker()
                pickerPanel.visibility = View.VISIBLE
                postIfActive {
                    pickerPanel.requestRectangleOnScreen(
                        Rect(0, 0, pickerPanel.width, pickerPanel.height),
                        true,
                    )
                }
            }
        }
        cancelButton.setOnClickListener {
            resetPicker()
            pickerPanel.visibility = View.GONE
        }
        applyButton.setOnClickListener {
            committedColor = ColorPickerPolicy.rgbToHex(picker.getColor())
            updateButtonLabel()
            onColorApplied(committedColor)
            pickerPanel.visibility = View.GONE
        }
    }

    private fun refreshBallStyle() {
        if (!::ballView.isInitialized) return
        ballView.updateStyle(
            DanmakuSettings.getBallColor(this),
            DanmakuSettings.getBallSize(this),
            DanmakuSettings.getBallOpacity(this),
        )
        val (x, y) = clampBallPosition(ballView.layoutParams.x, ballView.layoutParams.y)
        ballView.setPosition(x, y)
        try {
            windowManager.updateViewLayout(ballView, ballView.layoutParams)
        } catch (e: Exception) {
            Log.w(TAG, "refresh ball style error", e)
        }
    }

    private fun refreshDanmakuStyle() {
        if (!::danmakuView.isInitialized) return
        danmakuView.updateStyle(
            DanmakuSettings.getDmColor(this),
            DanmakuSettings.getDmSize(this),
            DanmakuSettings.getDmOpacity(this),
        )
    }

    private fun applyInputStyle(input: EditText) {
        val color = try {
            Color.parseColor(DanmakuSettings.getInputColor(this))
        } catch (_: IllegalArgumentException) {
            Color.parseColor(DanmakuSettings.DEFAULT_INPUT_COLOR)
        }
        input.textSize = DanmakuSettings.getInputSize(this)
        input.background.mutate().setTint(
            DanmakuUiPolicy.withOpacity(color, DanmakuSettings.getInputOpacity(this)),
        )
        val luminance = (
            0.2126 * Color.red(color) +
                0.7152 * Color.green(color) +
                0.0722 * Color.blue(color)
            ) / 255.0
        input.setTextColor(if (luminance > 0.65) Color.BLACK else Color.WHITE)
    }

    private fun clampBallPosition(x: Int, y: Int): Pair<Int, Int> {
        val width = ballView.layoutParams.width.takeIf { it > 0 }
            ?: dp(DanmakuSettings.DEFAULT_BALL_SIZE)
        val height = ballView.layoutParams.height.takeIf { it > 0 } ?: width
        val maxX = (screenWidth - width).coerceAtLeast(0)
        val maxY = (screenHeight - height).coerceAtLeast(0)
        return x.coerceIn(0, maxX) to y.coerceIn(0, maxY)
    }

    private fun placeNextToBall(
        params: WindowManager.LayoutParams,
        overlayWidth: Int,
        overlayHeight: Int,
        belowBall: Boolean,
    ) {
        val margin = dp(8)
        val (ballX, ballY) = ballView.getPosition()
        val ballWidth = ballView.width.coerceAtLeast(ballView.layoutParams.width.coerceAtLeast(1))
        val ballHeight = ballView.height.coerceAtLeast(ballView.layoutParams.height.coerceAtLeast(1))
        val rightX = ballX + ballWidth + margin
        val leftX = ballX - overlayWidth - margin
        val availableMaxX = (screenWidth - overlayWidth - margin).coerceAtLeast(margin)

        params.gravity = Gravity.TOP or Gravity.START
        params.x = if (rightX + overlayWidth + margin <= screenWidth) rightX else leftX.coerceAtLeast(margin)
        params.x = params.x.coerceIn(margin, availableMaxX)

        val desiredY = if (belowBall) ballY + ballHeight + margin else ballY
        val availableMaxY = (screenHeight - overlayHeight - margin).coerceAtLeast(margin)
        params.y = desiredY.coerceIn(margin, availableMaxY)
    }

    private fun clampOverlayAfterLayout(view: View, params: WindowManager.LayoutParams) {
        postIfActive {
            val margin = dp(8)
            val width = view.width.coerceAtLeast(if (params.width > 0) params.width else 1)
            val height = view.height.coerceAtLeast(if (params.height > 0) params.height else 1)
            val maxX = (screenWidth - width - margin).coerceAtLeast(margin)
            val maxY = (screenHeight - height - margin).coerceAtLeast(margin)
            val clampedX = params.x.coerceIn(margin, maxX)
            val clampedY = params.y.coerceIn(margin, maxY)
            if (clampedX != params.x || clampedY != params.y) {
                params.x = clampedX
                params.y = clampedY
                try {
                    windowManager.updateViewLayout(view, params)
                } catch (e: Exception) {
                    Log.w(TAG, "clamp overlay error", e)
                }
            }
        }
    }

    private fun safeAddOverlayView(
        view: View,
        params: WindowManager.LayoutParams,
        label: String,
    ): Boolean {
        if (!DanmakuUiPolicy.canAttachOverlay(Settings.canDrawOverlays(this))) {
            Log.e(TAG, "$label attach blocked: overlay permission unavailable")
            stopSelf()
            return false
        }
        return try {
            windowManager.addView(view, params)
            true
        } catch (e: SecurityException) {
            Log.e(TAG, "$label attach denied", e)
            stopSelf()
            false
        } catch (e: WindowManager.BadTokenException) {
            Log.e(TAG, "$label attach rejected", e)
            stopSelf()
            false
        } catch (e: IllegalStateException) {
            Log.e(TAG, "$label attach invalid state", e)
            stopSelf()
            false
        }
    }

    private fun safeRemoveView(view: View?, label: String) {
        if (view == null) return
        try {
            windowManager.removeView(view)
        } catch (e: Exception) {
            Log.w(TAG, "$label remove error", e)
        }
    }

    private fun resetBallPositionLive() {
        if (!::ballView.isInitialized) return
        val defaultX = (screenWidth - ballView.layoutParams.width - dp(20)).coerceAtLeast(0)
        val (x, y) = clampBallPosition(defaultX, dp(100))
        ballView.layoutParams.gravity = Gravity.TOP or Gravity.START
        ballView.setPosition(x, y)
        DanmakuSettings.resetBallPosition(this)
        try {
            windowManager.updateViewLayout(ballView, ballView.layoutParams)
        } catch (e: Exception) {
            Log.w(TAG, "reset ball position error", e)
        }
        closeAllPanels()
    }

    private fun resetAllLive() {
        if (!::ballView.isInitialized || !::danmakuView.isInitialized) return
        DanmakuSettings.resetAll(this)
        refreshBallStyle()
        refreshDanmakuStyle()
        danmakuVisible = true
        danmakuView.visibility = View.VISIBLE
        joinCurrentRoom()
        resetBallPositionLive()
        toast(getString(R.string.settings_reset_done))
    }

    // --- BallListener ---

    override fun onSingleClick() {
        if (destroyed) return
        togglePanel()
    }

    override fun onDoubleClick() {
        if (destroyed) return
        toggleDanmaku()
    }

    override fun onDragged(x: Int, y: Int) {
        if (destroyed) return
        val (clampedX, clampedY) = clampBallPosition(x, y)
        ballView.layoutParams.gravity = Gravity.TOP or Gravity.START
        ballView.setPosition(clampedX, clampedY)
        DanmakuSettings.setBallPos(this, clampedX, clampedY)
        try {
            windowManager.updateViewLayout(ballView, ballView.layoutParams)
        } catch (e: Exception) {
            Log.w(TAG, "onDragged updateViewLayout ball error", e)
        }

        panelView?.let { repositionOverlay(it, belowBall = false) }
        historyView?.let { repositionOverlay(it, belowBall = true) }
        settingsView?.let { repositionOverlay(it, belowBall = true) }
        roomManagementView?.let { repositionOverlay(it, belowBall = true) }
    }

    private fun repositionOverlay(view: View, belowBall: Boolean) {
        try {
            val params = view.layoutParams as WindowManager.LayoutParams
            val width = view.width.coerceAtLeast(if (params.width > 0) params.width else screenWidth / 2)
            val height = view.height.coerceAtLeast(if (params.height > 0) params.height else screenHeight / 2)
            placeNextToBall(params, width, height, belowBall)
            windowManager.updateViewLayout(view, params)
        } catch (e: Exception) {
            Log.w(TAG, "reposition overlay error", e)
        }
    }

    override fun onLongPress() {
        if (destroyed) return
        // 長按 3 秒 → 停止服務
        toast(getString(R.string.long_press_closing))
        stopSelf()
    }

    // --- Panel ---

    private fun togglePanel() {
        if (panelView != null || historyView != null || settingsView != null || roomManagementView != null) {
            closeAllPanels()
        } else {
            showPanel()
        }
    }

    private fun showPanel() {
        val inflater = LayoutInflater.from(this)
        val panel = inflater.inflate(R.layout.panel_view, null)

        val savedWidth = DanmakuSettings.getPanelWidth(this)
        val savedHeight = DanmakuSettings.getPanelHeight(this)
        val availableWidth = (screenWidth - dp(16)).coerceAtLeast(1)
        val minimumWidth = minOf(dp(280), availableWidth)
        val requestedWidth = (savedWidth * resources.displayMetrics.density).toInt()
        val widthPx = requestedWidth.coerceIn(minimumWidth, availableWidth)
        val heightPx = if (savedHeight > 0) {
            (savedHeight * resources.displayMetrics.density).toInt().coerceAtMost(screenHeight - dp(16))
        } else {
            WindowManager.LayoutParams.WRAP_CONTENT
        }

        val params = WindowManager.LayoutParams(
            widthPx,
            heightPx,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        )
        placeNextToBall(params, widthPx, if (heightPx > 0) heightPx else screenHeight / 3, belowBall = false)

        val roomButton = panel.findViewById<Button>(R.id.panel_room_label)
        renderRoomHeader(roomButton)
        roomButton.setOnClickListener { replacePanel(::showRoomManagement) }

        // Input + send
        val input = panel.findViewById<EditText>(R.id.panel_msg_input)
        applyInputStyle(input)
        input.setText(composerDraft)
        input.setSelection(input.text.length)
        val sendBtn = panel.findViewById<Button>(R.id.panel_send_btn)
        sendBtn.setOnClickListener {
            val text = input.text.toString().trim()
            composerDraft = input.text.toString()
            if (text.isNotEmpty() && sendState.state(SystemClock.elapsedRealtime()).mode == SendMode.READY) {
                submitComposer(text, input)
            } else {
                explainSendState(sendBtn)
            }
        }
        panel.findViewById<Button>(R.id.panel_retry_btn).setOnClickListener {
            val retry = sendState.peekRetry() ?: return@setOnClickListener
            submitComposer(retry, input)
        }

        // History button
        panel.findViewById<Button>(R.id.panel_history_btn).setOnClickListener {
            replacePanel(::showHistory)
        }

        // Settings button
        panel.findViewById<Button>(R.id.panel_settings_btn).setOnClickListener {
            replacePanel(::showSettings)
        }

        // 將 panel 包進只允許標題列拖曳的 wrapper
        val wrappedPanel = wrapWithDragLayout(panel, params, R.id.panel_drag_handle)
        if (!safeAddOverlayView(wrappedPanel, params, "composer panel")) return
        panelView = wrappedPanel
        panelVisible = true
        clampOverlayAfterLayout(wrappedPanel, params)

        // Make it focusable for input，同時明確保留 NOT_TOUCH_MODAL。
        params.flags = params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
        params.flags = params.flags or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
        windowManager.updateViewLayout(wrappedPanel, params)

        input.requestFocus()
        renderComposerState(announce = false)
    }

    private fun renderRoomHeader(button: Button) {
        val name = currentRoom.name.ifBlank { getString(R.string.composer_room_default) }
        button.text = getString(
            R.string.composer_room_details,
            name,
            currentRoom.roomCode,
            currentRoom.count,
            currentRoom.capacity,
        )
        button.contentDescription = getString(
            R.string.open_room_management,
            name,
            currentRoom.roomCode,
            currentRoom.count,
            currentRoom.capacity,
        )
    }

    private fun submitComposer(snapshot: String, input: EditText) {
        if (currentRoom.roomCode.isEmpty() || joinedRoomCode != currentRoom.roomCode) {
            composerDraft = input.text.toString()
            renderComposerState(announce = false)
            explainSendState(input)
            return
        }
        val generation = sendState.begin(snapshot)
        if (generation == null) {
            explainSendState(input)
            return
        }
        renderComposerState(announce = false)
        val client = socketClient
        if (client == null) {
            val effect = sendState.ack(
                generation,
                BarrageAck.Error(SocketError(SocketErrorCode.NOT_CONNECTED, getString(R.string.send_disconnected))),
                input.text.toString(),
                SystemClock.elapsedRealtime(),
            )
            composerDraft = effect.draft
            renderComposerState(announce = true)
            return
        }
        client.sendBarrage(snapshot, currentNickname, DanmakuSettings.getDmColor(this)) { ack ->
            postIfActive {
                val currentInput = panelView?.findViewById<EditText>(R.id.panel_msg_input)?.text?.toString() ?: composerDraft
                val effect = sendState.ack(generation, ack, currentInput, SystemClock.elapsedRealtime())
                composerDraft = effect.draft
                panelView?.findViewById<EditText>(R.id.panel_msg_input)?.let { live ->
                    if (live.text.toString() != effect.draft) {
                        live.setText(effect.draft)
                        live.setSelection(live.text.length)
                    }
                }
                renderComposerState(announce = ack is BarrageAck.Error)
            }
        }
    }

    private fun renderComposerState(announce: Boolean) {
        val root = panelView ?: return
        val button = root.findViewById<Button>(R.id.panel_send_btn) ?: return
        val statusView = root.findViewById<TextView>(R.id.panel_send_status)
        val retryButton = root.findViewById<Button>(R.id.panel_retry_btn)
        val state = sendState.state(SystemClock.elapsedRealtime())
        val shouldAnnounce = ComposerAccessibilityPolicy.shouldAnnounce(lastRenderedSendMode, state.mode, announce)
        lastRenderedSendMode = state.mode
        val roomReady = currentRoom.roomCode.isNotEmpty() && joinedRoomCode == currentRoom.roomCode
        val text = when {
            state.mode == SendMode.DISCONNECTED -> getString(R.string.send_disconnected)
            !roomReady -> getString(R.string.send_joining_room)
            else -> when (state.mode) {
                SendMode.READY -> getString(R.string.send_ready)
                SendMode.PENDING -> getString(R.string.send_pending)
                SendMode.QUEUED -> getString(R.string.send_queued, state.queuePosition ?: 0, ((state.estimatedWaitMs ?: 0) + 999) / 1000)
                SendMode.COOLDOWN -> getString(R.string.send_cooldown, state.remainingSeconds)
                SendMode.MUTED -> getString(R.string.send_muted, state.remainingSeconds / 60, state.remainingSeconds % 60)
                SendMode.ROOM_BUSY -> getString(R.string.send_room_busy, state.remainingSeconds)
                SendMode.DISCONNECTED -> getString(R.string.send_disconnected)
            }
        }
        val description = when {
            state.mode == SendMode.DISCONNECTED -> getString(R.string.send_state_disconnected)
            !roomReady -> getString(R.string.send_state_joining_room)
            else -> when (state.mode) {
                SendMode.READY -> getString(R.string.send_state_ready)
                SendMode.PENDING -> getString(R.string.send_state_pending)
                SendMode.QUEUED -> getString(R.string.send_state_queued, state.queuePosition ?: 0, ((state.estimatedWaitMs ?: 0) + 999) / 1000)
                SendMode.COOLDOWN, SendMode.MUTED, SendMode.ROOM_BUSY -> getString(R.string.send_state_limited, state.reason.orEmpty(), state.remainingSeconds)
                SendMode.DISCONNECTED -> getString(R.string.send_state_disconnected)
            }
        }
        button.text = text
        button.alpha = if (roomReady && state.mode == SendMode.READY) 1f else 0.55f
        button.isEnabled = true
        button.isClickable = true
        button.contentDescription = "$text. $description"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) button.stateDescription = description
        statusView.text = if (state.retryText != null) getString(R.string.retry_available) else description
        retryButton.visibility = if (state.retryText != null) View.VISIBLE else View.GONE
        if (shouldAnnounce) button.announceForAccessibility(description)
    }

    private fun explainSendState(source: View) {
        renderComposerState(announce = false)
        val description = panelView?.findViewById<Button>(R.id.panel_send_btn)?.contentDescription?.toString().orEmpty()
        if (description.isNotBlank()) {
            toast(description)
            source.announceForAccessibility(description)
        }
    }

    private fun closePanel() {
        panelView?.let {
            composerDraft = it.findViewById<EditText>(R.id.panel_msg_input)?.text?.toString() ?: composerDraft
            try { windowManager.removeView(it) } catch (e: Exception) { Log.w(TAG, "closePanel error", e) }
            panelView = null
        }
        panelVisible = false
    }

    private fun closeAllPanels() {
        closePanel()
        closeHistory()
        closeSettings()
        closeRoomManagement()
    }

    /**
     * WindowManager overlay 不在同一個觸控 dispatch 內同步換窗，避免尾端事件落到新面板。
     */
    private fun replacePanel(openNext: () -> Unit) {
        panelTransition.replace(
            closeCurrent = ::closeAllPanels,
            openNext = {
                if (panelView == null && historyView == null && settingsView == null && roomManagementView == null) {
                    openNext()
                }
            },
        )
    }

    // --- History ---

    private fun showHistory() {
        val inflater = LayoutInflater.from(this)
        val view = inflater.inflate(R.layout.history_view, null)
        historyView = view

        val historyWidth = (screenWidth * 0.8f).toInt().coerceAtMost(screenWidth - dp(16))
        val historyHeight = (screenHeight * 0.5f).toInt().coerceAtMost(screenHeight - dp(16))
        val params = WindowManager.LayoutParams(
            historyWidth,
            historyHeight,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        )
        placeNextToBall(params, historyWidth, historyHeight, belowBall = true)

        val listContainer = view.findViewById<LinearLayout>(R.id.history_list_container)
        listContainer.removeAllViews()
        for (msg in historyMessages) {
            val item = LayoutInflater.from(this).inflate(R.layout.history_item, null)
            item.findViewById<TextView>(R.id.hist_nick).text = msg.nickname.ifBlank { getString(R.string.anonymous) }
            item.findViewById<TextView>(R.id.hist_text).text = msg.text
            item.findViewById<TextView>(R.id.hist_text).setTextColor(
                try { android.graphics.Color.parseColor(msg.color) }
                catch (e: Exception) { android.graphics.Color.parseColor("#E6EDF3") }
            )
            item.findViewById<Button>(R.id.hist_report).setOnClickListener {
                val client = socketClient
                if (client == null) {
                    toast(getString(R.string.send_disconnected))
                } else {
                    client.report(msg.messageId, msg.sessionId, msg.text) { success, error ->
                        postIfActive {
                            toast(if (success) getString(R.string.report_sent) else error ?: getString(R.string.report_failed))
                        }
                    }
                }
            }
            listContainer.addView(item)
        }
        // Scroll to bottom
        val scrollView = view.findViewById<ScrollView>(R.id.history_scroll)
        postIfActive {
            scrollView.fullScroll(View.FOCUS_DOWN)
        }

        view.findViewById<Button>(R.id.history_close_btn).setOnClickListener {
            replacePanel(::showPanel)
        }

        val wrappedHistory = wrapWithDragLayout(view, params, R.id.history_drag_handle)
        if (!safeAddOverlayView(wrappedHistory, params, "history panel")) return
        historyView = wrappedHistory
        clampOverlayAfterLayout(wrappedHistory, params)
    }

    private fun closeHistory() {
        historyView?.let {
            try { windowManager.removeView(it) } catch (e: Exception) { Log.w(TAG, "closeHistory error", e) }
            historyView = null
        }
    }

    // --- Room management (separate from appearance settings) ---

    @Suppress("DEPRECATION")
    private fun showRoomManagement() {
        val view = LayoutInflater.from(this).inflate(R.layout.room_management_view, null)
        val width = (screenWidth * 0.9f).toInt().coerceAtMost(screenWidth - dp(16))
        val height = (screenHeight * 0.85f).toInt().coerceAtMost(screenHeight - dp(16))
        val params = WindowManager.LayoutParams(
            width,
            height,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        )
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        placeNextToBall(params, width, height, belowBall = true)

        view.findViewById<Button>(R.id.room_close_btn).setOnClickListener { replacePanel(::showPanel) }
        view.findViewById<Button>(R.id.room_default_btn).apply {
            text = getString(R.string.default_room_loading)
            isEnabled = false
            discoverDefaultRoom { room ->
                if (room == null) return@discoverDefaultRoom
                text = roomSummary(room)
                contentDescription = getString(R.string.room_switch_description, room.name, room.roomCode)
                isEnabled = true
                setOnClickListener { joinFromManager(room.roomCode, null) }
            }
        }

        renderJoinedRooms(view)
        bindPublicRooms(view)
        bindRoomLookup(view)
        bindRoomCreation(view)
        bindOwnerManagement(view)

        val wrapped = wrapWithDragLayout(view, params, R.id.room_drag_handle)
        if (!safeAddOverlayView(wrapped, params, "room management panel")) return
        roomManagementView = wrapped
        clampOverlayAfterLayout(wrapped, params)
        params.flags = params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
        params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
        windowManager.updateViewLayout(wrapped, params)
    }

    private fun renderJoinedRooms(root: View) {
        val container = root.findViewById<LinearLayout>(R.id.room_joined_list)
        container.removeAllViews()
        val defaultRoomCode = DanmakuSettings.getDefaultRoomCode(this)
        DanmakuSettings.getJoinedRooms(this).codes.filter { it != defaultRoomCode }.forEach { roomCode ->
            var roomName = roomCode
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val button = roomButton(roomCode, roomCode) { joinFromManager(roomCode, null) }
            row.addView(button, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            val exitButton = Button(this).apply {
                text = getString(R.string.exit_room)
                isAllCaps = false
                minWidth = dp(48)
                minHeight = dp(48)
                contentDescription = getString(R.string.exit_room_description, roomName, roomCode)
                setOnClickListener { exitJoinedRoom(root, roomCode, roomName) }
            }
            row.addView(exitButton, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ))
            container.addView(row)
            socketClient?.lookupRoom(roomCode) { result ->
                postIfActive {
                    when (result) {
                        is SocketResult.Success -> {
                            val room = result.value
                            roomName = room.name
                            button.text = roomSummary(room)
                            button.contentDescription = getString(R.string.room_switch_description, room.name, room.roomCode)
                            exitButton.contentDescription = getString(R.string.exit_room_description, room.name, room.roomCode)
                            button.setOnClickListener {
                                if (room.requiresPassword) {
                                    root.findViewById<EditText>(R.id.room_code_input).setText(room.roomCode)
                                    root.findViewById<Button>(R.id.room_lookup_btn).performClick()
                                } else {
                                    joinFromManager(room.roomCode, null)
                                }
                            }
                        }
                        is SocketResult.Failure -> if (result.error.code == SocketErrorCode.ROOM_NOT_FOUND) {
                            button.text = getString(R.string.room_code_unavailable, roomCode)
                            DanmakuSettings.removeJoinedRoom(this, roomCode)
                        }
                    }
                }
            }
        }
    }

    private fun exitJoinedRoom(root: View, roomCode: String, roomName: String) {
        if (joiningRoomCode == roomCode) {
            toast(getString(R.string.send_joining_room))
            return
        }
        when (RoomExitPolicy.action(roomCode, currentRoom.roomCode.takeIf { it.isNotEmpty() }, DanmakuSettings.getDefaultRoomCode(this))) {
            RoomExitAction.BLOCK_DEFAULT -> toast(getString(R.string.room_exit_default_forbidden))
            RoomExitAction.REMOVE_SHORTCUT -> {
                DanmakuSettings.removeJoinedRoom(this, roomCode)
                toast(getString(R.string.room_exited_shortcut, roomName))
                renderJoinedRooms(root)
            }
            RoomExitAction.SWITCH_TO_DEFAULT -> {
                DanmakuSettings.removeJoinedRoom(this, roomCode)
                DanmakuSettings.getDefaultRoomCode(this)?.let {
                    DanmakuSettings.setCurrentRoomCode(this, it)
                } ?: DanmakuSettings.clearCurrentRoomCode(this)
                socketClient?.clearDesiredRoomIntent()
                joiningRoomCode = null
                joinedRoomCode = null
                val input = panelView?.findViewById<EditText>(R.id.panel_msg_input)
                val effect = sendState.roomChanged(input?.text?.toString() ?: composerDraft)
                composerDraft = effect.draft
                currentRoom = RoomMetadata("", "", 0, 0, RoomVisibility.PUBLIC, false, null)
                historyMessages.clear()
                if (::ballView.isInitialized) ballView.setCount(0)
                renderComposerState(announce = false)
                renderJoinedRooms(root)
                mainHandler.removeCallbacks(defaultRoomRetry)
                defaultRoomRetryGate.reset()
                joinDefaultRoom(getString(R.string.room_exited_to_default, roomName))
            }
        }
    }

    private fun bindPublicRooms(root: View) {
        var page = 1
        var totalPages = 1
        val requests = LatestRequestGate()
        val query = root.findViewById<EditText>(R.id.room_public_query)
        val container = root.findViewById<LinearLayout>(R.id.room_public_list)
        val status = root.findViewById<TextView>(R.id.room_page_status)
        val previous = root.findViewById<Button>(R.id.room_prev_btn)
        val next = root.findViewById<Button>(R.id.room_next_btn)
        fun renderPaginationControls(loading: Boolean = false) {
            val hasPrevious = !loading && page > 1
            val hasNext = !loading && page < totalPages
            previous.isEnabled = hasPrevious
            next.isEnabled = hasNext
            previous.alpha = if (hasPrevious) 1f else 0.55f
            next.alpha = if (hasNext) 1f else 0.55f
            val previousDescription = if (hasPrevious) {
                getString(R.string.previous_page_available, page - 1)
            } else {
                getString(R.string.previous_page_unavailable)
            }
            val nextDescription = if (hasNext) {
                getString(R.string.next_page_available, page + 1)
            } else {
                getString(R.string.next_page_unavailable)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                previous.stateDescription = previousDescription
                next.stateDescription = nextDescription
            } else {
                previous.contentDescription = previousDescription
                next.contentDescription = nextDescription
            }
        }
        fun resetPublicResults() {
            requests.invalidate()
            page = 1
            totalPages = 1
            container.removeAllViews()
            status.text = null
            renderPaginationControls()
        }
        fun load() {
            val requestId = requests.next()
            val requestedQuery = query.text.toString()
            val requestedPage = page
            status.text = getString(R.string.room_loading)
            renderPaginationControls(loading = true)
            val client = socketClient
            if (client == null) {
                requests.invalidate()
                status.text = getString(R.string.send_disconnected)
                renderPaginationControls()
                return
            }
            client.listPublicRooms(requestedQuery, requestedPage) { result ->
                postIfActive {
                    if (!requests.isCurrent(requestId)) return@postIfActive
                    container.removeAllViews()
                    when (result) {
                        is SocketResult.Success -> {
                            page = result.value.pagination.page
                            totalPages = result.value.pagination.totalPages.coerceAtLeast(1)
                            result.value.rooms.forEach { room ->
                                container.addView(roomButton(roomSummary(room), room.roomCode) { joinFromManager(room.roomCode, null) })
                            }
                            if (result.value.rooms.isEmpty()) status.text = getString(R.string.room_public_empty)
                            else status.text = getString(R.string.page_status, page, totalPages)
                        }
                        is SocketResult.Failure -> status.text = getString(R.string.room_error, result.error.message)
                    }
                    renderPaginationControls()
                }
            }
        }
        fun search() {
            resetPublicResults()
            load()
        }
        root.findViewById<Button>(R.id.room_public_search_btn).setOnClickListener { search() }
        query.setOnEditorActionListener { _, _, _ -> search(); true }
        query.addTextChangedListener { resetPublicResults() }
        previous.setOnClickListener { if (page > 1) { page--; load() } }
        next.setOnClickListener { if (page < totalPages) { page++; load() } }
        load()
    }

    private fun bindRoomLookup(root: View) {
        val code = root.findViewById<EditText>(R.id.room_code_input)
        val password = root.findViewById<EditText>(R.id.room_join_password)
        val summary = root.findViewById<TextView>(R.id.room_lookup_summary)
        val join = root.findViewById<Button>(R.id.room_join_btn)
        val lookupButton = root.findViewById<Button>(R.id.room_lookup_btn)
        val requests = LatestRequestGate()
        var lookup: RoomMetadata? = null
        code.addTextChangedListener {
            requests.invalidate()
            lookup = null
            join.visibility = View.GONE
            password.visibility = View.GONE
            summary.text = null
        }
        lookupButton.setOnClickListener {
            val roomCode = code.text.toString()
            if (!RoomPolicy.isValidCode(roomCode)) {
                code.error = getString(R.string.room_invalid_code)
                return@setOnClickListener
            }
            val requestId = requests.next()
            summary.text = getString(R.string.room_loading)
            lookup = null
            join.visibility = View.GONE
            password.visibility = View.GONE
            val client = socketClient
            if (client == null) {
                requests.invalidate()
                summary.text = getString(R.string.send_disconnected)
                return@setOnClickListener
            }
            client.lookupRoom(roomCode) { result ->
                postIfActive {
                    if (!requests.isCurrent(requestId) || code.text.toString() != roomCode) return@postIfActive
                    when (result) {
                        is SocketResult.Success -> {
                            if (result.value.roomCode != roomCode) {
                                lookup = null
                                summary.text = getString(R.string.room_error, getString(R.string.room_invalid_code))
                                return@postIfActive
                            }
                            lookup = result.value
                            summary.text = getString(
                                if (result.value.requiresPassword) R.string.room_lookup_requires_password else R.string.room_lookup_no_password,
                                result.value.name,
                                result.value.roomCode,
                                result.value.count,
                                result.value.capacity,
                            )
                            password.visibility = if (result.value.requiresPassword) View.VISIBLE else View.GONE
                            join.visibility = View.VISIBLE
                        }
                        is SocketResult.Failure -> summary.text = getString(R.string.room_error, result.error.message)
                    }
                }
            }
        }
        join.setOnClickListener {
            val roomCode = code.text.toString()
            lookup?.takeIf { it.roomCode == roomCode }?.let { room ->
                joinFromManager(room.roomCode, password.text.toString().takeIf { room.requiresPassword })
            }
        }
        bindDoneAction(code) { lookupButton.performClick() }
        bindDoneAction(password) { if (join.visibility == View.VISIBLE) join.performClick() }
    }

    private fun bindRoomCreation(root: View) {
        val name = root.findViewById<EditText>(R.id.room_create_name)
        val public = root.findViewById<android.widget.RadioButton>(R.id.room_visibility_public)
        val unlisted = root.findViewById<android.widget.RadioButton>(R.id.room_visibility_unlisted)
        val requirePassword = root.findViewById<CheckBox>(R.id.room_require_password)
        val password = root.findViewById<EditText>(R.id.room_create_password)
        val retention = root.findViewById<Spinner>(R.id.room_retention_spinner)
        bindDoneAction(name)
        bindDoneAction(password)
        retention.adapter = android.widget.ArrayAdapter(
            this,
            R.layout.room_retention_spinner_item,
            arrayOf(getString(R.string.retention_one_day), getString(R.string.retention_three_days), getString(R.string.retention_seven_days)),
        ).also { adapter ->
            adapter.setDropDownViewResource(R.layout.room_retention_spinner_item)
        }
        retention.setSelection(RoomPolicy.RETENTION_DAYS.indexOf(RoomPolicy.DEFAULT_RETENTION_DAYS))
        fun updatePasswordVisibility() {
            requirePassword.visibility = if (unlisted.isChecked) View.VISIBLE else View.GONE
            if (!unlisted.isChecked) requirePassword.isChecked = false
            password.visibility = if (unlisted.isChecked && requirePassword.isChecked) View.VISIBLE else View.GONE
        }
        public.setOnCheckedChangeListener { _, _ -> updatePasswordVisibility() }
        requirePassword.setOnCheckedChangeListener { _, _ -> updatePasswordVisibility() }
        root.findViewById<Button>(R.id.room_create_btn).setOnClickListener {
            val visibility = if (unlisted.isChecked) RoomVisibility.UNLISTED else RoomVisibility.PUBLIC
            val secret = password.text.toString().takeIf { requirePassword.isChecked }
            val days = RoomPolicy.RETENTION_DAYS[retention.selectedItemPosition.coerceIn(0, 2)]
            val validation = RoomPolicy.validateCreate(name.text.toString(), visibility, secret, days)
            if (!validation.isValid) {
                name.error = getString(R.string.room_error, validation.reason.orEmpty())
                return@setOnClickListener
            }
            val client = socketClient
            if (client == null) {
                toast(getString(R.string.send_disconnected))
                return@setOnClickListener
            }
            cancelDefaultRoomRecovery()
            client.createRoom(RoomCreateRequest(name.text.toString(), visibility, secret, days)) { result ->
                postIfActive {
                    when (result) {
                        is SocketResult.Success -> {
                            val created = result.value
                            val secured = created.ownerCredential?.let { credential ->
                                runCatching { ownerCredentials.put(created.room.roomCode, credential) }.isSuccess
                            } ?: false
                            if (!secured) toast(getString(R.string.room_owner_credential_unavailable))
                            toast(getString(R.string.room_created))
                            replacePanel(::showPanel)
                        }
                        is SocketResult.Failure -> {
                            toast(getString(R.string.room_error, result.error.message))
                            if (joinedRoomCode == null) joinDefaultRoom()
                        }
                    }
                }
            }
        }
    }

    private fun bindOwnerManagement(root: View) {
        val credential = runCatching { ownerCredentials.get(currentRoom.roomCode) }.getOrNull() ?: return
        val section = root.findViewById<LinearLayout>(R.id.room_owner_section)
        section.visibility = View.VISIBLE
        val name = root.findViewById<EditText>(R.id.room_owner_name)
        name.setText(currentRoom.name)
        val public = root.findViewById<android.widget.RadioButton>(R.id.room_owner_visibility_public)
        val unlisted = root.findViewById<android.widget.RadioButton>(R.id.room_owner_visibility_unlisted)
        if (currentRoom.visibility == RoomVisibility.PUBLIC) public.isChecked = true else unlisted.isChecked = true
        val password = root.findViewById<EditText>(R.id.room_owner_password)
        val removePassword = root.findViewById<CheckBox>(R.id.room_owner_remove_password)
        root.findViewById<Button>(R.id.room_owner_update_btn).setOnClickListener {
            val passwordAction = when {
                removePassword.isChecked -> org.json.JSONObject().put("type", "remove")
                password.text.isNotEmpty() -> org.json.JSONObject().put("type", "set").put("password", password.text.toString())
                else -> null
            }
            val request = RoomUpdateRequest(
                currentRoom.roomCode,
                name.text.toString(),
                if (unlisted.isChecked) RoomVisibility.UNLISTED else RoomVisibility.PUBLIC,
                passwordAction,
            )
            socketClient?.updateRoom(request, credential) { result ->
                postIfActive {
                    when (result) {
                        is SocketResult.Success -> { currentRoom = result.value; toast(getString(R.string.room_updated)); replacePanel(::showRoomManagement) }
                        is SocketResult.Failure -> toast(getString(R.string.room_error, result.error.message))
                    }
                }
            }
        }
        root.findViewById<Button>(R.id.room_owner_delete_btn).setOnClickListener {
            socketClient?.deleteRoom(currentRoom.roomCode, credential) { result ->
                postIfActive {
                    when (result) {
                        is SocketResult.Success -> {
                            val deletedCode = currentRoom.roomCode
                            ownerCredentials.remove(deletedCode)
                            DanmakuSettings.removeJoinedRoom(this, deletedCode)
                            DanmakuSettings.getDefaultRoomCode(this)?.let {
                                DanmakuSettings.setCurrentRoomCode(this, it)
                            } ?: DanmakuSettings.clearCurrentRoomCode(this)
                            currentRoom = currentRoom.copy(roomCode = "", name = "", count = 0, capacity = 0)
                            toast(getString(R.string.room_closed))
                            joinCurrentRoom()
                            replacePanel(::showPanel)
                        }
                        is SocketResult.Failure -> toast(getString(R.string.room_error, result.error.message))
                    }
                }
            }
        }
    }

    private fun roomButton(label: String, roomCode: String, action: () -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        minHeight = dp(48)
        contentDescription = getString(R.string.room_switch_description, label, roomCode)
        setOnClickListener { action() }
    }

    private fun roomSummary(room: RoomMetadata): String =
        getString(R.string.room_summary, room.name, room.roomCode, room.count, room.capacity)

    private fun joinFromManager(roomCode: String, password: String?) {
        val client = socketClient
        if (client == null) {
            toast(getString(R.string.send_disconnected))
            return
        }
        cancelDefaultRoomRecovery()
        joiningRoomCode = roomCode
        client.joinRoom(roomCode, password) { result ->
            postIfActive {
                if (joiningRoomCode == roomCode) joiningRoomCode = null
                when (result) {
                    is SocketResult.Success -> {
                        currentRoom = result.value.room
                        DanmakuSettings.setCurrentRoomCode(this, roomCode)
                        DanmakuSettings.addJoinedRoom(this, roomCode)
                        toast(getString(R.string.room_joined, result.value.room.name))
                        replacePanel(::showPanel)
                    }
                    is SocketResult.Failure -> {
                        toast(getString(R.string.room_error, result.error.message))
                        if (joinedRoomCode == null) joinDefaultRoom()
                    }
                }
            }
        }
    }

    private fun closeRoomManagement() {
        roomManagementView?.let {
            try { windowManager.removeView(it) } catch (error: Exception) { Log.w(TAG, "closeRoomManagement error", error) }
            roomManagementView = null
        }
    }

    // --- Settings ---

    @Suppress("DEPRECATION")
    private fun showSettings() {
        val inflater = LayoutInflater.from(this)
        val view = inflater.inflate(R.layout.settings_view, null)
        settingsView = view

        val settingsWidth = (screenWidth * 0.75f).toInt().coerceAtMost(screenWidth - dp(16))
        val settingsHeight = (screenHeight * 0.8f).toInt().coerceAtMost(screenHeight - dp(16))
        val params = WindowManager.LayoutParams(
            settingsWidth,
            settingsHeight,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        )
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        placeNextToBall(params, settingsWidth, settingsHeight, belowBall = true)
        bindNicknameSettings(view)

        var activeColorPickerPanel: View? = null
        val beforeColorPickerOpen: (View) -> Unit = { nextPanel ->
            activeColorPickerPanel
                ?.takeIf { it !== nextPanel }
                ?.let { it.visibility = View.GONE }
            activeColorPickerPanel = nextPanel
        }

        // Ball settings
        bindColorPickerControl(
            view.findViewById(R.id.settings_ball_color),
            view.findViewById(R.id.settings_ball_color_picker),
            DanmakuSettings.getBallColor(this),
            DanmakuSettings.DEFAULT_BALL_COLOR,
            beforeColorPickerOpen,
        ) { color ->
            DanmakuSettings.setBallColor(this, color)
            refreshBallStyle()
        }

        val ballSizeBar = view.findViewById<SeekBar>(R.id.settings_ball_size)
        ballSizeBar.progress = DanmakuSettings.getBallSize(this)
        ballSizeBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                DanmakuSettings.setBallSize(this@DanmakuOverlayService, progress.coerceIn(32, 96))
                refreshBallStyle()
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })

        val ballOpacityBar = view.findViewById<SeekBar>(R.id.settings_ball_opacity)
        ballOpacityBar.progress = (DanmakuSettings.getBallOpacity(this) * 100).toInt()
        ballOpacityBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                val v = progress.coerceAtLeast(10) / 100f
                DanmakuSettings.setBallOpacity(this@DanmakuOverlayService, v)
                refreshBallStyle()
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })

        // Danmaku settings
        bindColorPickerControl(
            view.findViewById(R.id.settings_dm_color),
            view.findViewById(R.id.settings_dm_color_picker),
            DanmakuSettings.getDmColor(this),
            DanmakuSettings.DEFAULT_DM_COLOR,
            beforeColorPickerOpen,
        ) { color ->
            DanmakuSettings.setDmColor(this, color)
            refreshDanmakuStyle()
        }

        val dmSizeBar = view.findViewById<SeekBar>(R.id.settings_dm_size)
        dmSizeBar.progress = DanmakuSettings.getDmSize(this).toInt()
        dmSizeBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                DanmakuSettings.setDmSize(this@DanmakuOverlayService, progress.coerceIn(12, 48).toFloat())
                refreshDanmakuStyle()
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })

        val dmOpacityBar = view.findViewById<SeekBar>(R.id.settings_dm_opacity)
        dmOpacityBar.progress = (DanmakuSettings.getDmOpacity(this) * 100).toInt()
        dmOpacityBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                DanmakuSettings.setDmOpacity(
                    this@DanmakuOverlayService,
                    progress.coerceAtLeast(10) / 100f,
                )
                refreshDanmakuStyle()
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })

        // Input settings (applied when the input panel opens again)
        bindColorPickerControl(
            view.findViewById(R.id.settings_input_color),
            view.findViewById(R.id.settings_input_color_picker),
            DanmakuSettings.getInputColor(this),
            DanmakuSettings.DEFAULT_INPUT_COLOR,
            beforeColorPickerOpen,
        ) { color -> DanmakuSettings.setInputColor(this, color) }

        val inputSizeBar = view.findViewById<SeekBar>(R.id.settings_input_size)
        inputSizeBar.progress = DanmakuSettings.getInputSize(this).toInt()
        inputSizeBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (fromUser) {
                    DanmakuSettings.setInputSize(
                        this@DanmakuOverlayService,
                        progress.coerceIn(12, 32).toFloat(),
                    )
                }
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })

        val inputOpacityBar = view.findViewById<SeekBar>(R.id.settings_input_opacity)
        inputOpacityBar.progress = (DanmakuSettings.getInputOpacity(this) * 100).toInt()
        inputOpacityBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (fromUser) {
                    DanmakuSettings.setInputOpacity(
                        this@DanmakuOverlayService,
                        progress.coerceAtLeast(10) / 100f,
                    )
                }
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })

        // Panel width SeekBar
        val panelWidthBar = view.findViewById<SeekBar>(R.id.settings_panel_width)
        panelWidthBar.progress = DanmakuSettings.getPanelWidth(this)
        panelWidthBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                val w = progress.coerceAtLeast(280)
                DanmakuSettings.setPanelSize(this@DanmakuOverlayService, w, DanmakuSettings.getPanelHeight(this@DanmakuOverlayService))
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {
                toast(getString(R.string.panel_width_updated))
            }
        })

        // Panel height SeekBar
        val panelHeightBar = view.findViewById<SeekBar>(R.id.settings_panel_height)
        panelHeightBar.progress = DanmakuSettings.getPanelHeight(this)
        panelHeightBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                DanmakuSettings.setPanelSize(this@DanmakuOverlayService, DanmakuSettings.getPanelWidth(this@DanmakuOverlayService), progress)
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {
                toast(getString(R.string.panel_height_updated))
            }
        })

        // Reset buttons
        view.findViewById<Button>(R.id.settings_reset_btn).setOnClickListener {
            resetAllLive()
            replacePanel(::showPanel)
        }

        view.findViewById<Button>(R.id.settings_help_btn).setOnClickListener {
            replacePanel { showOnboarding() }
        }

        view.findViewById<Button>(R.id.settings_close_btn).setOnClickListener {
            replacePanel(::showPanel)
        }

        val wrappedSettings = wrapWithDragLayout(view, params, R.id.settings_drag_handle)
        if (!safeAddOverlayView(wrappedSettings, params, "settings panel")) return
        settingsView = wrappedSettings
        clampOverlayAfterLayout(wrappedSettings, params)
        params.flags = params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
        params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
        windowManager.updateViewLayout(wrappedSettings, params)
    }

    private fun renderNicknameSettings(root: View, message: String? = null) {
        val input = root.findViewById<EditText>(R.id.settings_nickname_input)
        val save = root.findViewById<Button>(R.id.settings_nickname_save)
        val status = root.findViewById<TextView>(R.id.settings_nickname_status)
        val available = !nicknameRequestPending && NicknamePolicy.canChange(currentNicknameChangeDate)
        input.isEnabled = available
        save.isEnabled = available
        input.alpha = if (available) 1f else 0.6f
        save.alpha = if (available) 1f else 0.6f
        status.text = message ?: getString(
            when {
                nicknameRequestPending -> R.string.nickname_saving
                available -> R.string.nickname_available
                else -> R.string.nickname_locked
            },
        )
    }

    private fun bindNicknameSettings(root: View) {
        val input = root.findViewById<EditText>(R.id.settings_nickname_input)
        val save = root.findViewById<Button>(R.id.settings_nickname_save)
        input.setText(currentNickname)

        fun submit() {
            if (nicknameRequestPending) {
                renderNicknameSettings(root, getString(R.string.nickname_saving))
                return
            }
            if (!NicknamePolicy.canChange(currentNicknameChangeDate)) {
                renderNicknameSettings(root)
                return
            }
            val requested = NicknamePolicy.normalize(input.text.toString())
            if (!NicknamePolicy.isLocallyValid(requested)) {
                input.error = getString(R.string.nickname_invalid)
                return
            }
            if (requested == currentNickname) {
                renderNicknameSettings(root, getString(R.string.nickname_saved))
                return
            }
            val requestId = nicknameRequests.next()
            nicknameRequestPending = true
            renderNicknameSettings(root, getString(R.string.nickname_saving))
            val client = socketClient
            if (client == null) {
                nicknameRequests.invalidate()
                nicknameRequestPending = false
                renderNicknameSettings(root, getString(R.string.nickname_error, getString(R.string.send_disconnected)))
                return
            }
            client.changeNickname(requested) { result ->
                postIfActive {
                    if (!nicknameRequests.isCurrent(requestId)) return@postIfActive
                    nicknameRequestPending = false
                    val message = when (result) {
                        is SocketResult.Success -> {
                            currentNickname = result.value.nickname
                            currentNicknameChangeDate = result.value.changeDate
                            val persisted = runCatching {
                                DanmakuSettings.saveNicknameChange(this, currentNickname, result.value.changeDate)
                            }.getOrDefault(false)
                            getString(if (persisted) R.string.nickname_saved else R.string.nickname_storage_warning)
                        }
                        is SocketResult.Failure -> {
                            if (result.error.code == SocketErrorCode.RATE_LIMITED && result.error.scope == "nickname") {
                                currentNicknameChangeDate = NicknamePolicy.taipeiDate()
                                getString(R.string.nickname_locked)
                            } else {
                                getString(R.string.nickname_error, result.error.message)
                            }
                        }
                    }
                    settingsView?.let { activeSettings ->
                        activeSettings.findViewById<EditText>(R.id.settings_nickname_input).setText(currentNickname)
                        renderNicknameSettings(activeSettings, message)
                    }
                }
            }
        }

        save.setOnClickListener { submit() }
        bindDoneAction(input) { save.performClick() }
        renderNicknameSettings(root)
    }

    private fun closeSettings() {
        settingsView?.let {
            try { windowManager.removeView(it) } catch (e: Exception) { Log.w(TAG, "closeSettings error", e) }
            settingsView = null
        }
    }

    // --- 拖曳功能 ---

    /**
     * 只有標題列可拖曳；SeekBar、Spinner、EditText 與 ScrollView 的手勢不再被搶走。
     */
    private fun wrapWithDragLayout(
        view: View,
        params: WindowManager.LayoutParams,
        dragHandleId: Int,
    ): View {
        val dragHandle = view.findViewById<View>(dragHandleId)
        val wrapper = object : android.widget.FrameLayout(this) {
            private var startRawX = 0f
            private var startRawY = 0f
            private var startWindowX = 0
            private var startWindowY = 0
            private var isDragging = false
            private var dragAllowed = false
            private val dragThreshold = ViewConfiguration.get(this@DanmakuOverlayService).scaledTouchSlop

            private fun closeSelf() {
                if (panelView === this) closePanel()
                else if (historyView === this) closeHistory()
                else if (settingsView === this) closeSettings()
                else if (roomManagementView === this) closeRoomManagement()
            }

            private fun isPointInside(view: View, event: MotionEvent): Boolean {
                if (view.visibility != View.VISIBLE || view.width <= 0 || view.height <= 0) return false
                val location = IntArray(2)
                view.getLocationOnScreen(location)
                return event.rawX >= location[0] && event.rawX <= location[0] + view.width &&
                    event.rawY >= location[1] && event.rawY <= location[1] + view.height
            }

            private fun isTouchOnClickableDescendant(root: View, event: MotionEvent): Boolean {
                val group = root as? ViewGroup ?: return false
                for (index in 0 until group.childCount) {
                    val child = group.getChildAt(index)
                    if (!isPointInside(child, event)) continue
                    if (child.isClickable || isTouchOnClickableDescendant(child, event)) return true
                }
                return false
            }

            private fun isTouchOnEditor(root: View, event: MotionEvent): Boolean {
                if (root is EditText && isPointInside(root, event)) return true
                val group = root as? ViewGroup ?: return false
                for (index in 0 until group.childCount) {
                    val child = group.getChildAt(index)
                    if (isPointInside(child, event) && isTouchOnEditor(child, event)) return true
                }
                return false
            }

            private fun isInsideDragHandle(event: MotionEvent): Boolean =
                isPointInside(dragHandle, event)

            override fun dispatchTouchEvent(event: MotionEvent): Boolean {
                if (event.action == MotionEvent.ACTION_OUTSIDE) {
                    closeSelf()
                    return true
                }
                if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                    val focusedEditor = findFocus() as? EditText
                    val touchInsideEditor = isTouchOnEditor(this, event)
                    if (DanmakuUiPolicy.shouldDismissIme(
                            actionDown = true,
                            hasFocusedEditor = focusedEditor != null,
                            touchInsideFocusedEditor = touchInsideEditor,
                        )
                    ) {
                        hideKeyboardAndClearFocus(focusedEditor)
                    }
                }
                return super.dispatchTouchEvent(event)
            }

            override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        startRawX = event.rawX
                        startRawY = event.rawY
                        startWindowX = params.x
                        startWindowY = params.y
                        isDragging = false
                        dragAllowed = DanmakuUiPolicy.canStartPanelDrag(
                            insideHandle = isInsideDragHandle(event),
                            onClickableChild = isTouchOnClickableDescendant(dragHandle, event),
                        )
                    }
                    MotionEvent.ACTION_MOVE -> {
                        if (
                            dragAllowed && DanmakuUiPolicy.hasExceededDragSlop(
                                event.rawX - startRawX,
                                event.rawY - startRawY,
                                dragThreshold,
                            )
                        ) {
                            isDragging = true
                            return true
                        }
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        isDragging = false
                        dragAllowed = false
                    }
                }
                return false
            }

            override fun onTouchEvent(event: MotionEvent): Boolean {
                if (!isDragging) return false
                when (event.actionMasked) {
                    MotionEvent.ACTION_MOVE -> {
                        val maxX = (screenWidth - width).coerceAtLeast(0)
                        val maxY = (screenHeight - height).coerceAtLeast(0)
                        params.gravity = Gravity.TOP or Gravity.START
                        params.x = (startWindowX + event.rawX - startRawX).toInt().coerceIn(0, maxX)
                        params.y = (startWindowY + event.rawY - startRawY).toInt().coerceIn(0, maxY)
                        try {
                            windowManager.updateViewLayout(this, params)
                        } catch (e: Exception) {
                            Log.w(TAG, "drag updateViewLayout error", e)
                        }
                        return true
                    }
                    MotionEvent.ACTION_UP -> {
                        isDragging = false
                        dragAllowed = false
                        performClick()
                        return true
                    }
                    MotionEvent.ACTION_CANCEL -> {
                        isDragging = false
                        dragAllowed = false
                        return true
                    }
                }
                return true
            }

            override fun performClick(): Boolean {
                super.performClick()
                return true
            }
        }

        val childParams = android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
        )
        (view.parent as? android.view.ViewGroup)?.removeView(view)
        wrapper.addView(view, childParams)
        return wrapper
    }

    // --- Onboarding ---

    private fun showOnboarding(): Boolean {
        val inflater = LayoutInflater.from(this)
        val view = inflater.inflate(R.layout.onboarding_view, null)
        onboardingView = view

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            0,
            PixelFormat.TRANSLUCENT,
        )

        view.findViewById<Button>(R.id.onboarding_ok_btn).setOnClickListener {
            DanmakuSettings.setOnboarded(this, true)
            safeRemoveView(view, "onboarding")
            onboardingView = null
        }

        val attached = safeAddOverlayView(view, params, "onboarding")
        if (!attached) {
            onboardingView = null
        }
        return attached
    }

    // --- Danmaku toggle ---

    private fun toggleDanmaku() {
        danmakuVisible = !danmakuVisible
        DanmakuSettings.setDmVisible(this, danmakuVisible)
        if (danmakuVisible) {
            danmakuView.visibility = View.VISIBLE
            danmakuView.startAnimation()
            toast(getString(R.string.danmaku_shown))
        } else {
            danmakuView.visibility = View.GONE
            danmakuView.clearAll()
            toast(getString(R.string.danmaku_hidden))
        }
    }

    // --- Socket callbacks ---

    private fun applyDisconnectedState(announce: Boolean) {
        ballView.setConnected(false)
        joinedRoomCode = null
        mainHandler.removeCallbacks(defaultRoomRetry)
        defaultRoomRetryGate.reset()
        val input = panelView?.findViewById<EditText>(R.id.panel_msg_input)
        val effect = sendState.disconnected(input?.text?.toString() ?: composerDraft)
        composerDraft = effect.draft
        input?.let {
            if (it.text.toString() != effect.draft) it.setText(effect.draft)
        }
        renderComposerState(announce = announce)
    }

    override fun onConnect() {
        postIfActive {
            ballView.setConnected(true)
            connectionNoticeGate.connected()
            mainHandler.removeCallbacks(defaultRoomRetry)
            defaultRoomRetryGate.reset()
            sendState.connected()
            renderComposerState(announce = false)
            if (currentRoom.roomCode.isEmpty()) joinCurrentRoom()
        }
    }

    override fun onDisconnect() {
        postIfActive {
            applyDisconnectedState(announce = connectionNoticeGate.disconnected())
        }
    }

    override fun onConnectionError(error: SocketError) {
        postIfActive {
            applyDisconnectedState(announce = connectionNoticeGate.disconnected())
        }
    }

    override fun onReconnectJoinFailed(roomCode: String, error: SocketError) {
        postIfActive {
            if (currentRoom.roomCode == roomCode) handleJoinFailure(roomCode, error)
        }
    }

    override fun onJoined(result: JoinRoomResult) {
        postIfActive {
            defaultRoomRequests.invalidate()
            joinedRoomCode = result.room.roomCode
            mainHandler.removeCallbacks(defaultRoomRetry)
            defaultRoomRetryGate.succeeded()
            if (currentRoom.roomCode.isNotEmpty() && currentRoom.roomCode != result.room.roomCode) {
                val input = panelView?.findViewById<EditText>(R.id.panel_msg_input)
                val effect = sendState.roomChanged(input?.text?.toString() ?: composerDraft)
                composerDraft = effect.draft
                input?.let {
                    if (it.text.toString() != effect.draft) {
                        it.setText(effect.draft)
                        it.setSelection(it.text.length)
                    }
                }
                renderComposerState(announce = false)
            }
            currentRoom = result.room
            DanmakuSettings.setCurrentRoomCode(this, result.room.roomCode)
            DanmakuSettings.addJoinedRoom(this, result.room.roomCode)
            ballView.setCount(result.room.count)
            historyMessages.clear()
            historyMessages.addAll(result.recentMessages)
            panelView?.findViewById<Button>(R.id.panel_room_label)?.let(::renderRoomHeader)
            renderComposerState(announce = false)
        }
    }

    override fun onBarrage(msg: DanmakuMsg) {
        postIfActive {
            if (danmakuVisible) {
                danmakuView.addDanmaku(
                    msg.text,
                    msg.nickname.ifBlank { getString(R.string.anonymous) },
                    msg.color,
                )
            }
            historyMessages.add(msg)
            if (historyMessages.size > 200) historyMessages.removeAt(0)
        }
    }

    override fun onBarrageStatus(status: BarrageDeliveryStatus) {
        postIfActive {
            val input = panelView?.findViewById<EditText>(R.id.panel_msg_input)
            val effect = sendState.status(status, input?.text?.toString() ?: composerDraft)
            composerDraft = effect.draft
            input?.let {
                if (it.text.toString() != effect.draft) {
                    it.setText(effect.draft)
                    it.setSelection(it.text.length)
                }
            }
            renderComposerState(announce = status is BarrageDeliveryStatus.Expired)
        }
    }

    override fun onRoomCount(roomCode: String, count: Int, capacity: Int) {
        postIfActive {
            if (roomCode != currentRoom.roomCode) return@postIfActive
            currentRoom = currentRoom.copy(count = count, capacity = capacity)
            ballView.setCount(count)
            panelView?.findViewById<Button>(R.id.panel_room_label)?.let(::renderRoomHeader)
        }
    }

    override fun onRoomDeleted(roomCode: String, reason: String) {
        postIfActive {
            DanmakuSettings.removeJoinedRoom(this, roomCode)
            runCatching { ownerCredentials.remove(roomCode) }
            if (roomCode == currentRoom.roomCode) {
                joinedRoomCode = null
                DanmakuSettings.getDefaultRoomCode(this)?.let {
                    DanmakuSettings.setCurrentRoomCode(this, it)
                } ?: DanmakuSettings.clearCurrentRoomCode(this)
                currentRoom = RoomMetadata("", "", 0, 0, RoomVisibility.PUBLIC, false, null)
                toast(getString(R.string.room_unavailable))
                joinCurrentRoom()
            }
        }
    }

    override fun onHideMessage(messageId: String) {
        postIfActive {
            historyMessages.removeAll { it.messageId == messageId }
        }
    }

    // --- Notification ---

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW,
        )
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    private fun createNotification(): Notification {
        // 停止服務的 PendingIntent
        val stopIntent = Intent(ACTION_STOP_SERVICE).setPackage(packageName)
        val stopPendingIntent = PendingIntent.getBroadcast(
            this, 0, stopIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPendingIntent = PendingIntent.getActivity(
            this, 1, openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openPendingIntent)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                getString(R.string.notification_stop),
                stopPendingIntent,
            )
            .setOngoing(true)
            .build()
    }

    @Suppress("DEPRECATION")
    private fun startForegroundWithType() {
        val notification = createNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ — must specify foreground service type
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    // --- 通知停止／主畫面即時重置 BroadcastReceiver ---

    private fun registerCommandReceiver() {
        commandReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    ACTION_STOP_SERVICE -> {
                        Log.i(TAG, "收到停止服務廣播")
                        stopSelf()
                    }
                    ACTION_RESET_POSITION -> resetBallPositionLive()
                    ACTION_RESET_ALL -> resetAllLive()
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_STOP_SERVICE)
            addAction(ACTION_RESET_POSITION)
            addAction(ACTION_RESET_ALL)
        }
        ContextCompat.registerReceiver(
            this,
            commandReceiver,
            filter,
            DanmakuUiPolicy.commandReceiverFlags(),
        )
    }

    // --- Service lifecycle ---

    override fun onDestroy() {
        destroyed = true
        Log.i(TAG, "Service destroyed")
        mainHandler.removeCallbacksAndMessages(null)
        socketClient?.disconnect()
        socketClient = null
        closeAllPanels()
        if (::ballView.isInitialized) safeRemoveView(ballView, "ball")
        if (::danmakuView.isInitialized) safeRemoveView(danmakuView, "danmaku")
        onboardingView?.let {
            try { windowManager.removeView(it) } catch (e: Exception) { Log.w(TAG, "removeView onboarding error", e) }
            onboardingView = null
        }
        // 註銷 BroadcastReceiver
        commandReceiver?.let {
            try { unregisterReceiver(it) } catch (e: Exception) { Log.w(TAG, "unregisterReceiver error", e) }
        }
        commandReceiver = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun toast(msg: String) {
        postIfActive {
            Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
        }
    }
}

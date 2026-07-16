package com.kolvid.danmaku

import androidx.core.content.ContextCompat
import kotlin.math.hypot
import kotlin.math.roundToInt

/** Small, platform-independent UI policies covered by local unit tests. */
object DanmakuUiPolicy {
    fun canStartOverlay(sdkInt: Int, notificationGranted: Boolean): Boolean =
        sdkInt < 33 || notificationGranted

    fun commandReceiverFlags(): Int = ContextCompat.RECEIVER_NOT_EXPORTED

    fun hasExceededDragSlop(deltaX: Float, deltaY: Float, touchSlop: Int): Boolean =
        hypot(deltaX, deltaY) > touchSlop

    fun canStartPanelDrag(insideHandle: Boolean, onClickableChild: Boolean): Boolean =
        insideHandle && !onClickableChild

    fun shouldDismissIme(actionDown: Boolean, hasFocusedEditor: Boolean, touchInsideFocusedEditor: Boolean): Boolean =
        actionDown && hasFocusedEditor && !touchInsideFocusedEditor

    fun canAttachOverlay(permissionGranted: Boolean): Boolean = permissionGranted

    fun shouldInitializeSocket(overlayViewsAttached: Boolean): Boolean = overlayViewsAttached

    fun withOpacity(argb: Int, opacity: Float): Int {
        val alpha = (opacity.coerceIn(0f, 1f) * 255f).roundToInt()
        return (argb and 0x00FFFFFF) or (alpha shl 24)
    }

}

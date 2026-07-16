package com.kolvid.danmaku

import androidx.core.content.ContextCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DanmakuUiPolicyTest {
    @Test
    fun `Android 13 and newer require notification grant before starting overlay`() {
        assertFalse(DanmakuUiPolicy.canStartOverlay(33, notificationGranted = false))
        assertTrue(DanmakuUiPolicy.canStartOverlay(33, notificationGranted = true))
    }

    @Test
    fun `Android 12 and older do not require runtime notification grant`() {
        assertTrue(DanmakuUiPolicy.canStartOverlay(32, notificationGranted = false))
    }

    @Test
    fun `dynamic command receiver is never exported`() {
        assertEquals(
            ContextCompat.RECEIVER_NOT_EXPORTED,
            DanmakuUiPolicy.commandReceiverFlags(),
        )
    }

    @Test
    fun `panel drag starts only after exceeding system touch slop`() {
        assertFalse(DanmakuUiPolicy.hasExceededDragSlop(6f, 6f, 10))
        assertTrue(DanmakuUiPolicy.hasExceededDragSlop(8f, 8f, 10))
    }

    @Test
    fun `panel drag never starts from a clickable child in the title bar`() {
        assertFalse(DanmakuUiPolicy.canStartPanelDrag(insideHandle = true, onClickableChild = true))
        assertTrue(DanmakuUiPolicy.canStartPanelDrag(insideHandle = true, onClickableChild = false))
        assertFalse(DanmakuUiPolicy.canStartPanelDrag(insideHandle = false, onClickableChild = false))
    }

    @Test
    fun `in-panel tap outside focused editor dismisses IME without treating outside-window events as tap-away`() {
        assertTrue(DanmakuUiPolicy.shouldDismissIme(actionDown = true, hasFocusedEditor = true, touchInsideFocusedEditor = false))
        assertFalse(DanmakuUiPolicy.shouldDismissIme(actionDown = true, hasFocusedEditor = true, touchInsideFocusedEditor = true))
        assertFalse(DanmakuUiPolicy.shouldDismissIme(actionDown = false, hasFocusedEditor = true, touchInsideFocusedEditor = false))
        assertFalse(DanmakuUiPolicy.shouldDismissIme(actionDown = true, hasFocusedEditor = false, touchInsideFocusedEditor = false))
    }

    @Test
    fun `overlay attachment is blocked when permission is unavailable`() {
        assertFalse(DanmakuUiPolicy.canAttachOverlay(permissionGranted = false))
        assertTrue(DanmakuUiPolicy.canAttachOverlay(permissionGranted = true))
    }

    @Test
    fun `socket initialization is skipped when overlay views fail to attach`() {
        assertFalse(DanmakuUiPolicy.shouldInitializeSocket(overlayViewsAttached = false))
        assertTrue(DanmakuUiPolicy.shouldInitializeSocket(overlayViewsAttached = true))
    }

    @Test
    fun `opacity is clamped and applied without changing rgb`() {
        assertEquals(0x80112233.toInt(), DanmakuUiPolicy.withOpacity(0xFF112233.toInt(), 0.5f))
        assertEquals(0x1A112233, DanmakuUiPolicy.withOpacity(0xFF112233.toInt(), 0.1f))
        assertEquals(0xFF112233.toInt(), DanmakuUiPolicy.withOpacity(0xFF112233.toInt(), 2f))
    }

}

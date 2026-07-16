package com.kolvid.danmaku

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OverlayPanelTransitionTest {
    @Test
    fun `replacement opens the next panel only after the current touch dispatch`() {
        var closed = false
        var opened = false
        var queuedOpen: (() -> Unit)? = null
        val transition = OverlayPanelTransition { action -> queuedOpen = action }

        transition.replace(
            closeCurrent = { closed = true },
            openNext = { opened = true },
        )

        assertTrue(closed)
        assertFalse(opened)

        queuedOpen?.invoke()
        assertTrue(opened)
    }
}

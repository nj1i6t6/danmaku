package com.kolvid.danmaku

/**
 * Defers opening a replacement overlay until the current Android touch dispatch has finished.
 */
class OverlayPanelTransition(
    private val post: (() -> Unit) -> Unit,
) {
    fun replace(
        closeCurrent: () -> Unit,
        openNext: () -> Unit,
    ) {
        closeCurrent()
        post(openNext)
    }
}

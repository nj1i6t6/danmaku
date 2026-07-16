package com.kolvid.danmaku

/** Collision policy for right-to-left danmaku sharing one lane. */
object DanmakuLanePolicy {
    fun canFollow(
        startX: Float,
        newSpeedPxPerMs: Float,
        existingRight: Float,
        existingSpeedPxPerMs: Float,
        minimumGapPx: Float,
    ): Boolean {
        if (existingRight <= 0f) return true
        if (startX - existingRight < minimumGapPx) return false
        if (newSpeedPxPerMs <= existingSpeedPxPerMs) return true
        if (existingSpeedPxPerMs <= 0f) return false

        val existingExitMs = existingRight / existingSpeedPxPerMs
        val newLeftAtExistingExit = startX - newSpeedPxPerMs * existingExitMs
        return newLeftAtExistingExit >= minimumGapPx
    }
}

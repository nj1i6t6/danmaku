package com.kolvid.danmaku

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DanmakuLanePolicyTest {
    @Test
    fun `new item cannot enter when initial gap is too small`() {
        assertFalse(
            DanmakuLanePolicy.canFollow(
                startX = 1040f,
                newSpeedPxPerMs = 0.05f,
                existingRight = 1030f,
                existingSpeedPxPerMs = 0.1f,
                minimumGapPx = 24f,
            )
        )
    }

    @Test
    fun `slower item can follow once minimum gap exists`() {
        assertTrue(
            DanmakuLanePolicy.canFollow(
                startX = 1040f,
                newSpeedPxPerMs = 0.05f,
                existingRight = 800f,
                existingSpeedPxPerMs = 0.1f,
                minimumGapPx = 24f,
            )
        )
    }

    @Test
    fun `faster item is rejected when it catches existing item before exit`() {
        assertFalse(
            DanmakuLanePolicy.canFollow(
                startX = 1040f,
                newSpeedPxPerMs = 0.2f,
                existingRight = 800f,
                existingSpeedPxPerMs = 0.1f,
                minimumGapPx = 24f,
            )
        )
    }

    @Test
    fun `faster item may follow when existing item exits before catch up`() {
        assertTrue(
            DanmakuLanePolicy.canFollow(
                startX = 1040f,
                newSpeedPxPerMs = 0.2f,
                existingRight = 200f,
                existingSpeedPxPerMs = 0.1f,
                minimumGapPx = 24f,
            )
        )
    }
}

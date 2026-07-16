package com.kolvid.danmaku

import org.junit.Assert.assertEquals
import org.junit.Test

class RoomExitPolicyTest {
    @Test
    fun `default room cannot be exited`() {
        assertEquals(
            RoomExitAction.BLOCK_DEFAULT,
            RoomExitPolicy.action(roomCode = "11111111", currentRoomCode = "11111111", defaultRoomCode = "11111111"),
        )
    }

    @Test
    fun `non-current custom room only removes its shortcut`() {
        assertEquals(
            RoomExitAction.REMOVE_SHORTCUT,
            RoomExitPolicy.action(roomCode = "22222222", currentRoomCode = "33333333", defaultRoomCode = "11111111"),
        )
    }

    @Test
    fun `current custom room switches to default before removal`() {
        assertEquals(
            RoomExitAction.SWITCH_TO_DEFAULT,
            RoomExitPolicy.action(roomCode = "22222222", currentRoomCode = "22222222", defaultRoomCode = "11111111"),
        )
    }
}

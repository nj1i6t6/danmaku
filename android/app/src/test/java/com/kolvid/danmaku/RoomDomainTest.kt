package com.kolvid.danmaku

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomDomainTest {
    @Test fun `room codes are exactly eight digits`() {
        assertTrue(RoomPolicy.isValidCode("48271635"))
        assertFalse(RoomPolicy.isValidCode("4827163"))
        assertFalse(RoomPolicy.isValidCode("4827163A"))
        assertFalse(RoomPolicy.isValidCode(" 48271635 "))
    }

    @Test fun `creation exposes only authoritative retention choices`() {
        assertEquals(listOf(1, 3, 7), RoomPolicy.RETENTION_DAYS)
        assertEquals(7, RoomPolicy.DEFAULT_RETENTION_DAYS)
        assertTrue(RoomPolicy.validateCreate("測試房", RoomVisibility.PUBLIC, null, 7).isValid)
        assertFalse(RoomPolicy.validateCreate("a", RoomVisibility.PUBLIC, null, 7).isValid)
        assertFalse(RoomPolicy.validateCreate("測試房", RoomVisibility.UNLISTED, "12345", 7).isValid)
        assertFalse(RoomPolicy.validateCreate("測試房", RoomVisibility.PUBLIC, "123456", 7).isValid)
        assertFalse(RoomPolicy.validateCreate("測試房", RoomVisibility.PUBLIC, null, 30).isValid)
    }

    @Test fun `joined list pins only the discovered default and de-duplicates persisted codes`() {
        val list = JoinedRoomList(defaultRoomCode = "87654321", persistedCodes = listOf("48271635", "87654321", "48271635", "19382641"))
        assertEquals(listOf("87654321", "48271635", "19382641"), list.codes)
        assertEquals(listOf("87654321", "19382641"), list.remove("48271635").codes)
        assertEquals(list.codes, list.remove("87654321").codes)
        assertEquals(listOf("87654321", "48271635", "19382641", "55555555"), list.add("55555555").codes)
        assertEquals(listOf("48271635"), JoinedRoomList(defaultRoomCode = null, persistedCodes = listOf("48271635")).codes)
    }

    @Test fun `default room retry gate bounds attempts and prevents overlapping requests`() {
        val gate = BoundedRetryGate(maxAttempts = 3)

        assertTrue(gate.tryStart())
        assertFalse(gate.tryStart())
        assertTrue(gate.failed())
        assertTrue(gate.tryStart())
        assertTrue(gate.failed())
        assertTrue(gate.tryStart())
        assertFalse(gate.failed())
        assertFalse(gate.tryStart())

        gate.reset()
        assertTrue(gate.tryStart())
        gate.succeeded()
        assertTrue(gate.tryStart())
    }

    @Test fun `latest request gate rejects stale responses and explicit invalidation`() {
        val gate = LatestRequestGate()
        val first = gate.next()
        val second = gate.next()

        assertFalse(gate.isCurrent(first))
        assertTrue(gate.isCurrent(second))
        gate.invalidate()
        assertFalse(gate.isCurrent(second))
    }

    @Test fun `connection notice gate emits only on connected to disconnected transition`() {
        val gate = ConnectionNoticeGate(initiallyConnected = false)

        assertFalse(gate.disconnected())
        gate.connected()
        assertTrue(gate.disconnected())
        assertFalse(gate.disconnected())
        gate.connected()
        assertTrue(gate.disconnected())
    }
}

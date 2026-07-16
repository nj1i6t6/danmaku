package com.kolvid.danmaku

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SendStateMachineTest {
    @Test fun `cooldown deadline is monotonic and survives rendering gaps`() {
        val machine = SendStateMachine(connected = true)
        val generation = machine.begin("hello")!!
        machine.ack(generation, BarrageAck.Error(SocketError(SocketErrorCode.RATE_LIMITED, "slow", retryAfterMs = 5_000)), "hello", nowMs = 1_000)
        assertEquals(SendMode.COOLDOWN, machine.state(1_001).mode)
        assertEquals(5, machine.state(1_001).remainingSeconds)
        assertEquals(SendMode.READY, machine.state(6_000).mode)
    }

    @Test fun `sent and queued only clear the submitted snapshot`() {
        val sent = SendStateMachine(connected = true)
        val sentGeneration = sent.begin("old")!!
        assertEquals("new", sent.ack(sentGeneration, BarrageAck.Sent("m1"), "new", 0).draft)

        val queued = SendStateMachine(connected = true)
        val queuedGeneration = queued.begin("old")!!
        assertEquals("", queued.ack(queuedGeneration, BarrageAck.Queued("m2", 3, 2_000), "old", 0).draft)
        assertEquals(SendMode.QUEUED, queued.state(1).mode)
        assertEquals("m2", queued.state(1).messageId)
    }

    @Test fun `queued delivered resets and expired restores or offers retry without overwriting`() {
        val empty = SendStateMachine(connected = true)
        val emptyGeneration = empty.begin("original")!!
        empty.ack(emptyGeneration, BarrageAck.Queued("m1", 2, 1_000), "original", 0)
        assertEquals("original", empty.status(BarrageDeliveryStatus.Expired("m1", SocketError(SocketErrorCode.QUEUE_EXPIRED, "expired")), "").draft)
        assertNull(empty.state(1).retryText)

        val draft = SendStateMachine(connected = true)
        val draftGeneration = draft.begin("original")!!
        draft.ack(draftGeneration, BarrageAck.Queued("m2", 2, 1_000), "original", 0)
        assertEquals("new draft", draft.status(BarrageDeliveryStatus.Expired("m2", SocketError(SocketErrorCode.QUEUE_EXPIRED, "expired")), "new draft").draft)
        assertEquals("original", draft.state(1).retryText)
        draft.status(BarrageDeliveryStatus.Delivered("other"), "new draft")
        assertEquals(SendMode.READY, draft.state(1).mode)
    }

    @Test fun `structured errors map to muted busy and disconnected states`() {
        val cases = listOf(
            SocketErrorCode.MUTED to SendMode.MUTED,
            SocketErrorCode.ROOM_BUSY to SendMode.ROOM_BUSY,
            SocketErrorCode.QUEUE_FULL to SendMode.ROOM_BUSY,
            SocketErrorCode.NOT_CONNECTED to SendMode.DISCONNECTED,
        )
        cases.forEach { (code, mode) ->
            val machine = SendStateMachine(connected = true)
            val generation = machine.begin("text")!!
            machine.ack(generation, BarrageAck.Error(SocketError(code, code.name, 2_000)), "text", 100)
            assertEquals(mode, machine.state(100).mode)
        }
    }

    @Test fun `switching rooms cancels queued state and restores or offers retry`() {
        val empty = SendStateMachine(connected = true)
        val emptyGeneration = empty.begin("queued original")!!
        empty.ack(emptyGeneration, BarrageAck.Queued("m1", 1, 1_000), "queued original", 0)
        assertEquals("queued original", empty.roomChanged("").draft)
        assertEquals(SendMode.READY, empty.state(1).mode)

        val changed = SendStateMachine(connected = true)
        val changedGeneration = changed.begin("queued original")!!
        changed.ack(changedGeneration, BarrageAck.Queued("m2", 1, 1_000), "queued original", 0)
        assertEquals("new draft", changed.roomChanged("new draft").draft)
        assertEquals("queued original", changed.state(1).retryText)
    }

    @Test fun `late acknowledgements from canceled generations are ignored`() {
        val roomChanged = SendStateMachine(connected = true)
        val firstGeneration = roomChanged.begin("old room message")
        assertNotNull(firstGeneration)
        assertEquals("new room draft", roomChanged.roomChanged("new room draft").draft)
        assertEquals(
            "new room draft",
            roomChanged.ack(firstGeneration!!, BarrageAck.Queued("old-id", 2, 1_000), "new room draft", 10).draft,
        )
        assertEquals(SendMode.READY, roomChanged.state(20).mode)
        assertNull(roomChanged.state(20).messageId)

        val disconnected = SendStateMachine(connected = true)
        val secondGeneration = disconnected.begin("pending message")
        assertNotNull(secondGeneration)
        disconnected.disconnected("newer draft")
        assertEquals(
            "newer draft",
            disconnected.ack(secondGeneration!!, BarrageAck.Sent("late-id"), "newer draft", 10).draft,
        )
        assertEquals(SendMode.DISCONNECTED, disconnected.state(20).mode)
    }

    @Test fun `retry text is preserved when disconnected begin cannot start`() {
        val machine = SendStateMachine(connected = true)
        val generation = machine.begin("queued original")!!
        machine.ack(generation, BarrageAck.Queued("m1", 1, 1_000), "new draft", 0)
        machine.status(
            BarrageDeliveryStatus.Expired("m1", SocketError(SocketErrorCode.QUEUE_EXPIRED, "expired")),
            "new draft",
        )
        machine.disconnected("new draft")

        val retry = machine.peekRetry()
        assertEquals("queued original", retry)
        assertNull(machine.begin(retry!!))
        assertEquals("queued original", machine.peekRetry())
    }

    @Test fun `retry survives an error acknowledgement and clears only after server acceptance`() {
        val machine = SendStateMachine(connected = true)
        val originalGeneration = machine.begin("queued original")!!
        machine.ack(originalGeneration, BarrageAck.Queued("m1", 1, 1_000), "new draft", 0)
        machine.status(
            BarrageDeliveryStatus.Expired("m1", SocketError(SocketErrorCode.QUEUE_EXPIRED, "expired")),
            "new draft",
        )

        val retryGeneration = machine.begin(machine.peekRetry()!!)!!
        val rejected = machine.ack(
            retryGeneration,
            BarrageAck.Error(SocketError(SocketErrorCode.CONTENT_REJECTED, "rejected")),
            "new draft",
            nowMs = 10,
        )
        assertEquals("new draft", rejected.draft)
        assertEquals("queued original", machine.peekRetry())

        val acceptedGeneration = machine.begin(machine.peekRetry()!!)!!
        machine.ack(acceptedGeneration, BarrageAck.Sent("m2"), "new draft", nowMs = 20)
        assertNull(machine.peekRetry())
    }

    @Test fun `pending and queued accessibility announcements fire once per transition`() {
        assertTrue(ComposerAccessibilityPolicy.shouldAnnounce(SendMode.READY, SendMode.PENDING, forced = false))
        assertFalse(ComposerAccessibilityPolicy.shouldAnnounce(SendMode.PENDING, SendMode.PENDING, forced = false))
        assertTrue(ComposerAccessibilityPolicy.shouldAnnounce(SendMode.PENDING, SendMode.QUEUED, forced = false))
        assertFalse(ComposerAccessibilityPolicy.shouldAnnounce(SendMode.QUEUED, SendMode.QUEUED, forced = false))
        assertTrue(ComposerAccessibilityPolicy.shouldAnnounce(SendMode.READY, SendMode.READY, forced = true))
    }
}

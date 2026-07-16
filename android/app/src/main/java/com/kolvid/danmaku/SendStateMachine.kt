package com.kolvid.danmaku

import kotlin.math.ceil

enum class SendMode { READY, PENDING, QUEUED, COOLDOWN, MUTED, ROOM_BUSY, DISCONNECTED }

data class SendUiState(
    val mode: SendMode,
    val remainingSeconds: Long = 0,
    val messageId: String? = null,
    val queuePosition: Int? = null,
    val estimatedWaitMs: Long? = null,
    val reason: String? = null,
    val retryText: String? = null,
)

data class DraftEffect(val draft: String)

object ComposerAccessibilityPolicy {
    fun shouldAnnounce(previous: SendMode?, current: SendMode, forced: Boolean): Boolean =
        forced || (previous != current && current in setOf(SendMode.PENDING, SendMode.QUEUED))
}

/** Platform-independent composer state. Deadlines use elapsedRealtime supplied by callers. */
class SendStateMachine(connected: Boolean) {
    private var mode = if (connected) SendMode.READY else SendMode.DISCONNECTED
    private var deadlineMs: Long? = null
    private var snapshot: String? = null
    private var queuedId: String? = null
    private var position: Int? = null
    private var waitMs: Long? = null
    private var reason: String? = null
    private var retry: String? = null
    private var generationCounter = 0L
    private var pendingGeneration: Long? = null

    fun begin(text: String): Long? {
        if (mode != SendMode.READY || text.isBlank()) return null
        snapshot = text
        mode = SendMode.PENDING
        generationCounter += 1
        pendingGeneration = generationCounter
        return pendingGeneration
    }

    fun ack(generation: Long, ack: BarrageAck, currentDraft: String, nowMs: Long): DraftEffect {
        if (mode != SendMode.PENDING || pendingGeneration != generation) return DraftEffect(currentDraft)
        pendingGeneration = null
        val submitted = snapshot.orEmpty()
        return when (ack) {
            is BarrageAck.Sent -> {
                clearAcceptedRetry(submitted)
                clearToReady()
                DraftEffect(clearSnapshotOnly(currentDraft, submitted))
            }
            is BarrageAck.Queued -> {
                clearAcceptedRetry(submitted)
                mode = SendMode.QUEUED
                queuedId = ack.messageId
                position = ack.position
                waitMs = ack.estimatedWaitMs
                reason = null
                DraftEffect(clearSnapshotOnly(currentDraft, submitted))
            }
            is BarrageAck.Error -> {
                reason = ack.error.message
                when (ack.error.code) {
                    SocketErrorCode.RATE_LIMITED -> timed(SendMode.COOLDOWN, nowMs, ack.error.retryAfterMs ?: 3_000L)
                    SocketErrorCode.MUTED -> timed(SendMode.MUTED, nowMs, ack.error.retryAfterMs ?: 300_000L)
                    SocketErrorCode.ROOM_BUSY, SocketErrorCode.QUEUE_FULL -> timed(SendMode.ROOM_BUSY, nowMs, ack.error.retryAfterMs ?: 1_000L)
                    SocketErrorCode.NOT_CONNECTED -> mode = SendMode.DISCONNECTED
                    else -> mode = SendMode.READY
                }
                snapshot = null
                DraftEffect(currentDraft)
            }
        }
    }

    fun status(status: BarrageDeliveryStatus, currentDraft: String): DraftEffect {
        if (status.messageId != queuedId) return DraftEffect(currentDraft)
        val original = snapshot.orEmpty()
        return when (status) {
            is BarrageDeliveryStatus.Delivered -> {
                clearToReady()
                DraftEffect(currentDraft)
            }
            is BarrageDeliveryStatus.Expired -> {
                val draft = if (currentDraft.isEmpty()) original else currentDraft
                retry = original.takeIf { currentDraft.isNotEmpty() }
                reason = status.error.message
                mode = SendMode.READY
                queuedId = null
                position = null
                waitMs = null
                snapshot = null
                DraftEffect(draft)
            }
        }
    }

    fun disconnected(currentDraft: String): DraftEffect {
        val original = snapshot
        if (mode == SendMode.QUEUED && currentDraft.isNotEmpty()) retry = original
        mode = SendMode.DISCONNECTED
        deadlineMs = null
        queuedId = null
        position = null
        waitMs = null
        snapshot = null
        pendingGeneration = null
        return DraftEffect(if (currentDraft.isEmpty()) original.orEmpty() else currentDraft)
    }

    fun roomChanged(currentDraft: String): DraftEffect {
        val original = snapshot
        if (mode == SendMode.QUEUED && currentDraft.isNotEmpty()) retry = original
        val draft = if (mode == SendMode.QUEUED && currentDraft.isEmpty()) original.orEmpty() else currentDraft
        clearToReady()
        return DraftEffect(draft)
    }

    fun connected() { if (mode == SendMode.DISCONNECTED) mode = SendMode.READY }

    fun state(nowMs: Long): SendUiState {
        val deadline = deadlineMs
        if (deadline != null && nowMs >= deadline && mode in setOf(SendMode.COOLDOWN, SendMode.MUTED, SendMode.ROOM_BUSY)) {
            clearToReady()
        }
        val remaining = deadlineMs?.let { ceil(((it - nowMs).coerceAtLeast(0)) / 1000.0).toLong() } ?: 0
        return SendUiState(mode, remaining, queuedId, position, waitMs, reason, retry)
    }

    fun peekRetry(): String? = retry

    private fun timed(next: SendMode, nowMs: Long, delayMs: Long) {
        mode = next
        deadlineMs = nowMs + delayMs
    }

    private fun clearAcceptedRetry(submitted: String) {
        if (retry == submitted) retry = null
    }

    private fun clearToReady() {
        mode = SendMode.READY
        deadlineMs = null
        snapshot = null
        queuedId = null
        position = null
        waitMs = null
        reason = null
        pendingGeneration = null
    }

    private fun clearSnapshotOnly(current: String, submitted: String): String = if (current == submitted) "" else current
}

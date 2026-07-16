package com.kolvid.danmaku

import org.json.JSONArray
import org.json.JSONObject

enum class RoomVisibility(val wireValue: String) { PUBLIC("public"), UNLISTED("unlisted");
    companion object { fun fromWire(value: String) = entries.firstOrNull { it.wireValue == value } ?: PUBLIC }
}

data class RoomMetadata(
    val roomCode: String,
    val name: String,
    val count: Int,
    val capacity: Int,
    val visibility: RoomVisibility,
    val requiresPassword: Boolean,
    val retentionDays: Int?,
    val ownedByClient: Boolean = false,
)

data class RoomPagination(val page: Int, val pageSize: Int, val total: Int, val totalPages: Int)
data class PublicRoomPage(val rooms: List<RoomMetadata>, val pagination: RoomPagination)
data class JoinRoomResult(val room: RoomMetadata, val recentMessages: List<DanmakuMsg>)
data class CreateRoomResult(val room: RoomMetadata, val ownerCredential: String?, val recentMessages: List<DanmakuMsg>)
data class NicknameChangeResult(val nickname: String, val changeDate: String)

data class RoomCreateRequest(val name: String, val visibility: RoomVisibility, val password: String?, val retentionDays: Int)
data class RoomUpdateRequest(
    val roomCode: String,
    val name: String? = null,
    val visibility: RoomVisibility? = null,
    val passwordAction: JSONObject? = null,
)

enum class SocketErrorCode {
    RATE_LIMITED, MUTED, ROOM_BUSY, QUEUE_FULL, QUEUE_EXPIRED, NOT_CONNECTED,
    NOT_IN_ROOM, ROOM_FULL, ROOM_NOT_FOUND, PASSWORD_REQUIRED, INVALID_PASSWORD,
    CONTENT_REJECTED, VALIDATION_ERROR, FORBIDDEN, CREATE_LIMITED, TIMEOUT, UNKNOWN,
}

data class SocketError(
    val code: SocketErrorCode,
    val message: String,
    val retryAfterMs: Long? = null,
    val scope: String? = null,
    val limit: Int? = null,
    val windowMs: Long? = null,
)

sealed interface SocketResult<out T> {
    data class Success<T>(val value: T) : SocketResult<T>
    data class Failure(val error: SocketError) : SocketResult<Nothing>
}

sealed interface BarrageAck {
    data class Sent(val messageId: String) : BarrageAck
    data class Queued(val messageId: String, val position: Int, val estimatedWaitMs: Long) : BarrageAck
    data class Error(val error: SocketError) : BarrageAck
}

sealed interface BarrageDeliveryStatus {
    val messageId: String
    data class Delivered(override val messageId: String) : BarrageDeliveryStatus
    data class Expired(override val messageId: String, val error: SocketError) : BarrageDeliveryStatus
}

data class ValidationResult(val isValid: Boolean, val reason: String? = null)

object RoomPolicy {
    val RETENTION_DAYS = listOf(1, 3, 7)
    const val DEFAULT_RETENTION_DAYS = 7
    const val PUBLIC_PAGE_SIZE = 20

    fun isValidCode(value: String): Boolean = value.matches(Regex("^[0-9]{8}$"))

    fun validateCreate(name: String, visibility: RoomVisibility, password: String?, retentionDays: Int): ValidationResult {
        val normalizedName = name.trim().replace(Regex("\\s+"), " ")
        if (normalizedName.length !in 2..24) return ValidationResult(false, "name")
        if (retentionDays !in RETENTION_DAYS) return ValidationResult(false, "retention")
        if (visibility == RoomVisibility.PUBLIC && !password.isNullOrEmpty()) return ValidationResult(false, "public_password")
        if (!password.isNullOrEmpty() && password.length !in 6..64) return ValidationResult(false, "password")
        return ValidationResult(true)
    }
}

data class JoinedRoomList private constructor(val defaultRoomCode: String?, val codes: List<String>) {
    constructor(defaultRoomCode: String?, persistedCodes: Collection<String>) : this(
        defaultRoomCode?.takeIf(RoomPolicy::isValidCode),
        buildList {
            defaultRoomCode?.takeIf(RoomPolicy::isValidCode)?.let(::add)
            persistedCodes.filter { RoomPolicy.isValidCode(it) && it != defaultRoomCode }.distinct().forEach(::add)
        },
    )
    fun add(roomCode: String): JoinedRoomList =
        if (!RoomPolicy.isValidCode(roomCode) || roomCode in codes) this else JoinedRoomList(defaultRoomCode, codes + roomCode)
    fun remove(roomCode: String): JoinedRoomList =
        if (defaultRoomCode != null && roomCode == defaultRoomCode) this else JoinedRoomList(defaultRoomCode, codes - roomCode)
}

enum class RoomExitAction { BLOCK_DEFAULT, REMOVE_SHORTCUT, SWITCH_TO_DEFAULT }

object RoomExitPolicy {
    fun action(roomCode: String, currentRoomCode: String?, defaultRoomCode: String?): RoomExitAction = when {
        defaultRoomCode != null && roomCode == defaultRoomCode -> RoomExitAction.BLOCK_DEFAULT
        roomCode == currentRoomCode -> RoomExitAction.SWITCH_TO_DEFAULT
        else -> RoomExitAction.REMOVE_SHORTCUT
    }
}

/** Counts bounded acknowledgement attempts and prevents overlapping retry requests. */
class BoundedRetryGate(private val maxAttempts: Int) {
    private var attempts = 0
    private var inFlight = false

    init { require(maxAttempts > 0) }

    fun tryStart(): Boolean {
        if (inFlight || attempts >= maxAttempts) return false
        attempts += 1
        inFlight = true
        return true
    }

    /** Returns true when another attempt may be scheduled. */
    fun failed(): Boolean {
        inFlight = false
        return attempts < maxAttempts
    }

    fun succeeded() {
        attempts = 0
        inFlight = false
    }

    fun reset() = succeeded()
}

/** Monotonic token gate for UI requests whose callbacks may arrive out of order. */
class LatestRequestGate {
    private var latest = 0L

    fun next(): Long {
        latest += 1
        return latest
    }

    fun isCurrent(request: Long): Boolean = request == latest
    fun invalidate() { latest += 1 }
}

class ConnectionNoticeGate(initiallyConnected: Boolean) {
    private var isConnected = initiallyConnected

    fun connected() { isConnected = true }

    /** Returns true only for a connected -> disconnected transition. */
    fun disconnected(): Boolean {
        val changed = isConnected
        isConnected = false
        return changed
    }
}

object RoomSocketCodec {
    fun error(value: JSONObject?): SocketError {
        val data = value ?: JSONObject()
        val code = runCatching { SocketErrorCode.valueOf(data.optString("code", "UNKNOWN")) }.getOrDefault(SocketErrorCode.UNKNOWN)
        return SocketError(
            code = code,
            message = data.optString("message").takeIf { it.isNotBlank() } ?: code.name,
            retryAfterMs = data.optLong("retryAfterMs").takeIf { data.has("retryAfterMs") },
            scope = data.optString("scope").takeIf { it.isNotBlank() },
            limit = data.optInt("limit").takeIf { data.has("limit") },
            windowMs = data.optLong("windowMs").takeIf { data.has("windowMs") },
        )
    }

    fun failure(response: JSONObject?, fallback: SocketErrorCode = SocketErrorCode.UNKNOWN): SocketResult.Failure {
        val nested = response?.optJSONObject("error")
        return if (nested != null) SocketResult.Failure(error(nested)) else SocketResult.Failure(
            SocketError(fallback, response?.optString("message")?.takeIf { it.isNotBlank() } ?: fallback.name),
        )
    }

    fun barrageAck(response: JSONObject?): BarrageAck {
        if (response?.optBoolean("ok", false) != true) return BarrageAck.Error(failure(response).error)
        return when (response.optString("status")) {
            "sent" -> BarrageAck.Sent(requiredMessageId(response))
            "queued" -> {
                require(response.has("position") && response.has("estimatedWaitMs")) { "queued acknowledgement is incomplete" }
                val position = response.getInt("position")
                val estimatedWaitMs = response.getLong("estimatedWaitMs")
                require(position > 0 && estimatedWaitMs >= 0) { "queued acknowledgement values are invalid" }
                BarrageAck.Queued(requiredMessageId(response), position, estimatedWaitMs)
            }
            else -> throw IllegalArgumentException("Invalid barrage acknowledgement")
        }
    }

    fun barrageStatus(value: JSONObject): BarrageDeliveryStatus {
        val messageId = requiredMessageId(value)
        return when (value.optString("status")) {
            "delivered" -> BarrageDeliveryStatus.Delivered(messageId)
            "expired" -> BarrageDeliveryStatus.Expired(messageId, error(value.optJSONObject("error")))
            else -> throw IllegalArgumentException("Invalid barrage status")
        }
    }

    fun room(value: JSONObject): RoomMetadata {
        val roomCode = value.optString("roomCode", value.optString("code"))
        val name = value.optString("name")
        val count = value.optInt("count")
        val capacity = value.optInt("capacity")
        require(RoomPolicy.isValidCode(roomCode)) { "Invalid room code" }
        require(name.isNotBlank() && capacity > 0 && count in 0..capacity) { "Invalid room metadata" }
        return RoomMetadata(
            roomCode = roomCode,
            name = name,
            count = count,
            capacity = capacity,
            visibility = RoomVisibility.fromWire(value.optString("visibility", "public")),
            requiresPassword = value.optBoolean("requiresPassword"),
            retentionDays = value.optInt("retentionDays").takeIf { value.has("retentionDays") && !value.isNull("retentionDays") },
            ownedByClient = value.optBoolean("ownedByClient", value.optBoolean("isOwner", false)),
        )
    }

    private fun requiredMessageId(value: JSONObject): String =
        value.optString("messageId").also { require(it.isNotBlank()) { "messageId is required" } }

    fun roomList(response: JSONObject?): SocketResult<PublicRoomPage> {
        if (response?.optBoolean("ok", false) != true) return failure(response)
        val rooms = parseRoomArray(response.optJSONArray("data"))
        val p = response.optJSONObject("pagination") ?: JSONObject()
        return SocketResult.Success(PublicRoomPage(rooms, RoomPagination(
            p.optInt("page", 1), p.optInt("pageSize", RoomPolicy.PUBLIC_PAGE_SIZE), p.optInt("total"), p.optInt("totalPages", 1),
        )))
    }

    fun createRoom(response: JSONObject?): SocketResult<CreateRoomResult> {
        if (response?.optBoolean("ok", false) != true) return failure(response)
        val ownerCredential = response.optString("ownerCredential").takeIf { it.isNotBlank() }
        val roomValue = response.optJSONObject("room") ?: throw IllegalArgumentException("room is required")
        return SocketResult.Success(CreateRoomResult(
            room(roomValue),
            ownerCredential,
            parseMessages(response.optJSONArray("recentMessages")),
        ))
    }

    fun parseRoomArray(array: JSONArray?): List<RoomMetadata> = buildList {
        if (array != null) for (index in 0 until array.length()) add(room(array.getJSONObject(index)))
    }

    fun parseMessages(array: JSONArray?): List<DanmakuMsg> = buildList {
        if (array != null) for (index in 0 until array.length()) add(message(array.getJSONObject(index)))
    }

    fun message(data: JSONObject) = DanmakuMsg(
        messageId = data.optString("messageId"), roomCode = data.optString("roomCode"), text = data.optString("text"),
        nickname = data.optString("nickname"), color = data.optString("color", "#E6EDF3"),
        timestamp = data.optLong("timestamp", System.currentTimeMillis()), sessionId = data.optString("sessionId"),
        mine = data.optBoolean("mine"),
    )
}

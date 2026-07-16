package com.kolvid.danmaku

import android.os.Handler
import android.os.Looper
import android.util.Log
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import java.net.URISyntaxException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Socket.IO roomCode client. Every command uses a typed acknowledgement. */
class DanmakuSocketClient(private val clientId: String, private val callback: Callback) {
    interface Callback {
        fun onConnect()
        fun onDisconnect()
        fun onConnectionError(error: SocketError)
        fun onReconnectJoinFailed(roomCode: String, error: SocketError)
        fun onJoined(result: JoinRoomResult)
        fun onBarrage(msg: DanmakuMsg)
        fun onBarrageStatus(status: BarrageDeliveryStatus)
        fun onRoomCount(roomCode: String, count: Int, capacity: Int)
        fun onRoomDeleted(roomCode: String, reason: String)
        fun onHideMessage(messageId: String)
    }

    private var socket: Socket? = null
    private var desiredRoomCode: String? = null
    private var desiredPassword: String? = null
    private val callbackHandler = Handler(Looper.getMainLooper())
    private val requestIds = AtomicLong()
    private val membershipRequests = LatestRequestGate()
    private val disconnectFailures = ConcurrentHashMap<Long, () -> Unit>()

    fun connect() {
        if (socket != null) return
        try {
            val options = IO.Options().apply {
                reconnection = true
                reconnectionDelay = 1_000
                reconnectionDelayMax = 5_000
                timeout = ACK_TIMEOUT_MS
                auth = mapOf("clientId" to clientId, "platform" to "android")
            }
            socket = IO.socket(BuildConfig.DANMAKU_SERVER_URL, options)
        } catch (error: URISyntaxException) {
            callback.onConnectionError(SocketError(SocketErrorCode.NOT_CONNECTED, error.message ?: "Invalid server URI"))
            return
        }
        val active = socket ?: return
        active.on(Socket.EVENT_CONNECT) {
            callbackHandler.post {
                callback.onConnect()
                val code = desiredRoomCode
                if (code != null) {
                    joinRoom(code, desiredPassword) { result ->
                        if (result is SocketResult.Failure) callback.onReconnectJoinFailed(code, result.error)
                    }
                }
            }
        }
        active.on(Socket.EVENT_DISCONNECT) {
            failOutstanding(SocketError(SocketErrorCode.NOT_CONNECTED, "Disconnected"))
            callbackHandler.post(callback::onDisconnect)
        }
        active.on(Socket.EVENT_CONNECT_ERROR) { args ->
            val message = args.firstOrNull()?.toString().orEmpty().ifBlank { "Connection failed" }
            callbackHandler.post { callback.onConnectionError(SocketError(SocketErrorCode.NOT_CONNECTED, message)) }
        }
        active.on("connection-refused") { args ->
            val value = args.firstOrNull() as? JSONObject
            val error = value?.optJSONObject("error")?.let(RoomSocketCodec::error)
                ?: SocketError(SocketErrorCode.NOT_CONNECTED, value?.optString("reason").orEmpty().ifBlank { "Connection refused" })
            callbackHandler.post { callback.onConnectionError(error) }
        }
        active.on("room-count") { args ->
            runCatching {
                val value = args.first() as JSONObject
                callbackHandler.post { callback.onRoomCount(value.optString("roomCode"), value.optInt("count"), value.optInt("capacity")) }
            }.onFailure { Log.w(TAG, "Invalid room-count payload") }
        }
        active.on("room-deleted") { args ->
            runCatching {
                val value = args.first() as JSONObject
                callbackHandler.post { callback.onRoomDeleted(value.optString("roomCode"), value.optString("reason")) }
            }.onFailure { Log.w(TAG, "Invalid room-deleted payload") }
        }
        active.on("barrage") { args ->
            runCatching { RoomSocketCodec.message(args.first() as JSONObject) }
                .onSuccess { callbackHandler.post { callback.onBarrage(it) } }
                .onFailure { Log.w(TAG, "Invalid barrage payload") }
        }
        active.on("barrage-status") { args ->
            runCatching { RoomSocketCodec.barrageStatus(args.first() as JSONObject) }
                .onSuccess { callbackHandler.post { callback.onBarrageStatus(it) } }
                .onFailure { Log.w(TAG, "Invalid barrage-status payload") }
        }
        active.on("hide-message") { args ->
            val id = (args.firstOrNull() as? JSONObject)?.optString("messageId").orEmpty()
            if (id.isNotEmpty()) callbackHandler.post { callback.onHideMessage(id) }
        }
        active.connect()
    }

    fun joinRoom(roomCode: String, password: String? = null, result: (SocketResult<JoinRoomResult>) -> Unit) {
        if (!RoomPolicy.isValidCode(roomCode)) {
            result(SocketResult.Failure(SocketError(SocketErrorCode.VALIDATION_ERROR, "Invalid room code")))
            return
        }
        val membershipRequest = membershipRequests.next()
        val payload = JSONObject().put("roomCode", roomCode).apply { if (!password.isNullOrEmpty()) put("password", password) }
        emitTyped("join-room", payload, { response ->
            if (response == null || !response.optBoolean("ok")) RoomSocketCodec.failure(response) else {
                val room = RoomSocketCodec.room(response.getJSONObject("room"))
                SocketResult.Success(JoinRoomResult(room, RoomSocketCodec.parseMessages(response.optJSONArray("recentMessages"))))
            }
        }) { parsed ->
            if (!membershipRequests.isCurrent(membershipRequest)) return@emitTyped
            if (parsed is SocketResult.Success) {
                desiredRoomCode = parsed.value.room.roomCode
                desiredPassword = password
                callback.onJoined(parsed.value)
            }
            result(parsed)
        }
    }

    fun leaveRoom(result: (SocketResult<Unit>) -> Unit) {
        emitSimple("leave-room", JSONObject(), result)
        clearDesiredRoomIntent()
    }

    fun clearDesiredRoomIntent() {
        membershipRequests.invalidate()
        desiredRoomCode = null
        desiredPassword = null
    }

    fun lookupRoom(roomCode: String, result: (SocketResult<RoomMetadata>) -> Unit) {
        if (!RoomPolicy.isValidCode(roomCode)) {
            result(SocketResult.Failure(SocketError(SocketErrorCode.VALIDATION_ERROR, "Invalid room code")))
            return
        }
        emitTyped("room-lookup", JSONObject().put("roomCode", roomCode), { response ->
            if (response != null && response.optBoolean("ok")) SocketResult.Success(RoomSocketCodec.room(response.getJSONObject("room")))
            else RoomSocketCodec.failure(response)
        }, result)
    }

    fun defaultRoom(result: (SocketResult<RoomMetadata>) -> Unit) {
        emitTyped("room-default", JSONObject(), { response ->
            if (response != null && response.optBoolean("ok")) SocketResult.Success(RoomSocketCodec.room(response.getJSONObject("room")))
            else RoomSocketCodec.failure(response)
        }, result)
    }

    fun listPublicRooms(query: String?, page: Int, result: (SocketResult<PublicRoomPage>) -> Unit) {
        val payload = JSONObject().put("page", page.coerceAtLeast(1)).put("pageSize", RoomPolicy.PUBLIC_PAGE_SIZE)
        query?.trim()?.takeIf { it.isNotEmpty() }?.let { payload.put("query", it) }
        emitTyped("room-list-public", payload, RoomSocketCodec::roomList, result)
    }

    fun createRoom(request: RoomCreateRequest, result: (SocketResult<CreateRoomResult>) -> Unit) {
        val validation = RoomPolicy.validateCreate(request.name, request.visibility, request.password, request.retentionDays)
        if (!validation.isValid) {
            result(SocketResult.Failure(SocketError(SocketErrorCode.VALIDATION_ERROR, validation.reason.orEmpty())))
            return
        }
        val payload = JSONObject().put("name", request.name.trim()).put("visibility", request.visibility.wireValue)
            .put("retentionDays", request.retentionDays)
        request.password?.takeIf { it.isNotEmpty() }?.let { payload.put("password", it) }
        emitTyped("room-create", payload, RoomSocketCodec::createRoom) { parsed ->
            if (parsed is SocketResult.Success) {
                desiredRoomCode = parsed.value.room.roomCode
                desiredPassword = request.password
                callback.onJoined(JoinRoomResult(parsed.value.room, parsed.value.recentMessages))
            }
            result(parsed)
        }
    }

    fun updateRoom(request: RoomUpdateRequest, ownerCredential: String, result: (SocketResult<RoomMetadata>) -> Unit) {
        val payload = JSONObject().put("roomCode", request.roomCode).put("ownerCredential", ownerCredential)
        request.name?.let { payload.put("name", it.trim()) }
        request.visibility?.let { payload.put("visibility", it.wireValue) }
        request.passwordAction?.let { payload.put("passwordAction", it) }
        emitTyped("room-update", payload, { response ->
            if (response != null && response.optBoolean("ok")) SocketResult.Success(RoomSocketCodec.room(response.getJSONObject("room")))
            else RoomSocketCodec.failure(response)
        }) { parsed ->
            if (parsed is SocketResult.Success && request.roomCode == desiredRoomCode) {
                request.passwordAction?.let { passwordAction ->
                    desiredPassword = when (passwordAction.optString("type")) {
                        "set" -> passwordAction.optString("password").takeIf { it.isNotEmpty() }
                        "remove" -> null
                        else -> desiredPassword
                    }
                }
            }
            result(parsed)
        }
    }

    fun deleteRoom(roomCode: String, ownerCredential: String, result: (SocketResult<Unit>) -> Unit) =
        emitSimple("room-delete", JSONObject().put("roomCode", roomCode).put("ownerCredential", ownerCredential), result)

    fun changeNickname(nickname: String, result: (SocketResult<NicknameChangeResult>) -> Unit) {
        val normalized = NicknamePolicy.normalize(nickname)
        if (!NicknamePolicy.isLocallyValid(normalized)) {
            result(SocketResult.Failure(SocketError(SocketErrorCode.VALIDATION_ERROR, "Invalid nickname")))
            return
        }
        emitTyped("nickname-change", JSONObject().put("nickname", normalized), { response ->
            if (response == null || !response.optBoolean("ok")) RoomSocketCodec.failure(response) else {
                val acceptedNickname = response.optString("nickname")
                val changeDate = response.optString("changeDate")
                require(NicknamePolicy.isLocallyValid(acceptedNickname)) { "Invalid nickname acknowledgement" }
                require(changeDate.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$"))) { "Invalid nickname change date" }
                SocketResult.Success(NicknameChangeResult(acceptedNickname, changeDate))
            }
        }, result)
    }

    fun sendBarrage(text: String, nickname: String, color: String, result: (BarrageAck) -> Unit) {
        val payload = JSONObject().put("text", text).put("nickname", nickname).put("color", color)
        emitTyped("barrage", payload, RoomSocketCodec::barrageAck, result)
    }

    fun report(messageId: String?, targetSessionId: String?, messageText: String?, result: (Boolean, String?) -> Unit) {
        val payload = JSONObject()
        messageId?.let { payload.put("messageId", it) }
        targetSessionId?.let { payload.put("targetSessionId", it) }
        messageText?.let { payload.put("messageText", it) }
        emitSimple("report", payload) { response ->
            when (response) {
                is SocketResult.Success -> result(true, null)
                is SocketResult.Failure -> result(false, response.error.message)
            }
        }
    }

    private fun emitSimple(event: String, payload: JSONObject, result: (SocketResult<Unit>) -> Unit) =
        emitTyped(event, payload, { response ->
            if (response != null && response.optBoolean("ok")) SocketResult.Success(Unit) else RoomSocketCodec.failure(response)
        }, result)

    private fun <T> emitTyped(event: String, payload: JSONObject, parser: (JSONObject?) -> T, result: (T) -> Unit) {
        val active = socket
        if (active == null || !active.connected()) {
            result(transportFailure(event, SocketError(SocketErrorCode.NOT_CONNECTED, "Not connected")))
            return
        }
        val completed = AtomicBoolean(false)
        val id = requestIds.incrementAndGet()
        fun finish(value: T) {
            if (completed.compareAndSet(false, true)) {
                disconnectFailures.remove(id)
                callbackHandler.removeCallbacksAndMessages(id)
                callbackHandler.post { result(value) }
            }
        }
        val timeout = Runnable {
            finish(transportFailure(event, SocketError(SocketErrorCode.TIMEOUT, "Server acknowledgement timed out")))
        }
        disconnectFailures[id] = {
            finish(transportFailure(event, SocketError(SocketErrorCode.NOT_CONNECTED, "Disconnected")))
        }
        callbackHandler.postAtTime(timeout, id, android.os.SystemClock.uptimeMillis() + ACK_TIMEOUT_MS)
        active.emit(event, payload, Ack { args ->
            runCatching { parser(args.firstOrNull() as? JSONObject) }
                .onSuccess(::finish)
                .onFailure {
                    finish(transportFailure(event, SocketError(SocketErrorCode.UNKNOWN, "Invalid server acknowledgement")))
                }
        })
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> transportFailure(event: String, error: SocketError): T =
        (if (event == "barrage") BarrageAck.Error(error) else SocketResult.Failure(error)) as T

    private fun failOutstanding(error: SocketError) {
        // The closures produce NOT_CONNECTED; error is deliberately not logged because operations may contain credentials.
        if (error.code == SocketErrorCode.NOT_CONNECTED) disconnectFailures.values.toList().forEach { it() }
    }

    fun disconnect() {
        failOutstanding(SocketError(SocketErrorCode.NOT_CONNECTED, "Disconnected"))
        callbackHandler.removeCallbacksAndMessages(null)
        socket?.disconnect()
        socket?.off()
        socket = null
        desiredPassword = null
    }

    companion object {
        private const val TAG = "DanmakuSocket"
        private const val ACK_TIMEOUT_MS = 8_000L
    }
}

data class DanmakuMsg(
    val messageId: String,
    val roomCode: String = "",
    val text: String,
    val nickname: String,
    val color: String,
    val timestamp: Long,
    val sessionId: String,
    val mine: Boolean,
)

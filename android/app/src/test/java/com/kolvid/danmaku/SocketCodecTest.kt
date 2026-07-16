package com.kolvid.danmaku

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SocketCodecTest {
    @Test fun `typed barrage ack parses sent queued and structured error`() {
        assertEquals(BarrageAck.Sent("a"), RoomSocketCodec.barrageAck(JSONObject("""{"ok":true,"status":"sent","messageId":"a"}""")))
        assertEquals(BarrageAck.Queued("b", 3, 2000), RoomSocketCodec.barrageAck(JSONObject("""{"ok":true,"status":"queued","messageId":"b","position":3,"estimatedWaitMs":2000}""")))
        val error = RoomSocketCodec.barrageAck(JSONObject("""{"ok":false,"error":{"code":"ROOM_BUSY","scope":"room","message":"busy","retryAfterMs":1000}}"""))
        assertEquals(SocketErrorCode.ROOM_BUSY, (error as BarrageAck.Error).error.code)
    }

    @Test fun `typed status and paginated room list preserve metadata`() {
        assertEquals(BarrageDeliveryStatus.Delivered("x"), RoomSocketCodec.barrageStatus(JSONObject("""{"messageId":"x","status":"delivered"}""")))
        val result = RoomSocketCodec.roomList(JSONObject("""{"ok":true,"data":[{"name":"Room","roomCode":"12345678","count":2,"capacity":100,"visibility":"public","requiresPassword":false,"retentionDays":7}],"pagination":{"page":2,"pageSize":20,"total":41,"totalPages":3}}"""))
        assertTrue(result is SocketResult.Success)
        val page = (result as SocketResult.Success).value
        assertEquals("12345678", page.rooms.single().roomCode)
        assertEquals(3, page.pagination.totalPages)
    }

    @Test fun `Android create acknowledgement preserves missing credential for explicit warning`() {
        val valid = JSONObject("""{"ok":true,"room":{"name":"Owner room","roomCode":"12345678","count":1,"capacity":100,"visibility":"unlisted","requiresPassword":false,"retentionDays":7},"ownerCredential":"credential-value","recentMessages":[]}""")
        val result = RoomSocketCodec.createRoom(valid) as SocketResult.Success<CreateRoomResult>
        assertEquals("credential-value", result.value.ownerCredential)
        val missing = RoomSocketCodec.createRoom(JSONObject("""{"ok":true,"room":{"name":"Owner room","roomCode":"12345678","count":1,"capacity":100,"visibility":"unlisted","requiresPassword":false,"retentionDays":7}}""")) as SocketResult.Success<CreateRoomResult>
        assertNull(missing.value.ownerCredential)
    }

    @Test fun `all specified structured error codes have stable mappings`() {
        val names = listOf("RATE_LIMITED","MUTED","ROOM_BUSY","QUEUE_FULL","QUEUE_EXPIRED","NOT_CONNECTED","NOT_IN_ROOM","ROOM_FULL","ROOM_NOT_FOUND","PASSWORD_REQUIRED","INVALID_PASSWORD","CONTENT_REJECTED","VALIDATION_ERROR","FORBIDDEN","CREATE_LIMITED")
        assertEquals(names, names.map { RoomSocketCodec.error(JSONObject("""{"code":"$it","message":"x"}""")).code.name })
    }

    @Test fun `malformed typed acknowledgements are rejected`() {
        assertThrows(IllegalArgumentException::class.java) {
            RoomSocketCodec.barrageAck(JSONObject("""{"ok":true,"status":"sent"}"""))
        }
        assertThrows(IllegalArgumentException::class.java) {
            RoomSocketCodec.barrageAck(JSONObject("""{"ok":true,"status":"queued","messageId":"m"}"""))
        }
        assertThrows(IllegalArgumentException::class.java) {
            RoomSocketCodec.barrageStatus(JSONObject("""{"messageId":"m","status":"mystery"}"""))
        }
        assertThrows(IllegalArgumentException::class.java) {
            RoomSocketCodec.room(JSONObject("""{"roomCode":"AB12CD34","name":"bad","capacity":100}"""))
        }
    }
}

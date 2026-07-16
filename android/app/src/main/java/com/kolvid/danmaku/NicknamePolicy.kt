package com.kolvid.danmaku

import java.time.Instant
import java.time.ZoneId

object NicknamePolicy {
    const val DEFAULT_NICKNAME = "匿名"
    const val MAX_LENGTH = 6
    private val taipeiZone: ZoneId = ZoneId.of("Asia/Taipei")

    fun normalize(value: String): String = value.trim().ifEmpty { DEFAULT_NICKNAME }

    fun isLocallyValid(value: String): Boolean {
        val normalized = normalize(value)
        return normalized.length <= MAX_LENGTH && normalized.none { it == '<' || it == '>' || it == '&' || it.code < 0x20 || it.code == 0x7f }
    }

    fun taipeiDate(timestampMs: Long = System.currentTimeMillis()): String =
        Instant.ofEpochMilli(timestampMs).atZone(taipeiZone).toLocalDate().toString()

    fun canChange(lastChangeDate: String?, timestampMs: Long = System.currentTimeMillis()): Boolean =
        lastChangeDate != taipeiDate(timestampMs)
}

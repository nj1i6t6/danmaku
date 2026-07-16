package com.kolvid.danmaku

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class NicknamePolicyTest {
    @Test
    fun `Taipei date changes at UTC plus eight midnight`() {
        val before = Instant.parse("2026-07-14T15:59:59.999Z").toEpochMilli()
        val after = Instant.parse("2026-07-14T16:00:00Z").toEpochMilli()
        assertEquals("2026-07-14", NicknamePolicy.taipeiDate(before))
        assertEquals("2026-07-15", NicknamePolicy.taipeiDate(after))
    }

    @Test
    fun `same Taipei date is locked and next date is available`() {
        val now = Instant.parse("2026-07-14T08:00:00Z").toEpochMilli()
        assertFalse(NicknamePolicy.canChange("2026-07-14", now))
        assertTrue(NicknamePolicy.canChange("2026-07-13", now))
        assertTrue(NicknamePolicy.canChange(null, now))
    }

    @Test
    fun `blank nickname becomes anonymous and input uses server-compatible six code-unit limit`() {
        assertEquals("匿名", NicknamePolicy.normalize("   "))
        assertEquals("小夜", NicknamePolicy.normalize("  小夜  "))
        assertTrue(NicknamePolicy.isLocallyValid("六字以內"))
        assertFalse(NicknamePolicy.isLocallyValid("超過六個字暱稱"))
    }
}

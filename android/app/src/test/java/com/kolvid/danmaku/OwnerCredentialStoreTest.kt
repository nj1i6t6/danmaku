package com.kolvid.danmaku

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class OwnerCredentialStoreTest {
    @Test fun `owner credential backing receives ciphertext and supports remove`() {
        val backing = MemoryCredentialBacking()
        val cipher = object : CredentialCipher {
            override fun encrypt(plaintext: ByteArray): EncryptedCredential = EncryptedCredential(byteArrayOf(7), plaintext.reversedArray())
            override fun decrypt(value: EncryptedCredential): ByteArray = value.ciphertext.reversedArray()
        }
        val store = OwnerCredentialStore(backing, cipher)
        store.put("48271635", "owner-secret")
        assertFalse(backing.raw("48271635")!!.ciphertext.contentEquals("owner-secret".toByteArray()))
        assertEquals("owner-secret", store.get("48271635"))
        store.remove("48271635")
        assertNull(store.get("48271635"))
    }

    private class MemoryCredentialBacking : CredentialBacking {
        private val values = mutableMapOf<String, EncryptedCredential>()
        override fun write(roomCode: String, value: EncryptedCredential) { values[roomCode] = value }
        override fun read(roomCode: String): EncryptedCredential? = values[roomCode]
        override fun remove(roomCode: String) { values.remove(roomCode) }
        fun raw(code: String) = values[code]
    }
}

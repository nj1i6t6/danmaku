package com.kolvid.danmaku

import android.content.Context
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

data class EncryptedCredential(val iv: ByteArray, val ciphertext: ByteArray)

interface CredentialCipher {
    fun encrypt(plaintext: ByteArray): EncryptedCredential
    fun decrypt(value: EncryptedCredential): ByteArray
}

interface CredentialBacking {
    fun write(roomCode: String, value: EncryptedCredential)
    fun read(roomCode: String): EncryptedCredential?
    fun remove(roomCode: String)
}

/** Pure coordinator: plaintext exists only in-memory and never reaches the backing store. */
class OwnerCredentialStore(private val backing: CredentialBacking, private val cipher: CredentialCipher) {
    fun put(roomCode: String, credential: String) {
        require(RoomPolicy.isValidCode(roomCode))
        val bytes = credential.toByteArray(Charsets.UTF_8)
        try { backing.write(roomCode, cipher.encrypt(bytes)) } finally { bytes.fill(0) }
    }

    fun get(roomCode: String): String? = backing.read(roomCode)?.let { encrypted ->
        val bytes = cipher.decrypt(encrypted)
        try { String(bytes, Charsets.UTF_8) } finally { bytes.fill(0) }
    }

    fun remove(roomCode: String) = backing.remove(roomCode)
}

class AndroidKeystoreCredentialCipher(private val alias: String = KEY_ALIAS) : CredentialCipher {
    override fun encrypt(plaintext: ByteArray): EncryptedCredential {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return EncryptedCredential(cipher.iv, cipher.doFinal(plaintext))
    }

    override fun decrypt(value: EncryptedCredential): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, value.iv))
        return cipher.doFinal(value.ciphertext)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val KEY_ALIAS = "danmaku_owner_credentials_v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}

class EncryptedPreferenceCredentialBacking(context: Context) : CredentialBacking {
    private val preferences = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
    override fun write(roomCode: String, value: EncryptedCredential) {
        val packed = Base64.encodeToString(value.iv, Base64.NO_WRAP) + "." +
            Base64.encodeToString(value.ciphertext, Base64.NO_WRAP)
        check(preferences.edit().putString(roomCode, packed).commit()) {
            "Unable to durably store owner credential"
        }
    }
    override fun read(roomCode: String): EncryptedCredential? {
        val parts = preferences.getString(roomCode, null)?.split('.', limit = 2) ?: return null
        if (parts.size != 2) return null
        return runCatching { EncryptedCredential(Base64.decode(parts[0], Base64.NO_WRAP), Base64.decode(parts[1], Base64.NO_WRAP)) }.getOrNull()
    }
    override fun remove(roomCode: String) { preferences.edit().remove(roomCode).apply() }
    companion object { private const val FILE_NAME = "danmaku_owner_credentials_encrypted" }
}

fun Context.ownerCredentialStore(): OwnerCredentialStore =
    OwnerCredentialStore(EncryptedPreferenceCredentialBacking(applicationContext), AndroidKeystoreCredentialCipher())

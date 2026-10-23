package hn.nova.capture

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import hn.nova.capture.core.Backoff
import hn.nova.capture.core.OutboxItem
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Preferencias de la app. El token de ingesta se guarda cifrado con una clave del Android Keystore. */
class Prefs(ctx: Context) {
    private val sp: SharedPreferences = ctx.getSharedPreferences("nova", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("server", "") ?: ""
        set(v) = sp.edit().putString("server", v.trim().trimEnd('/')).apply()

    var token: String?
        get() = sp.getString("token", null)?.let { runCatching { TokenVault.decrypt(it) }.getOrNull() }
        set(v) = sp.edit().apply { if (v.isNullOrBlank()) remove("token") else putString("token", TokenVault.encrypt(v.trim())) }.apply()

    var allowedApps: Set<String>
        get() = sp.getStringSet("apps", emptySet())?.toSet() ?: emptySet()
        set(v) = sp.edit().putStringSet("apps", v).apply()

    var smsEnabled: Boolean
        get() = sp.getBoolean("sms", false)
        set(v) = sp.edit().putBoolean("sms", v).apply()

    var smsSenders: Set<String>
        get() = sp.getStringSet("senders", emptySet())?.toSet() ?: emptySet()
        set(v) = sp.edit().putStringSet("senders", v).apply()

    /** Solo nombres de paquete y etiqueta (nunca contenido) de apps que publicaron avisos, para elegir cuáles capturar. */
    val seenApps: Map<String, String>
        get() = (sp.getStringSet("seen", emptySet()) ?: emptySet()).associate { it.substringBefore('|') to it.substringAfter('|', it) }

    fun rememberApp(pkg: String, label: String) {
        val cur = sp.getStringSet("seen", emptySet())?.toMutableSet() ?: mutableSetOf()
        if (cur.none { it.startsWith("$pkg|") } && cur.size < 60) { cur.add("$pkg|${label.replace('|', ' ')}"); sp.edit().putStringSet("seen", cur).apply() }
    }

    fun count(key: String, by: Int = 1) = sp.edit().putInt("n_$key", sp.getInt("n_$key", 0) + by).apply()
    fun counter(key: String) = sp.getInt("n_$key", 0)
    var lastError: String?
        get() = sp.getString("last_error", null)
        set(v) = sp.edit().putString("last_error", v).apply()
    var lastSentAt: Long
        get() = sp.getLong("last_sent", 0)
        set(v) = sp.edit().putLong("last_sent", v).apply()
}

object TokenVault {
    private const val ALIAS = "nova_ingest_token"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    fun encrypt(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val enc = c.doFinal(plain.toByteArray())
        return Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(enc, Base64.NO_WRAP)
    }

    fun decrypt(blob: String): String {
        val (iv, enc) = blob.split(':').map { Base64.decode(it, Base64.NO_WRAP) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return String(c.doFinal(enc))
    }
}

/** Cola de salida en almacenamiento privado de la app: los avisos no se pierden si no hay internet. */
class Outbox(ctx: Context) {
    private val file = File(ctx.filesDir, "outbox.tsv")

    @Synchronized fun add(item: OutboxItem) {
        val items = readAll()
        if (items.any { it.sourceId == item.sourceId }) return
        write((items + item).takeLast(500))
    }

    @Synchronized fun readAll(): List<OutboxItem> =
        if (!file.exists()) emptyList() else file.readLines().mapNotNull { OutboxItem.decode(it) }

    /** Aplica el resultado de un envío sin perder avisos que llegaron mientras tanto. */
    @Synchronized fun commit(done: Set<String>, retried: Map<String, Int>) {
        write(readAll().filter { it.sourceId !in done }.map { i -> retried[i.sourceId]?.let { i.copy(attempts = it) } ?: i })
    }

    fun size() = readAll().size

    private fun write(items: List<OutboxItem>) {
        val tmp = File(file.parentFile, "outbox.tmp")
        tmp.writeText(items.joinToString("\n") { it.encode() })
        tmp.renameTo(file)
    }

    /** Elimina los que superan la antigüedad máxima. */
    @Synchronized fun prune(now: Long): Int {
        val items = readAll()
        val keep = items.filter { now - it.createdAt < Backoff.MAX_AGE_MILLIS }
        if (keep.size != items.size) write(keep)
        return items.size - keep.size
    }
}

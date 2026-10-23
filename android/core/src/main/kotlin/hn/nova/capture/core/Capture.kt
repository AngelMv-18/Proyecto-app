package hn.nova.capture.core

import java.security.MessageDigest
import java.time.Instant

/** Un aviso capturado en el teléfono (notificación de una app bancaria o SMS). */
data class CaptureEvent(
    val channel: Channel,
    /** Paquete de la app (notificación) o número/nombre remitente (SMS). */
    val origin: String,
    val originLabel: String?,
    val title: String?,
    val text: String,
    val postedAtMillis: Long,
)

enum class Channel(val wire: String) { NOTIFICATION("notification"), SMS("sms") }

sealed class Decision {
    data class Send(val payload: String, val sourceId: String) : Decision()
    data class Skip(val reason: SkipReason) : Decision()
}

enum class SkipReason(val label: String) {
    NOT_ALLOWED("Origen no autorizado"),
    EMPTY("Sin texto"),
    SECURITY_CODE("Código de seguridad: nunca se envía"),
    NO_AMOUNT("Sin importe: aviso informativo"),
    DUPLICATE("Repetido"),
}

/**
 * Decide qué avisos salen del teléfono. Principio de mínimo dato: solo orígenes que el usuario autorizó,
 * nunca códigos de seguridad, y solo textos que parecen contener un importe.
 */
class CaptureFilter(
    private val allowedOrigins: Set<String>,
    private val dedupeWindowMillis: Long = 10 * 60 * 1000L,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val seen = LinkedHashMap<String, Long>()

    fun decide(e: CaptureEvent): Decision {
        if (normalizeOrigin(e.origin) !in allowedOrigins.map(::normalizeOrigin)) return Decision.Skip(SkipReason.NOT_ALLOWED)
        val text = listOfNotNull(e.title, e.text).joinToString(" ").trim()
        if (text.isBlank()) return Decision.Skip(SkipReason.EMPTY)
        val folded = fold(text)
        if (SECURITY.containsMatchIn(folded)) return Decision.Skip(SkipReason.SECURITY_CODE)
        if (!AMOUNT.containsMatchIn(text)) return Decision.Skip(SkipReason.NO_AMOUNT)
        val id = sourceId(e)
        val t = now()
        seen.entries.removeIf { t - it.value > dedupeWindowMillis }
        if (seen.containsKey(id)) return Decision.Skip(SkipReason.DUPLICATE)
        seen[id] = t
        while (seen.size > 500) seen.remove(seen.keys.first())
        return Decision.Send(Payload.json(e, id), id)
    }

    companion object {
        // Las apps bancarias suelen re-publicar la misma notificación; el id depende del origen y del texto.
        fun sourceId(e: CaptureEvent): String {
            val md = MessageDigest.getInstance("SHA-256")
            val raw = "${e.channel.wire}|${normalizeOrigin(e.origin)}|${e.title ?: ""}|${e.text}"
            return md.digest(raw.toByteArray()).joinToString("") { "%02x".format(it) }.take(32)
        }

        fun normalizeOrigin(s: String) = s.trim().lowercase().replace(Regex("[\\s()-]"), "")

        fun fold(s: String): String = java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFD)
            .replace(Regex("\\p{Mn}+"), "").lowercase()

        private val SECURITY = Regex("(codigo de (verificacion|seguridad|acceso)|\\botp\\b|clave (temporal|dinamica)|contrasena|password|token de|\\bpin\\b)")
        private val AMOUNT = Regex("(?i)(L\\.?|Lps?\\.?|HNL|US\\$|USD|\\$|€)\\s*\\d|\\d[\\d.,]*\\s*(HNL|USD|lempiras?|d[oó]lares?)")
    }
}

/** Construye el cuerpo JSON para POST /api/ingest/notification (sin dependencias externas). */
object Payload {
    fun json(e: CaptureEvent, sourceId: String): String {
        val parts = mutableListOf(
            "\"text\":${str(e.text.take(2000))}",
            "\"posted_at\":${str(Instant.ofEpochMilli(e.postedAtMillis).toString())}",
            "\"source_id\":${str(sourceId)}",
            "\"channel\":${str(e.channel.wire)}",
        )
        e.title?.takeIf { it.isNotBlank() }?.let { parts += "\"title\":${str(it.take(200))}" }
        (e.originLabel ?: e.origin).takeIf { it.isNotBlank() }?.let { parts += "\"app\":${str(it.take(80))}" }
        return "{" + parts.joinToString(",") + "}"
    }

    fun str(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) when {
            c == '"' -> sb.append("\\\"")
            c == '\\' -> sb.append("\\\\")
            c == '\n' -> sb.append("\\n")
            c == '\r' -> sb.append("\\r")
            c == '\t' -> sb.append("\\t")
            c < ' ' -> sb.append("\\u%04x".format(c.code))
            else -> sb.append(c)
        }
        return sb.append('"').toString()
    }
}

/** Reintentos con espera exponencial: 30 s, 1, 2, 4… hasta 6 h. Tras 2 días el aviso se descarta. */
object Backoff {
    const val MAX_AGE_MILLIS = 2 * 24 * 3600 * 1000L
    fun delayMillis(attempt: Int): Long = minOf(30_000L shl minOf(attempt, 20), 6 * 3600 * 1000L)
    /** 4xx distintos de 408/429 no se reintentan: el servidor rechazó el contenido o el token. */
    fun retryable(httpStatus: Int?): Boolean = httpStatus == null || httpStatus == 408 || httpStatus == 429 || httpStatus >= 500
}

/** Cola de salida persistente en formato de líneas (una entrada por aviso). */
data class OutboxItem(val sourceId: String, val payload: String, val createdAt: Long, val attempts: Int) {
    fun encode(): String = listOf(sourceId, createdAt.toString(), attempts.toString(), b64(payload)).joinToString("\t")

    companion object {
        fun decode(line: String): OutboxItem? {
            val p = line.split('\t')
            if (p.size != 4) return null
            return runCatching { OutboxItem(p[0], String(java.util.Base64.getDecoder().decode(p[3])), p[1].toLong(), p[2].toInt()) }.getOrNull()
        }
        private fun b64(s: String) = java.util.Base64.getEncoder().encodeToString(s.toByteArray())
    }
}

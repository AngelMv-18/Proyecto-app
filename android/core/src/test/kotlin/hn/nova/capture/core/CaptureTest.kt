package hn.nova.capture.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.test.assertFalse
import kotlin.test.assertNull

class CaptureTest {
    private var clock = 1_000_000L
    private val filter = CaptureFilter(setOf("com.banco.app", "+504 2290-0000"), now = { clock })
    private fun ev(text: String, origin: String = "com.banco.app", title: String? = "Banco", ch: Channel = Channel.NOTIFICATION) =
        CaptureEvent(ch, origin, "Banco", title, text, 1_760_000_000_000L)

    @Test fun sendsPurchaseFromAllowedApp() {
        val d = filter.decide(ev("Compra aprobada por L 1,250.50 en SUPER LA COLONIA"))
        assertIs<Decision.Send>(d)
        assertTrue(d.payload.contains("\"text\":\"Compra aprobada por L 1,250.50 en SUPER LA COLONIA\""))
        assertTrue(d.payload.contains("\"channel\":\"notification\""))
        assertTrue(d.payload.contains("\"posted_at\":\"2025-10-09T08:53:20Z\""))
    }

    @Test fun ignoresAppsNotAuthorized() {
        assertEquals(Decision.Skip(SkipReason.NOT_ALLOWED), filter.decide(ev("Compra por L 50.00", origin = "com.whatsapp")))
    }

    @Test fun neverSendsSecurityCodes() {
        assertEquals(Decision.Skip(SkipReason.SECURITY_CODE), filter.decide(ev("Su código de verificación es 482913 para la compra de L 100")))
        assertEquals(Decision.Skip(SkipReason.SECURITY_CODE), filter.decide(ev("Tu OTP es 1234")))
        assertEquals(Decision.Skip(SkipReason.SECURITY_CODE), filter.decide(ev("Clave dinámica: 9921 · L 10")))
    }

    @Test fun skipsMessagesWithoutAmount() {
        assertEquals(Decision.Skip(SkipReason.NO_AMOUNT), filter.decide(ev("Tu estado de cuenta ya está disponible")))
    }

    @Test fun dedupesRepostedNotificationWithinWindow() {
        assertIs<Decision.Send>(filter.decide(ev("Consumo de US$ 12.99 en NETFLIX")))
        assertEquals(Decision.Skip(SkipReason.DUPLICATE), filter.decide(ev("Consumo de US$ 12.99 en NETFLIX")))
        clock += 11 * 60 * 1000L
        assertIs<Decision.Send>(filter.decide(ev("Consumo de US$ 12.99 en NETFLIX")))
    }

    @Test fun smsSenderMatchesIgnoringFormatting() {
        val d = filter.decide(ev("BAC: Compra L 300.00 en FARMACIA", origin = "+50422900000", title = null, ch = Channel.SMS))
        assertIs<Decision.Send>(d)
        assertTrue(d.payload.contains("\"channel\":\"sms\""))
        assertFalse(d.payload.contains("\"title\""))
    }

    @Test fun sameTextSameIdAcrossRestarts() {
        assertEquals(CaptureFilter.sourceId(ev("Compra L 5")), CaptureFilter.sourceId(ev("Compra L 5")))
        assertTrue(Regex("^[a-f0-9]{32}$").matches(CaptureFilter.sourceId(ev("Compra L 5"))))
    }

    @Test fun jsonEscaping() {
        assertEquals("\"a\\\"b\\\\c\\nd\\u0001\"", Payload.str("a\"b\\c\nd\u0001"))
    }

    @Test fun backoffAndRetryPolicy() {
        assertEquals(30_000L, Backoff.delayMillis(0))
        assertEquals(60_000L, Backoff.delayMillis(1))
        assertEquals(6 * 3600 * 1000L, Backoff.delayMillis(30))
        assertTrue(Backoff.retryable(null)); assertTrue(Backoff.retryable(503)); assertTrue(Backoff.retryable(429))
        assertFalse(Backoff.retryable(401)); assertFalse(Backoff.retryable(400))
    }

    @Test fun outboxRoundTrip() {
        val i = OutboxItem("id1", "{\"text\":\"tab\\there\"}\n", 5L, 2)
        assertEquals(i, OutboxItem.decode(i.encode()))
        assertNull(OutboxItem.decode("roto"))
    }
}

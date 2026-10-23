package hn.nova.capture

import android.app.Notification
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import hn.nova.capture.core.Backoff
import hn.nova.capture.core.CaptureEvent
import hn.nova.capture.core.CaptureFilter
import hn.nova.capture.core.Channel
import hn.nova.capture.core.Decision
import hn.nova.capture.core.OutboxItem

/** Punto común: filtra el aviso, lo encola y programa el envío. Nada sale del teléfono sin pasar el filtro. */
object Pipeline {
    @Volatile private var filter: CaptureFilter? = null
    @Volatile private var filterKey: Set<String> = emptySet()

    @Synchronized fun handle(ctx: Context, e: CaptureEvent) {
        val p = Prefs(ctx)
        val allowed = p.allowedApps + p.smsSenders
        if (filter == null || allowed != filterKey) { filter = CaptureFilter(allowed); filterKey = allowed }
        when (val d = filter!!.decide(e)) {
            is Decision.Skip -> p.count("skip_${d.reason.name}")
            is Decision.Send -> {
                Outbox(ctx).add(OutboxItem(d.sourceId, d.payload, System.currentTimeMillis(), 0))
                p.count("queued")
                FlushJobService.schedule(ctx, 0)
            }
        }
    }
}

/** Lee notificaciones solo si el usuario concedió "Acceso a notificaciones" y solo de las apps que eligió. */
class CaptureService : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName) return
        val n = sbn.notification ?: return
        if ((n.flags and Notification.FLAG_GROUP_SUMMARY) != 0 || (n.flags and Notification.FLAG_ONGOING_EVENT) != 0) return
        val label = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString() }.getOrDefault(sbn.packageName)
        val prefs = Prefs(this)
        prefs.rememberApp(sbn.packageName, label)
        if (sbn.packageName !in prefs.allowedApps) return
        val ex = n.extras
        val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val text = (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: return
        Pipeline.handle(this, CaptureEvent(Channel.NOTIFICATION, sbn.packageName, label, title, text, sbn.postTime))
    }
}

/** SMS de remitentes autorizados (opcional; requiere permiso RECEIVE_SMS concedido por el usuario). */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val prefs = Prefs(ctx)
        if (!prefs.smsEnabled) return
        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        // Un SMS largo llega en varias partes del mismo remitente.
        msgs.filterNotNull().groupBy { it.displayOriginatingAddress ?: "" }.forEach { (from, parts) ->
            if (from.isBlank()) return@forEach
            val text = parts.joinToString("") { it.displayMessageBody ?: "" }
            val ts = parts.minOf { it.timestampMillis }
            Pipeline.handle(ctx, CaptureEvent(Channel.SMS, from, from, null, text, ts))
        }
    }
}

/** Envía la cola cuando hay red; reintenta con espera exponencial. */
class FlushJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread {
            val again = flush(applicationContext)
            jobFinished(params, false)
            if (again != null) schedule(applicationContext, again)
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true

    companion object {
        private const val JOB_ID = 7101

        fun schedule(ctx: Context, delayMillis: Long) {
            val js = ctx.getSystemService(JobScheduler::class.java) ?: return
            val job = JobInfo.Builder(JOB_ID, ComponentName(ctx, FlushJobService::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setMinimumLatency(delayMillis)
                .build()
            js.schedule(job)
        }

        /** Devuelve el retraso para el próximo intento si quedan pendientes reintentables, o null. */
        fun flush(ctx: Context): Long? {
            val prefs = Prefs(ctx)
            val outbox = Outbox(ctx)
            prefs.count("expired", outbox.prune(System.currentTimeMillis()))
            val token = prefs.token
            val server = prefs.serverUrl
            if (token.isNullOrBlank() || server.isBlank()) { prefs.lastError = "Falta configurar el servidor o el token"; return null }
            val done = mutableSetOf<String>()
            val retried = mutableMapOf<String, Int>()
            var minAttempt = Int.MAX_VALUE
            for (item in outbox.readAll()) {
                val r = Uploader.post(server, "/api/ingest/notification", token, item.payload)
                when {
                    r.status in 200..299 -> { done += item.sourceId; prefs.count("sent"); prefs.lastSentAt = System.currentTimeMillis(); prefs.lastError = null }
                    Backoff.retryable(r.status) -> {
                        retried[item.sourceId] = item.attempts + 1
                        minAttempt = minOf(minAttempt, item.attempts + 1)
                        prefs.lastError = r.error ?: "El servidor respondió ${r.status}"
                    }
                    else -> { done += item.sourceId; prefs.count("rejected"); prefs.lastError = "Rechazado por el servidor (${r.status}): revisa el token" }
                }
            }
            outbox.commit(done, retried)
            return if (retried.isEmpty()) null else Backoff.delayMillis(minAttempt)
        }
    }
}

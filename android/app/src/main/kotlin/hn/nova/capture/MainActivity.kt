package hn.nova.capture

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import hn.nova.capture.core.SkipReason
import java.text.DateFormat
import java.util.Date

/**
 * Pantalla única de configuración. Interfaz construida en código (sin librerías) con la estética de NOVA.
 * Qué hace la app: lee SOLO avisos de las apps/remitentes que marques, descarta códigos de seguridad, y envía el
 * texto a tu servidor NOVA, donde queda "por revisar" (no afecta saldos hasta que lo confirmes).
 */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var root: LinearLayout
    private val bg = Color.parseColor("#0B0D10"); private val surface = Color.parseColor("#141920")
    private val fg = Color.parseColor("#EEF2F6"); private val muted = Color.parseColor("#A3AFBD"); private val lime = Color.parseColor("#C6FF3D")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        window.statusBarColor = bg
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(24), dp(16), dp(32)) }
        setContentView(ScrollView(this).apply { setBackgroundColor(bg); addView(root) })
    }

    override fun onResume() { super.onResume(); render() }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun label(s: String, size: Float = 15f, color: Int = fg, bold: Boolean = false) = TextView(this).apply {
        this.text = s; textSize = size; setTextColor(color); if (bold) typeface = Typeface.DEFAULT_BOLD
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun card(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(14), dp(16), dp(14))
        background = GradientDrawable().apply { setColor(surface); cornerRadius = dp(18).toFloat(); setStroke(dp(1), Color.parseColor("#26FFFFFF")) }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) }
        views.forEach { addView(it) }
    }

    private fun button(s: String, primary: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        this.text = s; isAllCaps = false; minHeight = dp(48); setTextColor(if (primary) Color.parseColor("#0B1200") else fg)
        background = GradientDrawable().apply { setColor(if (primary) lime else Color.parseColor("#222A35")); cornerRadius = dp(14).toFloat() }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) }
        setOnClickListener { onClick() }
    }

    private fun input(value: String, hint: String, secret: Boolean = false) = EditText(this).apply {
        setText(value); this.hint = hint; setTextColor(fg); setHintTextColor(Color.parseColor("#6F7B89")); minHeight = dp(48)
        inputType = if (secret) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        background = GradientDrawable().apply { setColor(Color.parseColor("#0F1318")); cornerRadius = dp(12).toFloat(); setStroke(dp(1), Color.parseColor("#33FFFFFF")) }
        setPadding(dp(12), 0, dp(12), 0)
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) }
    }

    private fun listenerEnabled(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        val me = ComponentName(this, CaptureService::class.java)
        return flat.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    private fun render() {
        root.removeAllViews()
        root.addView(label("NOVA Captura", 26f, lime, bold = true))
        root.addView(label("Envía a tu NOVA FINANCE los avisos de compras de tus bancos para no registrarlos a mano. Todo llega como “por revisar”: no cambia tus saldos hasta que lo confirmes.", 14f, muted))

        // 1. Servidor
        val url = input(prefs.serverUrl, "https://finanzas.tudominio.com")
        val tok = input("", if (prefs.token != null) "Token guardado (escribe otro para cambiarlo)" else "nova_ing_…", secret = true)
        val status = label("", 13f, muted)
        root.addView(card(
            label("1. Tu servidor", 17f, bold = true),
            label("Genera el token en NOVA → Integraciones → Notificaciones y SMS. Se guarda cifrado en este teléfono.", 13f, muted),
            url, tok,
            button("Guardar", primary = true) {
                val u = url.text.toString().trim()
                if (!Uploader.validUrl(u)) { toast("La dirección debe empezar por https://"); return@button }
                prefs.serverUrl = u
                if (tok.text.isNotBlank()) prefs.token = tok.text.toString()
                toast("Guardado"); render()
            },
            button("Probar conexión") {
                val t = prefs.token; val s = prefs.serverUrl
                if (t == null || s.isBlank()) { toast("Guarda primero el servidor y el token"); return@button }
                status.text = "Probando…"
                Thread {
                    val r = Uploader.post(s, "/api/ingest/ping", t, "{}")
                    runOnUiThread {
                        status.text = when {
                            r.status == 200 -> if (r.body?.contains("\"account\":{") == true) "✓ Conectado. " + (Regex("\"name\":\"([^\"]*)\"").find(r.body)?.groupValues?.get(1)?.let { "Cuenta destino: $it" } ?: "") else "✓ Conectado, pero falta elegir la cuenta destino en NOVA."
                            r.status == 401 -> "✗ Token inválido o revocado."
                            r.status != null -> "✗ El servidor respondió ${r.status}."
                            else -> "✗ Sin conexión: ${r.error}"
                        }
                    }
                }.start()
            },
            status,
        ))

        // 2. Notificaciones
        val enabled = listenerEnabled()
        val seen = prefs.seenApps
        val apps = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        if (seen.isEmpty()) apps.addView(label(if (enabled) "Aún no se han visto avisos. Haz una compra o espera un aviso de tu banco y vuelve aquí." else "Concede el acceso para ver qué apps publican avisos.", 13f, muted))
        seen.entries.sortedBy { it.value.lowercase() }.forEach { (pkg, name) ->
            apps.addView(CheckBox(this).apply {
                this.text = "$name\n$pkg"; setTextColor(fg); isChecked = pkg in prefs.allowedApps; minHeight = dp(48)
                setOnCheckedChangeListener { _, on -> prefs.allowedApps = if (on) prefs.allowedApps + pkg else prefs.allowedApps - pkg }
            })
        }
        root.addView(card(
            label("2. Avisos de apps bancarias", 17f, bold = true),
            label(if (enabled) "✓ Acceso a notificaciones concedido." else "Sin acceso a notificaciones. Android te pedirá confirmarlo; puedes retirarlo cuando quieras.", 13f, if (enabled) lime else muted),
            button(if (enabled) "Revisar acceso a notificaciones" else "Dar acceso a notificaciones", primary = !enabled) { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) },
            label("Marca SOLO las apps de tus bancos o billeteras. Las demás se ignoran sin leer su contenido. De las apps no marcadas solo se guarda su nombre para mostrarlas aquí.", 13f, muted),
            apps,
        ))

        // 3. SMS
        val senders = input(prefs.smsSenders.joinToString(", "), "Remitentes, p. ej.: BAC, 5555, +50422900000")
        root.addView(card(
            label("3. SMS del banco (opcional)", 17f, bold = true),
            label("Muchos bancos en Honduras avisan por SMS. Solo se leen los SMS de los remitentes que escribas.", 13f, muted),
            Switch(this).apply {
                this.text = "Capturar SMS de remitentes autorizados"; setTextColor(fg); isChecked = prefs.smsEnabled && hasSms(); minHeight = dp(48)
                setOnCheckedChangeListener { _, on ->
                    if (on && !hasSms()) requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS), 1)
                    prefs.smsEnabled = on
                }
            },
            senders,
            button("Guardar remitentes") {
                prefs.smsSenders = senders.text.toString().split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
                toast("Remitentes guardados")
            },
        ))

        // 4. Estado
        val pending = Outbox(this).size()
        val skipped = SkipReason.values().map { it to prefs.counter("skip_${it.name}") }.filter { it.second > 0 }
        root.addView(card(
            label("Estado", 17f, bold = true),
            label("Enviados: ${prefs.counter("sent")} · Pendientes: $pending · Rechazados: ${prefs.counter("rejected")}", 14f),
            label(if (prefs.lastSentAt > 0) "Último envío: " + DateFormat.getDateTimeInstance().format(Date(prefs.lastSentAt)) else "Aún no se ha enviado nada.", 13f, muted),
            label(if (skipped.isEmpty()) "Omitidos: ninguno" else "Omitidos: " + skipped.joinToString(" · ") { "${it.first.label} ${it.second}" }, 13f, muted),
            label(prefs.lastError?.let { "Último problema: $it" } ?: "", 13f, Color.parseColor("#FFB84D")),
            button("Enviar pendientes ahora") { FlushJobService.schedule(this, 0); toast("Envío programado") },
        ))
        root.addView(label("Privacidad: no se leen contraseñas ni datos protegidos de otras apps, solo el texto visible de los avisos que tú autorizas. Los códigos de seguridad se descartan en el teléfono. Desinstalar la app borra el token y la cola.", 12f, muted).apply { gravity = Gravity.START; setPadding(0, dp(16), 0, 0) })
    }

    private fun hasSms() = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 1) {
            val ok = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
            prefs.smsEnabled = ok
            if (!ok) toast("Sin permiso de SMS: la captura de SMS queda desactivada")
            render()
        }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}

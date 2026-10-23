package hn.nova.capture

import java.net.HttpURLConnection
import java.net.URL

data class HttpResult(val status: Int?, val body: String?, val error: String?)

/** Cliente HTTP mínimo (HttpURLConnection). Exige HTTPS salvo hacia el emulador/equipo local. */
object Uploader {
    fun validUrl(url: String): Boolean =
        url.startsWith("https://") || url.startsWith("http://10.0.2.2") || url.startsWith("http://localhost")

    fun post(baseUrl: String, path: String, token: String, json: String): HttpResult {
        if (!validUrl(baseUrl)) return HttpResult(null, null, "La dirección del servidor debe empezar por https://")
        return try {
            val c = (URL(baseUrl + path).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 20_000
                doOutput = true
                setRequestProperty("content-type", "application/json; charset=utf-8")
                setRequestProperty("authorization", "Bearer $token")
                setRequestProperty("user-agent", "NOVA-Captura-Android/0.1")
            }
            c.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() }?.take(2000)
            c.disconnect()
            HttpResult(code, body, null)
        } catch (e: Exception) {
            HttpResult(null, null, e.javaClass.simpleName + (e.message?.let { ": $it" } ?: ""))
        }
    }
}

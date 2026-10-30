package com.sevencnup.codexremote

import android.net.Uri
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

internal class RemoteApiException(
    val statusCode: Int,
    message: String,
) : IOException(message)

internal class RemoteApi(
    private val endpoint: String,
    private val token: String? = null,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(90, TimeUnit.SECONDS)
        .build()
    private val uploadClient = client.newBuilder()
        .callTimeout(10, TimeUnit.MINUTES)
        .readTimeout(10, TimeUnit.MINUTES)
        .writeTimeout(10, TimeUnit.MINUTES)
        .build()

    fun get(path: String): JSONObject = request("GET", path)

    fun getArray(path: String): JSONArray = requestArray("GET", path)

    fun post(path: String, body: JSONObject = JSONObject()): JSONObject = request("POST", path, body)

    fun patch(path: String, body: JSONObject): JSONObject = request("PATCH", path, body)

    fun delete(path: String): JSONObject = request("DELETE", path)

    fun upload(path: String, mimeType: String, bytes: ByteArray): JSONObject {
        val body = bytes.toRequestBody(mimeType.toMediaType())
        return execute("POST", path, body, mimeType)
    }

    fun uploadStream(path: String, size: Long?, openStream: () -> InputStream, onProgress: (Long) -> Unit): JSONObject {
        val mediaType = "application/octet-stream".toMediaType()
        val body = object : RequestBody() {
            override fun contentType() = mediaType
            override fun contentLength() = size ?: -1L

            override fun writeTo(sink: BufferedSink) {
                openStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var sent = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (count == 0) continue
                        sink.write(buffer, 0, count)
                        sent += count
                        onProgress(sent)
                    }
                }
            }
        }
        return execute("POST", path, body, "application/octet-stream", uploadClient)
    }

    private fun request(method: String, path: String, value: JSONObject? = null): JSONObject {
        val body = value?.toString()?.toRequestBody(JSON_MEDIA_TYPE)
        return execute(method, path, body, if (body == null) null else "application/json")
    }

    private fun requestArray(method: String, path: String): JSONArray {
        val response = executeRaw(method, path, null, null)
        if (!response.isSuccessful) throw responseError(response.code, response.body?.string())
        val text = response.body?.string().orEmpty()
        return try {
            JSONArray(text)
        } catch (error: Exception) {
            throw IOException("服务器返回的数据格式无效。", error)
        } finally {
            response.close()
        }
    }

    private fun execute(method: String, path: String, body: RequestBody?, contentType: String?, networkClient: OkHttpClient = client): JSONObject {
        val response = executeRaw(method, path, body, contentType, networkClient)
        val text = response.body?.string().orEmpty()
        if (!response.isSuccessful) {
            val error = responseError(response.code, text)
            response.close()
            throw error
        }
        response.close()
        return try {
            JSONObject(text.ifBlank { "{}" })
        } catch (error: Exception) {
            throw IOException("服务器返回的数据格式无效。", error)
        }
    }

    private fun executeRaw(method: String, path: String, body: RequestBody?, contentType: String?, networkClient: OkHttpClient = client): okhttp3.Response {
        val builder = Request.Builder()
            .url(endpoint.trimEnd('/') + path)
            .header("Accept", "application/json")
            .header("User-Agent", "CodeRemoteAndroid/${BuildConfig.VERSION_NAME}")
        if (token != null) builder.header("Authorization", "Bearer $token")
        if (contentType != null) builder.header("Content-Type", contentType)
        when (method) {
            "GET" -> builder.get()
            "DELETE" -> builder.delete()
            else -> builder.method(method, body ?: ByteArray(0).toRequestBody(null))
        }
        return try {
            networkClient.newCall(builder.build()).execute()
        } catch (error: IOException) {
            throw IOException("无法连接电脑网页服务，请检查手机网络或远程连接。", error)
        }
    }

    private fun responseError(code: Int, text: String?): IOException {
        val detail = try {
            JSONObject(text.orEmpty()).optString("detail", "")
        } catch (_: Exception) {
            ""
        }
        val fallback = when (code) {
            401 -> "配对已失效，请重新输入配对码。"
            409 -> "当前操作与对话状态冲突，请刷新后重试。"
            413 -> "附件太大，无法上传。"
            else -> "服务器请求失败（HTTP $code）。"
        }
        return RemoteApiException(code, detail.ifBlank { fallback })
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        fun normalizeEndpoint(raw: String): String {
            var value = raw.trim()
            if (value.isEmpty()) throw IllegalArgumentException("请输入电脑网页地址。")
            if (!value.contains("://")) value = "http://$value"
            val uri = Uri.parse(value)
            if ((uri.scheme != "http" && uri.scheme != "https") || uri.host.isNullOrBlank()) {
                throw IllegalArgumentException("地址格式无效，请填写 http://电脑IP:4173。")
            }
            if (!uri.query.isNullOrBlank() || !uri.fragment.isNullOrBlank()) {
                throw IllegalArgumentException("地址不要包含查询参数或片段。")
            }
            if (uri.scheme == "http" && uri.port == -1 && uri.host?.matches(Regex("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) == true &&
                uri.path.orEmpty().trim('/').isEmpty()) {
                return "http://${uri.host}:4173"
            }
            return value.trimEnd('/')
        }

        fun encodePath(value: String): String = Uri.encode(value)
    }
}

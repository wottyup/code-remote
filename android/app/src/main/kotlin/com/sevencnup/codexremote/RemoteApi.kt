package com.sevencnup.codexremote

import android.net.Uri
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

internal class RemoteApi(
    private val endpoint: String,
    private val token: String? = null,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(90, TimeUnit.SECONDS)
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

    private fun execute(method: String, path: String, body: okhttp3.RequestBody?, contentType: String?): JSONObject {
        val response = executeRaw(method, path, body, contentType)
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

    private fun executeRaw(method: String, path: String, body: okhttp3.RequestBody?, contentType: String?): okhttp3.Response {
        val builder = Request.Builder()
            .url(endpoint.trimEnd('/') + path)
            .header("Accept", "application/json")
            .header("User-Agent", "CodexRemoteAndroid/${BuildConfig.VERSION_NAME}")
        if (token != null) builder.header("Authorization", "Bearer $token")
        if (contentType != null) builder.header("Content-Type", contentType)
        when (method) {
            "GET" -> builder.get()
            "DELETE" -> builder.delete()
            else -> builder.method(method, body ?: ByteArray(0).toRequestBody(null))
        }
        return try {
            client.newCall(builder.build()).execute()
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
        return IOException(detail.ifBlank { fallback })
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
            return value.trimEnd('/')
        }

        fun encodePath(value: String): String = Uri.encode(value)
    }
}

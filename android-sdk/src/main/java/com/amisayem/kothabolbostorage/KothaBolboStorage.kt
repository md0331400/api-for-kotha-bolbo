package com.amisayem.kothabolbostorage

import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.tasks.await
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * Small Android client for Kotha Bolbo Storage Server.
 *
 * Pass the contents of kotha-bolbo-storage-server.json and the app's FirebaseAuth.
 * Every storage request carries the signed-in user's Firebase ID token plus the
 * app-scoped X-API-Key from the config.
 */
class KothaBolboStorage(
    config: JSONObject,
    private val firebaseAuth: FirebaseAuth,
    private val http: OkHttpClient = OkHttpClient()
) {
    private val baseUrl = config.getString("storageApiUrl").trimEnd('/')
    private val storageApiKey = config.getString("storageApiKey")

    data class StoredFile(
        val id: String,
        val name: String,
        val mimeType: String,
        val sizeBytes: Long,
        val category: String,
        val createdAt: String?,
        val expiresAt: String?
    )

    class StorageException(val httpStatus: Int, message: String) : IOException(message)

    /** Uploads a local file to the configured Drive pool and returns confirmed metadata. */
    suspend fun upload(
        file: File,
        category: String,
        mimeType: String = "application/octet-stream",
        displayName: String = file.name
    ): JSONObject {
        require(file.isFile && file.length() > 0L) { "Upload file must exist and be non-empty." }
        require(category in setOf("chat", "voice", "photo", "video", "other")) { "Unsupported file category." }

        val ticket = apiJson(
            "POST",
            "/api/v1/storage/upload-ticket",
            JSONObject()
                .put("category", category)
                .put("name", displayName)
                .put("mimeType", mimeType)
                .put("sizeBytes", file.length())
                .put("idempotencyKey", UUID.randomUUID().toString())
        )
        val upload = ticket.getJSONObject("upload")
        val headers = upload.optJSONObject("headers") ?: JSONObject()
        val requestBody = file.asRequestBody(mimeType.toMediaTypeOrNull())
        val request = Request.Builder()
            .url(upload.getString("url"))
            .put(requestBody)
            .apply {
                val names = headers.keys()
                while (names.hasNext()) {
                    val key = names.next()
                    header(key, headers.getString(key))
                }
            }
            .build()

        val providerFileId = http.newCall(request).execute().use { response ->
            val responseText = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw StorageException(response.code, "Provider upload failed (HTTP ${response.code}).")
            }
            val providerResult = try { JSONObject(responseText) } catch (_: Exception) { JSONObject() }
            providerResult.optString("id").takeIf { it.isNotBlank() }
                ?: throw StorageException(response.code, "Provider upload response did not include a file ID.")
        }

        val confirmed = apiJson(
            "POST",
            "/api/v1/storage/upload-confirm",
            JSONObject().put("uploadId", ticket.getString("uploadId")).put("providerFileId", providerFileId)
        )
        return confirmed.optJSONObject("file")
            ?: throw StorageException(200, "Upload was sent but the API did not return confirmed file metadata.")
    }

    /** Lists this signed-in user's files for this registered app. */
    suspend fun listFiles(page: Int = 1, pageSize: Int = 20): List<StoredFile> {
        require(page >= 1) { "page must be >= 1" }
        require(pageSize in 1..100) { "pageSize must be between 1 and 100" }
        val result = apiJson("GET", "/api/v1/storage/files?page=$page&pageSize=$pageSize")
        val array = result.optJSONArray("data") ?: JSONArray()
        return (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            StoredFile(
                id = item.getString("id"),
                name = item.optString("name"),
                mimeType = item.optString("mimeType"),
                sizeBytes = item.optLong("sizeBytes"),
                category = item.optString("category"),
                createdAt = item.optString("createdAt").takeIf(String::isNotBlank),
                expiresAt = item.optString("expiresAt").takeIf(String::isNotBlank)
            )
        }
    }

    /** Downloads a file to the supplied destination, replacing it if it already exists. */
    suspend fun downloadTo(fileId: String, destination: File): File {
        val request = authenticatedRequest("/api/v1/storage/files/${pathSegment(fileId)}/download").get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw apiError(response.code, response.body?.string().orEmpty())
            val body = response.body ?: throw StorageException(response.code, "Download response was empty.")
            destination.parentFile?.mkdirs()
            body.byteStream().use { input -> destination.outputStream().use { output -> input.copyTo(output) } }
        }
        return destination
    }

    /** Deletes the file from storage and updates server-side quota. */
    suspend fun delete(fileId: String): JSONObject =
        apiJson("DELETE", "/api/v1/storage/files/${pathSegment(fileId)}")

    private suspend fun apiJson(method: String, path: String, body: JSONObject? = null): JSONObject {
        val requestBuilder = authenticatedRequest(path).method(
            method,
            body?.toString()?.toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())
                ?: if (method == "POST" || method == "PUT" || method == "PATCH") "{}".toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull()) else null
        )
        http.newCall(requestBuilder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw apiError(response.code, text)
            val envelope = JSONObject(text)
            return envelope.optJSONObject("data") ?: envelope
        }
    }

    private suspend fun authenticatedRequest(path: String): Request.Builder {
        val user = firebaseAuth.currentUser ?: throw IllegalStateException("Sign in with Firebase Auth before using storage.")
        val token = user.getIdToken(false).await().token
            ?: throw IllegalStateException("Firebase did not return an ID token.")
        return Request.Builder()
            .url("$baseUrl$path")
            .header("Authorization", "Bearer $token")
            .header("X-API-Key", storageApiKey)
            .header("Accept", "application/json")
    }

    private fun apiError(status: Int, text: String): StorageException {
        val message = try {
            JSONObject(text).optJSONObject("error")?.optString("message")
                ?.takeIf(String::isNotBlank)
        } catch (_: Exception) { null }
        return StorageException(status, message ?: "Storage API request failed (HTTP $status).")
    }

    private fun pathSegment(value: String): String =
        java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}

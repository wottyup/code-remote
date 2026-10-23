package com.sevencnup.codexremote

/** Image formats understood by the Android upload and preview pipeline. */
internal object ImageMediaType {
    private fun startsWith(bytes: ByteArray, signature: ByteArray): Boolean =
        bytes.size >= signature.size && signature.indices.all { bytes[it] == signature[it] }

    fun detect(bytes: ByteArray): String? {
        if (startsWith(bytes, byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))) return "image/png"
        if (bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() && bytes[2] == 0xff.toByte()) return "image/jpeg"
        if (bytes.size >= 12 && bytes.copyOfRange(0, 4).contentEquals("RIFF".toByteArray()) &&
            bytes.copyOfRange(8, 12).contentEquals("WEBP".toByteArray())) return "image/webp"
        if (startsWith(bytes, "GIF87a".toByteArray()) || startsWith(bytes, "GIF89a".toByteArray())) return "image/gif"
        if (bytes.size >= 12 && bytes.copyOfRange(4, 8).contentEquals("ftyp".toByteArray())) {
            val brands = (8 until minOf(bytes.size - 3, 64) step 4)
                .map { bytes.copyOfRange(it, it + 4).toString(Charsets.US_ASCII) }.toSet()
            if (brands.any { it == "avif" || it == "avis" }) return "image/avif"
            if (brands.any { it in setOf("heic", "heix", "hevc", "hevx") }) return "image/heic"
            if (brands.any { it == "mif1" || it == "msf1" }) return "image/heif"
        }
        return null
    }

    val uploadSupported: Set<String> = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
}

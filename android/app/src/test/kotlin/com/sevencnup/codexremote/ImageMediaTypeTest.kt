package com.sevencnup.codexremote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ImageMediaTypeTest {
    @Test fun detectsRasterFormatsByTheirContents() {
        assertEquals("image/png", ImageMediaType.detect(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))
        assertEquals("image/jpeg", ImageMediaType.detect(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0x00)))
        assertEquals("image/webp", "RIFF1234WEBP".toByteArray().let(ImageMediaType::detect))
        assertEquals("image/gif", "GIF89a".toByteArray().let(ImageMediaType::detect))
    }

    @Test fun identifiesHeifAndAvifForSystemDecoderFallback() {
        assertEquals("image/heic", "0000ftypheic0000heic".toByteArray().let(ImageMediaType::detect))
        assertEquals("image/avif", "0000ftypavif0000avif".toByteArray().let(ImageMediaType::detect))
    }

    @Test fun rejectsUnknownDataInsteadOfMislabelingItAsPng() {
        assertNull(ImageMediaType.detect("not actually an image".toByteArray()))
    }
}

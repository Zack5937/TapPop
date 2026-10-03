package com.onchainpayments.devnet.nfc

import java.security.MessageDigest

/** Private demo transport. Bytes carry a payment link, never payment authority. */
object PhoneTapProtocol {
    const val MAX_BYTES = 7000
    const val CHUNK_BYTES = 220
    const val SESSION_MS = 60000L
    const val AID = "F054415050415901"
    val SELECT = byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00, 0x08,
        0xF0.toByte(), 0x54, 0x41, 0x50, 0x50, 0x41, 0x59, 0x01, 0x00)
    private val OK = byteArrayOf(0x90.toByte(), 0x00)
    private val UNAVAILABLE = byteArrayOf(0x69, 0x85.toByte())
    private val BAD_COMMAND = byteArrayOf(0x6D, 0x00)
    private val BAD_RANGE = byteArrayOf(0x6B, 0x00)

    class Offer(val id: String, payload: ByteArray, val expiresAt: Long) {
        val bytes = payload.copyOf()
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        init { require(bytes.isNotEmpty() && bytes.size <= MAX_BYTES) }
    }

    class Server {
        private var selected: Offer? = null
        fun reset() { selected = null }
        fun respond(command: ByteArray, current: Offer?, now: Long): ByteArray {
            if (current == null || now >= current.expiresAt) { reset(); return UNAVAILABLE.copyOf() }
            if (command.contentEquals(SELECT) || command.contentEquals(SELECT.copyOf(SELECT.size - 1))) {
                selected = current
                return byteArrayOf(1, (current.bytes.size shr 8).toByte(), current.bytes.size.toByte()) + current.digest + OK
            }
            if (selected !== current) return UNAVAILABLE.copyOf()
            if (command.size != 5 || command[0] != 0x80.toByte() || command[1] != 0xB0.toByte()) return BAD_COMMAND.copyOf()
            val offset = ((command[2].toInt() and 255) shl 8) or (command[3].toInt() and 255)
            val count = command[4].toInt() and 255
            if (count !in 1..CHUNK_BYTES || offset + count > current.bytes.size) return BAD_RANGE.copyOf()
            return current.bytes.copyOfRange(offset, offset + count) + OK
        }
    }

    data class Header(val size: Int, val digest: ByteArray)
    fun content(response: ByteArray): ByteArray {
        require(response.size >= 2 && response.takeLast(2).toByteArray().contentEquals(OK)) { "Nearby phone is not sharing a payment. Ask it to start sending again." }
        return response.copyOf(response.size - 2)
    }
    fun header(response: ByteArray): Header {
        val data = content(response)
        require(data.size == 35 && data[0] == 1.toByte()) { "Unsupported phone tap protocol." }
        val size = ((data[1].toInt() and 255) shl 8) or (data[2].toInt() and 255)
        require(size in 1..MAX_BYTES) { "Phone tap payload exceeds the supported size." }
        return Header(size, data.copyOfRange(3, 35))
    }
    fun readCommand(offset: Int, count: Int): ByteArray {
        require(offset in 0 until MAX_BYTES && count in 1..CHUNK_BYTES && offset + count <= MAX_BYTES)
        return byteArrayOf(0x80.toByte(), 0xB0.toByte(), (offset shr 8).toByte(), offset.toByte(), count.toByte())
    }
    fun verify(header: Header, bytes: ByteArray) {
        require(bytes.size == header.size && MessageDigest.isEqual(header.digest, MessageDigest.getInstance("SHA-256").digest(bytes))) {
            "Phone tap data was incomplete or changed. Retry the tap."
        }
    }
}

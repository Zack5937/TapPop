package com.onchainpayments.devnet.nfc

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream

class PhoneTapProtocolTest {
    @Test fun completeMultiChunkTransferVerifiesDigest() {
        val payload = ("tappay://settle?data=" + "a".repeat(5000)).toByteArray()
        val offer = PhoneTapProtocol.Offer("one", payload, 60000)
        val server = PhoneTapProtocol.Server()
        val header = PhoneTapProtocol.header(server.respond(PhoneTapProtocol.SELECT, offer, 1))
        val output = ByteArrayOutputStream()
        while (output.size() < header.size) {
            val count = minOf(PhoneTapProtocol.CHUNK_BYTES, header.size - output.size())
            output.write(PhoneTapProtocol.content(server.respond(PhoneTapProtocol.readCommand(output.size(), count), offer, 1)))
        }
        PhoneTapProtocol.verify(header, output.toByteArray())
        assertArrayEquals(payload, output.toByteArray())
    }
    @Test fun inactiveExpiredAndUnselectedSessionsRejectReads() {
        val offer = PhoneTapProtocol.Offer("one", byteArrayOf(1, 2, 3), 60)
        val server = PhoneTapProtocol.Server()
        assertArrayEquals(byteArrayOf(0x69, 0x85.toByte()), server.respond(PhoneTapProtocol.SELECT, null, 1))
        assertArrayEquals(byteArrayOf(0x69, 0x85.toByte()), server.respond(PhoneTapProtocol.readCommand(0, 1), offer, 1))
        server.respond(PhoneTapProtocol.SELECT, offer, 1)
        assertArrayEquals(byteArrayOf(0x69, 0x85.toByte()), server.respond(PhoneTapProtocol.readCommand(0, 1), offer, 60))
    }
    @Test fun replacedOffersCannotMixChunks() {
        val first = PhoneTapProtocol.Offer("one", byteArrayOf(1, 2, 3), 100)
        val replacement = PhoneTapProtocol.Offer("two", byteArrayOf(4, 5, 6), 100)
        val server = PhoneTapProtocol.Server()
        server.respond(PhoneTapProtocol.SELECT, first, 1)
        assertArrayEquals(byteArrayOf(0x69, 0x85.toByte()), server.respond(PhoneTapProtocol.readCommand(0, 1), replacement, 1))
        server.reset()
        assertArrayEquals(byteArrayOf(0x69, 0x85.toByte()), server.respond(PhoneTapProtocol.readCommand(0, 1), first, 1))
    }
    @Test fun malformedCommandsAndOutOfRangeReadsFailClosed() {
        val offer = PhoneTapProtocol.Offer("one", byteArrayOf(1, 2, 3), 100)
        val server = PhoneTapProtocol.Server()
        server.respond(PhoneTapProtocol.SELECT, offer, 1)
        assertArrayEquals(byteArrayOf(0x6D, 0), server.respond(byteArrayOf(0), offer, 1))
        assertArrayEquals(byteArrayOf(0x6B, 0), server.respond(PhoneTapProtocol.readCommand(2, 2), offer, 1))
        assertArrayEquals(byteArrayOf(0x6B, 0), server.respond(byteArrayOf(0x80.toByte(), 0xB0.toByte(), 0, 0, 0), offer, 1))
    }
    @Test fun corruptTruncatedAndOversizedPayloadsAreRejected() {
        val offer = PhoneTapProtocol.Offer("one", byteArrayOf(1, 2, 3), 100)
        val header = PhoneTapProtocol.header(PhoneTapProtocol.Server().respond(PhoneTapProtocol.SELECT, offer, 1))
        assertThrows(IllegalArgumentException::class.java) { PhoneTapProtocol.verify(header, byteArrayOf(1, 2, 4)) }
        assertThrows(IllegalArgumentException::class.java) { PhoneTapProtocol.verify(header, byteArrayOf(1, 2)) }
        assertThrows(IllegalArgumentException::class.java) { PhoneTapProtocol.Offer("one", ByteArray(7001), 100) }
        assertThrows(IllegalArgumentException::class.java) { PhoneTapProtocol.header(byteArrayOf(1, 0x90.toByte(), 0)) }
    }
    @Test fun sourceMutationDoesNotChangeAdvertisedSnapshot() {
        val source = byteArrayOf(1, 2, 3)
        val offer = PhoneTapProtocol.Offer("one", source, 100)
        source[0] = 9
        val server = PhoneTapProtocol.Server()
        server.respond(PhoneTapProtocol.SELECT, offer, 1)
        assertArrayEquals(byteArrayOf(1, 2, 3), PhoneTapProtocol.content(server.respond(PhoneTapProtocol.readCommand(0, 3), offer, 1)))
    }
}

package com.onchainpayments.devnet.nfc

import android.nfc.cardemulation.HostApduService
import android.os.Bundle
import android.os.SystemClock

/** Only an explicitly opened, foreground, time-bounded session can be read. */
object PhoneTapOfferStore {
    @Volatile var offer: PhoneTapProtocol.Offer? = null
}

class PhoneTapService : HostApduService() {
    private val protocol = PhoneTapProtocol.Server()
    override fun processCommandApdu(commandApdu: ByteArray, extras: Bundle?): ByteArray =
        protocol.respond(commandApdu, PhoneTapOfferStore.offer, SystemClock.elapsedRealtime())

    override fun onDeactivated(reason: Int) { protocol.reset() }
}

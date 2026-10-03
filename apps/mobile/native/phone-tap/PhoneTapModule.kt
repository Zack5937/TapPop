package com.onchainpayments.devnet.nfc

import android.app.Activity
import android.content.ComponentName
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.cardemulation.CardEmulation
import android.nfc.tech.IsoDep
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.WindowManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

class PhoneTapModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val reading = AtomicBoolean(false)
    @Volatile private var session: String? = null
    @Volatile private var tagConnection: IsoDep? = null
    private var pending: Promise? = null
    private var activity: Activity? = null
    private var adapter: NfcAdapter? = null
    private var timeout: Runnable? = null
    private var resumed = false
    private var keepAwakeAdded = false
    private var deadline = 0L

    init { context.addLifecycleEventListener(this) }
    override fun getName() = "PhoneTap"

    @ReactMethod fun capabilities(promise: Promise) {
        main.post {
            try {
                val nfc = NfcAdapter.getDefaultAdapter(context)
                promise.resolve(Arguments.createMap().apply {
                    putBoolean("supported", nfc != null)
                    putBoolean("enabled", nfc?.isEnabled == true)
                    putBoolean("hce", context.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION))
                })
            } catch (error: Exception) { promise.reject("NFC_UNAVAILABLE", "Cannot read NFC capability.", error) }
        }
    }

    private fun start(id: String): NfcAdapter {
        require(id.matches(Regex("[a-f0-9]{32}"))) { "Invalid phone tap session." }
        check(session == null) { "Another phone tap is already active." }
        val host = context.currentActivity ?: error("Open the app before using phone tap.")
        check(resumed && !host.isFinishing) { "Keep Tap Pay open in the foreground." }
        val nfc = NfcAdapter.getDefaultAdapter(context) ?: error("This phone has no NFC. Use QR instead.")
        check(nfc.isEnabled) { "Turn on NFC in system settings, then retry." }
        activity = host; adapter = nfc; session = id; reading.set(false)
        deadline = SystemClock.elapsedRealtime() + PhoneTapProtocol.SESSION_MS
        keepAwakeAdded = host.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON == 0
        if (keepAwakeAdded) host.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        timeout = Runnable { finish(id, "Phone tap timed out. Start again and hold the phones close together.") }.also {
            main.postDelayed(it, PhoneTapProtocol.SESSION_MS)
        }
        return nfc
    }

    @ReactMethod fun advertise(id: String, payload: String, promise: Promise) {
        main.post {
            try {
                check(context.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION)) { "This phone cannot send through NFC card emulation. Use QR instead." }
                val bytes = payload.toByteArray(Charsets.UTF_8)
                require(bytes.size in 1..PhoneTapProtocol.MAX_BYTES && payload.startsWith("tappay://")) { "Invalid phone tap payload." }
                val nfc = start(id)
                PhoneTapOfferStore.offer = PhoneTapProtocol.Offer(id, bytes, deadline)
                check(CardEmulation.getInstance(nfc).setPreferredService(activity!!, ComponentName(context, PhoneTapService::class.java))) {
                    "Cannot activate phone tap sending on this device. Use QR instead."
                }
                promise.resolve(null)
            } catch (error: Exception) {
                finish(id, null)
                promise.reject("NFC_SEND_FAILED", error.message ?: "Cannot start phone tap.", error)
            }
        }
    }

    @ReactMethod fun read(id: String, promise: Promise) {
        main.post {
            try {
                val nfc = start(id)
                pending = promise
                nfc.enableReaderMode(activity!!, { tag -> receive(id, tag) },
                    NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK, null)
            } catch (error: Exception) {
                // Detach first so failure is delivered exactly once.
                if (session == id) pending = null
                finish(id, null)
                promise.reject("NFC_READ_FAILED", error.message ?: "Cannot start NFC reader.", error)
            }
        }
    }

    private fun receive(id: String, tag: Tag) {
        if (session != id || !reading.compareAndSet(false, true)) return
        val iso = IsoDep.get(tag)
        if (iso == null) { reading.set(false); return }
        try { worker.execute {
            try {
                check(session == id) { "Phone tap cancelled." }
                tagConnection = iso
                iso.connect(); iso.timeout = 2000
                val header = PhoneTapProtocol.header(iso.transceive(PhoneTapProtocol.SELECT))
                val output = ByteArrayOutputStream(header.size)
                while (output.size() < header.size) {
                    check(session == id && SystemClock.elapsedRealtime() < deadline) { "Phone tap cancelled or timed out." }
                    val count = minOf(PhoneTapProtocol.CHUNK_BYTES, header.size - output.size())
                    val part = PhoneTapProtocol.content(iso.transceive(PhoneTapProtocol.readCommand(output.size(), count)))
                    check(part.size == count) { "Incomplete phone tap data. Hold phones together and retry." }
                    output.write(part)
                }
                val bytes = output.toByteArray()
                PhoneTapProtocol.verify(header, bytes)
                val payload = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
                check(payload.startsWith("tappay://")) { "Nearby phone did not provide a Tap Pay link." }
                main.post {
                    if (session == id) {
                        val resolve = pending; pending = null
                        finish(id, null); resolve?.resolve(payload)
                    }
                }
            } catch (error: Exception) {
                main.post { finish(id, "Phone tap could not complete. Keep both apps open, align the NFC antennas and retry. ${error.message ?: ""}") }
            } finally {
                try { iso.close() } catch (_: Exception) { }
                if (tagConnection === iso) tagConnection = null
            }
        } } catch (_: RejectedExecutionException) {
            main.post { finish(id, "Phone tap closed. Open the app and retry.") }
        }
    }

    @ReactMethod fun stop(id: String, promise: Promise) {
        main.post { finish(id, "Phone tap cancelled."); promise.resolve(null) }
    }

    private fun finish(id: String, reason: String?) {
        if (session != id) return
        session = null
        if (PhoneTapOfferStore.offer?.id == id) PhoneTapOfferStore.offer = null
        timeout?.let { main.removeCallbacks(it) }; timeout = null
        try { tagConnection?.close() } catch (_: Exception) { }
        tagConnection = null
        val host = activity; val nfc = adapter
        if (host != null && nfc != null) {
            try { nfc.disableReaderMode(host) } catch (_: Exception) { }
            try { CardEmulation.getInstance(nfc).unsetPreferredService(host) } catch (_: Exception) { }
            if (keepAwakeAdded) host.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        activity = null; adapter = null; keepAwakeAdded = false
        val reject = pending; pending = null
        reject?.reject("NFC_STOPPED", reason ?: "Phone tap stopped.")
    }

    override fun onHostResume() { resumed = true }
    override fun onHostPause() { resumed = false; session?.let { finish(it, "Phone tap stopped when the app left the foreground.") } }
    override fun onHostDestroy() { onHostPause() }
    override fun invalidate() {
        context.removeLifecycleEventListener(this)
        main.post { session?.let { finish(it, "Phone tap closed.") }; worker.shutdownNow() }
        super.invalidate()
    }
}

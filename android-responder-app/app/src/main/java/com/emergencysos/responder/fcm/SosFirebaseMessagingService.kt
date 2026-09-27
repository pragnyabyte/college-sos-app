package com.emergencysos.responder.fcm

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.emergencysos.responder.EmergencySosApp
import com.emergencysos.responder.R
import com.emergencysos.responder.audio.AlarmSoundPlayer
import com.emergencysos.responder.data.AuditReceiptRequest
import com.emergencysos.responder.data.DeviceRegisterRequest
import com.emergencysos.responder.data.PreferencesManager
import com.emergencysos.responder.data.api.ApiClient
import com.emergencysos.responder.ui.IncidentAlertActivity
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class SosFirebaseMessagingService : FirebaseMessagingService() {

    private val serviceScope = CoroutineScope(Dispatchers.IO)

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.d(TAG, "New FCM Token generated: ${token.take(15)}...")

        val prefs = PreferencesManager.getInstance(applicationContext)
        prefs.fcmToken = token

        // If responder is authenticated, sync new token to Cloud Firestore
        if (prefs.isLoggedIn) {
            serviceScope.launch {
                try {
                    val firebaseRepo = com.emergencysos.responder.data.FirebaseRepository.getInstance(applicationContext)
                    firebaseRepo.registerDeviceToken(token, prefs.responderId)
                    Log.d(TAG, "Device FCM token successfully synced to Cloud Firestore for ${prefs.responderId}")
                } catch (e: Exception) {
                    Log.w(TAG, "Failed syncing FCM token to Firestore: ${e.message}")
                }
            }
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        Log.d(TAG, "FCM Message received from: ${remoteMessage.from}")

        val data = remoteMessage.data
        val sosId = data["sosId"] ?: data["id"] ?: "UNKNOWN-SOS"
        val title = remoteMessage.notification?.title ?: data["title"] ?: "🚨 EMERGENCY SOS: $sosId"
        val body = remoteMessage.notification?.body ?: data["body"] ?: "Emergency response requested on campus."
        val categoryId = data["categoryId"] ?: "Emergency"
        val priority = data["priority"] ?: "CRITICAL"
        val studentName = data["studentName"] ?: "Student"
        val studentId = data["studentId"] ?: ""
        val building = data["building"] ?: ""
        val floor = data["floor"] ?: ""
        val room = data["room"] ?: ""
        val description = data["description"] ?: ""

        val prefs = PreferencesManager.getInstance(applicationContext)

        // 1. Send immediate delivery receipt to Cloud Firestore for audit logging
        serviceScope.launch {
            try {
                val firebaseRepo = com.emergencysos.responder.data.FirebaseRepository.getInstance(applicationContext)
                firebaseRepo.reportReceipt(sosId)
                Log.d(TAG, "Delivery receipt reported to Firestore for incident $sosId")
            } catch (e: Exception) {
                Log.w(TAG, "Failed reporting delivery receipt: ${e.message}")
            }
        }

        // 2. Launch compliant EmergencyAlertForegroundService to sound siren, vibrate, and display lockscreen alert
        val locStr = listOf(building, floor, room).filter { it.isNotBlank() }.joinToString(" · ").ifEmpty { "Campus" }
        try {
            com.emergencysos.responder.service.EmergencyAlertForegroundService.startEmergencyAlert(
                context = applicationContext,
                incidentId = sosId,
                category = categoryId,
                priority = priority,
                studentName = studentName,
                studentId = studentId,
                location = locStr,
                description = description
            )
            Log.d(TAG, "EmergencyAlertForegroundService started for incident $sosId")
        } catch (e: Exception) {
            Log.e(TAG, "Error starting EmergencyAlertForegroundService: ${e.message}")
            // Fallback: direct alarm and notification
            wakeDevice()
            AlarmSoundPlayer.startAlarm(applicationContext)
        }
    }

    private fun wakeDevice() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
            val wakeLock = pm?.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "EmergencySos:WakeLock"
            )
            wakeLock?.acquire(15000L) // 15 seconds wake lock
        } catch (e: Exception) {
            Log.w(TAG, "WakeLock notice: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "SosFCMService"
    }
}

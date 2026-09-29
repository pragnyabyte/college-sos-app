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
        val studentName = data["studentName"] ?: data["student_name"] ?: "Student"
        val studentId = data["studentId"] ?: data["student_id"] ?: ""
        val building = data["building"] ?: ""
        val floor = data["floor"] ?: ""
        val room = data["room"] ?: ""
        val description = data["description"] ?: ""
        val studentPhone = data["studentPhone"] ?: data["student_phone"] ?: data["phone"] ?: ""
        val latitude = data["latitude"]?.toDoubleOrNull()
        val longitude = data["longitude"]?.toDoubleOrNull()
        val accuracy = data["accuracy"]?.toDoubleOrNull()

        val locStr = listOf(building, floor, room).filter { it.isNotBlank() }.joinToString(" · ").ifEmpty {
            if (latitude != null && longitude != null) "GPS: %.4f, %.4f".format(latitude, longitude) else "Campus"
        }

        val prefs = PreferencesManager.getInstance(applicationContext)
        if (prefs.isIncidentAlerted(sosId)) {
            Log.d(TAG, "Incident $sosId already alerted on this device. Updating location on existing notification without replaying siren.")
            if (latitude != null || longitude != null || locStr.isNotBlank()) {
                com.emergencysos.responder.service.EmergencyAlertForegroundService.updateLocation(
                    context = applicationContext,
                    incidentId = sosId,
                    location = locStr,
                    latitude = latitude,
                    longitude = longitude,
                    accuracy = accuracy
                )
            }
            return
        }
        prefs.markIncidentAlerted(sosId)

        // Prevent old incidents (> 30 mins) from replaying loud emergency siren
        val timestamp = data["timestamp"] ?: ""
        if (!isRecent(timestamp)) {
            Log.d(TAG, "FCM alert $sosId is older than 30 mins ($timestamp). Displaying notification without loud siren.")
            postDirectNotificationFallback(
                incidentId = sosId,
                title = title,
                body = "$studentName reported $categoryId at $locStr (Past Alert)",
                category = categoryId,
                priority = priority,
                studentName = studentName,
                studentId = studentId,
                location = locStr,
                description = description,
                studentPhone = studentPhone,
                latitude = latitude,
                longitude = longitude,
                accuracy = accuracy
            )
            return
        }

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
        val inForeground = EmergencySosApp.isAppInForeground
        Log.d(TAG, "Dispatching alert for $sosId (inForeground=$inForeground)")

        try {
            com.emergencysos.responder.service.EmergencyAlertForegroundService.startEmergencyAlert(
                context = applicationContext,
                incidentId = sosId,
                category = categoryId,
                priority = priority,
                studentName = studentName,
                studentId = studentId,
                location = locStr,
                description = description,
                studentPhone = studentPhone,
                latitude = latitude,
                longitude = longitude,
                accuracy = accuracy
            )
            Log.d(TAG, "EmergencyAlertForegroundService started for incident $sosId")
        } catch (e: Exception) {
            Log.e(TAG, "Error starting EmergencyAlertForegroundService: ${e.message}. Using resilient fallback notification.")
            wakeDevice()
            postDirectNotificationFallback(
                incidentId = sosId,
                title = title,
                body = "$studentName reported $categoryId at $locStr",
                category = categoryId,
                priority = priority,
                studentName = studentName,
                studentId = studentId,
                location = locStr,
                description = description,
                studentPhone = studentPhone,
                latitude = latitude,
                longitude = longitude,
                accuracy = accuracy
            )
            AlarmSoundPlayer.startAlarm(applicationContext)
        }
    }

    private fun postDirectNotificationFallback(
        incidentId: String,
        title: String,
        body: String,
        category: String,
        priority: String,
        studentName: String,
        studentId: String,
        location: String,
        description: String,
        studentPhone: String,
        latitude: Double?,
        longitude: Double?,
        accuracy: Double?
    ) {
        try {
            val alertIntent = Intent(applicationContext, IncidentAlertActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra("incident_id", incidentId)
                putExtra("category", category)
                putExtra("priority", priority)
                putExtra("student_name", studentName)
                putExtra("studentName", studentName)
                putExtra("student_id", studentId)
                putExtra("studentId", studentId)
                putExtra("student_phone", studentPhone)
                putExtra("studentPhone", studentPhone)
                putExtra("location", location)
                putExtra("description", description)
                if (latitude != null) putExtra("latitude", latitude)
                if (longitude != null) putExtra("longitude", longitude)
                if (accuracy != null) putExtra("accuracy", accuracy)
            }

            val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }

            val fullScreenPendingIntent = PendingIntent.getActivity(
                applicationContext,
                incidentId.hashCode(),
                alertIntent,
                piFlags
            )

            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            val notification = NotificationCompat.Builder(this, EmergencySosApp.CHANNEL_EMERGENCY_ID)
                .setSmallIcon(R.drawable.ic_stat_sos)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText("$body\nDetails: $description\nPhone: ${studentPhone.ifEmpty { "Not provided" }}"))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setColor(0xDC2626)
                .setContentIntent(fullScreenPendingIntent)
                .setFullScreenIntent(fullScreenPendingIntent, true)
                .build()

            nm?.notify(incidentId.hashCode(), notification)
            Log.d(TAG, "Resilient fallback notification posted directly to NotificationManager for $incidentId")
        } catch (err: Exception) {
            Log.e(TAG, "Direct fallback notification error: ${err.message}")
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

    private fun isRecent(createdAtStr: String?): Boolean {
        if (createdAtStr.isNullOrBlank()) return true
        return try {
            val format = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
            format.timeZone = java.util.TimeZone.getTimeZone("UTC")
            val cleanStr = createdAtStr.substringBefore('.').substringBefore('Z')
            val date = format.parse(cleanStr)
            if (date != null) {
                val ageMs = System.currentTimeMillis() - date.time
                // Consider recent if created within past 30 minutes (or future clock skew up to 5 min)
                ageMs in -300_000L..1_800_000L
            } else true
        } catch (_: Exception) {
            true
        }
    }

    companion object {
        private const val TAG = "SosFCMService"
    }
}

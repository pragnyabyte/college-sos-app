package com.emergencysos.responder.service

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.emergencysos.responder.EmergencySosApp
import com.emergencysos.responder.R
import com.emergencysos.responder.audio.AlarmSoundPlayer
import com.emergencysos.responder.data.FirebaseRepository
import com.emergencysos.responder.data.PreferencesManager
import com.emergencysos.responder.ui.IncidentAlertActivity
import com.emergencysos.responder.ui.MainActivity
import com.google.firebase.firestore.ListenerRegistration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

class EmergencyAlertForegroundService : Service() {

    private val serviceScope = CoroutineScope(Dispatchers.IO)
    private var wakeLock: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private var currentIncidentId: String = ""
    private var firestoreListener: ListenerRegistration? = null
    private var isAlarmActive: Boolean = false

    // Auto-silence siren after 3 minutes to prevent battery exhaustion if phone unattended
    private val autoSilenceRunnable = Runnable {
        Log.w(TAG, "Safety timeout reached (3 mins). Silencing siren audio to preserve device battery.")
        AlarmSoundPlayer.stopAlarm()
        releaseWakeLock()
        isAlarmActive = false
        showMonitorNotification()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START_MONITOR

        when (action) {
            ACTION_START_MONITOR -> {
                handleStartMonitor()
            }
            ACTION_START_ALERT -> {
                handleStartAlert(intent)
            }
            ACTION_STOP_ALARM -> {
                handleStopAlarm()
            }
            ACTION_ACKNOWLEDGE -> {
                handleAcknowledge()
            }
            ACTION_DISMISS -> {
                handleDismiss()
            }
            ACTION_STOP_MONITOR -> {
                handleStopMonitor()
            }
        }

        return START_STICKY
    }

    /**
     * Puts the service into standing monitor mode on the low-priority monitor channel.
     * Attaches real-time Firestore listener to catch emergency alerts in background.
     */
    private fun handleStartMonitor() {
        if (!isAlarmActive) {
            showMonitorNotification()
        }

        if (firestoreListener == null) {
            try {
                val repo = FirebaseRepository.getInstance(applicationContext)
                val prefs = PreferencesManager.getInstance(applicationContext)
                firestoreListener = repo.listenToIncidents(
                    onUpdate = { allIncidents, newlyAdded ->
                        if (newlyAdded != null && !prefs.isIncidentAlerted(newlyAdded.id)) {
                            prefs.markIncidentAlerted(newlyAdded.id)
                            alertedIncidentIds.add(newlyAdded.id)
                            val locStr = listOf(
                                newlyAdded.location?.building,
                                newlyAdded.location?.floor,
                                newlyAdded.location?.room
                            ).filter { !it.isNullOrBlank() }.joinToString(" · ").ifEmpty { "Campus" }

                            triggerIncidentAlert(
                                incidentId = newlyAdded.id,
                                category = newlyAdded.categoryId ?: "Emergency",
                                priority = newlyAdded.priority,
                                studentName = newlyAdded.studentName ?: "Student",
                                studentId = newlyAdded.studentId ?: "",
                                location = locStr,
                                description = newlyAdded.description ?: "",
                                studentPhone = newlyAdded.studentPhone ?: "",
                                latitude = newlyAdded.location?.latitude,
                                longitude = newlyAdded.location?.longitude,
                                accuracy = newlyAdded.location?.accuracy
                            )
                        }
                    },
                    onError = { e ->
                        Log.w(TAG, "Background monitor Firestore listener notice: ${e.message}")
                    }
                )
                Log.d(TAG, "Real-time Firestore listener attached in EmergencyAlertForegroundService")
            } catch (e: Exception) {
                Log.e(TAG, "Failed attaching Firestore listener in background service", e)
            }
        }
    }

    private fun showMonitorNotification() {
        val dashboardIntent = Intent(applicationContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val contentPendingIntent = PendingIntent.getActivity(
            applicationContext,
            100,
            dashboardIntent,
            piFlags
        )

        val notification = NotificationCompat.Builder(this, EmergencySosApp.CHANNEL_MONITOR_ID)
            .setSmallIcon(R.drawable.ic_stat_sos)
            .setContentTitle("Campus Safety Network · Active Monitor")
            .setContentText("Emergency responder online · Monitoring campus SOS alerts")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setContentIntent(contentPendingIntent)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun handleStartAlert(intent: Intent?) {
        val incidentId = intent?.getStringExtra(EXTRA_INCIDENT_ID) ?: "SOS-ALERT"
        val category = intent?.getStringExtra(EXTRA_CATEGORY) ?: "Emergency"
        val priority = intent?.getStringExtra(EXTRA_PRIORITY) ?: "CRITICAL"
        val studentName = intent?.getStringExtra(EXTRA_STUDENT_NAME) ?: "Student"
        val studentId = intent?.getStringExtra(EXTRA_STUDENT_ID) ?: ""
        val location = intent?.getStringExtra(EXTRA_LOCATION) ?: "Campus"
        val description = intent?.getStringExtra(EXTRA_DESCRIPTION) ?: ""
        val studentPhone = intent?.getStringExtra(EXTRA_STUDENT_PHONE) ?: ""
        val latitude = intent?.getDoubleExtra(EXTRA_LATITUDE, Double.NaN).let { if (it?.isNaN() == true) null else it }
        val longitude = intent?.getDoubleExtra(EXTRA_LONGITUDE, Double.NaN).let { if (it?.isNaN() == true) null else it }
        val accuracy = intent?.getDoubleExtra(EXTRA_ACCURACY, Double.NaN).let { if (it?.isNaN() == true) null else it }

        triggerIncidentAlert(
            incidentId = incidentId,
            category = category,
            priority = priority,
            studentName = studentName,
            studentId = studentId,
            location = location,
            description = description,
            studentPhone = studentPhone,
            latitude = latitude,
            longitude = longitude,
            accuracy = accuracy
        )
    }

    private fun triggerIncidentAlert(
        incidentId: String,
        category: String,
        priority: String,
        studentName: String,
        studentId: String,
        location: String,
        description: String,
        studentPhone: String = "",
        latitude: Double? = null,
        longitude: Double? = null,
        accuracy: Double? = null
    ) {
        currentIncidentId = incidentId
        isAlarmActive = true

        Log.d(TAG, "Triggering emergency alarm for $incidentId ($priority) at $location")

        // 1. Acquire safe wake lock to illuminate screen even when phone is sleeping/locked
        acquireWakeLock()

        // 2. Start distinctive emergency siren and vibration on USAGE_ALARM stream
        AlarmSoundPlayer.startAlarm(applicationContext)

        // Schedule safety auto-silence
        handler.removeCallbacks(autoSilenceRunnable)
        handler.postDelayed(autoSilenceRunnable, MAX_ALARM_DURATION_MS)

        // 3. Report delivery receipt to Firestore
        serviceScope.launch {
            try {
                FirebaseRepository.getInstance(applicationContext).reportReceipt(incidentId)
            } catch (e: Exception) {
                Log.w(TAG, "Notice recording delivery receipt: ${e.message}")
            }
        }

        // 4. Build FullScreenIntent & Notification Actions
        val alertIntent = Intent(applicationContext, IncidentAlertActivity::class.java).apply {
            this.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("incident_id", incidentId)
            putExtra("category", category)
            putExtra("priority", priority)
            putExtra("student_name", studentName)
            putExtra("student_id", studentId)
            putExtra("student_phone", studentPhone)
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

        // Notification Action 1: Acknowledge SOS
        val ackIntent = Intent(this, EmergencyAlertForegroundService::class.java).apply {
            this.action = ACTION_ACKNOWLEDGE
        }
        val ackPendingIntent = PendingIntent.getService(
            this,
            102,
            ackIntent,
            piFlags
        )

        // Notification Action 2: View Location (Map Intent)
        val mapUri = if (latitude != null && longitude != null) {
            android.net.Uri.parse("geo:$latitude,$longitude?q=$latitude,$longitude(Emergency+Student+Location)")
        } else {
            android.net.Uri.parse("geo:0,0?q=" + android.net.Uri.encode(location))
        }
        val mapIntent = Intent(Intent.ACTION_VIEW, mapUri).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val mapPendingIntent = PendingIntent.getActivity(
            applicationContext,
            incidentId.hashCode() + 10,
            mapIntent,
            piFlags
        )

        val title = "🚨 EMERGENCY SOS: $incidentId ($priority)"
        val locDetails = if (latitude != null && longitude != null) {
            "$location [GPS: %.4f, %.4f]".format(latitude, longitude)
        } else location
        val body = "$studentName reported $category at $locDetails"

        val notificationBuilder = NotificationCompat.Builder(this, EmergencySosApp.CHANNEL_EMERGENCY_ID)
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
            .addAction(R.drawable.ic_stat_sos, "ACKNOWLEDGE", ackPendingIntent)
            .addAction(R.drawable.ic_stat_sos, "VIEW LOCATION", mapPendingIntent)

        // Notification Action 3: Call Student (if phone number is present)
        if (studentPhone.isNotBlank()) {
            val callIntent = Intent(Intent.ACTION_DIAL).apply {
                data = android.net.Uri.parse("tel:${studentPhone.trim()}")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            val callPendingIntent = PendingIntent.getActivity(
                applicationContext,
                incidentId.hashCode() + 20,
                callIntent,
                piFlags
            )
            notificationBuilder.addAction(R.drawable.ic_stat_sos, "CALL STUDENT", callPendingIntent)
        }

        // Notification Action 4: Stop Alarm / Silence
        val stopAlarmIntent = Intent(this, EmergencyAlertForegroundService::class.java).apply {
            this.action = ACTION_STOP_ALARM
        }
        val stopAlarmPendingIntent = PendingIntent.getService(
            this,
            101,
            stopAlarmIntent,
            piFlags
        )
        notificationBuilder.addAction(R.drawable.ic_stat_sos, "STOP ALARM", stopAlarmPendingIntent)

        val notification = notificationBuilder.build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // Try direct launch if in background
        try {
            startActivity(alertIntent)
        } catch (e: Exception) {
            Log.d(TAG, "Direct activity launch notice (handled by full-screen intent): ${e.message}")
        }
    }

    private fun handleStopAlarm() {
        Log.d(TAG, "Silence alarm requested by responder.")
        handler.removeCallbacks(autoSilenceRunnable)
        AlarmSoundPlayer.stopAlarm()
        releaseWakeLock()
        isAlarmActive = false

        val prefs = PreferencesManager.getInstance(applicationContext)
        if (prefs.isLoggedIn) {
            showMonitorNotification()
        } else {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun handleAcknowledge() {
        Log.d(TAG, "Acknowledge requested for incident $currentIncidentId")
        handler.removeCallbacks(autoSilenceRunnable)
        AlarmSoundPlayer.stopAlarm()
        releaseWakeLock()
        isAlarmActive = false

        val id = currentIncidentId
        if (id.isNotEmpty()) {
            serviceScope.launch {
                try {
                    val firebaseRepo = FirebaseRepository.getInstance(applicationContext)
                    firebaseRepo.acknowledgeIncident(id)
                    Log.d(TAG, "Successfully acknowledged incident $id to Cloud Firestore.")
                } catch (e: Exception) {
                    Log.w(TAG, "Notice sending accept status from service: ${e.message}")
                }
            }
        }

        val prefs = PreferencesManager.getInstance(applicationContext)
        if (prefs.isLoggedIn) {
            showMonitorNotification()
        } else {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun handleDismiss() {
        Log.d(TAG, "Dismissing emergency alert.")
        handler.removeCallbacks(autoSilenceRunnable)
        AlarmSoundPlayer.stopAlarm()
        releaseWakeLock()
        isAlarmActive = false

        val prefs = PreferencesManager.getInstance(applicationContext)
        if (prefs.isLoggedIn) {
            showMonitorNotification()
        } else {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun handleStopMonitor() {
        Log.d(TAG, "Stopping emergency monitor service.")
        handler.removeCallbacks(autoSilenceRunnable)
        AlarmSoundPlayer.stopAlarm()
        releaseWakeLock()
        isAlarmActive = false

        firestoreListener?.remove()
        firestoreListener = null

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun acquireWakeLock() {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
                @Suppress("DEPRECATION")
                wakeLock = pm?.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                    "EmergencySos:AlertWakeLock"
                )
            }
            wakeLock?.acquire(MAX_ALARM_DURATION_MS)
        } catch (e: Exception) {
            Log.w(TAG, "WakeLock acquire notice: ${e.message}")
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (e: Exception) {
            Log.w(TAG, "WakeLock release notice: ${e.message}")
        } finally {
            wakeLock = null
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(autoSilenceRunnable)
        AlarmSoundPlayer.stopAlarm()
        releaseWakeLock()
        firestoreListener?.remove()
        firestoreListener = null
    }

    companion object {
        private const val TAG = "EmergencyAlertService"
        const val NOTIFICATION_ID = 9110

        const val ACTION_START_MONITOR = "com.emergencysos.responder.ACTION_START_MONITOR"
        const val ACTION_STOP_MONITOR = "com.emergencysos.responder.ACTION_STOP_MONITOR"
        const val ACTION_START_ALERT = "com.emergencysos.responder.ACTION_START_ALERT"
        const val ACTION_STOP_ALARM = "com.emergencysos.responder.ACTION_STOP_ALARM"
        const val ACTION_ACKNOWLEDGE = "com.emergencysos.responder.ACTION_ACKNOWLEDGE"
        const val ACTION_DISMISS = "com.emergencysos.responder.ACTION_DISMISS"

        const val EXTRA_INCIDENT_ID = "incident_id"
        const val EXTRA_CATEGORY = "category"
        const val EXTRA_PRIORITY = "priority"
        const val EXTRA_STUDENT_NAME = "student_name"
        const val EXTRA_STUDENT_ID = "student_id"
        const val EXTRA_STUDENT_PHONE = "student_phone"
        const val EXTRA_LOCATION = "location"
        const val EXTRA_DESCRIPTION = "description"
        const val EXTRA_LATITUDE = "latitude"
        const val EXTRA_LONGITUDE = "longitude"
        const val EXTRA_ACCURACY = "accuracy"

        private const val MAX_ALARM_DURATION_MS = 180_000L // 3 minutes

        // Thread-safe set to prevent duplicate sirens for the same incident
        val alertedIncidentIds: MutableSet<String> = ConcurrentHashMap.newKeySet()

        fun startMonitor(context: Context) {
            val intent = Intent(context, EmergencyAlertForegroundService::class.java).apply {
                this.action = ACTION_START_MONITOR
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopMonitor(context: Context) {
            val intent = Intent(context, EmergencyAlertForegroundService::class.java).apply {
                this.action = ACTION_STOP_MONITOR
            }
            context.startService(intent)
        }

        fun startEmergencyAlert(
            context: Context,
            incidentId: String,
            category: String,
            priority: String,
            studentName: String,
            studentId: String,
            location: String,
            description: String,
            studentPhone: String = "",
            latitude: Double? = null,
            longitude: Double? = null,
            accuracy: Double? = null
        ) {
            alertedIncidentIds.add(incidentId)
            val intent = Intent(context, EmergencyAlertForegroundService::class.java).apply {
                this.action = ACTION_START_ALERT
                putExtra(EXTRA_INCIDENT_ID, incidentId)
                putExtra(EXTRA_CATEGORY, category)
                putExtra(EXTRA_PRIORITY, priority)
                putExtra(EXTRA_STUDENT_NAME, studentName)
                putExtra(EXTRA_STUDENT_ID, studentId)
                putExtra(EXTRA_STUDENT_PHONE, studentPhone)
                putExtra(EXTRA_LOCATION, location)
                putExtra(EXTRA_DESCRIPTION, description)
                if (latitude != null) putExtra(EXTRA_LATITUDE, latitude)
                if (longitude != null) putExtra(EXTRA_LONGITUDE, longitude)
                if (accuracy != null) putExtra(EXTRA_ACCURACY, accuracy)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopAlarm(context: Context) {
            val intent = Intent(context, EmergencyAlertForegroundService::class.java).apply {
                this.action = ACTION_STOP_ALARM
            }
            context.startService(intent)
        }

        fun acknowledgeAlert(context: Context) {
            val intent = Intent(context, EmergencyAlertForegroundService::class.java).apply {
                this.action = ACTION_ACKNOWLEDGE
            }
            context.startService(intent)
        }

        fun dismissAlert(context: Context) {
            val intent = Intent(context, EmergencyAlertForegroundService::class.java).apply {
                this.action = ACTION_DISMISS
            }
            context.startService(intent)
        }
    }
}

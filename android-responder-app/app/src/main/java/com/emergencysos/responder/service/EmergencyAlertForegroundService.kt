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
import com.emergencysos.responder.data.PreferencesManager
import com.emergencysos.responder.data.StatusChangeRequest
import com.emergencysos.responder.data.api.ApiClient
import com.emergencysos.responder.ui.IncidentAlertActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class EmergencyAlertForegroundService : Service() {

    private val serviceScope = CoroutineScope(Dispatchers.IO)
    private var wakeLock: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private var currentIncidentId: String = ""

    // Auto-silence siren after 3 minutes to prevent battery exhaustion if phone unattended
    private val autoSilenceRunnable = Runnable {
        Log.w(TAG, "Safety timeout reached (3 mins). Silencing siren audio to preserve device battery.")
        AlarmSoundPlayer.stopAlarm()
        releaseWakeLock()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START_ALERT

        when (action) {
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
        }

        return START_NOT_STICKY
    }

    private fun handleStartAlert(intent: Intent?) {
        val incidentId = intent?.getStringExtra(EXTRA_INCIDENT_ID) ?: "SOS-ALERT"
        currentIncidentId = incidentId
        val category = intent?.getStringExtra(EXTRA_CATEGORY) ?: "Emergency"
        val priority = intent?.getStringExtra(EXTRA_PRIORITY) ?: "CRITICAL"
        val studentName = intent?.getStringExtra(EXTRA_STUDENT_NAME) ?: "Student"
        val studentId = intent?.getStringExtra(EXTRA_STUDENT_ID) ?: ""
        val location = intent?.getStringExtra(EXTRA_LOCATION) ?: "Campus"
        val description = intent?.getStringExtra(EXTRA_DESCRIPTION) ?: ""

        Log.d(TAG, "Starting EmergencyAlertForegroundService for $incidentId ($priority)")

        // 1. Acquire safe wake lock
        acquireWakeLock()

        // 2. Start distinctive emergency siren and vibration
        AlarmSoundPlayer.startAlarm(applicationContext)

        // Schedule safety auto-silence
        handler.removeCallbacks(autoSilenceRunnable)
        handler.postDelayed(autoSilenceRunnable, MAX_ALARM_DURATION_MS)

        // 3. Build FullScreenIntent & Notification Actions
        val alertIntent = Intent(applicationContext, IncidentAlertActivity::class.java).apply {
            this.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("incident_id", incidentId)
            putExtra("category", category)
            putExtra("priority", priority)
            putExtra("student_name", studentName)
            putExtra("student_id", studentId)
            putExtra("location", location)
            putExtra("description", description)
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

        // Notification Action: Stop Alarm / Silence
        val stopAlarmIntent = Intent(this, EmergencyAlertForegroundService::class.java).apply {
            this.action = ACTION_STOP_ALARM
        }
        val stopAlarmPendingIntent = PendingIntent.getService(
            this,
            101,
            stopAlarmIntent,
            piFlags
        )

        // Notification Action: Acknowledge SOS
        val ackIntent = Intent(this, EmergencyAlertForegroundService::class.java).apply {
            this.action = ACTION_ACKNOWLEDGE
        }
        val ackPendingIntent = PendingIntent.getService(
            this,
            102,
            ackIntent,
            piFlags
        )

        val title = "🚨 EMERGENCY SOS: $incidentId ($priority)"
        val body = "$studentName reported $category at $location"

        val notificationBuilder = NotificationCompat.Builder(this, EmergencySosApp.CHANNEL_EMERGENCY_ID)
            .setSmallIcon(R.drawable.ic_stat_sos)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText("$body\nDetails: $description"))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setColor(0xDC2626)
            .setContentIntent(fullScreenPendingIntent)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .addAction(R.drawable.ic_stat_sos, "STOP ALARM", stopAlarmPendingIntent)
            .addAction(R.drawable.ic_stat_sos, "ACKNOWLEDGE", ackPendingIntent)

        val notification = notificationBuilder.build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun handleStopAlarm() {
        Log.d(TAG, "Silence alarm requested by responder.")
        handler.removeCallbacks(autoSilenceRunnable)
        AlarmSoundPlayer.stopAlarm()
        releaseWakeLock()

        // Update notification to indicate silenced status
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val alertIntent = Intent(applicationContext, IncidentAlertActivity::class.java).apply {
            this.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("incident_id", currentIncidentId)
        }
        val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val fullScreenPendingIntent = PendingIntent.getActivity(applicationContext, currentIncidentId.hashCode(), alertIntent, piFlags)

        val notification = NotificationCompat.Builder(this, EmergencySosApp.CHANNEL_EMERGENCY_ID)
            .setSmallIcon(R.drawable.ic_stat_sos)
            .setContentTitle("⚠️ SOS $currentIncidentId (Siren Silenced)")
            .setContentText("Emergency is pending your response. Tap to open.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOngoing(true)
            .setContentIntent(fullScreenPendingIntent)
            .build()
        nm.notify(NOTIFICATION_ID, notification)
    }

    private fun handleAcknowledge() {
        Log.d(TAG, "Acknowledge requested for incident $currentIncidentId")
        handler.removeCallbacks(autoSilenceRunnable)
        AlarmSoundPlayer.stopAlarm()
        releaseWakeLock()

        val id = currentIncidentId
        if (id.isNotEmpty()) {
            serviceScope.launch {
                try {
                    val api = ApiClient.getInstance(applicationContext).getService()
                    api.changeStatus(id, "accept", StatusChangeRequest())
                    Log.d(TAG, "Successfully acknowledged incident $id to backend.")
                } catch (e: Exception) {
                    Log.w(TAG, "Notice sending accept status from service: ${e.message}")
                }
            }
        }

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun handleDismiss() {
        Log.d(TAG, "Dismissing emergency alert foreground service.")
        handler.removeCallbacks(autoSilenceRunnable)
        AlarmSoundPlayer.stopAlarm()
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun acquireWakeLock() {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
                wakeLock = pm?.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
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
    }

    companion object {
        private const val TAG = "EmergencyAlertService"
        const val NOTIFICATION_ID = 9110

        const val ACTION_START_ALERT = "com.emergencysos.responder.ACTION_START_ALERT"
        const val ACTION_STOP_ALARM = "com.emergencysos.responder.ACTION_STOP_ALARM"
        const val ACTION_ACKNOWLEDGE = "com.emergencysos.responder.ACTION_ACKNOWLEDGE"
        const val ACTION_DISMISS = "com.emergencysos.responder.ACTION_DISMISS"

        const val EXTRA_INCIDENT_ID = "incident_id"
        const val EXTRA_CATEGORY = "category"
        const val EXTRA_PRIORITY = "priority"
        const val EXTRA_STUDENT_NAME = "student_name"
        const val EXTRA_STUDENT_ID = "student_id"
        const val EXTRA_LOCATION = "location"
        const val EXTRA_DESCRIPTION = "description"

        private const val MAX_ALARM_DURATION_MS = 180_000L // 3 minutes

        fun startEmergencyAlert(
            context: Context,
            incidentId: String,
            category: String,
            priority: String,
            studentName: String,
            studentId: String,
            location: String,
            description: String
        ) {
            val intent = Intent(context, EmergencyAlertForegroundService::class.java).apply {
                this.action = ACTION_START_ALERT
                putExtra(EXTRA_INCIDENT_ID, incidentId)
                putExtra(EXTRA_CATEGORY, category)
                putExtra(EXTRA_PRIORITY, priority)
                putExtra(EXTRA_STUDENT_NAME, studentName)
                putExtra(EXTRA_STUDENT_ID, studentId)
                putExtra(EXTRA_LOCATION, location)
                putExtra(EXTRA_DESCRIPTION, description)
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

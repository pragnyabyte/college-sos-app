package com.emergencysos.responder

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log

class EmergencySosApp : Application() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channelId = CHANNEL_EMERGENCY_ID
            val name = getString(R.string.channel_emergency_sos_name)
            val descriptionText = getString(R.string.channel_emergency_sos_desc)
            val importance = NotificationManager.IMPORTANCE_HIGH

            val soundUri = try {
                android.net.Uri.parse("android.resource://${packageName}/raw/emergency_siren")
            } catch (e: Exception) {
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            }

            val audioAttributes = AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setFlags(AudioAttributes.FLAG_AUDIBILITY_ENFORCED)
                .build()

            val channel = NotificationChannel(channelId, name, importance).apply {
                description = descriptionText
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 800, 400, 800, 400, 800)
                setSound(soundUri, audioAttributes)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                setShowBadge(true)
                setBypassDnd(true) // Requests DND bypass where authorized by system policy
            }

            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
            Log.d("EmergencySosApp", "Emergency SOS notification channel initialized with IMPORTANCE_HIGH and USAGE_ALARM sound.")
        }
    }

    companion object {
        const val CHANNEL_EMERGENCY_ID = "emergency_sos_channel"
    }
}

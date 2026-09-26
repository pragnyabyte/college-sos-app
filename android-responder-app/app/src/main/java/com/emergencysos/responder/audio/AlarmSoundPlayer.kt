package com.emergencysos.responder.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.CombinedVibration
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

import android.net.Uri
import com.emergencysos.responder.R

object AlarmSoundPlayer {

    private const val TAG = "AlarmSoundPlayer"
    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var isPlaying = false

    private val VIBRATE_PATTERN = longArrayOf(0, 800, 400, 800, 400, 800, 400, 800)

    @Synchronized
    fun startAlarm(context: Context) {
        if (isPlaying) return
        isPlaying = true
        Log.d(TAG, "Starting urgent SOS alarm audio and vibration...")

        // 1. Start continuous vibration pattern
        try {
            vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vm?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val effect = VibrationEffect.createWaveform(VIBRATE_PATTERN, 0) // 0 repeats from start
                vibrator?.vibrate(effect)
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(VIBRATE_PATTERN, 0)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Vibration start notice: ${e.message}")
        }

        // 2. Play Alarm audio using USAGE_ALARM stream (routes via Alarm volume, independent of silent ringer)
        try {
            val audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setFlags(AudioAttributes.FLAG_AUDIBILITY_ENFORCED)
                .build()

            // Resolve sound: bundled emergency siren or fallback to system alarm
            val sirenUri: Uri = try {
                Uri.parse("android.resource://${context.packageName}/raw/emergency_siren")
            } catch (e: Exception) {
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            }

            mediaPlayer = MediaPlayer().apply {
                setAudioAttributes(audioAttributes)
                setDataSource(context, sirenUri)
                isLooping = true
                prepare()
                start()
            }
            Log.d(TAG, "Emergency alarm siren successfully playing on USAGE_ALARM stream.")
        } catch (e: Exception) {
            Log.w(TAG, "Bundled siren audio failed: ${e.message}. Attempting fallback system alarm...")
            try {
                val fallbackUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                val audioAttributes = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
                mediaPlayer = MediaPlayer().apply {
                    setAudioAttributes(audioAttributes)
                    setDataSource(context, fallbackUri)
                    isLooping = true
                    prepare()
                    start()
                }
            } catch (fallbackErr: Exception) {
                Log.e(TAG, "Fatal error starting emergency audio: ${fallbackErr.message}")
            }
        }
    }

    @Synchronized
    fun stopAlarm() {
        if (!isPlaying) return
        isPlaying = false
        Log.d(TAG, "Stopping emergency SOS alarm audio and vibration.")

        try {
            mediaPlayer?.let {
                if (it.isPlaying) it.stop()
                it.reset()
                it.release()
            }
        } catch (e: Exception) {
            Log.w(TAG, "MediaPlayer stop notice: ${e.message}")
        } finally {
            mediaPlayer = null
        }

        try {
            vibrator?.cancel()
        } catch (e: Exception) {
            Log.w(TAG, "Vibrator cancel notice: ${e.message}")
        } finally {
            vibrator = null
        }
    }

    fun isAlarmActive(): Boolean = isPlaying
}

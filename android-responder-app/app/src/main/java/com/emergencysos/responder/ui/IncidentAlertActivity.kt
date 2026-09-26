package com.emergencysos.responder.ui

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.emergencysos.responder.audio.AlarmSoundPlayer
import com.emergencysos.responder.data.AuditReceiptRequest
import com.emergencysos.responder.data.PreferencesManager
import com.emergencysos.responder.data.api.ApiClient
import com.emergencysos.responder.databinding.ActivityIncidentAlertBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class IncidentAlertActivity : AppCompatActivity() {

    private lateinit var binding: ActivityIncidentAlertBinding
    private lateinit var prefs: PreferencesManager

    private var incidentId: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = PreferencesManager.getInstance(this)

        configureLockScreenDisplay()

        binding = ActivityIncidentAlertBinding.inflate(layoutInflater)
        setContentView(binding.root)

        incidentId = intent.getStringExtra("incident_id") ?: "UNKNOWN-SOS"
        val category = intent.getStringExtra("category") ?: "Emergency"
        val priority = intent.getStringExtra("priority") ?: "CRITICAL"
        val studentName = intent.getStringExtra("student_name") ?: "Student"
        val studentId = intent.getStringExtra("student_id") ?: ""
        val location = intent.getStringExtra("location") ?: "Campus Location"
        val description = intent.getStringExtra("description") ?: "Emergency response requested."

        binding.tvAlertId.text = incidentId
        binding.tvCategory.text = category
        binding.tvPriority.text = "$priority PRIORITY"
        binding.tvLocation.text = location
        binding.tvStudent.text = if (studentId.isNotEmpty()) "$studentName ($studentId)" else studentName
        binding.tvDescription.text = description

        // Ensure alarm is playing
        if (!AlarmSoundPlayer.isAlarmActive()) {
            AlarmSoundPlayer.startAlarm(this)
        }

        // Report that the alert was viewed / opened on the screen
        reportOpenReceipt()

        setupActionButtons()
    }

    private fun configureLockScreenDisplay() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            km?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        }
    }

    private fun reportOpenReceipt() {
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val api = ApiClient.getInstance(this@IncidentAlertActivity).getService()
                api.reportOpen(
                    id = incidentId,
                    req = AuditReceiptRequest(
                        deviceId = prefs.deviceId,
                        clientTimestamp = System.currentTimeMillis().toString()
                    )
                )
            } catch (_: Exception) {}
        }
    }

    private fun setupActionButtons() {
        // Acknowledge SOS
        binding.btnAcknowledgeAlert.setOnClickListener {
            com.emergencysos.responder.service.EmergencyAlertForegroundService.acknowledgeAlert(this)
            binding.btnAcknowledgeAlert.isEnabled = false
            binding.btnAcknowledgeAlert.text = "Acknowledging..."

            lifecycleScope.launch {
                try {
                    val api = ApiClient.getInstance(this@IncidentAlertActivity).getService()
                    val res = withContext(Dispatchers.IO) {
                        api.changeStatus(incidentId, "accept")
                    }
                    if (res.isSuccessful) {
                        Toast.makeText(this@IncidentAlertActivity, "SOS $incidentId Acknowledged! Team responding.", Toast.LENGTH_LONG).show()
                    } else {
                        Toast.makeText(this@IncidentAlertActivity, "Status updated locally.", Toast.LENGTH_SHORT).show()
                    }
                } catch (e: Exception) {
                    Toast.makeText(this@IncidentAlertActivity, "Network notice: ${e.message}", Toast.LENGTH_SHORT).show()
                } finally {
                    openDashboard()
                }
            }
        }

        // Silence Siren Only
        binding.btnSilenceSiren.setOnClickListener {
            com.emergencysos.responder.service.EmergencyAlertForegroundService.stopAlarm(this)
            Toast.makeText(this, "Emergency siren silenced.", Toast.LENGTH_SHORT).show()
            binding.btnSilenceSiren.isEnabled = false
            binding.btnSilenceSiren.text = "Silenced"
        }

        // Open Dashboard
        binding.btnDismiss.setOnClickListener {
            com.emergencysos.responder.service.EmergencyAlertForegroundService.dismissAlert(this)
            openDashboard()
        }
    }

    private fun openDashboard() {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        startActivity(intent)
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        com.emergencysos.responder.service.EmergencyAlertForegroundService.stopAlarm(this)
    }
}

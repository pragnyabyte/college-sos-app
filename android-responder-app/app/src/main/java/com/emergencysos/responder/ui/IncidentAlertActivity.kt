package com.emergencysos.responder.ui

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import android.net.Uri
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.emergencysos.responder.audio.AlarmSoundPlayer
import com.emergencysos.responder.data.PreferencesManager
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
        val studentPhone = intent.getStringExtra("student_phone") ?: intent.getStringExtra("phone") ?: ""
        val location = intent.getStringExtra("location") ?: "Campus Location"
        val description = intent.getStringExtra("description") ?: "Emergency response requested."
        val latitude = intent.getDoubleExtra("latitude", Double.NaN).let { if (it.isNaN()) null else it }
        val longitude = intent.getDoubleExtra("longitude", Double.NaN).let { if (it.isNaN()) null else it }
        val accuracy = intent.getDoubleExtra("accuracy", Double.NaN).let { if (it.isNaN()) null else it }

        binding.tvAlertId.text = incidentId
        binding.tvCategory.text = category
        binding.tvPriority.text = "$priority PRIORITY"
        binding.tvLocation.text = location
        binding.tvStudent.text = if (studentId.isNotEmpty()) "$studentName ($studentId)" else studentName
        binding.tvStudentPhone.text = if (studentPhone.isNotEmpty()) "📞 Phone: $studentPhone" else "Phone: Not provided"
        binding.tvDescription.text = description

        // GPS Coordinates and accuracy presentation
        if (latitude != null && longitude != null) {
            val accStr = if (accuracy != null && accuracy > 0) " (±${accuracy.toInt()}m)" else ""
            binding.tvGpsCoordinates.text = "📍 GPS: %.5f, %.5f%s".format(latitude, longitude, accStr)
        } else {
            binding.tvGpsCoordinates.text = "Campus Location (Manual selection)"
        }

        // Ensure alarm is playing
        if (!AlarmSoundPlayer.isAlarmActive()) {
            AlarmSoundPlayer.startAlarm(this)
        }

        // Report that the alert was viewed / opened on the screen
        reportOpenReceipt()

        setupActionButtons(studentPhone, latitude, longitude, location)
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
                val firebaseRepo = com.emergencysos.responder.data.FirebaseRepository.getInstance(this@IncidentAlertActivity)
                firebaseRepo.reportOpen(incidentId)
            } catch (_: Exception) {}
        }
    }

    private fun setupActionButtons(
        studentPhone: String,
        latitude: Double?,
        longitude: Double?,
        locationText: String
    ) {
        // 1. ACKNOWLEDGE SOS
        binding.btnAcknowledgeAlert.setOnClickListener {
            com.emergencysos.responder.service.EmergencyAlertForegroundService.acknowledgeAlert(this)
            binding.btnAcknowledgeAlert.isEnabled = false
            binding.btnAcknowledgeAlert.text = "Acknowledging..."

            lifecycleScope.launch {
                try {
                    val firebaseRepo = com.emergencysos.responder.data.FirebaseRepository.getInstance(this@IncidentAlertActivity)
                    val res = withContext(Dispatchers.IO) {
                        firebaseRepo.acknowledgeIncident(incidentId)
                    }
                    if (res.isSuccess) {
                        Toast.makeText(this@IncidentAlertActivity, "SOS $incidentId Acknowledged! Team responding.", Toast.LENGTH_LONG).show()
                    } else {
                        Toast.makeText(this@IncidentAlertActivity, "Status updated locally.", Toast.LENGTH_SHORT).show()
                    }
                } catch (e: Exception) {
                    Toast.makeText(this@IncidentAlertActivity, "Notice: ${e.message}", Toast.LENGTH_SHORT).show()
                } finally {
                    openDashboard()
                }
            }
        }

        // 2. CALL STUDENT
        binding.btnCallStudent.setOnClickListener {
            if (studentPhone.isNotBlank()) {
                try {
                    val dialIntent = Intent(Intent.ACTION_DIAL).apply {
                        data = Uri.parse("tel:${studentPhone.trim()}")
                    }
                    startActivity(dialIntent)
                } catch (e: Exception) {
                    Toast.makeText(this, "Unable to dial phone: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(this, "No student phone number attached to this SOS alert.", Toast.LENGTH_LONG).show()
            }
        }

        // 3. VIEW LOCATION (Maps Intent)
        binding.btnViewLocation.setOnClickListener {
            try {
                val mapUri = if (latitude != null && longitude != null) {
                    Uri.parse("geo:$latitude,$longitude?q=$latitude,$longitude(Emergency+Student+Location)")
                } else {
                    Uri.parse("geo:0,0?q=" + Uri.encode(locationText))
                }
                val mapIntent = Intent(Intent.ACTION_VIEW, mapUri)
                startActivity(mapIntent)
            } catch (e: Exception) {
                // Fallback to browser Google Maps URL
                try {
                    val webMapUri = if (latitude != null && longitude != null) {
                        Uri.parse("https://maps.google.com/?q=$latitude,$longitude")
                    } else {
                        Uri.parse("https://maps.google.com/?q=" + Uri.encode(locationText))
                    }
                    startActivity(Intent(Intent.ACTION_VIEW, webMapUri))
                } catch (err: Exception) {
                    Toast.makeText(this, "Unable to open maps: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }

        // 4. Silence Siren Only
        binding.btnSilenceSiren.setOnClickListener {
            com.emergencysos.responder.service.EmergencyAlertForegroundService.stopAlarm(this)
            Toast.makeText(this, "Emergency siren silenced.", Toast.LENGTH_SHORT).show()
            binding.btnSilenceSiren.isEnabled = false
            binding.btnSilenceSiren.text = "Silenced"
        }

        // 5. Open Dashboard
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

package com.emergencysos.responder.ui

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.emergencysos.responder.data.PreferencesManager
import com.emergencysos.responder.databinding.ActivityOnboardingBinding

class OnboardingActivity : AppCompatActivity() {

    private lateinit var binding: ActivityOnboardingBinding
    private lateinit var prefs: PreferencesManager

    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { isGranted ->
            if (isGranted) {
                Toast.makeText(this, "Notification permission granted! ✓", Toast.LENGTH_SHORT).show()
                binding.btnGrantNotifications.text = "✓ Notifications Enabled"
                binding.btnGrantNotifications.isEnabled = false
            } else {
                Toast.makeText(this, "Notifications are required for emergency alerts.", Toast.LENGTH_LONG).show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = PreferencesManager.getInstance(this)

        binding = ActivityOnboardingBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupButtons()
    }

    private fun setupButtons() {
        // 1. Post Notifications Permission
        binding.btnGrantNotifications.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                Toast.makeText(this, "Notification permission already granted on this Android version.", Toast.LENGTH_SHORT).show()
            }
        }

        // 2. Battery Optimization
        binding.btnGrantBattery.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
                if (pm?.isIgnoringBatteryOptimizations(packageName) == false) {
                    try {
                        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                            data = Uri.parse("package:$packageName")
                        }
                        startActivity(intent)
                    } catch (e: Exception) {
                        startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    }
                } else {
                    Toast.makeText(this, "Battery optimization already disabled! ✓", Toast.LENGTH_SHORT).show()
                    binding.btnGrantBattery.text = "✓ Battery Unrestricted"
                }
            }
        }

        // 3. Do Not Disturb Override Access
        binding.btnGrantDnd.setOnClickListener {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                if (nm?.isNotificationPolicyAccessGranted == false) {
                    val intent = Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
                    startActivity(intent)
                } else {
                    Toast.makeText(this, "Do Not Disturb policy access already granted! ✓", Toast.LENGTH_SHORT).show()
                    binding.btnGrantDnd.text = "✓ DND Exception Granted"
                }
            }
        }

        // 4. Channel Settings (Override DND & Sound)
        binding.btnChannelSettings.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                try {
                    val intent = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).apply {
                        putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                        putExtra(Settings.EXTRA_CHANNEL_ID, com.emergencysos.responder.EmergencySosApp.CHANNEL_EMERGENCY_ID)
                    }
                    startActivity(intent)
                } catch (e: Exception) {
                    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    }
                    startActivity(intent)
                }
            } else {
                Toast.makeText(this, "Channel settings not applicable on this Android version.", Toast.LENGTH_SHORT).show()
            }
        }

        // Continue to Dashboard
        binding.btnFinishOnboarding.setOnClickListener {
            prefs.onboardingCompleted = true
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }
    }
}

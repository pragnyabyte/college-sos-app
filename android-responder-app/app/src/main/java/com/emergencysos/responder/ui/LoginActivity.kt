package com.emergencysos.responder.ui

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.emergencysos.responder.data.DeviceRegisterRequest
import com.emergencysos.responder.data.LoginRequest
import com.emergencysos.responder.data.PreferencesManager
import com.emergencysos.responder.data.api.ApiClient
import com.emergencysos.responder.databinding.ActivityLoginBinding
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

class LoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLoginBinding
    private lateinit var prefs: PreferencesManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = PreferencesManager.getInstance(this)

        if (prefs.isLoggedIn) {
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }

        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.etServerUrl.setText(prefs.serverUrl)
        binding.etResponderId.setText(prefs.responderId)

        binding.btnLogin.setOnClickListener {
            handleLogin()
        }
    }

    private fun handleLogin() {
        val serverUrl = binding.etServerUrl.text.toString().trim()
        val responderId = binding.etResponderId.text.toString().trim().uppercase()
        val pin = binding.etPin.text.toString().trim()

        if (serverUrl.isEmpty()) {
            binding.tilServerUrl.error = "Server URL is required"
            return
        }
        if (responderId.isEmpty()) {
            binding.tilResponderId.error = "Responder ID is required"
            return
        }
        if (pin.isEmpty()) {
            binding.tilPin.error = "PIN is required"
            return
        }

        binding.tilServerUrl.error = null
        binding.tilResponderId.error = null
        binding.tilPin.error = null
        binding.tvError.visibility = View.GONE
        binding.progressBar.visibility = View.VISIBLE
        binding.btnLogin.isEnabled = false

        prefs.serverUrl = serverUrl

        lifecycleScope.launch {
            try {
                val firebaseRepo = com.emergencysos.responder.data.FirebaseRepository.getInstance(this@LoginActivity)
                val loginResult = withContext(Dispatchers.IO) {
                    firebaseRepo.loginResponder(responderId, pin)
                }

                if (loginResult.isFailure) {
                    val err = loginResult.exceptionOrNull()
                    val msg = err?.message ?: "Authentication failed"
                    showError(msg)
                    return@launch
                }

                val user = loginResult.getOrThrow()
                prefs.authToken = "sos-firebase-token-${user.id}-${System.currentTimeMillis()}"
                prefs.responderId = user.id
                prefs.responderName = user.name

                // Retrieve FCM Token and Register Device in Cloud Firestore
                try {
                    val token = FirebaseMessaging.getInstance().token.await()
                    prefs.fcmToken = token
                    withContext(Dispatchers.IO) {
                        firebaseRepo.registerDeviceToken(token, user.id)
                    }
                } catch (fcmErr: Exception) {
                    // Non-fatal if offline or play services initializing
                }

                Toast.makeText(this@LoginActivity, "Welcome, ${user.name}", Toast.LENGTH_SHORT).show()

                // Start persistent background emergency monitor
                com.emergencysos.responder.service.EmergencyAlertForegroundService.startMonitor(this@LoginActivity)

                if (!prefs.onboardingCompleted) {
                    startActivity(Intent(this@LoginActivity, OnboardingActivity::class.java))
                } else {
                    startActivity(Intent(this@LoginActivity, MainActivity::class.java))
                }
                finish()

            } catch (e: Exception) {
                showError("Login failed: ${e.message}")
            } finally {
                binding.progressBar.visibility = View.GONE
                binding.btnLogin.isEnabled = true
            }
        }
    }

    private fun showError(message: String) {
        binding.tvError.text = message
        binding.tvError.visibility = View.VISIBLE
    }
}

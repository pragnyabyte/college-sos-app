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
                val api = ApiClient.getInstance(this@LoginActivity).getService()
                val loginRes = withContext(Dispatchers.IO) {
                    api.login(LoginRequest(regdNo = responderId, pin = pin, role = "RESPONDER"))
                }

                if (!loginRes.isSuccessful || loginRes.body() == null) {
                    val errBody = loginRes.errorBody()?.string() ?: ""
                    val msg = if (errBody.contains("Invalid")) "Invalid Responder ID or PIN" else "Authentication failed (${loginRes.code()})"
                    showError(msg)
                    return@launch
                }

                val body = loginRes.body()!!
                prefs.authToken = body.token
                prefs.responderId = body.user.id
                prefs.responderName = body.user.name

                // 2. Retrieve FCM Token and Register Device independently in MongoDB
                try {
                    val token = FirebaseMessaging.getInstance().token.await()
                    prefs.fcmToken = token

                    withContext(Dispatchers.IO) {
                        api.registerDevice(
                            DeviceRegisterRequest(
                                deviceId = prefs.deviceId,
                                installationId = prefs.deviceId,
                                fcmToken = token,
                                platform = "android",
                                appVersion = "1.0.0",
                                model = "${Build.MANUFACTURER} ${Build.MODEL}"
                            )
                        )
                    }
                } catch (fcmErr: Exception) {
                    // Non-fatal if offline or play services initializing
                }

                Toast.makeText(this@LoginActivity, "Welcome, ${body.user.name}", Toast.LENGTH_SHORT).show()

                if (!prefs.onboardingCompleted) {
                    startActivity(Intent(this@LoginActivity, OnboardingActivity::class.java))
                } else {
                    startActivity(Intent(this@LoginActivity, MainActivity::class.java))
                }
                finish()

            } catch (e: Exception) {
                showError("Cannot connect to server. Check URL and network connection: ${e.message}")
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

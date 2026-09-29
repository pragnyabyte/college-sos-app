package com.emergencysos.responder.ui

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.emergencysos.responder.R
import com.emergencysos.responder.data.FirebaseRepository
import com.emergencysos.responder.data.PreferencesManager
import com.emergencysos.responder.databinding.ActivityLoginBinding
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

class LoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLoginBinding
    private lateinit var prefs: PreferencesManager
    private lateinit var firebaseRepo: FirebaseRepository

    private var isStudentRole = true
    private var isStudentRegistrationMode = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = PreferencesManager.getInstance(this)
        firebaseRepo = FirebaseRepository.getInstance(this)

        // Session auto-resume: do not log user out when swiped away or reopened
        if (prefs.isLoggedIn) {
            if (prefs.userRole == "STUDENT") {
                startActivity(Intent(this, StudentActivity::class.java))
                finish()
                return
            } else if (prefs.userRole == "RESPONDER") {
                startActivity(Intent(this, MainActivity::class.java))
                finish()
                return
            }
        }

        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupRoleToggle()
        setupStudentModeToggle()

        binding.btnLogin.setOnClickListener {
            if (isStudentRole) {
                if (isStudentRegistrationMode) {
                    handleStudentRegister()
                } else {
                    handleStudentLogin()
                }
            } else {
                handleResponderLogin()
            }
        }
    }

    private fun setupRoleToggle() {
        binding.toggleRole.check(R.id.btnRoleStudent)

        binding.toggleRole.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (isChecked) {
                when (checkedId) {
                    R.id.btnRoleStudent -> {
                        isStudentRole = true
                        updateRoleUI()
                    }
                    R.id.btnRoleResponder -> {
                        isStudentRole = false
                        updateRoleUI()
                    }
                }
            }
        }
        updateRoleUI()
    }

    private fun updateRoleUI() {
        binding.tvError.visibility = View.GONE
        if (isStudentRole) {
            binding.tilRegistrationNo.visibility = View.VISIBLE
            binding.tilName.visibility = View.VISIBLE
            binding.tilPhone.visibility = if (isStudentRegistrationMode) View.VISIBLE else View.GONE
            binding.tvStudentModeToggle.visibility = View.VISIBLE
            binding.tilResponderId.visibility = View.GONE
            binding.tilPin.visibility = View.GONE

            if (isStudentRegistrationMode) {
                binding.btnLogin.text = "Register as Student"
                binding.tvStudentModeToggle.text = "Already registered? Sign In"
            } else {
                binding.btnLogin.text = "Sign In as Student"
                binding.tvStudentModeToggle.text = "Need to register? Click here"
            }
        } else {
            binding.tilRegistrationNo.visibility = View.GONE
            binding.tilName.visibility = View.GONE
            binding.tilPhone.visibility = View.GONE
            binding.tvStudentModeToggle.visibility = View.GONE
            binding.tilResponderId.visibility = View.VISIBLE
            binding.tilPin.visibility = View.VISIBLE
            binding.btnLogin.text = "Sign In as Responder"
        }
    }

    private fun setupStudentModeToggle() {
        binding.tvStudentModeToggle.setOnClickListener {
            isStudentRegistrationMode = !isStudentRegistrationMode
            updateRoleUI()
        }
    }

    private fun handleStudentLogin() {
        val regdNo = binding.etRegistrationNo.text.toString().trim().uppercase()
        val name = binding.etName.text.toString().trim()

        if (regdNo.isEmpty()) {
            binding.tilRegistrationNo.error = "Registration / ID No. is required"
            return
        }
        binding.tilRegistrationNo.error = null
        binding.tvError.visibility = View.GONE
        showLoading(true)

        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    firebaseRepo.loginStudent(regdNo, name.ifEmpty { null })
                }

                if (result.isSuccess) {
                    val user = result.getOrThrow()
                    prefs.authToken = "token-stu-${user.id}-${System.currentTimeMillis()}"
                    prefs.userRole = "STUDENT"
                    prefs.studentId = user.id
                    prefs.studentName = user.name

                    Toast.makeText(this@LoginActivity, "Welcome, ${user.name}", Toast.LENGTH_SHORT).show()
                    startActivity(Intent(this@LoginActivity, StudentActivity::class.java))
                    finish()
                } else {
                    val err = result.exceptionOrNull()?.message ?: "Student authentication failed"
                    showError(err)
                }
            } catch (e: Exception) {
                showError("Login error: ${e.message}")
            } finally {
                showLoading(false)
            }
        }
    }

    private fun handleStudentRegister() {
        val regdNo = binding.etRegistrationNo.text.toString().trim().uppercase()
        val name = binding.etName.text.toString().trim()
        val phone = binding.etPhone.text.toString().trim()

        if (name.isEmpty()) {
            binding.tilName.error = "Full Name is required"
            return
        }
        if (regdNo.isEmpty()) {
            binding.tilRegistrationNo.error = "Registration / ID No. is required"
            return
        }
        binding.tilName.error = null
        binding.tilRegistrationNo.error = null
        binding.tvError.visibility = View.GONE
        showLoading(true)

        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    firebaseRepo.registerStudent(name, regdNo, phone)
                }

                if (result.isSuccess) {
                    val user = result.getOrThrow()
                    prefs.authToken = "token-stu-${user.id}-${System.currentTimeMillis()}"
                    prefs.userRole = "STUDENT"
                    prefs.studentId = user.id
                    prefs.studentName = user.name
                    if (phone.isNotEmpty()) prefs.studentPhone = phone

                    Toast.makeText(this@LoginActivity, "Registration Successful! Welcome, ${user.name}", Toast.LENGTH_SHORT).show()
                    startActivity(Intent(this@LoginActivity, StudentActivity::class.java))
                    finish()
                } else {
                    val err = result.exceptionOrNull()?.message ?: "Student registration failed"
                    showError(err)
                }
            } catch (e: Exception) {
                showError("Registration error: ${e.message}")
            } finally {
                showLoading(false)
            }
        }
    }

    private fun handleResponderLogin() {
        val responderId = binding.etResponderId.text.toString().trim().uppercase()
        val pin = binding.etPin.text.toString().trim()

        if (responderId.isEmpty()) {
            binding.tilResponderId.error = "Responder ID is required"
            return
        }
        if (pin.isEmpty()) {
            binding.tilPin.error = "PIN is required"
            return
        }

        binding.tilResponderId.error = null
        binding.tilPin.error = null
        binding.tvError.visibility = View.GONE
        showLoading(true)

        lifecycleScope.launch {
            try {
                val loginResult = withContext(Dispatchers.IO) {
                    firebaseRepo.loginResponder(responderId, pin)
                }

                if (loginResult.isFailure) {
                    val err = loginResult.exceptionOrNull()
                    showError(err?.message ?: "Authentication failed")
                    return@launch
                }

                val user = loginResult.getOrThrow()
                prefs.authToken = "sos-firebase-token-${user.id}-${System.currentTimeMillis()}"
                prefs.userRole = "RESPONDER"
                prefs.responderId = user.id
                prefs.responderName = user.name

                // Retrieve and sync FCM Token to Cloud Firestore
                try {
                    val token = FirebaseMessaging.getInstance().token.await()
                    prefs.fcmToken = token
                    withContext(Dispatchers.IO) {
                        firebaseRepo.registerDeviceToken(token, user.id)
                    }
                } catch (_: Exception) {}

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
                showLoading(false)
            }
        }
    }

    private fun showLoading(loading: Boolean) {
        binding.progressBar.visibility = if (loading) View.VISIBLE else View.GONE
        binding.btnLogin.isEnabled = !loading
    }

    private fun showError(message: String) {
        binding.tvError.text = message
        binding.tvError.visibility = View.VISIBLE
    }
}

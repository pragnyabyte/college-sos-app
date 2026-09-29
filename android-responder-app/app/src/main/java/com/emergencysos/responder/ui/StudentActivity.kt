package com.emergencysos.responder.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.emergencysos.responder.R
import com.emergencysos.responder.data.FirebaseRepository
import com.emergencysos.responder.data.Incident
import com.emergencysos.responder.data.PreferencesManager
import com.emergencysos.responder.databinding.ActivityStudentBinding
import com.emergencysos.responder.util.LocationHelper
import com.google.firebase.firestore.ListenerRegistration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class StudentActivity : AppCompatActivity() {

    private lateinit var binding: ActivityStudentBinding
    private lateinit var prefs: PreferencesManager
    private lateinit var firebaseRepo: FirebaseRepository
    private var activeIncidentListener: ListenerRegistration? = null
    private var currentActiveIncidentId: String? = null
    private var cachedLocation: Location? = null

    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val granted = permissions[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
                permissions[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        if (granted) {
            fetchGpsLocation()
        } else {
            binding.tvGpsStatus.text = "📍 GPS Permission Denied (Manual Location will be used)"
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = PreferencesManager.getInstance(this)
        firebaseRepo = FirebaseRepository.getInstance(this)

        if (!prefs.isLoggedIn || prefs.userRole != "STUDENT") {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        binding = ActivityStudentBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupUI()
        checkLocationPermissionAndFetch()
        listenToActiveSos()
        loadHistory()
    }

    private fun setupUI() {
        binding.tvStudentName.text = prefs.studentName.ifEmpty { "Student" }
        binding.tvStudentRegd.text = "ID: ${prefs.studentId.ifEmpty { "STU-2026" }}"

        binding.btnLogout.setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle("Sign Out")
                .setMessage("Are you sure you want to sign out of the emergency student console?")
                .setPositiveButton("Sign Out") { _, _ ->
                    prefs.clearSession()
                    startActivity(Intent(this, LoginActivity::class.java))
                    finish()
                }
                .setNegativeButton("Cancel", null)
                .show()
        }

        binding.btnSendSosNow.setOnClickListener {
            handleSendSos()
        }

        binding.btnCancelSos.setOnClickListener {
            handleCancelSos()
        }

        binding.rvHistory.layoutManager = LinearLayoutManager(this)
    }

    private fun checkLocationPermissionAndFetch() {
        if (LocationHelper.hasLocationPermission(this)) {
            fetchGpsLocation()
        } else {
            locationPermissionLauncher.launch(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                )
            )
        }
    }

    private fun fetchGpsLocation() {
        binding.tvGpsStatus.text = "📍 Acquiring GPS coordinates..."
        LocationHelper.requestSingleFreshLocation(this) { loc ->
            cachedLocation = loc
            if (loc != null) {
                binding.tvGpsStatus.text = "📍 GPS Active: %.5f, %.5f (±%.0fm)".format(
                    loc.latitude, loc.longitude, loc.accuracy
                )
            } else {
                binding.tvGpsStatus.text = "📍 GPS Signal Weak. Building/Floor location will be sent."
            }
        }
    }

    private fun getSelectedCategoryId(): String {
        return when (binding.chipGroupCategory.checkedChipId) {
            R.id.chipMedical -> "medical"
            R.id.chipSecurity -> "security"
            R.id.chipFire -> "fire"
            R.id.chipHarassment -> "harassment"
            R.id.chipGeneral -> "general"
            else -> "security"
        }
    }

    private fun handleSendSos() {
        val categoryId = getSelectedCategoryId()
        val building = binding.etBuilding.text?.toString()?.trim() ?: "Main Academic Block"
        val floor = binding.etFloor.text?.toString()?.trim() ?: "Ground Floor"
        val room = binding.etRoom.text?.toString()?.trim() ?: "Corridor"
        val description = binding.etDescription.text?.toString()?.trim()

        binding.progressSos.visibility = View.VISIBLE
        binding.btnSendSosNow.isEnabled = false

        lifecycleScope.launch {
            try {
                val loc = cachedLocation ?: LocationHelper.getBestLastKnownLocation(this@StudentActivity)
                val result = withContext(Dispatchers.IO) {
                    firebaseRepo.createStudentSos(
                        studentId = prefs.studentId,
                        studentName = prefs.studentName,
                        studentPhone = prefs.studentPhone,
                        categoryId = categoryId,
                        description = description,
                        latitude = loc?.latitude,
                        longitude = loc?.longitude,
                        accuracy = loc?.accuracy?.toDouble(),
                        building = building,
                        floor = floor,
                        room = room
                    )
                }

                if (result.isSuccess) {
                    val inc = result.getOrThrow()
                    currentActiveIncidentId = inc.id
                    prefs.activeSosId = inc.id
                    Toast.makeText(this@StudentActivity, "🚨 SOS ALERT BROADCAST TO RESPONDERS: ${inc.id}", Toast.LENGTH_LONG).show()
                    loadHistory()
                } else {
                    val err = result.exceptionOrNull()?.message ?: "Failed to send emergency SOS"
                    Toast.makeText(this@StudentActivity, "Error: $err", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                Toast.makeText(this@StudentActivity, "SOS failed: ${e.message}", Toast.LENGTH_LONG).show()
            } finally {
                binding.progressSos.visibility = View.GONE
                binding.btnSendSosNow.isEnabled = true
            }
        }
    }

    private fun handleCancelSos() {
        val sosId = currentActiveIncidentId ?: prefs.activeSosId
        if (sosId.isBlank()) return

        AlertDialog.Builder(this)
            .setTitle("Cancel Emergency SOS")
            .setMessage("Are you sure you want to cancel emergency alert $sosId?")
            .setPositiveButton("Yes, Cancel SOS") { _, _ ->
                lifecycleScope.launch {
                    val res = withContext(Dispatchers.IO) {
                        firebaseRepo.cancelStudentSos(sosId, "Cancelled by student")
                    }
                    if (res.isSuccess) {
                        Toast.makeText(this@StudentActivity, "SOS $sosId has been cancelled", Toast.LENGTH_SHORT).show()
                        currentActiveIncidentId = null
                        prefs.activeSosId = ""
                        binding.cardActiveSos.visibility = View.GONE
                        loadHistory()
                    } else {
                        Toast.makeText(this@StudentActivity, "Could not cancel SOS: ${res.exceptionOrNull()?.message}", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton("Keep SOS Active", null)
            .show()
    }

    private fun listenToActiveSos() {
        val studentId = prefs.studentId
        if (studentId.isBlank()) return

        activeIncidentListener?.remove()
        activeIncidentListener = firebaseRepo.listenToStudentActiveIncident(studentId) { incident ->
            if (incident != null) {
                currentActiveIncidentId = incident.id
                prefs.activeSosId = incident.id
                binding.cardActiveSos.visibility = View.VISIBLE
                binding.tvActiveSosTitle.text = "🚨 EMERGENCY SOS ACTIVE: ${incident.id}"
                binding.tvActiveSosStatus.text = incident.status

                val locStr = listOf(
                    incident.location?.building,
                    incident.location?.floor,
                    incident.location?.room
                ).filter { !it.isNullOrBlank() }.joinToString(" · ")
                binding.tvActiveSosDetails.text = "Category: ${incident.categoryId ?: "Emergency"} · ${locStr.ifEmpty { "Campus" }}"

                val responderInfo = when (incident.status) {
                    "ACCEPTED" -> "✅ Accepted by ${incident.acceptedByName ?: "Emergency Responder"}. Unit is preparing."
                    "RESPONDING" -> "🚑 Responder unit is en route to your location!"
                    "ARRIVED" -> "📍 Responder has ARRIVED at your location!"
                    else -> "📡 Broadcaster active · Awaiting responder acceptance..."
                }
                binding.tvActiveSosResponder.text = responderInfo
            } else {
                currentActiveIncidentId = null
                prefs.activeSosId = ""
                binding.cardActiveSos.visibility = View.GONE
            }
        }
    }

    private fun loadHistory() {
        lifecycleScope.launch {
            val res = withContext(Dispatchers.IO) {
                firebaseRepo.fetchStudentSosHistory(prefs.studentId)
            }
            res.getOrNull()?.let { list ->
                if (list.isEmpty()) {
                    binding.tvEmptyHistory.visibility = View.VISIBLE
                    binding.rvHistory.visibility = View.GONE
                } else {
                    binding.tvEmptyHistory.visibility = View.GONE
                    binding.rvHistory.visibility = View.VISIBLE
                    val adapter = IncidentAdapter(
                        onActionClick = { _, _ -> },
                        onItemClick = { inc ->
                            Toast.makeText(this@StudentActivity, "SOS: ${inc.id} (${inc.status})", Toast.LENGTH_SHORT).show()
                        }
                    )
                    binding.rvHistory.adapter = adapter
                    adapter.submitList(list)
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        activeIncidentListener?.remove()
        activeIncidentListener = null
    }
}

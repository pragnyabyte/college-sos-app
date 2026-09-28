package com.emergencysos.responder.ui

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.emergencysos.responder.data.DevicePingRequest
import com.emergencysos.responder.data.Incident
import com.emergencysos.responder.data.PreferencesManager
import com.emergencysos.responder.data.StatusChangeRequest
import com.emergencysos.responder.data.api.ApiClient
import com.emergencysos.responder.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

import android.content.Context
import android.app.NotificationManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import com.emergencysos.responder.EmergencySosApp
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import com.emergencysos.responder.service.EmergencyAlertForegroundService

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: PreferencesManager
    private lateinit var adapter: IncidentAdapter
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    // Track incidents already alerted to avoid duplicate ringing upon reconnect
    private val alertedIncidentIds = mutableSetOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = PreferencesManager.getInstance(this)

        if (!prefs.isLoggedIn) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupUI()
        updateDeviceDiagnostics()
        EmergencyAlertForegroundService.startMonitor(this)
        registerNetworkMonitoring()
        loadIncidents()
        sendDevicePing()
    }

    override fun onResume() {
        super.onResume()
        updateDeviceDiagnostics()
        startFirestoreListener()
        loadIncidents()
    }

    override fun onDestroy() {
        super.onDestroy()
        firestoreListener?.remove()
        firestoreListener = null
        unregisterNetworkMonitoring()
    }

    private fun startFirestoreListener() {
        if (firestoreListener != null) return
        try {
            val repo = com.emergencysos.responder.data.FirebaseRepository.getInstance(this)
            firestoreListener = repo.listenToIncidents(
                onUpdate = { allIncidents, newlyAdded ->
                    val activeList = allIncidents.filter { it.status != "RESOLVED" && it.status != "CANCELLED" }
                    adapter.submitList(activeList)
                    binding.tvEmpty.visibility = if (activeList.isEmpty()) View.VISIBLE else View.GONE

                    if (newlyAdded != null && !alertedIncidentIds.contains(newlyAdded.id)) {
                        alertedIncidentIds.add(newlyAdded.id)
                        val locStr = "${newlyAdded.location?.building ?: ""} · ${newlyAdded.location?.floor ?: ""} · ${newlyAdded.location?.room ?: ""}".trim()
                        EmergencyAlertForegroundService.startEmergencyAlert(
                            context = this@MainActivity,
                            incidentId = newlyAdded.id,
                            category = newlyAdded.categoryId ?: "Emergency",
                            priority = newlyAdded.priority,
                            studentName = newlyAdded.studentName ?: "Student",
                            studentId = newlyAdded.studentId ?: "",
                            location = locStr.ifEmpty { "Campus" },
                            description = newlyAdded.description ?: "",
                            studentPhone = newlyAdded.studentPhone ?: "",
                            latitude = newlyAdded.location?.latitude,
                            longitude = newlyAdded.location?.longitude,
                            accuracy = newlyAdded.location?.accuracy
                        )
                    }
                }
            )
        } catch (_: Exception) {}
    }

    private fun registerNetworkMonitoring() {
        try {
            connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()

            networkCallback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    runOnUiThread {
                        binding.tvConnectivityStatus.text = "🟢 Online · Connected"
                        binding.tvConnectivityStatus.setTextColor(0xFF38BDF8.toInt())
                        // Automatic recovery when connection returns: reload incidents immediately
                        loadIncidents()
                    }
                }

                override fun onLost(network: Network) {
                    runOnUiThread {
                        binding.tvConnectivityStatus.text = "🔴 Offline · Connection lost"
                        binding.tvConnectivityStatus.setTextColor(0xFFEF4444.toInt())
                    }
                }
            }
            networkCallback?.let { connectivityManager?.registerNetworkCallback(request, it) }
        } catch (e: Exception) {
            binding.tvConnectivityStatus.text = "Online (unmonitored)"
        }
    }

    private fun unregisterNetworkMonitoring() {
        try {
            networkCallback?.let { connectivityManager?.unregisterNetworkCallback(it) }
        } catch (_: Exception) {}
        networkCallback = null
    }

    private fun setupUI() {
        binding.tvResponderId.text = "${prefs.responderName} (${prefs.responderId})"
        binding.tvDeviceStatus.text = "Device Linked · ID: ${prefs.deviceId.take(18)}…"

        adapter = IncidentAdapter(
            onActionClick = { incident, action -> handleIncidentAction(incident, action) },
            onItemClick = { incident -> openIncidentAlert(incident) }
        )

        binding.rvIncidents.layoutManager = LinearLayoutManager(this)
        binding.rvIncidents.adapter = adapter

        binding.swipeRefresh.setOnRefreshListener {
            loadIncidents()
        }

        binding.btnSync.setOnClickListener {
            loadIncidents()
        }

        binding.btnTestAlert.setOnClickListener {
            triggerTestDrill()
        }

        binding.btnSettings.setOnClickListener {
            startActivity(Intent(this, OnboardingActivity::class.java))
        }

        binding.btnFixPermissions.setOnClickListener {
            startActivity(Intent(this, OnboardingActivity::class.java))
        }

        binding.tvToggleDiagnostics.setOnClickListener {
            if (binding.layoutDiagDetails.visibility == View.VISIBLE) {
                binding.layoutDiagDetails.visibility = View.GONE
                binding.tvToggleDiagnostics.text = "[Show]"
            } else {
                binding.layoutDiagDetails.visibility = View.VISIBLE
                binding.tvToggleDiagnostics.text = "[Hide]"
            }
        }

        binding.btnLogout.setOnClickListener {
            confirmLogout()
        }

        binding.bannerOverdueAlert.setOnClickListener {
            // Find first unacknowledged and open it
            lifecycleScope.launch {
                val firstUnack = adapter.currentList.firstOrNull { it.status == "DEPARTMENT_NOTIFIED" || it.status == "SOS_SENT" }
                if (firstUnack != null) {
                    openIncidentAlert(firstUnack)
                }
            }
        }
    }

    private fun updateDeviceDiagnostics() {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            val notifGranted = NotificationManagerCompat.from(this).areNotificationsEnabled()

            val channelEnabled = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = nm?.getNotificationChannel(EmergencySosApp.CHANNEL_EMERGENCY_ID)
                channel != null && channel.importance >= NotificationManager.IMPORTANCE_HIGH
            } else {
                true
            }

            val fullScreenAllowed = if (Build.VERSION.SDK_INT >= 34) {
                nm?.canUseFullScreenIntent() == true
            } else {
                true
            }

            val dndGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                nm?.isNotificationPolicyAccessGranted == true
            } else {
                true
            }

            val missingPermissions = mutableListOf<String>()
            if (!notifGranted) missingPermissions.add("Notifications Disabled")
            if (!channelEnabled) missingPermissions.add("Emergency Channel Blocked")
            if (!fullScreenAllowed) missingPermissions.add("Full-Screen Restricted")
            if (!dndGranted) missingPermissions.add("DND Policy Access Missing")

            if (missingPermissions.isNotEmpty()) {
                binding.bannerMissingPermissions.visibility = View.VISIBLE
                binding.tvMissingPermissionsText.text = "⚠️ Missing: ${missingPermissions.joinToString(", ")}"
            } else {
                binding.bannerMissingPermissions.visibility = View.GONE
            }

            binding.tvDiagNotif.text = if (notifGranted) "🟢 Enabled" else "🔴 Disabled"
            binding.tvDiagNotif.setTextColor(if (notifGranted) 0xFF34D399.toInt() else 0xFFEF4444.toInt())

            binding.tvDiagChannel.text = if (channelEnabled) "🟢 Siren Channel Active" else "🔴 Blocked / Low Priority"
            binding.tvDiagChannel.setTextColor(if (channelEnabled) 0xFF34D399.toInt() else 0xFFEF4444.toInt())

            binding.tvDiagFullScreen.text = if (fullScreenAllowed) "🟢 Full-Screen Allowed" else "⚠️ Background Only"
            binding.tvDiagFullScreen.setTextColor(if (fullScreenAllowed) 0xFF34D399.toInt() else 0xFFFBBF24.toInt())

            binding.tvDiagDnd.text = if (dndGranted) "🟢 DND Override Active" else "⚠️ Standard Ringer Only"
            binding.tvDiagDnd.setTextColor(if (dndGranted) 0xFF34D399.toInt() else 0xFFFBBF24.toInt())

            binding.tvDiagLastRegistration.text = prefs.lastSuccessfulRegistration
            binding.tvDiagLastDeliveryAck.text = prefs.lastDeliveryAcknowledgment
        } catch (_: Exception) {}
    }

    private var firestoreListener: com.google.firebase.firestore.ListenerRegistration? = null

    private fun loadIncidents() {
        binding.swipeRefresh.isRefreshing = true

        lifecycleScope.launch {
            try {
                val firebaseRepo = com.emergencysos.responder.data.FirebaseRepository.getInstance(this@MainActivity)
                val result = withContext(Dispatchers.IO) {
                    firebaseRepo.getIncidents()
                }

                val nowTime = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())

                if (result.isSuccess) {
                    val list = result.getOrNull() ?: emptyList()
                    val activeList = list.filter { it.status != "RESOLVED" && it.status != "CANCELLED" }
                    adapter.submitList(activeList)

                    binding.tvConnectivityStatus.text = "🟢 Online · Synced with Firebase"
                    binding.tvConnectivityStatus.setTextColor(0xFF34D399.toInt())
                    binding.tvLastSyncTime.text = "Last sync: $nowTime"
                    binding.tvEmpty.visibility = if (activeList.isEmpty()) View.VISIBLE else View.GONE

                    // Check for overdue / unacknowledged incidents
                    val unacknowledged = activeList.filter { it.status == "DEPARTMENT_NOTIFIED" || it.status == "SOS_SENT" }
                    if (unacknowledged.isNotEmpty()) {
                        binding.bannerOverdueAlert.visibility = View.VISIBLE
                        binding.tvOverdueAlertText.text = "⚠️ ${unacknowledged.size} OVERDUE EMERGENCY AWAITING RESPONSE"
                        binding.tvOverdueAlertSubtext.text = "Incident ${unacknowledged.first().id} at ${unacknowledged.first().location?.building ?: "Campus"} (Reported: ${unacknowledged.first().createdAt ?: "Recently"})"

                        for (inc in unacknowledged) {
                            if (!alertedIncidentIds.contains(inc.id)) {
                                alertedIncidentIds.add(inc.id)
                                val locStr = "${inc.location?.building ?: ""} · ${inc.location?.floor ?: ""} · ${inc.location?.room ?: ""}".trim()
                                EmergencyAlertForegroundService.startEmergencyAlert(
                                    context = this@MainActivity,
                                    incidentId = inc.id,
                                    category = inc.categoryId ?: "Emergency",
                                    priority = inc.priority,
                                    studentName = inc.studentName ?: "Student",
                                    studentId = inc.studentId ?: "",
                                    location = locStr.ifEmpty { "Campus" },
                                    description = inc.description ?: "",
                                    studentPhone = inc.studentPhone ?: "",
                                    latitude = inc.location?.latitude,
                                    longitude = inc.location?.longitude,
                                    accuracy = inc.location?.accuracy
                                )
                                break
                            }
                        }
                    } else {
                        binding.bannerOverdueAlert.visibility = View.GONE
                    }
                } else {
                    val err = result.exceptionOrNull()
                    binding.tvConnectivityStatus.text = "⚠️ Sync notice"
                    binding.tvConnectivityStatus.setTextColor(0xFFFBBF24.toInt())
                    Toast.makeText(this@MainActivity, "Firestore: ${err?.message}", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                binding.tvConnectivityStatus.text = "🔴 Offline · Network unavailable"
                binding.tvConnectivityStatus.setTextColor(0xFFEF4444.toInt())
                binding.tvLastSyncTime.text = "Failed to sync"
                Toast.makeText(this@MainActivity, "Network error: ${e.message}", Toast.LENGTH_SHORT).show()
            } finally {
                binding.swipeRefresh.isRefreshing = false
            }
        }
    }

    private fun handleIncidentAction(incident: Incident, action: String) {
        lifecycleScope.launch {
            try {
                val firebaseRepo = com.emergencysos.responder.data.FirebaseRepository.getInstance(this@MainActivity)
                val targetStatus = when (action.lowercase()) {
                    "accept" -> "ACCEPTED"
                    "respond" -> "RESPONDING"
                    "arrive" -> "ARRIVED"
                    "resolve" -> "RESOLVED"
                    "cancel" -> "CANCELLED"
                    else -> action.uppercase()
                }

                val res = withContext(Dispatchers.IO) {
                    firebaseRepo.changeIncidentStatus(incident.id, targetStatus)
                }

                if (res.isSuccess) {
                    Toast.makeText(this@MainActivity, "Incident ${incident.id} marked $targetStatus", Toast.LENGTH_SHORT).show()
                    loadIncidents()
                } else {
                    Toast.makeText(this@MainActivity, "Status update failed", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Error updating status: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun openIncidentAlert(incident: Incident) {
        val intent = Intent(this, IncidentAlertActivity::class.java).apply {
            putExtra("incident_id", incident.id)
            putExtra("category", incident.categoryId)
            putExtra("priority", incident.priority)
            putExtra("student_name", incident.studentName)
            putExtra("student_id", incident.studentId)
            putExtra("student_phone", incident.studentPhone ?: "")
            putExtra("location", "${incident.location?.building ?: ""} · ${incident.location?.floor ?: ""} · ${incident.location?.room ?: ""}")
            putExtra("description", incident.description)
            incident.location?.latitude?.let { putExtra("latitude", it) }
            incident.location?.longitude?.let { putExtra("longitude", it) }
            incident.location?.accuracy?.let { putExtra("accuracy", it) }
        }
        startActivity(intent)
    }

    private fun triggerTestDrill() {
        binding.btnTestAlert.isEnabled = false
        binding.btnTestAlert.text = "Triggering Drill..."

        lifecycleScope.launch {
            try {
                val repo = com.emergencysos.responder.data.FirebaseRepository.getInstance(this@MainActivity)
                val res = withContext(Dispatchers.IO) {
                    repo.createTestDrillIncident()
                }

                if (res.isSuccess) {
                    val drillId = res.getOrNull()
                    Toast.makeText(this@MainActivity, "⚡ Test Drill ($drillId) dispatched to all registered responder phones!", Toast.LENGTH_LONG).show()
                    loadIncidents()
                } else {
                    Toast.makeText(this@MainActivity, "Test drill failed: ${res.exceptionOrNull()?.message}", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Test drill error: ${e.message}", Toast.LENGTH_SHORT).show()
            } finally {
                binding.btnTestAlert.isEnabled = true
                binding.btnTestAlert.text = getString(com.emergencysos.responder.R.string.btn_test_drill)
            }
        }
    }

    private fun sendDevicePing() {
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val repo = com.emergencysos.responder.data.FirebaseRepository.getInstance(this@MainActivity)
                repo.pingDevice()
            } catch (_: Exception) {}
        }
    }

    private fun confirmLogout() {
        AlertDialog.Builder(this)
            .setTitle("Confirm Logout")
            .setMessage("Are you sure you want to log out of this device? Other responder devices under ${prefs.responderId} will continue receiving alerts.")
            .setPositiveButton("Logout") { _, _ ->
                performLogout()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun performLogout() {
        lifecycleScope.launch {
            try {
                EmergencyAlertForegroundService.stopMonitor(this@MainActivity)
                withContext(Dispatchers.IO) {
                    com.emergencysos.responder.data.FirebaseRepository.getInstance(this@MainActivity)
                        .registerDeviceToken("", prefs.responderId)
                }
            } catch (_: Exception) {}

            prefs.clearSession()
            Toast.makeText(this@MainActivity, "Device logged out safely.", Toast.LENGTH_SHORT).show()
            startActivity(Intent(this@MainActivity, LoginActivity::class.java))
            finish()
        }
    }
}

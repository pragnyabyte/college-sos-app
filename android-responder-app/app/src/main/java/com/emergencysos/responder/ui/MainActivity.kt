package com.emergencysos.responder.ui

import android.content.Intent
import android.os.Bundle
import android.util.Log
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
import com.google.firebase.messaging.FirebaseMessaging

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

        if (prefs.userRole == "STUDENT") {
            startActivity(Intent(this, StudentActivity::class.java))
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
        syncDeviceFcmToken()
        handleIncomingIncidentIntent(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIncidentIntent(intent)
    }

    private fun handleIncomingIncidentIntent(incomingIntent: Intent?) {
        val targetId = incomingIntent?.getStringExtra("incident_id")
            ?: incomingIntent?.getStringExtra("sosId")
            ?: incomingIntent?.getStringExtra("id")
        if (!targetId.isNullOrBlank()) {
            lifecycleScope.launch {
                try {
                    val repo = com.emergencysos.responder.data.FirebaseRepository.getInstance(this@MainActivity)
                    val result = withContext(Dispatchers.IO) {
                        repo.getIncidents()
                    }
                    val found = result.getOrNull()?.find { it.id == targetId }
                    if (found != null) {
                        openIncidentAlert(found)
                    }
                } catch (_: Exception) {}
            }
        }
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

                    if (newlyAdded != null && !prefs.isIncidentAlerted(newlyAdded.id)) {
                        prefs.markIncidentAlerted(newlyAdded.id)
                        alertedIncidentIds.add(newlyAdded.id)
                        if (!isRecent(newlyAdded.createdAt)) {
                            Log.d(TAG, "Skipping siren for older incident ${newlyAdded.id} created at ${newlyAdded.createdAt}")
                            return@listenToIncidents
                        }
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
                        val firstUnack = unacknowledged.first()
                        val stuInfo = "${firstUnack.studentName ?: "Student"} (${firstUnack.studentId ?: "N/A"})"
                        binding.tvOverdueAlertSubtext.text = "Incident ${firstUnack.id} from $stuInfo at ${firstUnack.location?.building ?: "Campus"}"

                        // Mark existing incidents as known so they never trigger a stale siren
                        for (inc in activeList) {
                            if (!prefs.isIncidentAlerted(inc.id)) {
                                prefs.markIncidentAlerted(inc.id)
                                alertedIncidentIds.add(inc.id)
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
            putExtra("studentName", incident.studentName)
            putExtra("student_id", incident.studentId)
            putExtra("studentId", incident.studentId)
            putExtra("student_phone", incident.studentPhone ?: "")
            putExtra("studentPhone", incident.studentPhone ?: "")
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

    private fun syncDeviceFcmToken() {
        try {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful && !task.result.isNullOrBlank()) {
                    val token = task.result
                    prefs.fcmToken = token
                    lifecycleScope.launch(Dispatchers.IO) {
                        try {
                            val repo = com.emergencysos.responder.data.FirebaseRepository.getInstance(this@MainActivity)
                            repo.registerDeviceToken(token, prefs.responderId)
                            withContext(Dispatchers.Main) {
                                updateDeviceDiagnostics()
                            }
                        } catch (_: Exception) {}
                    }
                }
            }
        } catch (_: Exception) {}
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

    private fun isRecent(createdAtStr: String?): Boolean {
        if (createdAtStr.isNullOrBlank()) return true
        return try {
            val format = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
            format.timeZone = java.util.TimeZone.getTimeZone("UTC")
            val cleanStr = createdAtStr.substringBefore('.').substringBefore('Z')
            val date = format.parse(cleanStr)
            if (date != null) {
                val ageMs = System.currentTimeMillis() - date.time
                // Consider recent if created within past 30 minutes (or future clock skew up to 5 min)
                ageMs in -300_000L..1_800_000L
            } else true
        } catch (_: Exception) {
            true
        }
    }

    companion object {
        private const val TAG = "MainActivity"
    }
}

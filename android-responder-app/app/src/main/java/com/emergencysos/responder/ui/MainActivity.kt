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
        registerNetworkMonitoring()
        loadIncidents()
        sendDevicePing()
    }

    override fun onResume() {
        super.onResume()
        loadIncidents()
    }

    override fun onDestroy() {
        super.onDestroy()
        unregisterNetworkMonitoring()
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

    private fun loadIncidents() {
        binding.swipeRefresh.isRefreshing = true

        lifecycleScope.launch {
            try {
                val api = ApiClient.getInstance(this@MainActivity).getService()
                val response = withContext(Dispatchers.IO) {
                    api.getIncidents()
                }

                val nowTime = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())

                if (response.isSuccessful && response.body() != null) {
                    val list = response.body()!!
                    val activeList = list.filter { it.status != "RESOLVED" && it.status != "CANCELLED" }
                    adapter.submitList(activeList)

                    binding.tvConnectivityStatus.text = "🟢 Online · Synced"
                    binding.tvConnectivityStatus.setTextColor(0xFF34D399.toInt())
                    binding.tvLastSyncTime.text = "Last sync: $nowTime"
                    binding.tvEmpty.visibility = if (activeList.isEmpty()) View.VISIBLE else View.GONE

                    // Phase 4: Recover overdue / unacknowledged incidents missed during offline periods
                    val unacknowledged = activeList.filter { it.status == "DEPARTMENT_NOTIFIED" || it.status == "SOS_SENT" }
                    if (unacknowledged.isNotEmpty()) {
                        binding.bannerOverdueAlert.visibility = View.VISIBLE
                        binding.tvOverdueAlertText.text = "⚠️ ${unacknowledged.size} OVERDUE EMERGENCY AWAITING RESPONSE"
                        binding.tvOverdueAlertSubtext.text = "Incident ${unacknowledged.first().id} at ${unacknowledged.first().location?.building ?: "Campus"} (Reported: ${unacknowledged.first().createdAt ?: "Recently"})"

                        // Deduplicated alarm: only trigger full alert if not already alerted on this phone
                        for (inc in unacknowledged) {
                            if (!alertedIncidentIds.contains(inc.id)) {
                                alertedIncidentIds.add(inc.id)
                                val locStr = "${inc.location?.building ?: ""} · ${inc.location?.floor ?: ""} · ${inc.location?.room ?: ""}".trim()
                                EmergencyAlertForegroundService.startEmergencyAlert(
                                    context = this@MainActivity,
                                    incidentId = inc.id,
                                    category = inc.categoryId,
                                    priority = inc.priority,
                                    studentName = inc.studentName,
                                    studentId = inc.studentId,
                                    location = locStr.ifEmpty { "Campus" },
                                    description = inc.description
                                )
                                break // Alarm for the foremost unacknowledged incident
                            }
                        }
                    } else {
                        binding.bannerOverdueAlert.visibility = View.GONE
                    }
                } else {
                    binding.tvConnectivityStatus.text = "⚠️ Server notice: HTTP ${response.code()}"
                    binding.tvConnectivityStatus.setTextColor(0xFFFBBF24.toInt())
                    Toast.makeText(this@MainActivity, "Could not sync incidents: ${response.code()}", Toast.LENGTH_SHORT).show()
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
                val api = ApiClient.getInstance(this@MainActivity).getService()
                val res = withContext(Dispatchers.IO) {
                    api.changeStatus(incident.id, action, StatusChangeRequest())
                }

                if (res.isSuccessful) {
                    Toast.makeText(this@MainActivity, "Incident ${incident.id} marked $action", Toast.LENGTH_SHORT).show()
                    loadIncidents()
                } else {
                    Toast.makeText(this@MainActivity, "Status update failed: ${res.code()}", Toast.LENGTH_SHORT).show()
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
            putExtra("location", "${incident.location?.building ?: ""} · ${incident.location?.floor ?: ""} · ${incident.location?.room ?: ""}")
            putExtra("description", incident.description)
        }
        startActivity(intent)
    }

    private fun triggerTestDrill() {
        binding.btnTestAlert.isEnabled = false
        binding.btnTestAlert.text = "Triggering Drill..."

        lifecycleScope.launch {
            try {
                val api = ApiClient.getInstance(this@MainActivity).getService()
                val res = withContext(Dispatchers.IO) {
                    api.triggerTestAlert()
                }

                if (res.isSuccessful) {
                    Toast.makeText(this@MainActivity, "⚡ Test Drill dispatched to all registered responder phones!", Toast.LENGTH_LONG).show()
                    loadIncidents()
                } else {
                    Toast.makeText(this@MainActivity, "Test drill failed: ${res.code()}", Toast.LENGTH_SHORT).show()
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
                val api = ApiClient.getInstance(this@MainActivity).getService()
                api.pingDevice(DevicePingRequest(prefs.deviceId))
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
                val api = ApiClient.getInstance(this@MainActivity).getService()
                withContext(Dispatchers.IO) {
                    // Deactivate ONLY this phone's device registration in MongoDB Atlas
                    api.unregisterDevice(prefs.deviceId)
                }
            } catch (_: Exception) {}

            prefs.clearSession()
            Toast.makeText(this@MainActivity, "Device logged out safely.", Toast.LENGTH_SHORT).show()
            startActivity(Intent(this@MainActivity, LoginActivity::class.java))
            finish()
        }
    }
}

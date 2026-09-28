package com.emergencysos.responder.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.emergencysos.responder.data.PreferencesManager

/**
 * Ensures emergency responder monitor service automatically starts after device reboot or app update.
 * Complies with persistent login requirements so responders receive alerts even after phone restarts.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        Log.d(TAG, "Boot or package broadcast received: $action")

        if (action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            val prefs = PreferencesManager.getInstance(context)
            if (prefs.isLoggedIn) {
                Log.d(TAG, "Responder ${prefs.responderId} is logged in. Starting background monitor service...")
                EmergencyAlertForegroundService.startMonitor(context)
            } else {
                Log.d(TAG, "No active responder session found. Monitor service skipped.")
            }
        }
    }

    companion object {
        private const val TAG = "SosBootReceiver"
    }
}

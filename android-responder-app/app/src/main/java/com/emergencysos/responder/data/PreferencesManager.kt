package com.emergencysos.responder.data

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

class PreferencesManager(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value.trim().removeSuffix("/")).apply()

    var authToken: String
        get() = prefs.getString(KEY_AUTH_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_AUTH_TOKEN, value).apply()

    var responderId: String
        get() = prefs.getString(KEY_RESPONDER_ID, "RESP-1111") ?: "RESP-1111"
        set(value) = prefs.edit().putString(KEY_RESPONDER_ID, value).apply()

    var responderName: String
        get() = prefs.getString(KEY_RESPONDER_NAME, "Campus Emergency Responder") ?: "Campus Emergency Responder"
        set(value) = prefs.edit().putString(KEY_RESPONDER_NAME, value).apply()

    var fcmToken: String
        get() = prefs.getString(KEY_FCM_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_FCM_TOKEN, value).apply()

    val deviceId: String
        get() {
            var id = prefs.getString(KEY_DEVICE_ID, null)
            if (id == null) {
                id = "android-" + UUID.randomUUID().toString()
                prefs.edit().putString(KEY_DEVICE_ID, id).apply()
            }
            return id
        }

    var userRole: String
        get() = prefs.getString(KEY_USER_ROLE, "") ?: ""
        set(value) = prefs.edit().putString(KEY_USER_ROLE, value).apply()

    var studentId: String
        get() = prefs.getString(KEY_STUDENT_ID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_STUDENT_ID, value).apply()

    var studentName: String
        get() = prefs.getString(KEY_STUDENT_NAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_STUDENT_NAME, value).apply()

    var studentPhone: String
        get() = prefs.getString(KEY_STUDENT_PHONE, "") ?: ""
        set(value) = prefs.edit().putString(KEY_STUDENT_PHONE, value).apply()

    var activeSosId: String
        get() = prefs.getString(KEY_ACTIVE_SOS_ID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_ACTIVE_SOS_ID, value).apply()

    val isLoggedIn: Boolean
        get() = authToken.isNotEmpty() && userRole.isNotEmpty()

    var onboardingCompleted: Boolean
        get() = prefs.getBoolean(KEY_ONBOARDING, false)
        set(value) = prefs.edit().putBoolean(KEY_ONBOARDING, value).apply()

    var lastSuccessfulRegistration: String
        get() = prefs.getString(KEY_LAST_REGISTRATION, "Not yet registered") ?: "Not yet registered"
        set(value) = prefs.edit().putString(KEY_LAST_REGISTRATION, value).apply()

    var lastDeliveryAcknowledgment: String
        get() = prefs.getString(KEY_LAST_DELIVERY_ACK, "None recorded") ?: "None recorded"
        set(value) = prefs.edit().putString(KEY_LAST_DELIVERY_ACK, value).apply()

    fun isIncidentAlerted(id: String): Boolean {
        if (id.isBlank()) return false
        val set = prefs.getStringSet(KEY_ALERTED_INCIDENT_IDS, emptySet()) ?: emptySet()
        return set.contains(id)
    }

    fun markIncidentAlerted(id: String) {
        if (id.isBlank()) return
        val set = prefs.getStringSet(KEY_ALERTED_INCIDENT_IDS, emptySet())?.toMutableSet() ?: mutableSetOf()
        set.add(id)
        if (set.size > 200) {
            val trimmed = set.toList().takeLast(200).toSet()
            prefs.edit().putStringSet(KEY_ALERTED_INCIDENT_IDS, trimmed).apply()
        } else {
            prefs.edit().putStringSet(KEY_ALERTED_INCIDENT_IDS, set).apply()
        }
    }

    fun clearSession() {
        prefs.edit()
            .remove(KEY_AUTH_TOKEN)
            .remove(KEY_USER_ROLE)
            .remove(KEY_STUDENT_ID)
            .remove(KEY_STUDENT_NAME)
            .remove(KEY_STUDENT_PHONE)
            .remove(KEY_ACTIVE_SOS_ID)
            .remove(KEY_RESPONDER_NAME)
            .apply()
        // Note: deviceId and fcmToken persist across logouts for device tracking
    }

    companion object {
        private const val PREFS_NAME = "sos_responder_prefs"
        private const val DEFAULT_SERVER_URL = "http://10.0.2.2:4000" // Default for Android Emulator; or physical Wi-Fi IP / Firebase function
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_USER_ROLE = "user_role"
        private const val KEY_STUDENT_ID = "student_id"
        private const val KEY_STUDENT_NAME = "student_name"
        private const val KEY_STUDENT_PHONE = "student_phone"
        private const val KEY_ACTIVE_SOS_ID = "active_sos_id"
        private const val KEY_RESPONDER_ID = "responder_id"
        private const val KEY_RESPONDER_NAME = "responder_name"
        private const val KEY_FCM_TOKEN = "fcm_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_ONBOARDING = "onboarding_completed"
        private const val KEY_LAST_REGISTRATION = "last_registration"
        private const val KEY_LAST_DELIVERY_ACK = "last_delivery_ack"
        private const val KEY_ALERTED_INCIDENT_IDS = "alerted_incident_ids"

        @Volatile
        private var instance: PreferencesManager? = null

        fun getInstance(context: Context): PreferencesManager {
            return instance ?: synchronized(this) {
                instance ?: PreferencesManager(context.applicationContext).also { instance = it }
            }
        }
    }
}

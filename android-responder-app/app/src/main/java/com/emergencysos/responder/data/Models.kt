package com.emergencysos.responder.data

import com.google.gson.annotations.SerializedName

data class LoginRequest(
    @SerializedName("regdNo") val regdNo: String,
    @SerializedName("pin") val pin: String,
    @SerializedName("role") val role: String = "RESPONDER"
)

data class LoginResponse(
    @SerializedName("token") val token: String,
    @SerializedName("user") val user: User
)

data class User(
    @SerializedName("id") val id: String,
    @SerializedName("name") val name: String,
    @SerializedName("role") val role: String,
    @SerializedName("departmentId") val departmentId: String? = null
)

data class DeviceRegisterRequest(
    @SerializedName("deviceId") val deviceId: String,
    @SerializedName("installationId") val installationId: String,
    @SerializedName("fcmToken") val fcmToken: String,
    @SerializedName("platform") val platform: String = "android",
    @SerializedName("appVersion") val appVersion: String = "1.0.0",
    @SerializedName("model") val model: String
)

data class DeviceRegisterResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("responderId") val responderId: String,
    @SerializedName("deviceId") val deviceId: String,
    @SerializedName("active") val active: Boolean
)

data class DevicePingRequest(
    @SerializedName("deviceId") val deviceId: String
)

data class DevicePingResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("timestamp") val timestamp: String
)

data class AuditReceiptRequest(
    @SerializedName("deviceId") val deviceId: String,
    @SerializedName("clientTimestamp") val clientTimestamp: String = ""
)

data class AuditReceiptResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("incidentId") val incidentId: String,
    @SerializedName("receivedAt") val receivedAt: String? = null,
    @SerializedName("openedAt") val openedAt: String? = null
)

data class Incident(
    @SerializedName("id") val id: String,
    @SerializedName("_id") val mongoId: String? = null,
    @SerializedName("category_id") val categoryId: String? = null,
    @SerializedName("student_id") val studentId: String? = null,
    @SerializedName("student_name") val studentName: String? = null,
    @SerializedName("student_phone") val studentPhone: String? = null,
    @SerializedName("description") val description: String? = null,
    @SerializedName("location") val location: IncidentLocation? = null,
    @SerializedName("priority") val priority: String = "HIGH",
    @SerializedName("status") var status: String = "DEPARTMENT_NOTIFIED",
    @SerializedName("primary_department_id") val primaryDepartmentId: String? = null,
    @SerializedName("accepted_by_name") val acceptedByName: String? = null,
    @SerializedName("created_at") val createdAt: String? = null,
    @SerializedName("timeline") val timeline: List<TimelineItem>? = null
)

data class IncidentLocation(
    @SerializedName("building") val building: String? = null,
    @SerializedName("floor") val floor: String? = null,
    @SerializedName("room") val room: String? = null,
    @SerializedName("latitude") val latitude: Double? = null,
    @SerializedName("longitude") val longitude: Double? = null,
    @SerializedName("accuracy") val accuracy: Double? = null,
    @SerializedName("locationStatus") val locationStatus: String? = null,
    @SerializedName("gpsTimestamp") val gpsTimestamp: String? = null
)

data class TimelineItem(
    @SerializedName("status") val status: String,
    @SerializedName("timestamp") val timestamp: String,
    @SerializedName("actorId") val actorId: String? = null,
    @SerializedName("note") val note: String? = null
)

data class StatusChangeRequest(
    @SerializedName("note") val note: String? = null,
    @SerializedName("reason") val reason: String? = null
)

data class TestAlertResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("testIncident") val testIncident: Incident? = null
)

data class StudentUser(
    @SerializedName("id") val id: String,
    @SerializedName("name") val name: String,
    @SerializedName("regdNo") val regdNo: String,
    @SerializedName("phone") val phone: String? = null,
    @SerializedName("accountId") val accountId: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null
)

data class EmergencyCategory(
    val id: String,
    val name: String,
    val icon: String,
    val priority: String,
    val primaryDept: String,
    val examples: String
)


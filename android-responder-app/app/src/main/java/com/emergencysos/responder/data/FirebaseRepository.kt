package com.emergencysos.responder.data

import android.content.Context
import android.os.Build
import android.util.Log
import com.google.firebase.Timestamp
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.tasks.await
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class FirebaseRepository private constructor(private val context: Context) {

    private val firestore = FirebaseFirestore.getInstance()
    private val prefs = PreferencesManager.getInstance(context)

    companion object {
        private const val TAG = "FirebaseRepository"
        @Volatile
        private var instance: FirebaseRepository? = null

        fun getInstance(context: Context): FirebaseRepository {
            return instance ?: synchronized(this) {
                instance ?: FirebaseRepository(context.applicationContext).also { instance = it }
            }
        }
    }

    private fun getCurrentIsoTimestamp(): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(Date())
    }

    /**
     * Authenticates the emergency responder against Cloud Firestore.
     * Preserves configured responder ID (RESP-1111) and PIN (2026).
     */
    suspend fun loginResponder(responderId: String, pin: String, enteredName: String? = null): Result<User> {
        return try {
            val cleanId = responderId.trim().uppercase()
            val cleanPin = pin.trim()

            if (cleanId.isEmpty()) {
                return Result.failure(IllegalArgumentException("Registration / ID No. is required."))
            }
            if (cleanPin.isEmpty()) {
                return Result.failure(IllegalArgumentException("Responder PIN is required."))
            }

            // Verify authorized credentials
            if (cleanId != "RESP-1111") {
                return Result.failure(SecurityException("Invalid Registration Number"))
            }
            if (cleanPin != "2026") {
                return Result.failure(SecurityException("Invalid PIN"))
            }

            val displayName = if (!enteredName.isNullOrBlank()) enteredName.trim() else "Campus Emergency Response Unit (RESP-1111)"

            // Sync authorized responder profile in Cloud Firestore
            try {
                val respDoc = firestore.collection("emergency_responders").document(cleanId)
                val respData = hashMapOf(
                    "responderId" to cleanId,
                    "name" to displayName,
                    "role" to "RESPONDER",
                    "departmentId" to "DEPT_SECURITY",
                    "authorized" to true,
                    "updatedAt" to getCurrentIsoTimestamp()
                )
                respDoc.set(respData, SetOptions.merge()).await()
                Log.d(TAG, "Responder document updated in Cloud Firestore: $cleanId")
            } catch (e: Exception) {
                Log.w(TAG, "Responder profile sync notice: ${e.message}")
            }

            val user = User(
                id = cleanId,
                name = displayName,
                role = "RESPONDER",
                departmentId = "DEPT_SECURITY"
            )

            Result.success(user)
        } catch (e: Exception) {
            Log.e(TAG, "Login error", e)
            Result.failure(e)
        }
    }

    /**
     * Registers the Android device and its FCM push token in Cloud Firestore ('responder_devices' collection).
     */
    suspend fun registerDeviceToken(fcmToken: String, responderId: String = "RESP-1111"): Result<Boolean> {
        return try {
            val deviceId = prefs.deviceId
            val deviceDoc = firestore.collection("responder_devices").document(deviceId)

            val payload = hashMapOf(
                "deviceId" to deviceId,
                "fcmToken" to fcmToken,
                "responderId" to responderId,
                "platform" to "android",
                "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
                "appVersion" to "1.0.0",
                "active" to fcmToken.isNotBlank(),
                "lastActiveAt" to getCurrentIsoTimestamp(),
                "updatedAt" to getCurrentIsoTimestamp()
            )

            deviceDoc.set(payload, SetOptions.merge()).await()
            val nowFormatted = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())
            prefs.lastSuccessfulRegistration = nowFormatted
            Log.d(TAG, "Device FCM token registered in Cloud Firestore: $deviceId at $nowFormatted")
            Result.success(true)
        } catch (e: Exception) {
            Log.w(TAG, "Error registering device token in Firestore: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Retrieves all emergency incidents from Cloud Firestore sorted by timestamp.
     */
    suspend fun getIncidents(): Result<List<Incident>> {
        return try {
            val snapshot = firestore.collection("incidents")
                .get()
                .await()

            val list = mutableListOf<Incident>()
            for (doc in snapshot.documents) {
                val data = doc.data ?: continue
                list.add(parseIncidentFromMap(doc.id, data))
            }

            // Sort descending by created timestamp
            list.sortByDescending { it.createdAt ?: "" }
            Result.success(list)
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching incidents from Firestore", e)
            Result.failure(e)
        }
    }

    /**
     * Retrieves an individual incident document by ID from Cloud Firestore.
     * If the incident has a studentId but studentName is generic/missing, it falls back
     * to querying the 'students' collection to resolve the real student's registered name.
     */
    suspend fun getIncidentById(incidentId: String): Result<Incident> {
        return try {
            val doc = firestore.collection("incidents").document(incidentId).get().await()
            if (!doc.exists()) {
                return Result.failure(Exception("Incident not found: $incidentId"))
            }
            val data = doc.data ?: return Result.failure(Exception("Empty incident data"))
            var incident = parseIncidentFromMap(doc.id, data)

            // Fallback lookup: If studentName is generic ("Student") and studentId is present, check students collection
            if ((incident.studentName == null || incident.studentName == "Student" || incident.studentName?.isBlank() == true) &&
                !incident.studentId.isNullOrBlank()) {
                try {
                    val stuDoc = firestore.collection("students").document(incident.studentId!!).get().await()
                    if (stuDoc.exists()) {
                        val stuData = stuDoc.data
                        val resolvedName = (stuData?.get("name") as? String)?.ifBlank { null }
                        if (resolvedName != null) {
                            incident = incident.copy(studentName = resolvedName)
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Student collection fallback lookup notice: ${e.message}")
                }
            }

            Result.success(incident)
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching incident $incidentId", e)
            Result.failure(e)
        }
    }

    /**
     * Parses an Incident object from Firestore document data, flexibly handling
     * both snake_case and camelCase field naming conventions.
     */
    private fun parseIncidentFromMap(id: String, data: Map<String, Any?>): Incident {
        val studentId = (data["student_id"] as? String)?.ifBlank { null }
            ?: (data["studentId"] as? String)?.ifBlank { null }
            ?: (data["user_id"] as? String)?.ifBlank { null }
            ?: (data["userId"] as? String)
            ?: ""

        val studentName = (data["student_name"] as? String)?.ifBlank { null }
            ?: (data["studentName"] as? String)?.ifBlank { null }
            ?: (data["user_name"] as? String)?.ifBlank { null }
            ?: (data["userName"] as? String)?.ifBlank { null }
            ?: (data["name"] as? String)
            ?: "Student"

        val studentPhone = data["student_phone"] as? String
            ?: data["studentPhone"] as? String
            ?: data["phone"] as? String

        val locMap = data["location"] as? Map<*, *>
        val location = if (locMap != null) {
            IncidentLocation(
                building = locMap["building"] as? String,
                floor = locMap["floor"] as? String,
                room = locMap["room"] as? String,
                latitude = (locMap["latitude"] as? Number)?.toDouble(),
                longitude = (locMap["longitude"] as? Number)?.toDouble(),
                accuracy = (locMap["accuracy"] as? Number)?.toDouble(),
                locationStatus = locMap["locationStatus"] as? String ?: locMap["location_status"] as? String,
                gpsTimestamp = locMap["gpsTimestamp"] as? String ?: locMap["gps_timestamp"] as? String
            )
        } else null

        return Incident(
            id = id,
            categoryId = data["category_id"] as? String ?: data["categoryId"] as? String ?: "other",
            studentId = studentId,
            studentName = studentName,
            studentPhone = studentPhone,
            description = data["description"] as? String ?: "",
            location = location,
            priority = data["priority"] as? String ?: "HIGH",
            status = data["status"] as? String ?: "DEPARTMENT_NOTIFIED",
            createdAt = data["created_at"] as? String ?: data["createdAt"] as? String ?: ""
        )
    }

    /**
     * Listens in real-time to the Cloud Firestore 'incidents' collection.
     * Fires whenever an incident is added, updated, or removed.
     */
    fun listenToIncidents(
        onUpdate: (incidents: List<Incident>, addedIncident: Incident?) -> Unit,
        onError: (Exception) -> Unit = {}
    ): ListenerRegistration {
        var isInitialSnapshot = true
        return firestore.collection("incidents")
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    Log.w(TAG, "Incidents snapshot listener error: ${error.message}")
                    onError(error)
                    return@addSnapshotListener
                }

                if (snapshot == null) return@addSnapshotListener

                val allIncidents = mutableListOf<Incident>()
                var newlyAddedIncident: Incident? = null

                if (!isInitialSnapshot) {
                    for (change in snapshot.documentChanges) {
                        val doc = change.document
                        val data = doc.data
                        val id = doc.id
                        val status = data["status"] as? String ?: "DEPARTMENT_NOTIFIED"

                        if (change.type == com.google.firebase.firestore.DocumentChange.Type.ADDED) {
                            if (status != "RESOLVED" && status != "CANCELLED" && status != "ACCEPTED") {
                                newlyAddedIncident = parseIncidentFromMap(id, data)
                            }
                        }
                    }
                }
                isInitialSnapshot = false

                for (doc in snapshot.documents) {
                    val data = doc.data ?: continue
                    allIncidents.add(parseIncidentFromMap(doc.id, data))
                }

                allIncidents.sortByDescending { it.createdAt ?: "" }
                onUpdate(allIncidents, newlyAddedIncident)
            }
    }

    /**
     * Acknowledges an incoming SOS incident and updates Cloud Firestore directly.
     * Prevents race condition overwrites and updates timeline.
     */
    suspend fun acknowledgeIncident(incidentId: String, note: String = "Acknowledged by responder"): Result<Boolean> {
        return changeIncidentStatus(incidentId, "ACCEPTED", note)
    }

    /**
     * Updates an incident status in Cloud Firestore (ACCEPTED, RESPONDING, ARRIVED, RESOLVED, CANCELLED).
     */
    suspend fun changeIncidentStatus(incidentId: String, newStatus: String, note: String = ""): Result<Boolean> {
        return try {
            val docRef = firestore.collection("incidents").document(incidentId)
            val now = getCurrentIsoTimestamp()
            val responderName = prefs.responderName.ifEmpty { "Campus Emergency Response Unit" }
            val responderId = prefs.responderId.ifEmpty { "RESP-1111" }

            val timelineItem = hashMapOf(
                "status" to newStatus,
                "timestamp" to now,
                "actor" to responderName,
                "note" to note
            )

            val updates = hashMapOf<String, Any>(
                "status" to newStatus,
                "updated_at" to now,
                "timeline" to FieldValue.arrayUnion(timelineItem)
            )

            if (newStatus == "ACCEPTED") {
                updates["accepted_by"] = responderName
                updates["responder_id"] = responderId
            }

            docRef.update(updates).await()
            Log.d(TAG, "Incident $incidentId status updated to $newStatus in Cloud Firestore")
            Result.success(true)
        } catch (e: Exception) {
            Log.e(TAG, "Error updating status for incident $incidentId", e)
            Result.failure(e)
        }
    }

    /**
     * Records an audit receipt for an SOS delivery on this device.
     */
    suspend fun reportReceipt(incidentId: String): Result<Boolean> {
        return try {
            val deviceId = prefs.deviceId
            val docRef = firestore.collection("incidents").document(incidentId)
            val receiptData = hashMapOf(
                "deviceId" to deviceId,
                "responderId" to prefs.responderId,
                "deliveredAt" to getCurrentIsoTimestamp(),
                "platform" to "android"
            )
            docRef.collection("delivery_receipts").document(deviceId).set(receiptData, SetOptions.merge()).await()
            val nowFormatted = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())
            prefs.lastDeliveryAcknowledgment = "$nowFormatted ($incidentId)"
            Result.success(true)
        } catch (e: Exception) {
            Log.w(TAG, "Audit receipt notice: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Records that an incident alert was opened on the device screen.
     */
    suspend fun reportOpen(incidentId: String): Result<Boolean> {
        return try {
            val deviceId = prefs.deviceId
            val docRef = firestore.collection("incidents").document(incidentId)
            val receiptData = hashMapOf(
                "deviceId" to deviceId,
                "responderId" to prefs.responderId,
                "openedAt" to getCurrentIsoTimestamp(),
                "platform" to "android"
            )
            docRef.collection("delivery_receipts").document(deviceId).set(receiptData, SetOptions.merge()).await()
            Result.success(true)
        } catch (e: Exception) {
            Log.w(TAG, "Audit open notice: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Updates device ping/heartbeat in Cloud Firestore.
     */
    suspend fun pingDevice(): Result<Boolean> {
        return try {
            val deviceId = prefs.deviceId
            val deviceDoc = firestore.collection("responder_devices").document(deviceId)
            val updates = hashMapOf<String, Any>(
                "lastPing" to getCurrentIsoTimestamp(),
                "status" to "online"
            )
            deviceDoc.set(updates, SetOptions.merge()).await()
            Result.success(true)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Triggers a live test drill incident in Cloud Firestore for physical two-phone validation.
     */
    suspend fun createTestDrillIncident(): Result<String> {
        return try {
            val drillId = "SOS-DRILL-${System.currentTimeMillis() % 100000}"
            val now = getCurrentIsoTimestamp()
            val docRef = firestore.collection("incidents").document(drillId)

            val location = hashMapOf(
                "building" to "Main Academic Block",
                "floor" to "2nd Floor",
                "room" to "Hall 204",
                "latitude" to 20.2961,
                "longitude" to 85.8245,
                "accuracy" to 10.0,
                "locationStatus" to "MOCK_DRILL"
            )

            val drillData = hashMapOf(
                "id" to drillId,
                "category_id" to "drill",
                "priority" to "CRITICAL",
                "student_id" to "RESPONDER-DRILL",
                "student_name" to "System Drill Test",
                "description" to "Campus-wide emergency responder verification drill. Testing siren & lockscreen alarm reception.",
                "location" to location,
                "status" to "DEPARTMENT_NOTIFIED",
                "primary_department_id" to "DEPT_SECURITY",
                "created_at" to now,
                "createdAt" to now,
                "updated_at" to now
            )

            docRef.set(drillData).await()
            Result.success(drillId)
        } catch (e: Exception) {
            Log.e(TAG, "Error triggering test drill in Firestore", e)
            Result.failure(e)
        }
    }

    /**
     * Registers a new student in Cloud Firestore 'students' collection.
     * Prevents duplicate registration numbers, rejects email formats, and rejects reserved RESP-1111 ID.
     */
    suspend fun registerStudent(name: String, regdNo: String, phone: String? = null): Result<User> {
        return try {
            val cleanName = name.trim()
            val cleanId = regdNo.trim().uppercase()
            val cleanPhone = phone?.trim() ?: ""

            if (cleanName.isEmpty()) {
                return Result.failure(IllegalArgumentException("Full Name is required."))
            }
            if (cleanId.isEmpty()) {
                return Result.failure(IllegalArgumentException("Registration / ID No. is required."))
            }
            if (cleanId.contains("@")) {
                return Result.failure(IllegalArgumentException("Email addresses are not accepted. Please enter a valid Registration / ID No."))
            }
            if (!Regex("^[A-Za-z0-9_\\-\\.\\/]{2,50}$").matches(cleanId)) {
                return Result.failure(IllegalArgumentException("Invalid Registration Number format. Must be 2-50 alphanumeric characters."))
            }
            if (cleanId == "RESP-1111") {
                return Result.failure(IllegalArgumentException("This registration ID is reserved for emergency services."))
            }

            val studentRef = firestore.collection("students").document(cleanId)
            val existingSnap = studentRef.get().await()
            if (existingSnap.exists()) {
                return Result.failure(IllegalArgumentException("This registration ID is already registered. Please sign in."))
            }

            val now = getCurrentIsoTimestamp()
            val accountId = "STU-" + java.util.UUID.randomUUID().toString().take(8).uppercase()
            val studentData = hashMapOf<String, Any?>(
                "name" to cleanName,
                "regdNo" to cleanId,
                "phone" to cleanPhone,
                "role" to "STUDENT",
                "departmentId" to null,
                "accountId" to accountId,
                "createdAt" to now,
                "status" to "active"
            )

            studentRef.set(studentData).await()
            Log.d(TAG, "Student registered successfully in Firestore: $cleanId ($cleanName)")

            val user = User(
                id = cleanId,
                name = cleanName,
                role = "STUDENT",
                departmentId = null
            )
            Result.success(user)
        } catch (e: Exception) {
            Log.e(TAG, "Error registering student", e)
            Result.failure(e)
        }
    }

    /**
     * Authenticates a student against Cloud Firestore 'students' collection.
     * Verifies registered status and validates optional entered name.
     */
    suspend fun loginStudent(regdNo: String, enteredName: String? = null): Result<User> {
        return try {
            val cleanId = regdNo.trim().uppercase()
            val cleanName = enteredName?.trim()

            if (cleanId.isEmpty()) {
                return Result.failure(IllegalArgumentException("Registration / ID No. is required."))
            }
            if (cleanId.contains("@")) {
                return Result.failure(IllegalArgumentException("Email addresses are not accepted. Please enter your Registration / ID No."))
            }
            if (cleanId == "RESP-1111") {
                return Result.failure(IllegalArgumentException("RESP-1111 is reserved for Emergency Responders. Please select Emergency Responder role."))
            }

            val studentRef = firestore.collection("students").document(cleanId)
            val snap = studentRef.get().await()
            if (!snap.exists()) {
                return Result.failure(IllegalArgumentException("Student not registered. Please register first."))
            }

            val registeredName = snap.getString("name") ?: cleanId
            val registeredPhone = snap.getString("phone") ?: ""

            if (!cleanName.isNullOrEmpty()) {
                if (!cleanName.equals(registeredName.trim(), ignoreCase = true)) {
                    return Result.failure(IllegalArgumentException("Entered name does not match our records for this Registration ID."))
                }
            }

            // Save phone to prefs if present
            if (registeredPhone.isNotEmpty()) {
                prefs.studentPhone = registeredPhone
            }

            val user = User(
                id = cleanId,
                name = registeredName,
                role = "STUDENT",
                departmentId = null
            )
            Result.success(user)
        } catch (e: Exception) {
            Log.e(TAG, "Error logging in student", e)
            Result.failure(e)
        }
    }

    /**
     * Creates and dispatches an emergency SOS incident directly into Cloud Firestore.
     * Connects with the existing emergency alert system and notifies all active responders.
     */
    suspend fun createStudentSos(
        studentId: String,
        studentName: String,
        studentPhone: String? = null,
        categoryId: String = "general",
        description: String? = null,
        latitude: Double? = null,
        longitude: Double? = null,
        accuracy: Double? = null,
        building: String? = null,
        floor: String? = null,
        room: String? = null
    ): Result<Incident> {
        return try {
            val now = getCurrentIsoTimestamp()
            val randomNum = (100..999).random()
            val sosId = "SOS-$randomNum"

            val hasGps = latitude != null && longitude != null
            val locMap = hashMapOf<String, Any?>(
                "building" to (building?.ifBlank { null } ?: if (hasGps) "Campus (GPS Attached)" else "Campus"),
                "floor" to (floor?.ifBlank { null } ?: if (hasGps) "Ground / Outdoors" else "Ground / Outdoors"),
                "room" to (room?.ifBlank { null } ?: if (hasGps) "Live GPS Location" else "Live Emergency SOS"),
                "area" to (room?.ifBlank { null } ?: "Emergency Zone"),
                "latitude" to latitude,
                "longitude" to longitude,
                "accuracy" to accuracy,
                "locationStatus" to if (hasGps) "available" else "unavailable",
                "gpsTimestamp" to if (hasGps) now else null,
                "source" to if (hasGps) "GPS" else "MANUAL"
            )

            val catMap = mapOf(
                "medical" to Pair("CRITICAL", "DEPT_MEDICAL"),
                "security" to Pair("HIGH", "DEPT_SECURITY"),
                "fire" to Pair("CRITICAL", "DEPT_FIRE"),
                "harassment" to Pair("HIGH", "DEPT_WELFARE"),
                "electrical" to Pair("HIGH", "DEPT_ELECTRICAL"),
                "infrastructure" to Pair("HIGH", "DEPT_MAINTENANCE"),
                "trapped" to Pair("HIGH", "DEPT_SECURITY"),
                "general" to Pair("HIGH", "DEPT_SECURITY"),
                "other" to Pair("MEDIUM", "DEPT_ADMIN")
            )
            val (priority, primaryDept) = catMap[categoryId] ?: Pair("HIGH", "DEPT_SECURITY")
            val assignedDepts = listOf(primaryDept, "DEPT_SECURITY")

            val phoneToUse = studentPhone?.ifBlank { null } ?: prefs.studentPhone

            val incidentData = hashMapOf<String, Any?>(
                "id" to sosId,
                "category_id" to categoryId,
                "student_id" to studentId,
                "studentId" to studentId,
                "student_name" to studentName,
                "studentName" to studentName,
                "student_phone" to phoneToUse,
                "studentPhone" to phoneToUse,
                "description" to (description?.ifBlank { null } ?: "Emergency SOS triggered by $studentName ($studentId)"),
                "location" to locMap,
                "priority" to priority,
                "status" to "DEPARTMENT_NOTIFIED",
                "primary_department_id" to primaryDept,
                "assigned_departments" to assignedDepts,
                "assignedDepartments" to assignedDepts,
                "created_at" to now,
                "createdAt" to now,
                "updated_at" to now,
                "timeline" to listOf(
                    mapOf("status" to "DEPARTMENT_NOTIFIED", "timestamp" to now, "note" to "Emergency SOS initiated by student via Android app")
                )
            )

            firestore.collection("incidents").document(sosId).set(incidentData).await()
            Log.d(TAG, "Student SOS created and saved in Cloud Firestore: $sosId")

            val incident = Incident(
                id = sosId,
                categoryId = categoryId,
                studentId = studentId,
                studentName = studentName,
                studentPhone = phoneToUse,
                description = description,
                location = IncidentLocation(
                    building = locMap["building"] as? String,
                    floor = locMap["floor"] as? String,
                    room = locMap["room"] as? String,
                    latitude = latitude,
                    longitude = longitude,
                    accuracy = accuracy,
                    locationStatus = locMap["locationStatus"] as? String,
                    gpsTimestamp = locMap["gpsTimestamp"] as? String
                ),
                priority = priority,
                status = "DEPARTMENT_NOTIFIED",
                primaryDepartmentId = primaryDept,
                createdAt = now
            )

            prefs.activeSosId = sosId
            Result.success(incident)
        } catch (e: Exception) {
            Log.e(TAG, "Error creating student SOS", e)
            Result.failure(e)
        }
    }

    /**
     * Real-time listener for the student's active SOS alert.
     * Fires immediately whenever a responder acknowledges, responds, or resolves the emergency.
     */
    fun listenToStudentActiveIncident(studentId: String, onUpdate: (Incident?) -> Unit): ListenerRegistration {
        val cleanId = studentId.trim().uppercase()
        return firestore.collection("incidents")
            .whereEqualTo("student_id", cleanId)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    Log.w(TAG, "Active incident snapshot error", err)
                    return@addSnapshotListener
                }
                if (snap != null) {
                    val activeDoc = snap.documents.firstOrNull { doc ->
                        val status = doc.getString("status") ?: ""
                        status != "RESOLVED" && status != "CANCELLED" && status != "REJECTED" && status != "DUPLICATE"
                    }

                    if (activeDoc != null) {
                        try {
                            val inc = parseIncidentFromMap(activeDoc.id, activeDoc.data ?: emptyMap())
                            onUpdate(inc)
                        } catch (e: Exception) {
                            Log.w(TAG, "Error parsing active incident", e)
                            onUpdate(null)
                        }
                    } else {
                        onUpdate(null)
                    }
                }
            }
    }

    /**
     * Cancels an active SOS alert created by the student.
     */
    suspend fun cancelStudentSos(incidentId: String, reason: String? = null): Result<Boolean> {
        return try {
            val now = getCurrentIsoTimestamp()
            val docRef = firestore.collection("incidents").document(incidentId)
            val timelineEntry = mapOf(
                "status" to "CANCELLED",
                "timestamp" to now,
                "note" to (reason ?: "Cancelled by student from mobile app")
            )

            val updates = hashMapOf<String, Any>(
                "status" to "CANCELLED",
                "updated_at" to now,
                "timeline" to FieldValue.arrayUnion(timelineEntry)
            )

            docRef.update(updates).await()
            if (prefs.activeSosId == incidentId) {
                prefs.activeSosId = ""
            }
            Log.d(TAG, "Student SOS cancelled in Cloud Firestore: $incidentId")
            Result.success(true)
        } catch (e: Exception) {
            Log.e(TAG, "Error cancelling student SOS", e)
            Result.failure(e)
        }
    }

    /**
     * Updates the student's live GPS coordinates on an existing incident in Firestore without creating a duplicate.
     */
    suspend fun updateStudentSosLocation(
        incidentId: String,
        latitude: Double,
        longitude: Double,
        accuracy: Double
    ): Result<Boolean> {
        return try {
            val now = getCurrentIsoTimestamp()
            val docRef = firestore.collection("incidents").document(incidentId)
            val updates = hashMapOf<String, Any>(
                "location.latitude" to latitude,
                "location.longitude" to longitude,
                "location.accuracy" to accuracy,
                "location.locationStatus" to "available",
                "location.gpsTimestamp" to now,
                "updated_at" to now
            )
            docRef.update(updates).await()
            Result.success(true)
        } catch (e: Exception) {
            Log.w(TAG, "Error updating student live GPS coordinates", e)
            Result.failure(e)
        }
    }

    /**
     * Fetches incident history for a specific student from Cloud Firestore.
     */
    suspend fun fetchStudentSosHistory(studentId: String): Result<List<Incident>> {
        return try {
            val cleanId = studentId.trim().uppercase()
            val snap = firestore.collection("incidents")
                .whereEqualTo("student_id", cleanId)
                .get()
                .await()

            val list = snap.documents.mapNotNull { doc ->
                try {
                    val data = doc.data ?: return@mapNotNull null
                    parseIncidentFromMap(doc.id, data)
                } catch (e: Exception) { null }
            }.sortedByDescending { it.createdAt ?: "" }

            Result.success(list)
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching student history", e)
            Result.failure(e)
        }
    }
}


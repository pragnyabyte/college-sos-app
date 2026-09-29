package com.emergencysos.responder

import com.emergencysos.responder.data.Incident
import com.emergencysos.responder.data.IncidentLocation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IncidentModelTest {

    @Test
    fun testIncidentCreationAndFormatting() {
        val location = IncidentLocation(
            building = "Science Complex",
            floor = "3rd Floor",
            room = "Lab 302",
            latitude = 20.2961,
            longitude = 85.8245,
            accuracy = 8.5,
            locationStatus = "available"
        )

        val incident = Incident(
            id = "SOS-999",
            categoryId = "medical",
            priority = "CRITICAL",
            studentName = "Rahul Sharma",
            studentId = "STU-2024-001",
            studentPhone = "+919876543210",
            description = "Severe chest pain in chemistry lab",
            location = location,
            status = "DEPARTMENT_NOTIFIED",
            createdAt = "2026-09-28T10:00:00.000Z"
        )

        assertEquals("SOS-999", incident.id)
        assertEquals("CRITICAL", incident.priority)
        assertEquals("Science Complex", incident.location?.building)
        assertEquals("3rd Floor", incident.location?.floor)
        assertEquals("Lab 302", incident.location?.room)
        assertEquals(20.2961, incident.location?.latitude ?: 0.0, 0.0001)
        assertEquals(85.8245, incident.location?.longitude ?: 0.0, 0.0001)
        assertEquals(8.5, incident.location?.accuracy ?: 0.0, 0.1)
        assertEquals("DEPARTMENT_NOTIFIED", incident.status)
    }

    @Test
    fun testLocationFormattingWithoutGps() {
        val location = IncidentLocation(
            building = "Hostel B",
            floor = "Ground Floor",
            room = "Common Room",
            latitude = null,
            longitude = null,
            accuracy = null,
            locationStatus = "unavailable"
        )

        val locString = listOf(location.building, location.floor, location.room)
            .filter { !it.isNullOrBlank() }
            .joinToString(" · ")

        assertEquals("Hostel B · Ground Floor · Common Room", locString)
        assertNull(location.latitude)
        assertNull(location.longitude)
    }

    @Test
    fun testStatusTransitions() {
        val validStatuses = setOf(
            "SOS_SENT",
            "DEPARTMENT_NOTIFIED",
            "ACCEPTED",
            "RESPONDING",
            "ARRIVED",
            "RESOLVED",
            "CANCELLED"
        )

        assertTrue(validStatuses.contains("DEPARTMENT_NOTIFIED"))
        assertTrue(validStatuses.contains("ACCEPTED"))
        assertTrue(validStatuses.contains("RESOLVED"))
        assertFalse(validStatuses.contains("INVALID_STATUS"))
    }
}

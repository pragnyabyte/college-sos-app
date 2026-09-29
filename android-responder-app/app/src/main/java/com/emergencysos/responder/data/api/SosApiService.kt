package com.emergencysos.responder.data.api

import com.emergencysos.responder.data.*
import retrofit2.Response
import retrofit2.http.*

interface SosApiService {

    @POST("api/auth/login")
    suspend fun login(@Body req: LoginRequest): Response<LoginResponse>

    @POST("api/responder/device")
    suspend fun registerDevice(@Body req: DeviceRegisterRequest): Response<DeviceRegisterResponse>

    @DELETE("api/responder/device/{deviceId}")
    suspend fun unregisterDevice(@Path("deviceId") deviceId: String): Response<Map<String, Any>>

    @POST("api/responder/device/ping")
    suspend fun pingDevice(@Body req: DevicePingRequest): Response<DevicePingResponse>

    @GET("api/sos/admin")
    suspend fun getIncidents(): Response<List<Incident>>

    @GET("api/sos/{id}")
    suspend fun getIncident(@Path("id") id: String): Response<Incident>

    @POST("api/sos/{id}/{action}")
    suspend fun changeStatus(
        @Path("id") id: String,
        @Path("action") action: String,
        @Body req: StatusChangeRequest = StatusChangeRequest()
    ): Response<Incident>

    @POST("api/sos/{id}/receipt")
    suspend fun reportReceipt(
        @Path("id") id: String,
        @Body req: AuditReceiptRequest
    ): Response<AuditReceiptResponse>

    @POST("api/sos/{id}/open")
    suspend fun reportOpen(
        @Path("id") id: String,
        @Body req: AuditReceiptRequest
    ): Response<AuditReceiptResponse>

    @POST("api/responder/test-alert")
    suspend fun triggerTestAlert(): Response<TestAlertResponse>
}

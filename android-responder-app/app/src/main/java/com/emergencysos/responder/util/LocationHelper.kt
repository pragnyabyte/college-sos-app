package com.emergencysos.responder.util

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat

object LocationHelper {

    private const val TAG = "LocationHelper"

    fun hasLocationPermission(context: Context): Boolean {
        val fine = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        return fine || coarse
    }

    @SuppressLint("MissingPermission")
    fun getBestLastKnownLocation(context: Context): Location? {
        if (!hasLocationPermission(context)) {
            Log.w(TAG, "Location permission not granted")
            return null
        }

        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null

        var bestLocation: Location? = null

        val providers = listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER
        )

        for (provider in providers) {
            try {
                if (lm.isProviderEnabled(provider)) {
                    val l = lm.getLastKnownLocation(provider) ?: continue
                    if (bestLocation == null || l.accuracy < bestLocation.accuracy || l.time > bestLocation.time) {
                        bestLocation = l
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Error querying provider $provider: ${e.message}")
            }
        }

        return bestLocation
    }

    @SuppressLint("MissingPermission")
    fun requestSingleFreshLocation(context: Context, onResult: (Location?) -> Unit) {
        if (!hasLocationPermission(context)) {
            onResult(null)
            return
        }

        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        if (lm == null) {
            onResult(null)
            return
        }

        // First check last known location
        val lastKnown = getBestLastKnownLocation(context)
        if (lastKnown != null && System.currentTimeMillis() - lastKnown.time < 30_000) {
            // Less than 30s old, return immediately
            onResult(lastKnown)
            return
        }

        val provider = when {
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> null
        }

        if (provider == null) {
            onResult(lastKnown)
            return
        }

        try {
            var delivered = false
            val listener = object : LocationListener {
                override fun onLocationChanged(location: Location) {
                    if (!delivered) {
                        delivered = true
                        lm.removeUpdates(this)
                        onResult(location)
                    }
                }

                @Deprecated("Deprecated in Java")
                override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                override fun onProviderEnabled(provider: String) {}
                override fun onProviderDisabled(provider: String) {}
            }

            lm.requestSingleUpdate(provider, listener, Looper.getMainLooper())

            // Fallback timeout after 3 seconds: deliver lastKnown if fresh update hasn't arrived
            android.os.Handler(Looper.getMainLooper()).postDelayed({
                if (!delivered) {
                    delivered = true
                    try { lm.removeUpdates(listener) } catch (_: Exception) {}
                    onResult(lastKnown)
                }
            }, 3000)

        } catch (e: Exception) {
            Log.w(TAG, "Error requesting single update", e)
            onResult(lastKnown)
        }
    }
}

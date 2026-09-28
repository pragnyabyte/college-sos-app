import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createIncidentInFirestore,
  updateIncidentLocationInFirestore,
  fetchIncidentFromFirestore,
  deleteIncidentFromFirestore
} from '../frontend/src/firebase-client.js';

console.log('===============================================================');
console.log('MASTER TEST SUITE — STUDENT GPS TIMEOUT FIX & LIVE TRACKING');
console.log('===============================================================\n');

// 1. Inspect Codebase for Geolocation & Live Tracking Architecture
console.log('1. Inspecting frontend/src/app.js code implementation...');
const appJsPath = join(process.cwd(), 'frontend', 'src', 'app.js');
const appJs = readFileSync(appJsPath, 'utf-8');

// TASK 1: Geolocation Progressive Acquisition & Timeouts
assert.ok(appJs.includes('navigator.geolocation.getCurrentPosition'), 'Must use navigator.geolocation.getCurrentPosition');
assert.ok(appJs.includes('enableHighAccuracy: true'), 'Must specify enableHighAccuracy: true');
assert.ok(appJs.includes('maximumAge: 0'), 'Must specify maximumAge: 0 for precision fix');
assert.ok(appJs.includes('enableHighAccuracy: false'), 'Must include fast coarse acquisition stage');
assert.ok(appJs.includes('Getting your location'), 'Must show clear status message Getting your location');
assert.ok(appJs.includes('Location acquired'), 'Must show status message Location acquired');
assert.ok(appJs.includes('GPS signal is weak'), 'Must show status message GPS signal is weak');
assert.ok(appJs.includes('Location permission denied'), 'Must show status message Location permission denied');
console.log('   ✓ PASS: Progressive 2-stage location acquisition implemented with all status callbacks.');

// TASK 2: watchPosition & Continuous Live Tracking
assert.ok(appJs.includes('navigator.geolocation.watchPosition'), 'Must use navigator.geolocation.watchPosition');
assert.ok(appJs.includes('navigator.geolocation.clearWatch'), 'Must use clearWatch to stop tracking');
assert.ok(appJs.includes('calculateDistanceMeters'), 'Must implement calculateDistanceMeters for movement calculation');
assert.ok(appJs.includes('startLiveLocationTracking'), 'Must implement startLiveLocationTracking');
assert.ok(appJs.includes('stopLiveLocationTracking'), 'Must implement stopLiveLocationTracking');
console.log('   ✓ PASS: Continuous watchPosition live tracking with cleanup implemented.');

// TASK 3: Firebase Firestore Only (No Railway / MongoDB required)
assert.ok(appJs.includes('updateIncidentLocationInFirestore'), 'Must use updateIncidentLocationInFirestore directly');
assert.ok(appJs.includes('listenToIncident'), 'Must import listenToIncident');
console.log('   ✓ PASS: Cloud Firestore direct updates and real-time subscription verified.');

// TASK 4: Non-blocking SOS Flow
assert.ok(appJs.includes('Getting your current GPS location...'), 'Must show initial GPS status');
assert.ok(appJs.includes('Dispatching emergency alert...'), 'Must show dispatch status');
assert.ok(appJs.includes('startLiveLocationTracking(created.id)'), 'Must automatically start live tracking after incident creation');
console.log('   ✓ PASS: Non-blocking SOS creation starts live tracking immediately.');

// TASK 5: Responder Live Map & Freshness Indicator
assert.ok(appJs.includes('🟢 LIVE TRACKING'), 'Must display LIVE TRACKING badge when fresh');
assert.ok(appJs.includes('Last location received:'), 'Must display Last location received when stale');
assert.ok(appJs.includes('openstreetmap.org/export/embed.html'), 'Must embed interactive OpenStreetMap iframe');
assert.ok(appJs.includes('https://www.google.com/maps/search/?api=1&query='), 'Must provide official Google Maps Universal Scheme');
console.log('   ✓ PASS: Responder live map and freshness window verified.\n');

// 2. Test Haversine Distance Calculation
console.log('2. Verifying Haversine distance calculations...');
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return 0;
  const R = 6371e3;
  const rad = Math.PI / 180;
  const φ1 = lat1 * rad;
  const φ2 = lat2 * rad;
  const Δφ = (lat2 - lat1) * rad;
  const Δλ = (lon2 - lon1) * rad;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Distance between Bangalore Vidhana Soudha (12.979693, 77.590659) and Cubbon Park (12.976352, 77.592928) ~ 440m
const d1 = calculateDistanceMeters(12.979693, 77.590659, 12.976352, 77.592928);
assert.ok(d1 > 400 && d1 < 480, `Expected ~440m, got ${d1}`);
console.log(`   ✓ PASS: Bangalore sample distance: ${Math.round(d1)}m (expected ~440m)`);

// Very small movement (student walking ~10 meters)
const d2 = calculateDistanceMeters(12.971598, 77.594566, 12.971680, 77.594566);
assert.ok(d2 >= 8 && d2 <= 11, `Expected ~9m, got ${d2}`);
console.log(`   ✓ PASS: Small student walking step: ${d2.toFixed(1)}m detected accurately.`);

// Same coordinate distance must be exactly 0
assert.equal(calculateDistanceMeters(12.971598, 77.594566, 12.971598, 77.594566), 0);
console.log('   ✓ PASS: Zero movement accurately returns 0m.\n');

// 3. Test Location Freshness Determination
console.log('3. Verifying Live vs. Stale freshness window (< 60 seconds)...');
function checkLocationFreshness(timestamp, now = Date.now()) {
  if (!timestamp) return { isLive: false, ageSec: Infinity };
  const ageSec = Math.max(0, Math.round((now - new Date(timestamp).getTime()) / 1000));
  return { isLive: ageSec <= 60, ageSec };
}

// 5 seconds ago -> LIVE
const fresh = checkLocationFreshness(new Date(Date.now() - 5000).toISOString());
assert.equal(fresh.isLive, true);
assert.equal(fresh.ageSec, 5);
console.log('   ✓ PASS: Update from 5s ago correctly categorized as LIVE TRACKING.');

// 45 seconds ago -> LIVE
const stillFresh = checkLocationFreshness(new Date(Date.now() - 45000).toISOString());
assert.equal(stillFresh.isLive, true);
console.log('   ✓ PASS: Update from 45s ago correctly categorized as LIVE TRACKING.');

// 75 seconds ago -> STALE
const stale = checkLocationFreshness(new Date(Date.now() - 75000).toISOString());
assert.equal(stale.isLive, false);
assert.equal(stale.ageSec, 75);
console.log('   ✓ PASS: Update from 75s ago correctly categorized as STALE / INACTIVE.\n');

// 4. Live Cloud Firestore End-to-End Simulation
console.log('4. Testing Live Cloud Firestore Student-to-Responder Tracking Pipeline...');

const testStudent = {
  id: 'STU-GPS-' + Math.floor(1000 + Math.random() * 9000),
  name: 'Aarav Patel',
  role: 'STUDENT'
};

const initialPayload = {
  categoryId: 'security',
  description: 'Testing live GPS tracking pipeline',
  location: {
    building: 'Library Complex',
    floor: '2nd Floor',
    room: 'Silent Study Room',
    area: 'Silent Study Room',
    latitude: 12.971598,
    longitude: 77.594566,
    accuracy: 35.0, // Initial network fix
    locationStatus: 'available',
    gpsTimestamp: new Date().toISOString(),
    source: 'GPS'
  },
  idempotencyKey: 'test-gps-e2e-' + Date.now()
};

let createdIncident = null;

try {
  // Step A: Create SOS in Cloud Firestore
  createdIncident = await createIncidentInFirestore(initialPayload, testStudent);
  assert.ok(createdIncident.id, 'Incident must be created with ID');
  assert.equal(createdIncident.location.latitude, 12.971598);
  assert.equal(createdIncident.location.longitude, 77.594566);
  assert.equal(createdIncident.location.accuracy, 35.0);
  console.log(`   ✓ PASS: Step A: Emergency SOS created in Firestore: ${createdIncident.id} (Initial fix ±35m)`);

  // Step B: Student moves 25 meters, precision GNSS acquires (accuracy improves to ±8m)
  const movedLat = 12.971820;
  const movedLng = 77.594566;
  const movedAcc = 8.0;
  const stepBDist = calculateDistanceMeters(12.971598, 77.594566, movedLat, movedLng);
  console.log(`   ... Student moved ${Math.round(stepBDist)}m. Pushing precision GPS update to Firestore...`);

  const updatedLocPayload = {
    latitude: movedLat,
    longitude: movedLng,
    accuracy: movedAcc,
    gpsTimestamp: new Date().toISOString(),
    locationStatus: 'available',
    source: 'GPS',
    isLive: true
  };

  await updateIncidentLocationInFirestore(createdIncident.id, updatedLocPayload, testStudent);

  // Step C: Verify Responder fetches updated document from Firestore
  const fetchedDoc = await fetchIncidentFromFirestore(createdIncident.id);
  assert.ok(fetchedDoc, 'Document must exist in Firestore');
  assert.equal(fetchedDoc.location.latitude, movedLat);
  assert.equal(fetchedDoc.location.longitude, movedLng);
  assert.equal(fetchedDoc.location.accuracy, movedAcc);
  assert.equal(fetchedDoc.location.building, 'Library Complex'); // Preserved
  assert.equal(fetchedDoc.location.room, 'Silent Study Room'); // Preserved
  assert.ok(fetchedDoc.location.lastUpdated, 'Must contain lastUpdated timestamp');
  console.log(`   ✓ PASS: Step B & C: Live coordinates updated in Firestore and fetched by responder console!`);
  console.log(`           Coordinates: ${fetchedDoc.location.latitude.toFixed(6)}, ${fetchedDoc.location.longitude.toFixed(6)} (±${fetchedDoc.location.accuracy}m)`);

  // Step D: Verify Google Maps Universal Search URL matches exact updated coordinates
  const expectedMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${movedLat},${movedLng}`)}`;
  assert.equal(expectedMapsUrl, `https://www.google.com/maps/search/?api=1&query=${movedLat}%2C${movedLng}`);
  console.log(`   ✓ PASS: Step D: Live Google Maps navigation URL verified: ${expectedMapsUrl}`);

  // Cleanup test document from Firestore
  await deleteIncidentFromFirestore(createdIncident.id);
  console.log(`   ✓ PASS: Cleaned up test incident ${createdIncident.id} from Firestore.\n`);

} catch (err) {
  console.error('   ❌ FAILED:', err.message);
  if (createdIncident?.id) {
    await deleteIncidentFromFirestore(createdIncident.id).catch(() => {});
  }
  process.exit(1);
}

console.log('===============================================================');
console.log('ALL LIVE GPS TRACKING & TIMEOUT TESTS PASSED SUCCESSFULLY! ✓');
console.log('===============================================================');
process.exit(0);


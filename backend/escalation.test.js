import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, closeDatabase } from './db.js';
import {
  ALERT_STATUSES,
  ESCALATION_CONFIG,
  formatLocationLink,
  formatLocationSummary,
  generateEmergencyTwiML,
  handleTwiMLGather,
  getRegisteredResponderPhones,
  sendEmergencySms,
  sendEmergencyVoiceCall,
  processEscalations
} from './escalation.js';
import {
  ensurePermanentResponder,
  registerResponderDevice,
  unregisterResponderDevice,
  getActiveResponderDevices,
  sendEmergencySosNotification,
  RESPONDER_ID
} from './fcm.js';
import { createIncident, changeStatus, getIncident, deleteIncident } from './service.js';

test('Escalation Module - Configuration & Status Definitions', () => {
  assert.equal(ALERT_STATUSES.DISPATCH_ATTEMPTED, 'DISPATCH_ATTEMPTED');
  assert.equal(ALERT_STATUSES.PROVIDER_ACCEPTED, 'PROVIDER_ACCEPTED');
  assert.equal(ALERT_STATUSES.DEVICE_DELIVERY_CONFIRMED, 'DEVICE_DELIVERY_CONFIRMED');
  assert.equal(ALERT_STATUSES.NOTIFICATION_DISPLAYED, 'NOTIFICATION_DISPLAYED');
  assert.equal(ALERT_STATUSES.RESPONDER_ACKNOWLEDGED, 'RESPONDER_ACKNOWLEDGED');
  assert.equal(ALERT_STATUSES.AUDIBLE_SOUND_VERIFIED, 'AUDIBLE_SOUND_VERIFIED');

  assert.equal(typeof ESCALATION_CONFIG.PUSH_RETRY_SECONDS, 'number');
  assert.equal(typeof ESCALATION_CONFIG.SMS_SECONDS, 'number');
  assert.equal(typeof ESCALATION_CONFIG.VOICE_SECONDS, 'number');
  assert.equal(typeof ESCALATION_CONFIG.MAX_RETRIES, 'number');
});

test('Location Link Formatter - Validates GPS Coordinates and Maps URLs', () => {
  const withGps = { latitude: 12.9716, longitude: 77.5946 };
  const link = formatLocationLink(withGps);
  assert.ok(link.includes('https://www.google.com/maps/search/?api=1&query=12.971600,77.594600'));

  const withoutGps = { building: 'Library', floor: '1st Floor' };
  assert.equal(formatLocationLink(withoutGps), null);

  const summary = formatLocationSummary({ building: 'Admin Block', floor: '2nd Floor', room: '201' });
  assert.equal(summary, 'Admin Block, 2nd Floor, 201');
});

test('TwiML IVR Emergency Voice Call Generation', () => {
  const fakeIncident = {
    id: 'SOS-IVR-1001',
    priority: 'CRITICAL',
    category_id: 'medical',
    emergency_type: 'Medical Emergency',
    student_name: 'Ananya Roy',
    location: { building: 'Hostel 3', floor: 'Ground Floor', room: '102' }
  };

  const xml = generateEmergencyTwiML(fakeIncident);
  assert.ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<Response>'));
  assert.ok(xml.includes('Ananya Roy'));
  assert.ok(xml.includes('Medical Emergency'));
  assert.ok(xml.includes('Press 1 to acknowledge'));
  assert.ok(xml.includes('<Gather numDigits="1"'));
});

test('Multi-Responder Simultaneous Alerting - Multiple Registered Responder Devices', async () => {
  await ensurePermanentResponder();

  const devicePhone1 = 'PHONE-RESP-A-' + Date.now();
  const tokenPhone1 = 'fcm_token_phone_a_' + Date.now();
  const devicePhone2 = 'PHONE-RESP-B-' + Date.now();
  const tokenPhone2 = 'fcm_token_phone_b_' + Date.now();

  // Register Phone 1 (Responder A)
  await registerResponderDevice({
    responderId: RESPONDER_ID,
    deviceId: devicePhone1,
    fcmToken: tokenPhone1,
    platform: 'android',
    model: 'Pixel 8'
  });

  // Register Phone 2 (Responder B on different device at the same time)
  await registerResponderDevice({
    responderId: RESPONDER_ID,
    deviceId: devicePhone2,
    fcmToken: tokenPhone2,
    platform: 'android',
    model: 'Samsung Galaxy S24'
  });

  const active = await getActiveResponderDevices(RESPONDER_ID);
  const devA = active.find(d => d.deviceId === devicePhone1);
  const devB = active.find(d => d.deviceId === devicePhone2);

  assert.ok(devA, 'Phone 1 must be active and registered');
  assert.ok(devB, 'Phone 2 must be active and registered simultaneously');

  const testSos = {
    id: 'SOS-SIMUL-TEST-' + Math.floor(1000 + Math.random() * 9000),
    category_id: 'security',
    priority: 'HIGH',
    student_name: 'Simultaneous Test Student',
    student_id: 'STU-SIMUL',
    location: { building: 'Sports Complex', floor: '1st Floor', room: 'Gym' },
    created_at: new Date().toISOString()
  };

  const dispatch = await sendEmergencySosNotification(testSos);
  assert.ok(dispatch.totalDevices >= 2, 'FCM dispatch must target both responder devices simultaneously');

  // Cleanup test devices
  await unregisterResponderDevice(devicePhone1, RESPONDER_ID);
  await unregisterResponderDevice(devicePhone2, RESPONDER_ID);
});

test('SMS & Voice Call Escalation - Dispatch Attempt Auditing', async () => {
  const fakeIncident = {
    id: 'SOS-AUDIT-' + Math.floor(1000 + Math.random() * 9000),
    category_id: 'fire',
    priority: 'CRITICAL',
    student_name: 'Test Alert Student',
    student_id: 'STU-0099',
    location: { building: 'Chemistry Lab', floor: '3rd Floor', latitude: 12.9716, longitude: 77.5946 },
    created_at: new Date().toISOString()
  };

  const smsRes = await sendEmergencySms(fakeIncident);
  assert.ok(typeof smsRes.attemptedCount === 'number');

  const voiceRes = await sendEmergencyVoiceCall(fakeIncident);
  assert.ok(typeof voiceRes.attemptedCount === 'number');

  const db = await getDb();
  const logs = await db.collection('notification_audit_logs').find({
    incident_id: fakeIncident.id
  }).toArray();

  assert.ok(logs.length >= 2, 'Audit logs must capture dispatch attempts for both SMS and Voice');
  assert.ok(logs.some(l => l.details.channel === 'SMS'));
  assert.ok(logs.some(l => l.details.channel === 'VOICE_CALL'));

  // Clean up
  await db.collection('notification_audit_logs').deleteMany({ incident_id: fakeIncident.id });
});

test('Escalation Lifecycle - Unacknowledged SOS triggers 15s push, 30s SMS, 60s Voice', async () => {
  const db = await getDb();
  const testIncidentId = 'SOS-ESC-TEST-' + Math.floor(1000 + Math.random() * 9000);
  const now = Date.now();

  // Create an incident simulated as created 70 seconds ago (older than all 3 thresholds)
  const created70sAgo = new Date(now - 70 * 1000).toISOString();
  await db.collection('incidents').insertOne({
    id: testIncidentId,
    category_id: 'security',
    priority: 'HIGH',
    student_name: 'Escalation Test Student',
    student_id: 'STU-ESC-01',
    status: 'DEPARTMENT_NOTIFIED',
    location: { building: 'Main Gate', floor: 'Ground' },
    created_at: created70sAgo,
    updated_at: created70sAgo
  });

  // Run escalation processor
  const results = await processEscalations();
  assert.ok(results.processed >= 1, 'Processor must detect active unacknowledged incidents');

  const incidentDoc = await db.collection('incidents').findOne({ id: testIncidentId });
  assert.ok(incidentDoc.escalation_push_retried_at, 'Stage 1 (15s push retry) must be marked');
  assert.ok(incidentDoc.escalation_sms_sent_at, 'Stage 2 (30s SMS) must be marked');
  assert.ok(incidentDoc.escalation_voice_call_sent_at, 'Stage 3 (60s Voice call) must be marked');
  assert.equal(incidentDoc.escalation_level, 3);

  // Clean up
  await db.collection('incidents').deleteOne({ id: testIncidentId });
  await db.collection('notification_audit_logs').deleteMany({ incident_id: testIncidentId });
});

test('Phone IVR Acknowledgment - Responder pressing 1 resolves alert across all consoles', async () => {
  const db = await getDb();
  const testIncidentId = 'SOS-IVR-ACK-' + Math.floor(1000 + Math.random() * 9000);
  const now = new Date().toISOString();

  await db.collection('incidents').insertOne({
    id: testIncidentId,
    category_id: 'security',
    priority: 'HIGH',
    student_name: 'IVR Test Student',
    student_id: 'STU-IVR',
    status: 'DEPARTMENT_NOTIFIED',
    location: { building: 'Sports Complex', floor: '1st Floor' },
    created_at: now,
    updated_at: now
  });

  let broadcastCaptured = null;
  const broadcastCallback = (payload) => {
    broadcastCaptured = payload;
  };

  // Simulate responder pressing '1' on automated voice call
  const twimlResponse = await handleTwiMLGather(testIncidentId, '1', '+15555550199', broadcastCallback);

  assert.ok(twimlResponse.includes('successfully acknowledged'));
  assert.ok(broadcastCaptured, 'Acknowledgment must trigger real-time broadcast to all responder dashboards');
  assert.equal(broadcastCaptured.status, 'ACCEPTED');

  // Verify status in MongoDB is ACCEPTED
  const updated = await db.collection('incidents').findOne({ id: testIncidentId });
  assert.equal(updated.status, 'ACCEPTED');
  assert.equal(updated.accepted_by, 'TWILIO_VOICE');

  // Clean up
  await db.collection('incidents').deleteOne({ id: testIncidentId });
  await db.collection('notification_audit_logs').deleteMany({ incident_id: testIncidentId });
});

test.after(async () => {
  try {
    await closeDatabase();
  } catch {}
});

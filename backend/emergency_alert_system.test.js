import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './db.js';
import {
  ensurePermanentResponder,
  registerResponderDevice,
  unregisterResponderDevice,
  getActiveResponderDevices,
  isRegisteredDeviceId,
  sendEmergencySosNotification,
  recordDeviceReceipt,
  recordDeviceOpen,
  RESPONDER_ID
} from './fcm.js';

test('Emergency Alert System - Device Registration & Identity Association', async () => {
  await ensurePermanentResponder();

  const testDeviceId = 'DEV-TEST-UNIT-' + Date.now();
  const testFcmToken = 'fcm_test_token_' + Date.now();

  // 1. Register device under permanent responder
  const regResult = await registerResponderDevice({
    responderId: RESPONDER_ID,
    deviceId: testDeviceId,
    fcmToken: testFcmToken,
    platform: 'android',
    appVersion: '1.0.0',
    model: 'Test Device Android 14'
  });

  assert.equal(regResult.success, true);
  assert.equal(regResult.deviceId, testDeviceId);

  // 2. Verify isRegisteredDeviceId
  const isRegistered = await isRegisteredDeviceId(testDeviceId);
  assert.equal(isRegistered, true);

  const isUnknown = await isRegisteredDeviceId('UNKNOWN-DEV-999');
  assert.equal(isUnknown, false);

  // 3. Verify getActiveResponderDevices
  const devices = await getActiveResponderDevices(RESPONDER_ID, true);
  const found = devices.find(d => d.deviceId === testDeviceId);
  assert.ok(found, 'Registered test device should be in active devices list');
  assert.equal(found.platform, 'android');
  assert.ok(found.fcmTokenMasked.includes('...'), 'FCM token must be masked when requested');

  // 4. Record device receipt (verifies physical delivery audit logging)
  const fakeIncidentId = 'SOS-TEST-' + Math.floor(1000 + Math.random() * 9000);
  const receiptResult = await recordDeviceReceipt({
    incidentId: fakeIncidentId,
    deviceId: testDeviceId,
    responderId: RESPONDER_ID,
    clientTimestamp: new Date().toISOString()
  });
  assert.equal(receiptResult.success, true);
  assert.equal(receiptResult.incidentId, fakeIncidentId);

  // Check audit log in MongoDB
  const db = await getDb();
  const auditReceipt = await db.collection('notification_audit_logs').findOne({
    incident_id: fakeIncidentId,
    event: 'DEVICE_RECEIPT'
  });
  assert.ok(auditReceipt, 'Receipt audit record must exist in MongoDB');
  assert.equal(auditReceipt.details.deviceId, testDeviceId);

  // 5. Record device open
  const openResult = await recordDeviceOpen({
    incidentId: fakeIncidentId,
    deviceId: testDeviceId,
    responderId: RESPONDER_ID,
    clientTimestamp: new Date().toISOString()
  });
  assert.equal(openResult.success, true);

  const auditOpen = await db.collection('notification_audit_logs').findOne({
    incident_id: fakeIncidentId,
    event: 'RESPONDER_OPENED'
  });
  assert.ok(auditOpen, 'Open audit record must exist in MongoDB');

  // 6. Test FCM notification dispatch with targeted platform handling
  const fakeIncident = {
    id: fakeIncidentId,
    category_id: 'security',
    priority: 'CRITICAL',
    student_name: 'Test Student',
    student_id: 'STU-001',
    location: { building: 'Science Block', floor: '2nd Floor', room: 'Lab 204' },
    description: 'Testing emergency push dispatch',
    created_at: new Date().toISOString()
  };

  const dispatchResult = await sendEmergencySosNotification(fakeIncident);
  assert.ok(typeof dispatchResult.fcmAcceptedCount === 'number');
  assert.ok(typeof dispatchResult.totalDevices === 'number');
  assert.ok(dispatchResult.totalDevices >= 1);

  // 7. Cleanup / Unregister device
  await unregisterResponderDevice(testDeviceId, RESPONDER_ID);
  const afterUnregister = await getActiveResponderDevices(RESPONDER_ID);
  const stillActive = afterUnregister.find(d => d.deviceId === testDeviceId);
  assert.equal(stillActive, undefined, 'Deactivated device must not appear in active devices list');

  // Clean up test audit log entries
  await db.collection('notification_audit_logs').deleteMany({ incident_id: fakeIncidentId });
  await db.collection('emergency_responders').updateOne(
    { responderId: RESPONDER_ID },
    { $unset: { [`devices.${testDeviceId}`]: '' } }
  );

  const { closeDatabase } = await import('./db.js');
  await closeDatabase();
});

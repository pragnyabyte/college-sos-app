import assert from 'node:assert';
import { issueToken, createSessionUser } from '../backend/auth.js';
import { recordDeviceReceipt, recordDeviceOpen, updateDevicePing, checkAndEscalateIncidents } from '../backend/fcm.js';
import { initDatabase, getDb } from '../backend/db.js';

async function run() {
  console.log('Testing new fcm & audit endpoints in memory / mongodb...');
  await initDatabase();

  const mockIncidentId = 'TEST-AUDIT-' + Date.now();
  const mockDeviceId = 'android_dev_test_99';

  console.log('1. Testing recordDeviceReceipt...');
  const rec = await recordDeviceReceipt({
    incidentId: mockIncidentId,
    deviceId: mockDeviceId,
    responderId: 'RESP-1111',
    clientTimestamp: new Date().toISOString()
  });
  assert.strictEqual(rec.success, true);
  assert.strictEqual(rec.incidentId, mockIncidentId);

  console.log('2. Testing recordDeviceOpen...');
  const op = await recordDeviceOpen({
    incidentId: mockIncidentId,
    deviceId: mockDeviceId,
    responderId: 'RESP-1111',
    clientTimestamp: new Date().toISOString()
  });
  assert.strictEqual(op.success, true);
  assert.strictEqual(op.incidentId, mockIncidentId);

  console.log('3. Verifying logs in notification_audit_logs...');
  const db = await getDb();
  const logs = await db.collection('notification_audit_logs').find({ incident_id: mockIncidentId }).toArray();
  assert.strictEqual(logs.length, 2, 'Should have logged 2 audit events');
  assert.strictEqual(logs[0].event, 'DEVICE_RECEIPT');
  assert.strictEqual(logs[1].event, 'RESPONDER_OPENED');

  console.log('4. Testing updateDevicePing...');
  await updateDevicePing(mockDeviceId, 'RESP-1111');

  console.log('5. Testing checkAndEscalateIncidents (threshold 0m)...');
  const resEsc = await checkAndEscalateIncidents(0);
  assert.ok(Array.isArray(resEsc));

  console.log('All new endpoint helper functions verified successfully! ✓');
  process.exit(0);
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

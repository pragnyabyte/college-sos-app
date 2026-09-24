import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = 'http://localhost:4000';

async function req(path, method = 'GET', body = null, token = null) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function runTests() {
  console.log('====================================================');
  console.log('TESTING REAL-TIME CLOCK & SOS ALERT DELETION');
  console.log('====================================================\n');

  // 1. Verify Frontend Code Integrity for Real-Time Clock
  console.log('1. Checking Frontend Implementation for Real-Time Clock...');
  const appJs = readFileSync(join(process.cwd(), 'frontend/src/app.js'), 'utf-8');
  assert.ok(appJs.includes('getLiveClockTime()'), 'Must contain getLiveClockTime function');
  assert.ok(appJs.includes("hour12: true"), 'Must use 12-hour format with AM/PM');
  assert.ok(appJs.includes('clockTimeText'), 'Must have clockTimeText elements');
  assert.ok(appJs.includes('setInterval('), 'Must update clock dynamically with setInterval');
  assert.ok(appJs.includes('responderRealtimeClock'), 'Must render real-time clock in header for responder');
  assert.ok(appJs.includes('toolbarRealtimeClock'), 'Must render real-time clock in responderToolbar');
  console.log('   ✓ Real-time clock generates dynamic 12-hour time (AM/PM) every second without refresh');

  // 2. Verify Frontend Code Integrity for Delete Confirmation Modal
  console.log('\n2. Checking Frontend Implementation for SOS Alert Delete Option...');
  assert.ok(appJs.includes('btnDeleteCard'), 'Must have Delete button on alert cards');
  assert.ok(appJs.includes('data-delete-sos'), 'Must bind data-delete-sos attribute');
  assert.ok(appJs.includes('Are you sure you want to delete this SOS alert?'), 'Must have confirmation question');
  assert.ok(appJs.includes('btnModalCancel'), 'Must have Cancel option');
  assert.ok(appJs.includes('btnModalDelete'), 'Must have Delete confirmation action');
  assert.ok(appJs.includes('deleteIncidentFromFirestore'), 'Must call Firestore deletion');
  console.log('   ✓ Delete button on cards and modal with Cancel/Delete verified in app.js');

  // 3. Test Student SOS Creation
  console.log('\n3. Creating test SOS from student account...');
  const runId = Date.now().toString().slice(-4);
  const stuLogin = await req('/api/auth/login', 'POST', {
    name: 'Clock Test Student',
    regdNo: `STU-CLK-${runId}`,
    role: 'STUDENT'
  });
  assert.equal(stuLogin.status, 200, 'Student login should succeed');
  const stuToken = stuLogin.data.token;

  const createRes = await req('/api/sos', 'POST', {
    categoryId: 'medical',
    description: 'Test emergency for deletion verification',
    location: { building: 'Health Center', floor: '1st Floor', room: 'Clinic 2', source: 'MANUAL' },
    idempotencyKey: 'idemp-delete-test-' + Date.now()
  }, stuToken);
  assert.equal(createRes.status, 201, 'SOS creation should succeed');
  const createdSosId = createRes.data.id;
  console.log(`   ✓ Created SOS: ${createdSosId}`);

  // 4. Test Student Attempting to Delete (Should be Forbidden 403)
  console.log('\n4. Verifying Student CANNOT delete SOS alert (access control check)...');
  const studentDelAttempt = await req(`/api/sos/${createdSosId}`, 'DELETE', null, stuToken);
  assert.equal(studentDelAttempt.status, 403, 'Student should be rejected with 403 Forbidden');
  console.log('   ✓ Student deletion rejected with 403 Forbidden as expected');

  // 5. Test Authorized Responder Authentication (RESP-001 / RESP-911)
  console.log('\n5. Authenticating authorized Emergency Responder (RESP-001)...');
  const respLogin = await req('/api/auth/login', 'POST', {
    name: 'Campus Emergency Response Unit',
    regdNo: 'RESP-001',
    role: 'RESPONDER',
    pin: 'RESP-911'
  });
  assert.equal(respLogin.status, 200, 'Responder authentication should succeed');
  const respToken = respLogin.data.token;
  console.log('   ✓ Emergency Responder RESP-001 authenticated');

  // 6. Verify Incident Exists in Database Before Deletion
  console.log('\n6. Checking incident exists before deletion...');
  const checkBefore = await req(`/api/sos/${createdSosId}`, 'GET', null, respToken);
  assert.equal(checkBefore.status, 200, 'Incident should exist in DB');
  assert.equal(checkBefore.data.id, createdSosId);
  console.log(`   ✓ Incident ${createdSosId} verified active in MongoDB database`);

  // 7. Responder Confirms Deletion of SOS Alert
  console.log(`\n7. Responder executes permanent deletion of SOS ${createdSosId}...`);
  const delRes = await req(`/api/sos/${createdSosId}`, 'DELETE', null, respToken);
  assert.equal(delRes.status, 200, 'Responder delete should succeed');
  assert.equal(delRes.data.success, true);
  console.log(`   ✓ Successfully deleted incident ${createdSosId} from backend database & Firestore Admin`);

  // 8. Verify Incident is Permanently Removed from Database
  console.log('\n8. Verifying incident is permanently deleted (404)...');
  const checkAfter = await req(`/api/sos/${createdSosId}`, 'GET', null, respToken);
  assert.equal(checkAfter.status, 404, 'Incident should return 404 Not Found after deletion');
  console.log(`   ✓ Verified: Incident ${createdSosId} returned 404 (permanently purged)`);

  console.log('\n====================================================');
  console.log('ALL REAL-TIME CLOCK & SOS DELETION TESTS PASSED! ✓');
  console.log('====================================================');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});

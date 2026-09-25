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

function formatReportedTime(timestamp) {
  if (!timestamp) return 'Time not recorded';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return String(timestamp);

  const day = String(d.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getMonth()];
  const year = d.getFullYear();

  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const formattedHours = String(hours).padStart(2, '0');

  return `${day} ${month} ${year}, ${formattedHours}:${minutes}:${seconds} ${ampm}`;
}

async function runTests() {
  console.log('====================================================');
  console.log('TESTING REMOVAL OF REAL-TIME CLOCK & FIXED REPORTED TIME');
  console.log('====================================================\n');

  // 1. Verify Code Integrity: No Real-Time Clock in Header / App
  console.log('1. Checking Frontend: Verify Real-Time Clock is completely removed...');
  const appJs = readFileSync(join(process.cwd(), 'frontend/src/app.js'), 'utf-8');
  assert.ok(!appJs.includes('responderRealtimeClock'), 'Must NOT have responderRealtimeClock');
  assert.ok(!appJs.includes('toolbarRealtimeClock'), 'Must NOT have toolbarRealtimeClock');
  assert.ok(!appJs.includes('getLiveClockTime()'), 'Must NOT have getLiveClockTime');
  assert.ok(!appJs.includes('REAL-TIME CLOCK'), 'Must NOT have REAL-TIME CLOCK in header');
  console.log('   ✓ Real-Time Clock box completely removed from header and toolbar.');

  // 2. Verify Frontend Code Integrity: Format and display of fixed reported time
  console.log('\n2. Checking Frontend: Verify Fixed Reported Time and single Delete button on SOS cards...');
  assert.ok(appJs.includes('formatReportedTime('), 'Must contain formatReportedTime function');
  assert.ok(appJs.includes('<dt>Reported</dt><dd class="reportedMeta">'), 'Must render Reported in dl facts');
  assert.ok(appJs.includes('btnDeleteCardSecondary'), 'Must maintain lower Delete button in cardFootActions');
  assert.ok(!appJs.includes('cardReportedBox'), 'Top cardReportedBox must be completely removed');
  assert.ok(!appJs.includes('btnDeleteCard"'), 'Top btnDeleteCard must be completely removed');
  console.log('   ✓ Duplicate reported time box and duplicate top delete button removed; lower fields intact.');

  // 3. Authenticate Responder (RESP-1111 / 2611)
  console.log('\n3. Authenticating Emergency Responder (RESP-1111)...');
  const respLogin = await req('/api/auth/login', 'POST', {
    name: 'Campus Emergency Response Unit',
    regdNo: 'RESP-1111',
    role: 'RESPONDER',
    pin: '2611'
  });
  assert.equal(respLogin.status, 200, 'Responder authentication should succeed');
  const respToken = respLogin.data.token;
  console.log('   ✓ Responder RESP-1111 authenticated');

  // 4. Student Submits a Complaint / SOS
  console.log('\n4. Student logs in and submits a new emergency SOS...');
  const runId = Date.now().toString().slice(-4);
  const stuLogin = await req('/api/auth/login', 'POST', {
    name: 'Rohan Deshmukh',
    regdNo: `STU-TIME-${runId}`,
    role: 'STUDENT'
  });
  assert.equal(stuLogin.status, 200);
  const stuToken = stuLogin.data.token;

  const creationBefore = new Date();
  const createRes = await req('/api/sos', 'POST', {
    categoryId: 'infrastructure',
    description: 'Ceiling leakage in 2nd floor library hall',
    location: { building: 'Library Block', floor: '2nd Floor', room: 'Reading Room B', source: 'MANUAL' },
    idempotencyKey: 'idemp-time-test-' + Date.now()
  }, stuToken);
  assert.equal(createRes.status, 201, 'SOS creation should succeed');
  const createdSos = createRes.data;
  const createdSosId = createdSos.id;
  assert.ok(createdSos.created_at, 'SOS record must have created_at timestamp');
  console.log(`   ✓ SOS ${createdSosId} created with timestamp: ${createdSos.created_at}`);

  // 5. Verify the formatted reported time
  const initialReportedTime = formatReportedTime(createdSos.created_at);
  console.log(`   ✓ Formatted Fixed Timestamp: "Reported: ${initialReportedTime}"`);
  assert.match(initialReportedTime, /^\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}:\d{2} (AM|PM)$/, 'Timestamp must match format: DD Mon YYYY, HH:MM:SS AM/PM');

  // 6. Simulate Responder fetching the board later (simulating page reload / multiple seconds later)
  console.log('\n5. Waiting 2 seconds to simulate time passing and page reload...');
  await new Promise(r => setTimeout(r, 2000));

  console.log('6. Responder fetches incident list (page refresh / poll)...');
  const listRes = await req('/api/sos/admin', 'GET', null, respToken);
  assert.equal(listRes.status, 200);
  const fetchedIncident = listRes.data.find(x => x.id === createdSosId);
  assert.ok(fetchedIncident, 'Created incident must be present in responder list');

  const reloadedReportedTime = formatReportedTime(fetchedIncident.created_at);
  console.log(`   ✓ Timestamp after 2 seconds on reload: "${reloadedReportedTime}"`);
  assert.equal(reloadedReportedTime, initialReportedTime, 'Reported time MUST remain strictly fixed and NOT change over time or on reload');
  console.log('   ✓ VERIFIED: The timestamp remains 100% FIXED and does not change!');

  // 7. Verify opening the incident details maintains the exact same timestamp
  console.log('\n7. Responder opens incident details...');
  const detailRes = await req(`/api/sos/${createdSosId}`, 'GET', null, respToken);
  assert.equal(detailRes.status, 200);
  const detailReportedTime = formatReportedTime(detailRes.data.created_at);
  assert.equal(detailReportedTime, initialReportedTime, 'Details view must show the exact same creation timestamp');
  console.log(`   ✓ Details timestamp matches: "${detailReportedTime}"`);

  // 8. Delete option verification: clean up created test incident
  console.log(`\n8. Testing Delete option on SOS ${createdSosId}...`);
  const delRes = await req(`/api/sos/${createdSosId}`, 'DELETE', null, respToken);
  assert.equal(delRes.status, 200, 'Delete must succeed');
  assert.equal(delRes.data.success, true);
  console.log('   ✓ SOS alert permanently deleted from database.');

  console.log('\n====================================================');
  console.log('ALL TESTS PASSED! REAL-TIME CLOCK REMOVED & FIXED REPORTED TIME VERIFIED! ✓');
  console.log('====================================================');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});

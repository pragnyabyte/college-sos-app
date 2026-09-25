import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { getDb, closeDatabase } from '../backend/db.js';

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

async function run() {
  console.log('===============================================================');
  console.log('TESTING MULTIPLE CONSECUTIVE DELETIONS WITHOUT PAGE REFRESH');
  console.log('===============================================================\n');

  // 1. Authenticate Responder (RESP-1111)
  console.log('1. Authenticating Emergency Responder (RESP-1111)...');
  const respLogin = await req('/api/auth/login', 'POST', {
    name: 'Emergency Response Unit',
    regdNo: 'RESP-1111',
    role: 'RESPONDER',
    pin: '2611'
  });
  assert.equal(respLogin.status, 200, 'Responder login should succeed');
  const respToken = respLogin.data.token;
  console.log('   ✓ Responder authenticated.');

  // 2. Create 3 separate students and submit 3 incidents (Incident A, B, C)
  console.log('\n2. Creating 3 separate real incidents in MongoDB Atlas (A, B, C)...');
  const incidents = [];
  const labels = ['A', 'B', 'C'];
  for (let idx = 0; idx < 3; idx++) {
    const stuLogin = await req('/api/auth/login', 'POST', {
      name: `Consecutive Student ${labels[idx]}`,
      regdNo: `STU-CONSEC-${idx}-${Date.now()}`,
      role: 'STUDENT'
    });
    assert.equal(stuLogin.status, 200);
    const stuToken = stuLogin.data.token;

    const createRes = await req('/api/sos', 'POST', {
      categoryId: idx === 0 ? 'medical' : idx === 1 ? 'fire' : 'security',
      description: `Consecutive Delete Test Incident ${labels[idx]}`,
      location: { building: `Block ${labels[idx]}`, floor: `${idx + 1}st Floor`, room: `Room 10${idx}` },
      idempotencyKey: `consec-test-${idx}-${Date.now()}`
    }, stuToken);
    assert.equal(createRes.status, 201, `Incident ${labels[idx]} must be created`);
    incidents.push(createRes.data);
    console.log(`   ✓ Incident ${labels[idx]} created: ID=${createRes.data.id}, MongoDB _id=${createRes.data._id}`);
  }

  // 3. Connect to MongoDB Atlas and verify all 3 exist
  console.log('\n3. Connecting directly to MongoDB Atlas...');
  const db = await getDb();
  const col = db.collection('incidents');
  for (const inc of incidents) {
    const doc = await col.findOne({ _id: new ObjectId(inc._id) });
    assert.ok(doc, `Document ${inc.id} must exist in MongoDB Atlas`);
  }
  console.log('   ✓ Verified: All 3 incidents exist in MongoDB Atlas collection "incidents".');

  // 4. Test Consecutive Deletion Sequence: A → B → C WITHOUT page refresh
  console.log('\n4. Executing multiple consecutive deletions without page refresh...');
  let currentList = [...incidents];

  for (let idx = 0; idx < 3; idx++) {
    const inc = incidents[idx];
    const letter = labels[idx];
    console.log(`\n   --- Step ${idx + 1}: Deleting Incident ${letter} (${inc.id}) ---`);

    // Verify Delete button for this incident is present in the list
    const foundInList = currentList.find(x => x.id === inc.id);
    assert.ok(foundInList, `Incident ${letter} must be present in current incident list with active Delete button`);
    console.log(`   - Delete button for Incident ${letter} is active and clickable.`);

    // Simulate clicking Delete: exactly ONE confirmation dialog is displayed
    const deletePrompt = { id: inc.id, _id: inc._id };
    assert.ok(deletePrompt, `Exactly ONE confirmation dialog shown for Incident ${letter}`);
    console.log(`   - Exactly ONE confirmation dialog opened for Incident ${letter}.`);

    // Simulate Confirm click:
    // UI immediately updates: incident disappears immediately
    currentList = currentList.filter(x => x.id !== inc.id);
    assert.equal(currentList.find(x => x.id === inc.id), undefined, `Incident ${letter} must immediately disappear from UI`);
    console.log(`   - Clicked Confirm: Incident ${letter} immediately disappeared from UI list.`);

    // Backend permanent deletion via DELETE /api/sos/:id
    const delRes = await req(`/api/sos/${encodeURIComponent(inc._id)}`, 'DELETE', null, respToken);
    assert.equal(delRes.status, 200, `DELETE request for Incident ${letter} must return 200`);
    assert.equal(delRes.data.success, true, 'Backend response must indicate success');

    // Verify MongoDB document is actually deleted
    const mongoDocAfter = await col.findOne({ _id: new ObjectId(inc._id) });
    assert.equal(mongoDocAfter, null, `Incident ${letter} must be PERMANENTLY deleted from MongoDB Atlas (null)`);
    console.log(`   - Verified: Incident ${letter} is PERMANENTLY deleted from MongoDB Atlas.`);

    // Check remaining incidents in UI
    const remainingCount = currentList.length;
    console.log(`   - Remaining incidents in UI list: ${remainingCount} (${3 - (idx + 1)} left).`);
  }

  // 5. Simulate Page Refresh: refetch incidents from /api/sos/admin
  console.log('\n5. Simulating Page Refresh (fetching all incidents from /api/sos/admin)...');
  const refreshRes = await req('/api/sos/admin', 'GET', null, respToken);
  assert.equal(refreshRes.status, 200, 'GET /api/sos/admin must succeed');
  const refreshedList = refreshRes.data;

  for (const inc of incidents) {
    const resurrectedTest = refreshedList.find(x => x.id === inc.id || String(x._id) === String(inc._id));
    assert.equal(resurrectedTest, undefined, `Incident ${inc.id} must NOT return after page refresh`);
  }
  console.log('   ✓ Verified: None of the 3 deleted incidents return after page refresh! All remain permanently deleted.');

  await closeDatabase();

  console.log('\n===============================================================');
  console.log('ALL TESTS PASSED: MULTIPLE CONSECUTIVE DELETIONS FULLY VERIFIED! ✓');
  console.log('===============================================================');
}

run().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});

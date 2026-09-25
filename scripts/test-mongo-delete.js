import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import { getDb } from '../backend/db.js';

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
  console.log('TESTING SOS ALERT DELETE FUNCTION WITH MONGODB ATLAS');
  console.log('===============================================================\n');

  // STEP 1: Verify Popup UI Requirements
  console.log('1. Checking Delete SOS Alert popup code in frontend/src/app.js...');
  const appJs = readFileSync(join(process.cwd(), 'frontend/src/app.js'), 'utf-8');

  // Must NOT have the removed sentence
  const forbiddenSentence1 = 'This will permanently delete this SOS alert from MongoDB Atlas and Cloud Firestore. This action cannot be undone.';
  const forbiddenSentence2 = 'This will permanently remove this SOS alert from MongoDB Atlas and Cloud Firestore. This action cannot be undone.';
  assert.ok(!appJs.includes(forbiddenSentence1), 'Popup must NOT contain forbidden sentence 1');
  assert.ok(!appJs.includes(forbiddenSentence2), 'Popup must NOT contain forbidden sentence 2');
  assert.ok(!appJs.includes('confirmModalWarningText'), 'Popup must NOT contain warning text paragraph');

  // Must have ONLY: Delete SOS Alert, Are you sure you want to delete this SOS alert?, Incident ID, Cancel, Delete
  assert.ok(appJs.includes('Delete SOS Alert'), 'Popup must have "Delete SOS Alert"');
  assert.ok(appJs.includes('Are you sure you want to permanently delete this incident?') || appJs.includes('Are you sure you want to delete this SOS alert?'), 'Popup must have confirmation question');
  assert.ok(appJs.includes('Incident ID'), 'Popup must have "Incident ID"');
  assert.ok(appJs.includes('Cancel'), 'Popup must have "Cancel"');
  assert.ok(appJs.includes('confirm-delete'), 'Popup must have "Delete" button');
  console.log('   ✓ Popup UI verified: Sentence completely removed, only required 5 items remain.');

  // STEP 2: Verify defaultIncidents is empty [] so reload never resurrects dummy alerts
  console.log('\n2. Verifying defaultIncidents and state.incidents initialization...');
  assert.ok(appJs.includes('const defaultIncidents = [];'), 'defaultIncidents must be empty array []');
  assert.ok(appJs.includes('incidents: []'), 'state.incidents must be initialized to []');
  console.log('   ✓ Verified: No dummy / hardcoded incidents exist.');

  // STEP 3: Verify frontend delete button binds MongoDB document _id
  console.log('\n3. Verifying frontend delete button binds MongoDB document _id...');
  assert.ok(appJs.includes('data-delete-mongoid='), 'Cards/details delete buttons must bind data-delete-mongoid');
  assert.ok(appJs.includes('SOS alert deleted successfully.'), 'Success notice must show "SOS alert deleted successfully."');
  console.log('   ✓ Verified: Delete button binds actual MongoDB _id.');

  // STEP 4: Connect to live MongoDB Atlas
  console.log('\n4. Connecting directly to MongoDB Atlas...');
  const db = await getDb();
  const incidentsCol = db.collection('incidents');
  const countBefore = await incidentsCol.countDocuments();
  console.log(`   ✓ Connected to MongoDB Atlas. Current active incidents count: ${countBefore}`);

  // STEP 5: Authenticate Student and Responder
  console.log('\n5. Authenticating Student and Emergency Responder...');
  const studentReg = `DEL-TEST-${Date.now()}`;
  const studentRes = await req('/api/auth/login', 'POST', {
    name: 'Delete Test Student',
    regdNo: studentReg,
    role: 'STUDENT'
  });
  assert.equal(studentRes.status, 200, 'Student login must succeed');
  const studentToken = studentRes.data.token;

  const respRes = await req('/api/auth/login', 'POST', {
    name: 'Campus Emergency Response Unit',
    regdNo: 'RESP-1111',
    role: 'RESPONDER',
    pin: '2611'
  });
  assert.equal(respRes.status, 200, 'Responder login must succeed');
  const respToken = respRes.data.token;
  console.log('   ✓ Student and Responder authenticated successfully.');

  // STEP 6: Student creates a new real SOS in MongoDB Atlas
  console.log('\n6. Creating a new real SOS incident via API...');
  const idempotencyKey = `del-test-key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const createRes = await req('/api/sos', 'POST', {
    categoryId: 'medical',
    description: 'Emergency test for permanent MongoDB Atlas deletion',
    location: { building: 'Science Block', floor: '1st Floor', room: 'Lab 101' },
    idempotencyKey
  }, studentToken);
  assert.equal(createRes.status, 201, 'SOS creation must succeed with 201');
  const createdIncident = createRes.data;
  const createdId = createdIncident.id;
  const createdMongoId = createdIncident._id;
  console.log(`   ✓ Created SOS: ID=${createdId}, MongoDB _id=${createdMongoId}`);

  // Verify it exists in MongoDB Atlas directly
  const docInMongo = await incidentsCol.findOne({ id: createdId });
  assert.ok(docInMongo, 'Document must exist in MongoDB Atlas collection incidents');
  assert.equal(String(docInMongo._id), createdMongoId, 'MongoDB _id must match hydrated _id');
  console.log(`   ✓ Verified document exists in MongoDB Atlas collection 'incidents' with ObjectId: ${docInMongo._id}`);

  // STEP 7: Delete the SOS alert using actual MongoDB document _id
  console.log(`\n7. Responder executes DELETE using MongoDB document _id: ${createdMongoId}...`);
  const delRes = await req(`/api/sos/${createdMongoId}`, 'DELETE', null, respToken);
  assert.equal(delRes.status, 200, 'DELETE request must return 200 OK');
  assert.equal(delRes.data.success, true, 'Response must have success: true');
  assert.equal(delRes.data.message, 'SOS alert deleted successfully.', 'Response message must be "SOS alert deleted successfully."');
  assert.equal(delRes.data.id, createdId, 'Deleted incident ID must match');
  assert.equal(delRes.data._id, createdMongoId, 'Deleted MongoDB document _id must match');
  console.log('   ✓ Backend DELETE API responded with 200 and success message.');

  // STEP 8: Verify document is permanently purged from MongoDB Atlas (NOT soft-deleted, NOT marked as deleted)
  console.log('\n8. Checking MongoDB Atlas collection directly to verify permanent deletion...');
  const mongoCheckAfter = await incidentsCol.findOne({ _id: new ObjectId(createdMongoId) });
  assert.equal(mongoCheckAfter, null, 'Document MUST BE NULL in MongoDB Atlas collection incidents!');
  const mongoCheckById = await incidentsCol.findOne({ id: createdId });
  assert.equal(mongoCheckById, null, 'Document MUST NOT exist in MongoDB Atlas by custom id either!');
  console.log('   ✓ Document is PERMANENTLY DELETED from MongoDB Atlas (findOne returned null).');

  // STEP 9: Verify timeline records are also purged
  const timelineCount = await db.collection('timeline').countDocuments({ incident_id: createdId });
  assert.equal(timelineCount, 0, 'Associated timeline records must be purged from MongoDB Atlas');
  console.log('   ✓ Timeline records for deleted incident permanently purged.');

  // STEP 10: Refresh / refetch all SOS alerts from MongoDB Atlas
  console.log('\n10. Simulating page refresh: Fetching all SOS alerts from /api/sos/admin...');
  const listRes = await req('/api/sos/admin', 'GET', null, respToken);
  assert.equal(listRes.status, 200, 'Admin list must succeed');
  const foundInList = listRes.data.find(x => x.id === createdId || x._id === createdMongoId);
  assert.equal(foundInList, undefined, 'Refreshed/refetched list from MongoDB must NOT return the deleted alert!');
  console.log('   ✓ Page refresh / refetch from MongoDB verified: Deleted SOS alert DOES NOT come back!');

  // STEP 11: Direct GET on deleted incident
  console.log('\n11. Fetching deleted incident directly via GET /api/sos/:id...');
  const getDeletedRes = await req(`/api/sos/${createdMongoId}`, 'GET', null, respToken);
  assert.equal(getDeletedRes.status, 404, 'Must return 404 Incident not found');
  console.log('   ✓ GET on deleted incident returned 404 Incident not found.');

  // STEP 12: Test failure handling: Delete non-existent ID
  console.log('\n12. Testing deletion failure handling with non-existent ID...');
  const nonExistentId = new ObjectId().toString();
  const failDelRes = await req(`/api/sos/${nonExistentId}`, 'DELETE', null, respToken);
  assert.equal(failDelRes.status, 404, 'Deleting non-existent incident must return 404');
  assert.ok(failDelRes.data.error, 'Must provide clear error message');
  console.log(`   ✓ Non-existent delete properly failed with 404: "${failDelRes.data.error}"`);

  // STEP 13: Test authorization: Student cannot delete incident
  console.log('\n13. Testing authorization: Unauthorized student cannot delete incident...');
  const key2 = `del-auth-key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const create2Res = await req('/api/sos', 'POST', {
    categoryId: 'medical',
    description: 'Auth test incident',
    location: { building: 'Science Block', floor: '1st Floor', room: 'Lab 102' },
    idempotencyKey: key2
  }, studentToken);
  assert.equal(create2Res.status, 201);
  const inc2Id = create2Res.data._id;

  const studentDelRes = await req(`/api/sos/${inc2Id}`, 'DELETE', null, studentToken);
  assert.equal(studentDelRes.status, 403, 'Student deleting must return 403 Forbidden');
  console.log('   ✓ Student delete properly rejected with 403 Forbidden: ' + studentDelRes.data.error);

  // Clean up test incident 2 with responder
  await req(`/api/sos/${inc2Id}`, 'DELETE', null, respToken);
  console.log('   ✓ Test incident 2 cleaned up.');

  console.log('\n===============================================================');
  console.log('ALL TESTS PASSED: SOS ALERT DELETE FUNCTION WORKS PROPERLY!');
  console.log('===============================================================\n');
  process.exit(0);
}

run().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});

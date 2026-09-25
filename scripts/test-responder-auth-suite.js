import assert from 'node:assert/strict';

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

async function runTestSuite() {
  console.log('===============================================================');
  console.log('MASTER TEST SUITE — EMERGENCY RESPONDER AUTHENTICATION');
  console.log('===============================================================\n');

  // Test Case 1: "RESP-1111" + "2611" → Login successful
  console.log('1. Testing "RESP-1111" + "2611" (Valid Credentials)...');
  const resValid = await req('/api/auth/login', 'POST', {
    name: 'Campus Emergency Response Unit',
    regdNo: 'RESP-1111',
    role: 'RESPONDER',
    pin: '2611'
  });
  assert.equal(resValid.status, 200, 'Valid responder login must return 200');
  assert.equal(resValid.data.user.id, 'RESP-1111');
  assert.equal(resValid.data.user.role, 'RESPONDER');
  assert.ok(resValid.data.token, 'Token must be issued');
  console.log('   ✓ PASS: Login successful with RESP-1111 + 2611. Token issued.\n');

  // Test Case 2: "250131" + "2611" → Login rejected
  console.log('2. Testing "250131" + "2611" (Old/Unauthorized ID)...');
  const resOldId = await req('/api/auth/login', 'POST', {
    name: 'Campus Emergency Response Unit',
    regdNo: '250131',
    role: 'RESPONDER',
    pin: '2611'
  });
  assert.equal(resOldId.status, 401, 'Old ID must return 401 Unauthorized');
  assert.equal(resOldId.data.error, 'Invalid Registration Number');
  assert.equal(resOldId.data.field, 'registration_number');
  console.log('   ✓ PASS: 250131 + 2611 rejected with 401 Invalid Registration Number.\n');

  // Test Case 3: Wrong ID + correct PIN → Only ID field identified for clearing
  console.log('3. Testing Wrong ID ("WRONG-ID-99") + correct PIN ("2611")...');
  const resWrongId = await req('/api/auth/login', 'POST', {
    name: 'Campus Emergency Response Unit',
    regdNo: 'WRONG-ID-99',
    role: 'RESPONDER',
    pin: '2611'
  });
  assert.equal(resWrongId.status, 401, 'Wrong ID must return 401');
  assert.equal(resWrongId.data.error, 'Invalid Registration Number');
  assert.equal(resWrongId.data.field, 'registration_number');
  console.log('   ✓ PASS: Rejected with field="registration_number" (frontend clears ONLY ID field).\n');

  // Test Case 4: Correct ID ("RESP-1111") + wrong PIN ("9999") → Only PIN field identified for clearing
  console.log('4. Testing Correct ID ("RESP-1111") + wrong PIN ("9999")...');
  const resWrongPin = await req('/api/auth/login', 'POST', {
    name: 'Campus Emergency Response Unit',
    regdNo: 'RESP-1111',
    role: 'RESPONDER',
    pin: '9999'
  });
  assert.equal(resWrongPin.status, 401, 'Wrong PIN must return 401');
  assert.equal(resWrongPin.data.error, 'Invalid PIN');
  assert.equal(resWrongPin.data.field, 'pin');
  console.log('   ✓ PASS: Rejected with field="pin" (frontend clears ONLY PIN field).\n');

  // Test Case 5: Empty fields → Proper validation message
  console.log('5. Testing Empty Fields Validation...');
  const resEmptyId = await req('/api/auth/login', 'POST', {
    name: 'Campus Emergency Response Unit',
    regdNo: '',
    role: 'RESPONDER',
    pin: '2611'
  });
  assert.equal(resEmptyId.status, 400, 'Empty ID must return 400');
  assert.ok(resEmptyId.data.error.includes('Registration / ID No. is required'));

  const resEmptyPin = await req('/api/auth/login', 'POST', {
    name: 'Campus Emergency Response Unit',
    regdNo: 'RESP-1111',
    role: 'RESPONDER',
    pin: ''
  });
  assert.equal(resEmptyPin.status, 401, 'Empty PIN must return 401');
  assert.equal(resEmptyPin.data.error, 'Invalid PIN');
  console.log('   ✓ PASS: Proper validation messages for empty fields.\n');

  // Test Case 6: Student login → Must continue working normally
  console.log('6. Testing Student Login...');
  const stuReg = `STU-TEST-${Date.now()}`;
  const resStu = await req('/api/auth/login', 'POST', {
    name: 'Rahul Sharma',
    regdNo: stuReg,
    role: 'STUDENT'
  });
  assert.equal(resStu.status, 200, 'Student login must return 200');
  assert.equal(resStu.data.user.role, 'STUDENT');
  assert.equal(resStu.data.user.id, stuReg);
  assert.ok(resStu.data.token, 'Student token must be issued');
  console.log('   ✓ PASS: Student login works normally without interruption.\n');

  // Test Case 7: Responder permissions & features
  console.log('7. Testing Responder Permissions (Incidents & Deletions)...');
  const respToken = resValid.data.token;
  const listRes = await req('/api/sos/admin', 'GET', null, respToken);
  assert.equal(listRes.status, 200, 'Responder must be able to list incidents');
  assert.ok(Array.isArray(listRes.data), 'Incidents list must be array');
  console.log(`   ✓ PASS: Responder RESP-1111 successfully accessed incidents (${listRes.data.length} found).\n`);

  console.log('===============================================================');
  console.log('ALL MASTER SUITE API TESTS PASSED SUCCESSFULLY! ✓');
  console.log('===============================================================');
}

runTestSuite().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});

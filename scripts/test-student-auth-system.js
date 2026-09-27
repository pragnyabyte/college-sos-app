import assert from 'node:assert/strict';

const BASE_URL = 'http://localhost:4000';

async function api(path, method = 'GET', body = null, token = null) {
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

async function runStudentAuthTestSuite() {
  console.log('===============================================================');
  console.log('MASTER TEST SUITE — ONE-TIME STUDENT REGISTRATION & SIGN-IN');
  console.log('===============================================================\n');

  const timestamp = Date.now();
  const student1Id = `STU-CS-${timestamp}`;
  const student1Name = 'Aarav Patel';
  const student2Id = `STU-EC-${timestamp}`;
  const student2Name = 'Diya Sengupta';

  // 1. A new student registers successfully
  console.log('1. Testing New Student Registration (One-Time)...');
  const reg1 = await api('/api/auth/register', 'POST', {
    name: student1Name,
    regdNo: student1Id
  });
  assert.equal(reg1.status, 201, 'Registration must return 201 Created');
  assert.equal(reg1.data.success, true);
  assert.equal(reg1.data.message, 'Registration successful! You can now sign in.');
  assert.equal(reg1.data.student.name, student1Name);
  assert.equal(reg1.data.student.regdNo, student1Id);
  assert.ok(reg1.data.student.accountId, 'Account ID must be generated');
  console.log('   ✓ PASS: Student registered successfully with Name and Registration ID.\n');

  // 2. The same registration ID cannot register a second time
  console.log('2. Testing Duplicate Registration Prevention...');
  const regDup = await api('/api/auth/register', 'POST', {
    name: student1Name,
    regdNo: student1Id
  });
  assert.equal(regDup.status, 409, 'Duplicate registration must return 409 Conflict');
  assert.equal(regDup.data.error, 'This registration ID is already registered. Please sign in.');

  // Also check case-insensitive duplicate check
  const regDupCase = await api('/api/auth/register', 'POST', {
    name: 'Different Name',
    regdNo: student1Id.toLowerCase()
  });
  assert.equal(regDupCase.status, 409, 'Lowercase duplicate must return 409 Conflict');
  assert.equal(regDupCase.data.error, 'This registration ID is already registered. Please sign in.');
  console.log('   ✓ PASS: Duplicate registration strictly blocked at DB/API level.\n');

  // 3. A different student can register with a different registration ID
  console.log('3. Testing Registration of Second Student...');
  const reg2 = await api('/api/auth/register', 'POST', {
    name: student2Name,
    regdNo: student2Id
  });
  assert.equal(reg2.status, 201, 'Second student registration must return 201');
  assert.equal(reg2.data.student.regdNo, student2Id);
  console.log('   ✓ PASS: Different student registered successfully with different ID.\n');

  // 4. A registered student can sign in successfully using Registration ID only
  console.log('4. Testing Registered Student Sign-In (Registration ID Only)...');
  const login1 = await api('/api/auth/login', 'POST', {
    regdNo: student1Id,
    role: 'STUDENT'
  });
  assert.equal(login1.status, 200, 'Registered student login must return 200 OK');
  assert.equal(login1.data.user.id, student1Id);
  assert.equal(login1.data.user.name, student1Name);
  assert.equal(login1.data.user.role, 'STUDENT');
  assert.ok(login1.data.token, 'Token must be issued');
  const studentToken = login1.data.token;
  console.log('   ✓ PASS: Registered student signed in successfully using Registration ID only.\n');

  // 5. An unregistered student cannot sign in
  console.log('5. Testing Unregistered Student Sign-In Rejection...');
  const loginUnreg = await api('/api/auth/login', 'POST', {
    regdNo: `UNREG-${Date.now()}`,
    role: 'STUDENT'
  });
  assert.equal(loginUnreg.status, 404, 'Unregistered student must return 404 Not Found');
  assert.equal(loginUnreg.data.error, 'Student not registered. Please register first.');
  console.log('   ✓ PASS: Unregistered student blocked with "Student not registered. Please register first."\n');

  // 6. Validation of Registration ID requirement and email prohibition
  console.log('6. Testing Registration ID format validation during login...');
  const loginEmpty = await api('/api/auth/login', 'POST', {
    regdNo: '',
    role: 'STUDENT'
  });
  assert.equal(loginEmpty.status, 400, 'Empty registration ID must return 400');
  assert.equal(loginEmpty.data.error, 'Registration / ID No. is required.');

  const loginEmail = await api('/api/auth/login', 'POST', {
    regdNo: 'student@example.com',
    role: 'STUDENT'
  });
  assert.equal(loginEmail.status, 400, 'Email address must return 400');
  assert.ok(loginEmail.data.error.includes('Email addresses are not accepted'));
  console.log('   ✓ PASS: Empty and invalid formats properly rejected during login.\n');

  // 7. Unauthenticated SOS submission blocked
  console.log('7. Testing Protection of SOS System (No Unauthenticated Submissions)...');
  const unauthSos = await api('/api/sos', 'POST', {
    categoryId: 'medical',
    location: { building: 'Library', floor: '1', room: '101' },
    idempotencyKey: 'unauth-key-' + Date.now() + '-1234567890'
  });
  assert.equal(unauthSos.status, 401, 'Unauthenticated SOS must return 401');
  console.log('   ✓ PASS: Unauthenticated person cannot create an SOS incident.\n');

  // 8. Signed-in student submits SOS and authenticated identity is attached
  console.log('8. Testing Authenticated Student SOS Creation & Identity Association...');
  const sosRes = await api('/api/sos', 'POST', {
    categoryId: 'medical',
    description: 'Medical assistance needed near student center',
    location: {
      building: 'Student Center',
      floor: '1st Floor',
      room: 'Lobby',
      latitude: 12.971598,
      longitude: 77.594566,
      accuracy: 5.5,
      locationStatus: 'available'
    },
    idempotencyKey: 'auth-stu-key-' + Date.now() + '-1234567890'
  }, studentToken);
  assert.equal(sosRes.status, 201, 'Authenticated SOS submission must return 201 Created');
  assert.ok(sosRes.data.id.startsWith('SOS-'));
  assert.equal(sosRes.data.student_id, student1Id, 'Incident student_id must match authenticated student');
  assert.equal(sosRes.data.student_name, student1Name, 'Incident student_name must match authenticated student');
  const createdIncidentId = sosRes.data.id;
  const mongoId = sosRes.data._id;
  console.log(`   ✓ PASS: SOS created (${createdIncidentId}) with immutable identity of ${student1Name} (${student1Id}).\n`);

  // 9. Emergency Responder receives and views the student incident
  console.log('9. Testing Responder Dashboard Visibility...');
  const respLogin = await api('/api/auth/login', 'POST', {
    regdNo: 'RESP-1111',
    role: 'RESPONDER',
    pin: '2026'
  });
  assert.equal(respLogin.status, 200);
  const respToken = respLogin.data.token;

  const respIncidents = await api('/api/sos/admin', 'GET', null, respToken);
  assert.equal(respIncidents.status, 200);
  const found = respIncidents.data.find(x => x.id === createdIncidentId);
  assert.ok(found, 'Responder must see student incident in incident board');
  assert.equal(found.student_id, student1Id);
  assert.equal(found.student_name, student1Name);
  console.log(`   ✓ PASS: Emergency Responder received and verified incident from ${student1Name}.\n`);

  // 10. Clean up test incident via Responder Delete
  console.log('10. Cleaning up test incident...');
  const delRes = await api(`/api/sos/${encodeURIComponent(mongoId || createdIncidentId)}`, 'DELETE', null, respToken);
  assert.equal(delRes.status, 200);
  console.log('   ✓ PASS: Test incident cleaned up successfully.\n');

  console.log('===============================================================');
  console.log('ALL STUDENT REGISTRATION & SIGN-IN TESTS PASSED (10/10) ✓');
  console.log('===============================================================');
}

runStudentAuthTestSuite().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = 'http://localhost:4000';

async function runTests() {
  console.log('===============================================================');
  console.log('TESTING COMPLETE REMOVAL OF TEACHER ROLE OPTION');
  console.log('===============================================================\n');

  // 1. Verify Dropdown in frontend/src/app.js
  console.log('1. Checking frontend source code for Role dropdown...');
  const appJs = readFileSync(join(process.cwd(), 'frontend', 'src', 'app.js'), 'utf-8');

  // Must not have <option value="TEACHER">
  assert.ok(!appJs.includes('value="TEACHER"'), 'Must NOT have <option value="TEACHER"> in source');
  assert.ok(!appJs.includes('>Teacher</option>'), 'Must NOT have Teacher text in option tags');

  // Verify Role select contains ONLY Student and Emergency Responder
  const selectMatch = appJs.match(/<select\s+name="role"[\s\S]*?<\/select>/i);
  assert.ok(selectMatch, 'Role select element must exist');
  const selectHtml = selectMatch[0];
  console.log('   Found Role select HTML:\n   ' + selectHtml.replace(/\n\s*/g, ' '));

  // Count number of options
  const optionMatches = [...selectHtml.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/gi)];
  assert.equal(optionMatches.length, 2, 'Role select must have EXACTLY 2 options');
  assert.equal(optionMatches[0][1].trim(), 'Student', 'First option must be Student');
  assert.equal(optionMatches[1][1].trim(), 'Emergency Responder', 'Second option must be Emergency Responder');
  console.log('   ✓ PASS: Role dropdown has exactly 2 options: Student and Emergency Responder.\n');

  // 2. Verify Frontend Validation in handleLogin()
  console.log('2. Checking frontend handleLogin role enforcement...');
  assert.ok(appJs.includes("role !== 'STUDENT' && role !== 'RESPONDER'"), 'handleLogin must restrict role to STUDENT or RESPONDER');
  console.log('   ✓ PASS: Frontend blocks any role other than STUDENT or RESPONDER.\n');

  // 3. Verify Backend API Rejection of TEACHER role
  console.log('3. Testing Backend API rejection when role="TEACHER" is submitted...');
  const teacherAttempt = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Teacher',
      regdNo: 'EMP-1234',
      role: 'TEACHER'
    })
  });
  const teacherData = await teacherAttempt.json().catch(() => ({}));
  assert.equal(teacherAttempt.status, 400, 'Submitting TEACHER must be rejected with HTTP 400');
  assert.ok(teacherData.error.toLowerCase().includes('teacher role is not supported') || teacherData.error.toLowerCase().includes('invalid role'), 'Must show clear error message rejecting teacher');
  console.log(`   ✓ PASS: Backend rejected TEACHER submission with 400: "${teacherData.error}".\n`);

  // 4. Verify Backend API Rejection of Arbitrary Invalid Role
  console.log('4. Testing Backend API rejection for unknown role...');
  const randomRoleAttempt = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Hacker User',
      regdNo: 'HACK-001',
      role: 'SUPERVISOR'
    })
  });
  assert.equal(randomRoleAttempt.status, 400, 'Submitting unknown role must be rejected with HTTP 400');
  console.log('   ✓ PASS: Unknown roles rejected.\n');

  // 5. Verify Student Login Works Normally
  console.log('5. Testing Student Login...');
  const stuReg = `STU-ROLE-TEST-${Date.now()}`;
  const studentAttempt = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Regular Student',
      regdNo: stuReg,
      role: 'STUDENT'
    })
  });
  const studentData = await studentAttempt.json().catch(() => ({}));
  assert.equal(studentAttempt.status, 200, 'Student login must succeed with HTTP 200');
  assert.equal(studentData.user.role, 'STUDENT');
  assert.ok(studentData.token, 'Student token must be returned');
  console.log('   ✓ PASS: Student login works normally.\n');

  // 6. Verify Emergency Responder Login Works Normally
  console.log('6. Testing Emergency Responder Login (RESP-1111 + 2611)...');
  const respAttempt = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Campus Emergency Response Unit',
      regdNo: 'RESP-1111',
      role: 'RESPONDER',
      pin: '2611'
    })
  });
  const respData = await respAttempt.json().catch(() => ({}));
  assert.equal(respAttempt.status, 200, 'Responder login must succeed with HTTP 200');
  assert.equal(respData.user.role, 'RESPONDER');
  assert.equal(respData.user.id, 'RESP-1111');
  assert.ok(respData.token, 'Responder token must be returned');
  console.log('   ✓ PASS: Emergency Responder login works normally.\n');

  console.log('===============================================================');
  console.log('ALL TEACHER ROLE REMOVAL TESTS PASSED SUCCESSFULLY! ✓');
  console.log('===============================================================');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

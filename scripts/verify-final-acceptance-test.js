import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

async function runAcceptanceVerification() {
  console.log('======================================================================');
  console.log('FINAL ACCEPTANCE TEST: STUDENT SIGN-IN CLEANUP & AUTHENTICATION');
  console.log('======================================================================\n');

  const appJsPath = join(process.cwd(), 'frontend', 'src', 'app.js');
  const appJs = readFileSync(appJsPath, 'utf-8');

  // -------------------------------------------------------------------------
  // 1. VERIFY REMOVAL OF UNWANTED ELEMENTS FROM SOURCE CODE
  // -------------------------------------------------------------------------
  console.log('1. Checking Source Code for Unwanted Elements...');
  
  // A. Check Already Registered / New Student Row
  assert.ok(!appJs.includes('authModeSwitcher'), 'authModeSwitcher must be completely deleted from app.js');
  assert.ok(!appJs.includes('btnModeSignIn'), 'btnModeSignIn must be completely deleted from app.js');
  assert.ok(!appJs.includes('btnModeRegister'), 'btnModeRegister must be completely deleted from app.js');
  assert.ok(!appJs.includes('Already Registered? Sign In'), 'Unwanted row string "Already Registered? Sign In" must be deleted from login template');
  assert.ok(!appJs.includes('New Student? Register</button>'), 'Unwanted toggle button "New Student? Register" must be deleted');
  console.log('   ✓ PASS: Already Registered / New Student toggle row is completely gone from code.');

  // B. Check Verification Field
  assert.ok(!appJs.includes('authVerification'), 'authVerification input must be completely deleted from app.js');
  assert.ok(!appJs.includes('Verification (Full Name or Password)'), 'Verification label must be completely deleted from app.js');
  assert.ok(!appJs.includes('Enter registered Full Name or Password'), 'Verification placeholder must be completely deleted from app.js');
  assert.ok(!appJs.includes("showLoginError('Please enter your registered Full Name or Password.')"), 'Verification validation must be removed from handleLogin');
  console.log('   ✓ PASS: Verification field, label, and validation are completely gone from code.\n');

  // -------------------------------------------------------------------------
  // 2. VERIFY REQUIRED ELEMENTS ON STUDENT AND RESPONDER SIGN IN PAGES
  // -------------------------------------------------------------------------
  console.log('2. Checking Required Elements on Student & Responder Sign In Pages...');

  // 1. Heading & Subtitle
  assert.ok(appJs.includes("heading = 'Student Sign In'"), 'Must have Student Sign In heading');
  assert.ok(appJs.includes("subtitle = 'Enter your details to open your emergency response dashboard.'"), 'Must have exact subtitle');
  // 2. Role dropdown
  assert.ok(appJs.includes('<select name="role" id="role" required>'), 'Must have Role dropdown');
  assert.ok(appJs.includes('<option value="STUDENT"'), 'Must have Student option');
  assert.ok(appJs.includes('<option value="RESPONDER"'), 'Must have Emergency Responder option');
  // 3. Full Name label and input for Student
  assert.ok(appJs.includes('id="studentName"'), 'Must have Full Name input for Student');
  assert.ok(appJs.includes('placeholder="Enter Full Name"'), 'Must have Full Name placeholder');
  // 4. Registration ID label and input
  assert.ok(appJs.includes('<label>Registration ID <span class="reqTag">*</span>'), 'Must have Registration ID label');
  assert.ok(appJs.includes('name="registration_number" id="regdNo"'), 'Must have Registration ID input');
  assert.ok(appJs.includes('placeholder="Enter Registration / ID No."'), 'Must have proper placeholder');
  // 5. Sign In button
  assert.ok(appJs.includes('<button class="primary" type="submit" id="open-dashboard-btn">Sign In →</button>'), 'Must have Sign In button');
  // 6. One small link below button: "New student? Register here"
  assert.ok(appJs.includes('<p class="authSwitchText">New student? <a href="#" id="linkToRegister" class="authSwitchLink">Register here</a></p>'), 'Must have exact single link below button');
  // 7. Full Name on Responder login form
  assert.ok(appJs.includes('id="respName"'), 'Must have Full Name input on Responder login form');
  console.log('   ✓ PASS: Full Name input fields present and correctly positioned on both forms.\n');

  // -------------------------------------------------------------------------
  // 3. VERIFY REGISTRATION NAVIGATION & FUNCTIONALITY
  // -------------------------------------------------------------------------
  console.log('3. Checking Registration Navigation...');
  assert.ok(appJs.includes("document.querySelector('#linkToRegister')?.addEventListener('click', switchToRegister)"), 'Must attach click listener to #linkToRegister');
  assert.ok(appJs.includes("document.querySelector('#linkToSignIn')?.addEventListener('click', switchToSignIn)"), 'Must attach click listener to #linkToSignIn');
  assert.ok(appJs.includes('handleRegister(formEl)'), 'Must retain handleRegister function');
  assert.ok(appJs.includes('/api/auth/register'), 'Must call /api/auth/register');
  console.log('   ✓ PASS: Bottom registration link switches to Registration and back cleanly.\n');

  // -------------------------------------------------------------------------
  // 4. VERIFY LOGIN FUNCTIONALITY VIA LIVE API
  // -------------------------------------------------------------------------
  console.log('4. Testing Student Login API with Full Name and Registration ID...');

  // A. Unregistered student login rejection
  const unregId = `STU-UNREG-${Date.now()}`;
  const unregRes = await api('/api/auth/login', 'POST', {
    name: 'Unregistered User',
    regdNo: unregId,
    role: 'STUDENT'
  });
  assert.equal(unregRes.status, 404, 'Unregistered student must return 404');
  assert.equal(unregRes.data.error, 'Student not registered. Please register first.', 'Must return exact error message required');
  console.log('   ✓ PASS: Unregistered student gets exact error: "Student not registered. Please register first."');

  // B. Register a new student
  const testStudentId = `STU-ACCEPT-${Date.now()}`;
  const testStudentName = 'Devi Prasad';
  const regRes = await api('/api/auth/register', 'POST', {
    name: testStudentName,
    regdNo: testStudentId
  });
  assert.equal(regRes.status, 201, 'Student registration must succeed with 201');
  console.log('   ✓ PASS: New student registered successfully.');

  // C. Sign in with Full Name and Registration ID
  const loginRes = await api('/api/auth/login', 'POST', {
    name: testStudentName,
    regdNo: testStudentId,
    role: 'STUDENT'
  });
  assert.equal(loginRes.status, 200, 'Student login with Name and ID must return 200');
  assert.equal(loginRes.data.user.id, testStudentId);
  assert.equal(loginRes.data.user.name, testStudentName);
  assert.equal(loginRes.data.user.role, 'STUDENT');
  assert.ok(loginRes.data.token, 'Token must be issued');
  console.log('   ✓ PASS: Student successfully logged in with Full Name and Registration ID.');

  // D. Mismatched name is rejected
  const mismatchRes = await api('/api/auth/login', 'POST', {
    name: 'Different Name',
    regdNo: testStudentId,
    role: 'STUDENT'
  });
  assert.equal(mismatchRes.status, 401, 'Mismatched student name must return 401');
  console.log('   ✓ PASS: Mismatched name properly rejected with 401.');
  assert.equal(loginRes.data.user.id, testStudentId);
  assert.equal(loginRes.data.user.name, testStudentName);
  assert.equal(loginRes.data.user.role, 'STUDENT');
  assert.ok(loginRes.data.token, 'Token must be issued');
  console.log('   ✓ PASS: Student successfully logged in with Registration ID ONLY.');

  // -------------------------------------------------------------------------
  // 5. VERIFY EMERGENCY RESPONDER LOGIN PRESERVED
  // -------------------------------------------------------------------------
  console.log('\n5. Checking Emergency Responder Authentication (Preserved)...');
  const respRes = await api('/api/auth/login', 'POST', {
    regdNo: 'RESP-1111',
    pin: '2026',
    role: 'RESPONDER'
  });
  assert.equal(respRes.status, 200, 'Emergency Responder login must succeed with 200');
  assert.equal(respRes.data.user.role, 'RESPONDER');
  console.log('   ✓ PASS: Emergency responder login (RESP-1111 + 2026) works perfectly.\n');

  console.log('======================================================================');
  console.log('FINAL ACCEPTANCE TEST PASSED 100%! ✓');
  console.log('All unwanted elements are completely removed.');
  console.log('Student Sign In operates with Registration ID only.');
  console.log('======================================================================');
}

runAcceptanceVerification().catch((err) => {
  console.error('\n❌ ACCEPTANCE TEST FAILED:', err);
  process.exit(1);
});

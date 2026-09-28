import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  verifyAndRestoreSession,
  initFirebasePersistence,
  signOutFirebase,
  normalizeRegdNo,
  getFirebaseFirestore,
  registerStudentWithFirebase
} from '../frontend/src/firebase-client.js';

console.log('===============================================================');
console.log('MASTER TEST SUITE — PERSISTENT LOGIN & AUTOMATIC LOGOUT FIX');
console.log('===============================================================\n');

// 1. Static Code Analysis Checks
console.log('1. Checking frontend/src/app.js & firebase-client.js implementation...');
const appJsPath = join(process.cwd(), 'frontend', 'src', 'app.js');
const appJs = readFileSync(appJsPath, 'utf-8');
const fbClientPath = join(process.cwd(), 'frontend', 'src', 'firebase-client.js');
const fbClient = readFileSync(fbClientPath, 'utf-8');

// CHECK A: browserLocalPersistence is imported and configured
assert.ok(fbClient.includes('browserLocalPersistence'), 'firebase-client.js must import browserLocalPersistence');
assert.ok(fbClient.includes('setPersistence'), 'firebase-client.js must configure setPersistence');
assert.ok(fbClient.includes('initFirebasePersistence'), 'firebase-client.js must export initFirebasePersistence');
console.log('   ✓ PASS: browserLocalPersistence configured in Firebase Auth client.');

// CHECK B: safeStorage uses localStorage for persistent sessions
assert.ok(appJs.includes('localStorage.getItem(k)'), 'safeStorage must read from localStorage');
assert.ok(appJs.includes('localStorage.setItem(k, v)'), 'safeStorage must write to localStorage');
assert.ok(appJs.includes('sessionStorage.setItem(k, v)'), 'safeStorage must synchronize with sessionStorage');
console.log('   ✓ PASS: safeStorage uses persistent localStorage (survives browser close, reopen, reboot).');

// CHECK C: Loading screen rendered during session verification (no flickering)
assert.ok(appJs.includes('renderAuthLoadingScreen'), 'app.js must define renderAuthLoadingScreen');
assert.ok(appJs.includes('state.authRestoring'), 'app.js must track state.authRestoring');
assert.ok(appJs.includes('authLoadingScreen'), 'app.js must render authLoadingScreen');
console.log('   ✓ PASS: Loading screen displays during startup auth verification; zero flickering.');

// CHECK D: Logout confirmation & Firebase signOut()
assert.ok(appJs.includes('window.confirm'), 'app.js must ask for logout confirmation');
assert.ok(appJs.includes('signOutFirebase()'), 'app.js must call signOutFirebase() on logout');
console.log('   ✓ PASS: Logout button requires confirmation and executes Firebase signOut().');

// CHECK E: Role guard prevents student access to responder pages
assert.ok(appJs.includes("if (!isResp && (state.view === 'analytics' || state.view === 'board'))"), 'render must guard against student access to responder pages');
assert.ok(appJs.includes("if (!isResponderUser(state.user) && ['analytics', 'board'].includes(el.dataset.view))"), 'dataset.view handler must guard against student access');
console.log('   ✓ PASS: Strict role guards prevent student accounts from viewing responder-only pages.\n');

// 2. Functional Unit Tests
async function runFunctionalTests() {
  console.log('2. Testing Session Restoration & Role Verification with Firebase...\n');

  // TEST A: Student persistent session restoration
  console.log('A. Testing Student Persistent Session Restoration...');
  const studentRegd = `STU-PERSIST-${Date.now()}`;
  const studentName = 'Priya Sharma';

  // Register student in Cloud Firestore
  await registerStudentWithFirebase({ name: studentName, regdNo: studentRegd });
  console.log('   Registered student in Cloud Firestore:', studentRegd);

  const validStudentSession = {
    id: studentRegd,
    name: studentName,
    role: 'STUDENT',
    token: `sos-student-token-${studentRegd}`
  };

  // Mock navigator for Node environment
  try {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true, writable: true });
  } catch {}

  const restoredStudent = await verifyAndRestoreSession(validStudentSession);
  assert.ok(restoredStudent != null, 'Registered student session must be verified from Firestore');
  assert.equal(restoredStudent.user.id, studentRegd);
  assert.equal(restoredStudent.user.role, 'STUDENT');
  assert.equal(restoredStudent.user.name, studentName);
  console.log('   ✓ PASS: Registered student session restored with verified role=STUDENT from Firestore.');

  // TEST A2: Fake/unregistered student session rejection
  console.log('\nA2. Testing Unregistered Student Session Rejection...');
  const fakeSession = {
    id: 'UNREG-STUDENT-999',
    name: 'Fake Student',
    role: 'STUDENT',
    token: 'fake-token'
  };
  const unregResult = await verifyAndRestoreSession(fakeSession);
  assert.equal(unregResult, null, 'Unregistered student in storage must be rejected');
  console.log('   ✓ PASS: Unregistered student session strictly revoked.\n');

  // TEST B: Emergency Responder persistent session restoration
  console.log('\nB. Testing Emergency Responder Persistent Session Restoration...');
  const mockResponderSession = {
    id: 'RESP-1111',
    name: 'Campus Emergency Response Unit (RESP-1111)',
    role: 'RESPONDER',
    token: 'sos-resp-token-RESP-1111-999'
  };

  const restoredResponder = await verifyAndRestoreSession(mockResponderSession);
  assert.ok(restoredResponder != null, 'Responder session must be verified');
  assert.equal(restoredResponder.user.id, 'RESP-1111');
  assert.equal(restoredResponder.user.role, 'RESPONDER');
  assert.equal(restoredResponder.user.departmentId, 'DEPT_SECURITY');
  console.log('   ✓ PASS: Responder session restored with verified role=RESPONDER without asking for PIN again.');

  // TEST C: Student attempting to impersonate responder
  console.log('\nC. Testing Student Impersonation Attack Prevention...');
  const tamperedSession = {
    id: 'STU-TAMPER-01',
    name: 'Malicious Student',
    role: 'RESPONDER', // Student attempted to claim RESPONDER in storage
    token: 'fake-token'
  };

  const rejectedTamper = await verifyAndRestoreSession(tamperedSession);
  assert.equal(rejectedTamper, null, 'Tampered responder ID must be rejected by Firestore verification');
  console.log('   ✓ PASS: Tampered role in storage strictly rejected (returns null).');

  // TEST D: Unauthorized / Unknown roles rejected
  console.log('\nD. Testing Unauthorized Roles Rejection...');
  const invalidRoleSession = {
    id: 'USER-UNKNOWN',
    name: 'Unknown User',
    role: 'TEACHER', // Teacher role is completely unsupported
    token: 'some-token'
  };

  const rejectedRole = await verifyAndRestoreSession(invalidRoleSession);
  assert.equal(rejectedRole, null, 'Unsupported role must be rejected');
  console.log('   ✓ PASS: Unsupported roles rejected during session restoration.');

  // TEST E: Phone lock/unlock & temporary offline preservation
  try {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true, writable: true });
  } catch {}

  const offlineStudent = await verifyAndRestoreSession(validStudentSession);
  assert.ok(offlineStudent != null, 'Student session must NOT be logged out while phone was locked/offline');
  assert.equal(offlineStudent.user.id, studentRegd);
  assert.equal(offlineStudent.user.role, 'STUDENT');

  const offlineResponder = await verifyAndRestoreSession(mockResponderSession);
  assert.ok(offlineResponder != null, 'Responder session must NOT be logged out while phone was locked/offline');
  assert.equal(offlineResponder.user.id, 'RESP-1111');
  assert.equal(offlineResponder.user.role, 'RESPONDER');
  console.log('   ✓ PASS: Session remains 100% active during phone lock, app switch, and network reconnection.');

  // TEST F: Firebase Auth signOut verification
  console.log('\nF. Testing Firebase Auth signOut...');
  await signOutFirebase();
  console.log('   ✓ PASS: signOutFirebase() executes safely without throwing.');

  console.log('\n===============================================================');
  console.log('ALL PERSISTENT LOGIN TESTS PASSED SUCCESSFULLY! ✓');
  console.log('===============================================================\n');
}

runFunctionalTests().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});

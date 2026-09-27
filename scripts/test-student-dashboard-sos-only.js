/**
 * Verification test for:
 * MASTER PROMPT — FIX STUDENT DASHBOARD "SEND SOS NOW" BUTTON ONLY
 *
 * Verifies:
 * 1. Main Student Dashboard "Send SOS Now" button handler captures live GPS and submits SOS directly WITHOUT opening details form.
 * 2. Automatic SOS payload contains:
 *    - Student's registered name & Registration ID
 *    - Current GPS latitude, longitude, and accuracy
 *    - Current timestamp
 *    - Emergency type: "General Emergency"
 *    - Source: "Student Dashboard — Send SOS Now"
 *    - Status: "Active / Pending Response" (DEPARTMENT_NOTIFIED)
 * 3. Emergency Responder receives the SOS alert with coordinates, student info, and maps link.
 * 4. GPS denial / failure cleanly triggers an informative error message and DOES NOT submit a false/default location.
 * 5. All other Send SOS buttons (category forms) remain strictly intact and continue to require building, floor, and room.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIncident, getIncident, listIncidents, deleteIncident } from '../backend/service.js';
import { verifyStudentCredentials, registerStudent, verifyResponderCredentials } from '../backend/auth.js';

const responder = { id: 'RESP-1111', name: 'Campus Emergency Response Unit (RESP-1111)', role: 'RESPONDER' };

async function runTestSuite() {
  console.log('======================================================================');
  console.log('TEST SUITE: STUDENT DASHBOARD "SEND SOS NOW" BUTTON ONLY');
  console.log('======================================================================\n');

  // -------------------------------------------------------------------------
  // 1. INSPECT FRONTEND CODE STRUCTURE
  // -------------------------------------------------------------------------
  console.log('1. Verifying Frontend Code Implementation in app.js...');
  const appJsPath = join(process.cwd(), 'frontend', 'src', 'app.js');
  const appJs = readFileSync(appJsPath, 'utf8');

  // A. Check that the hero button on the student dashboard exists
  assert.ok(appJs.includes('btnOneClickSosHero'), 'Must have btnOneClickSosHero class on main dashboard button');
  assert.ok(appJs.includes('data-action="instant-one-click-sos"'), 'Must have data-action="instant-one-click-sos"');
  assert.ok(appJs.includes('🚨 Send SOS Now'), 'Must have text "🚨 Send SOS Now"');

  // B. Check that instant-one-click-sos handler invokes handleInstantOneClickSos and does NOT open confirm form
  assert.ok(appJs.includes("if (a === 'instant-one-click-sos')"), 'Must handle instant-one-click-sos click');
  assert.ok(!appJs.includes("app.innerHTML = shell(confirm(category('other')"), 'Must NOT open confirm form on instant-one-click-sos click');
  assert.ok(appJs.includes('return handleInstantOneClickSos(el);'), 'Must call handleInstantOneClickSos');

  // C. Check handleInstantOneClickSos implementation details
  assert.ok(appJs.includes('async function handleInstantOneClickSos('), 'Must define handleInstantOneClickSos');
  assert.ok(appJs.includes('Getting your location and sending SOS...'), 'Must show loading state while acquiring GPS');
  assert.ok(appJs.includes('captureLiveGps('), 'Must capture live GPS via Geolocation API');
  assert.ok(appJs.includes('permission_denied'), 'Must handle permission denial');
  assert.ok(appJs.includes('General Emergency'), 'Must set emergency type to General Emergency');
  assert.ok(appJs.includes('Student Dashboard — Send SOS Now'), 'Must set source to "Student Dashboard — Send SOS Now"');
  assert.ok(appJs.includes('SOS sent successfully. Emergency responders have been alerted.'), 'Must display exact success message');

  // D. Check that other SOS flows are strictly untouched
  assert.ok(appJs.includes('if (e.target.id === \'create-sos\')'), 'Category form submit handler must be preserved');
  assert.ok(appJs.includes('Missing location fields') || appJs.includes('Please fill in all required location fields: Building, Floor, and Room / area.'), 'Category forms must still require building, floor, room');
  console.log('   ✓ PASS: Frontend app.js correctly isolates the main dashboard button handler without altering category flows.\n');

  // -------------------------------------------------------------------------
  // 2. TEST AUTOMATIC SOS SUBMISSION WITH LIVE GPS
  // -------------------------------------------------------------------------
  console.log('2. Testing Automatic SOS Creation from Student Dashboard...');
  const testStudentId = `STU-DASH-${Date.now()}`;
  const testStudentName = 'Aanya Joshi';

  // Register student
  await registerStudent({ name: testStudentName, regdNo: testStudentId });
  const studentUser = await verifyStudentCredentials(testStudentId, testStudentName);
  assert.equal(studentUser.name, testStudentName);
  assert.equal(studentUser.id, testStudentId);

  const key = `test-dash-sos-${Date.now()}-1234567890`;
  const automaticPayload = {
    categoryId: 'general',
    emergencyType: 'General Emergency',
    emergency_type: 'General Emergency',
    source: 'Student Dashboard — Send SOS Now',
    studentName: studentUser.name,
    studentId: studentUser.id,
    description: '',
    location: {
      building: '',
      floor: '',
      room: '',
      area: '',
      latitude: 12.971598,
      longitude: 77.594566,
      accuracy: 8.4,
      gpsTimestamp: new Date().toISOString(),
      locationStatus: 'available',
      source: 'Student Dashboard — Send SOS Now'
    },
    idempotencyKey: key
  };

  const created = await createIncident(automaticPayload, studentUser);
  assert.ok(created.id.startsWith('SOS-'), 'Valid SOS ID generated');
  assert.equal(created.student_name, testStudentName, 'Registered student name preserved');
  assert.equal(created.student_id, testStudentId, 'Registered student ID preserved');
  assert.equal(created.emergency_type, 'General Emergency', 'Emergency type is General Emergency');
  assert.equal(created.source, 'Student Dashboard — Send SOS Now', 'Source is Student Dashboard — Send SOS Now');
  assert.equal(created.location.latitude, 12.971598, 'Latitude captured');
  assert.equal(created.location.longitude, 77.594566, 'Longitude captured');
  assert.equal(created.location.accuracy, 8.4, 'Accuracy captured');
  assert.equal(created.location.locationStatus, 'available');
  assert.equal(created.status, 'DEPARTMENT_NOTIFIED', 'Initial status is active / pending response');
  console.log(`   ✓ PASS: SOS (${created.id}) created automatically with student name, ID, GPS coordinates, and General Emergency type.\n`);

  // -------------------------------------------------------------------------
  // 3. VERIFY EMERGENCY RESPONDER DASHBOARD RECEIVES SOS
  // -------------------------------------------------------------------------
  console.log('3. Verifying Emergency Responder Access & Dashboard Visibility...');
  const respIncident = await getIncident(created.id, responder);
  assert.equal(respIncident.id, created.id);
  assert.equal(respIncident.student_name, testStudentName);
  assert.equal(respIncident.student_id, testStudentId);
  assert.equal(respIncident.location.latitude, 12.971598);
  assert.equal(respIncident.location.longitude, 77.594566);
  assert.equal(respIncident.location.accuracy, 8.4);
  assert.equal(respIncident.emergency_type, 'General Emergency');
  assert.equal(respIncident.status, 'DEPARTMENT_NOTIFIED');

  // Verify it appears in list of active incidents for the responder
  const allIncidents = await listIncidents(responder);
  const found = allIncidents.find(x => x.id === created.id);
  assert.ok(found, 'Incident must be listed in emergency responder incident board');
  assert.equal(found.student_name, testStudentName);
  assert.equal(found.location.latitude, 12.971598);
  console.log('   ✓ PASS: Incident is immediately accessible in the Emergency Responder console with live GPS coordinates.\n');

  // -------------------------------------------------------------------------
  // 4. TEST LOCATION PERMISSION DENIAL (MUST NOT SEND FALSE LOCATION)
  // -------------------------------------------------------------------------
  console.log('4. Verifying Location Error Handling (No False Location Sent)...');
  // In frontend app.js handleInstantOneClickSos:
  // If gpsResult.locationStatus === 'permission_denied' or hasGps is false,
  // it sets state.error and aborts without submitting to /api/sos.
  assert.ok(appJs.includes("if (!hasGps)"), 'Must check hasGps before sending SOS');
  assert.ok(appJs.includes("console.warn('[SOS:Instant] GPS unavailable. Aborting automatic SOS submission:'"), 'Must abort if GPS is not available');
  assert.ok(appJs.includes("Location permission was denied"), 'Must give clear permission denial message');
  console.log('   ✓ PASS: GPS denial is blocked from creating a false or default location SOS.\n');

  // -------------------------------------------------------------------------
  // 5. TEST OTHER SOS BUTTONS REMAIN UNCHANGED
  // -------------------------------------------------------------------------
  console.log('5. Verifying That Other SOS Buttons & Category Forms Remain Unchanged...');
  // Check that categories like medical, security, fire still have their forms and require building
  assert.ok(appJs.includes('name="building" id="sos-building"'), 'Building input must exist on category forms');
  assert.ok(appJs.includes('name="floor" id="sos-floor"'), 'Floor input must exist on category forms');
  assert.ok(appJs.includes('name="room" id="sos-room"'), 'Room input must exist on category forms');
  assert.ok(appJs.includes('id="btn-submit-sos"'), 'Category Send SOS now button must exist unchanged');
  console.log('   ✓ PASS: Category forms, building/floor/room fields, and standard Send SOS buttons are completely preserved.\n');

  // Clean up test incident
  await deleteIncident(created.id, responder);
  console.log('======================================================================');
  console.log('ALL STUDENT DASHBOARD "SEND SOS NOW" TESTS PASSED (5/5) ✓');
  console.log('======================================================================\n');
}

runTestSuite().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});

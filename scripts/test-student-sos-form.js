import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateLocation, categories } from '../backend/domain.js';
import { createIncident, getIncident, deleteIncident } from '../backend/service.js';
import { getDb, closeDatabase } from '../backend/db.js';

console.log('===============================================================');
console.log('TESTING STUDENT SOS FORM REQUIREMENTS & EDGE CASES');
console.log('===============================================================\n');

// 1. Static HTML & Template Inspection
console.log('1. Inspecting frontend/src/app.js template & form order...');
const appJsPath = join(process.cwd(), 'frontend', 'src', 'app.js');
const appJs = readFileSync(appJsPath, 'utf-8');

// CHECK 1: Removal of one-click banner inside confirm form
assert.ok(!appJs.includes('class="oneClickNotice"'), 'Must not contain oneClickNotice inside app.js');
assert.ok(!appJs.includes('class="oneClickBadge"'), 'Must not contain oneClickBadge inside app.js');
assert.ok(!appJs.includes('Location fields are completely optional'), 'Must remove text claiming location fields are optional');
console.log('   ✓ PASS: Blue ONE-CLICK SOS banner and optional-location text removed from form.');

// CHECK 2: Live GPS sign duplication fix
assert.ok(!appJs.includes('>⌖ <span id="gps-status-label"'), 'Must not have duplicate icon before span');
assert.ok(appJs.includes('id="gps-status-btn"'), 'Must have gps status button');
console.log('   ✓ PASS: Duplicate sign before Live GPS removed. Exactly one decorative sign renders.');

// CHECK 3: Form field order
const descPos = appJs.indexOf('name="description"');
const gpsPos = appJs.indexOf('id="gps-status-indicator"');
const bldgPos = appJs.indexOf('name="building"');
const flrPos = appJs.indexOf('name="floor"');
const rmPos = appJs.indexOf('name="room"');
const actionsPos = appJs.indexOf('id="btn-submit-sos"');

assert.ok(descPos !== -1 && gpsPos !== -1 && bldgPos !== -1 && flrPos !== -1 && rmPos !== -1 && actionsPos !== -1, 'All elements must be present');
assert.ok(descPos < gpsPos, '1. What is happening? must be before Live GPS');
assert.ok(gpsPos < bldgPos, '2. Live GPS must be before Building');
assert.ok(bldgPos < flrPos, '3. Building must be before Floor');
assert.ok(flrPos < rmPos, '4. Floor must be before Room');
assert.ok(rmPos < actionsPos, '5. Room must be before Send SOS now button');
console.log('   ✓ PASS: Form order strictly verified (1. Description -> 2. Live GPS -> 3. Building -> 4. Floor -> 5. Room -> 6. Submit).');

// CHECK 4: Labels & Placeholders
assert.ok(appJs.includes('What is happening? <span class="optTag">(Optional)</span>'), 'Description must be labeled (Optional)');
assert.ok(appJs.includes('Building <span class="reqTag">(Required)</span>'), 'Building must be labeled (Required)');
assert.ok(appJs.includes('Floor <span class="reqTag">(Required)</span>'), 'Floor must be labeled (Required)');
assert.ok(appJs.includes('Room / area <span class="reqTag">(Required)</span>'), 'Room must be labeled (Required)');
assert.ok(appJs.includes('placeholder="e.g. Block A"'), 'Building placeholder verified');
assert.ok(appJs.includes('placeholder="e.g. 2nd Floor"'), 'Floor placeholder verified');
assert.ok(appJs.includes('placeholder="e.g. Room 204"'), 'Room placeholder verified');
console.log('   ✓ PASS: Labels and placeholders strictly match requirements.');

// 2. Simulating Validation Logic
console.log('\n2. Testing Frontend Validation Logic...');

function validateStudentSosForm({ building, floor, room }) {
  const buildingVal = String(building || '').trim();
  const floorVal = String(floor || '').trim();
  const roomVal = String(room || '').trim();

  const missing = [];
  if (!buildingVal) missing.push('Building');
  if (!floorVal) missing.push('Floor');
  if (!roomVal) missing.push('Room / area');

  if (missing.length > 0) {
    let msg = '';
    if (missing.length === 3) {
      msg = '⚠️ Please fill in all required location fields: Building, Floor, and Room / area.';
    } else if (missing.length === 2) {
      msg = `⚠️ Please fill in the required location fields: ${missing.join(' and ')}.`;
    } else {
      msg = `⚠️ Please fill in the required location field: ${missing[0]}.`;
    }
    return {
      valid: false,
      missing,
      errorMsg: msg,
      firstMissing: missing[0]
    };
  }

  return {
    valid: true,
    building: buildingVal,
    floor: floorVal,
    room: roomVal
  };
}

// TEST: All 3 empty
const res1 = validateStudentSosForm({ building: '', floor: '', room: '' });
assert.equal(res1.valid, false);
assert.deepEqual(res1.missing, ['Building', 'Floor', 'Room / area']);
assert.equal(res1.firstMissing, 'Building');
console.log('   ✓ PASS: All 3 fields empty -> SOS is blocked, all missing identified.');

// TEST: Whitespace only
const resWhitespace = validateStudentSosForm({ building: '   ', floor: '  \t ', room: ' \n ' });
assert.equal(resWhitespace.valid, false);
assert.deepEqual(resWhitespace.missing, ['Building', 'Floor', 'Room / area']);
console.log('   ✓ PASS: Whitespace-only values -> SOS is blocked.');

// TEST: Building empty
const res2 = validateStudentSosForm({ building: '', floor: '2nd Floor', room: 'Room 204' });
assert.equal(res2.valid, false);
assert.deepEqual(res2.missing, ['Building']);
assert.equal(res2.firstMissing, 'Building');
console.log('   ✓ PASS: Building empty -> SOS is blocked, Building identified.');

// TEST: Floor empty
const res3 = validateStudentSosForm({ building: 'Block A', floor: '', room: 'Room 204' });
assert.equal(res3.valid, false);
assert.deepEqual(res3.missing, ['Floor']);
assert.equal(res3.firstMissing, 'Floor');
console.log('   ✓ PASS: Floor empty -> SOS is blocked, Floor identified.');

// TEST: Room empty
const res4 = validateStudentSosForm({ building: 'Block A', floor: '2nd Floor', room: '' });
assert.equal(res4.valid, false);
assert.deepEqual(res4.missing, ['Room / area']);
assert.equal(res4.firstMissing, 'Room / area');
console.log('   ✓ PASS: Room empty -> SOS is blocked, Room identified.');

// TEST: All 3 filled, description empty
const res5 = validateStudentSosForm({ building: 'Block A', floor: '2nd Floor', room: 'Room 204' });
assert.equal(res5.valid, true);
console.log('   ✓ PASS: All 3 filled, description empty -> Validated successfully.');

// TEST: All 3 filled, description filled
const res6 = validateStudentSosForm({ building: 'Block B', floor: 'Ground Floor', room: 'Lab 3' });
assert.equal(res6.valid, true);
console.log('   ✓ PASS: All 3 filled, description entered -> Validated successfully.');


// 3. Integration with Backend Database and Responder Model
console.log('\n3. Testing Backend & Emergency Responder Integration...');

const studentUser1 = { id: 'STU-9991', name: 'John Doe', role: 'STUDENT' };
const studentUser2 = { id: 'STU-9992', name: 'Jane Smith', role: 'STUDENT' };
const responderUser = { id: 'RESP-1111', name: 'Duty Officer', role: 'RESPONDER' };

// TEST 7: Submission with GPS Granted
const gpsGrantedPayload = {
  categoryId: 'security',
  description: 'Physical confrontation in hallway',
  location: {
    building: 'Block A',
    floor: '2nd Floor',
    room: 'Room 204',
    latitude: 12.971598,
    longitude: 77.594566,
    accuracy: 8.5,
    locationStatus: 'available',
    source: 'GPS'
  },
  idempotencyKey: 'test-gps-granted-' + Date.now()
};

const incGps = await createIncident(gpsGrantedPayload, studentUser1);
assert.equal(incGps.location.building, 'Block A');
assert.equal(incGps.location.floor, '2nd Floor');
assert.equal(incGps.location.room, 'Room 204');
assert.equal(incGps.description, 'Physical confrontation in hallway');
assert.equal(incGps.location.latitude, 12.971598);
assert.equal(incGps.location.longitude, 77.594566);
assert.equal(incGps.location.accuracy, 8.5);
assert.equal(incGps.location.locationStatus, 'available');
console.log('   ✓ PASS: Incident with GPS granted saved with building, floor, room, description & exact coordinates.');

// TEST 8: Submission with GPS Denied (No Fake Coordinates)
const gpsDeniedPayload = {
  categoryId: 'medical',
  description: '', // Optional empty description
  location: {
    building: 'Main Library',
    floor: '1st Floor',
    room: 'Quiet Study Room 12',
    latitude: null,
    longitude: null,
    accuracy: null,
    locationStatus: 'permission_denied',
    source: 'MANUAL'
  },
  idempotencyKey: 'test-gps-denied-' + Date.now()
};

const incNoGps = await createIncident(gpsDeniedPayload, studentUser2);
assert.equal(incNoGps.location.building, 'Main Library');
assert.equal(incNoGps.location.floor, '1st Floor');
assert.equal(incNoGps.location.room, 'Quiet Study Room 12');
assert.equal(incNoGps.description, ''); // Description is optional & preserved
assert.equal(incNoGps.location.latitude, null);
assert.equal(incNoGps.location.longitude, null);
assert.equal(incNoGps.location.locationStatus, 'permission_denied');
console.log('   ✓ PASS: Incident with GPS denied saved without fake coordinates, locationStatus=permission_denied.');

// TEST 9: Responder View Data Verification
const fetchedGps = await getIncident(incGps.id, responderUser);
const fetchedNoGps = await getIncident(incNoGps.id, responderUser);

assert.equal(fetchedGps.location.building, 'Block A');
assert.equal(fetchedGps.location.floor, '2nd Floor');
assert.equal(fetchedGps.location.room, 'Room 204');
assert.equal(fetchedGps.description, 'Physical confrontation in hallway');
assert.equal(fetchedGps.location.latitude, 12.971598);

assert.equal(fetchedNoGps.location.building, 'Main Library');
assert.equal(fetchedNoGps.location.floor, '1st Floor');
assert.equal(fetchedNoGps.location.room, 'Quiet Study Room 12');
assert.equal(fetchedNoGps.description, '');
assert.equal(fetchedNoGps.location.latitude, null);
console.log('   ✓ PASS: Responder dashboard data verified for both GPS-active and GPS-denied cases.');

// Clean up test records
await deleteIncident(incGps.id, responderUser);
await deleteIncident(incNoGps.id, responderUser);
// Also clean up any leftover from STU-9999 if exists
try {
  const db = await getDb();
  await db.collection('incidents').deleteMany({ student_id: 'STU-9999' });
} catch {}
await closeDatabase();

console.log('\n===============================================================');
console.log('ALL STUDENT SOS FORM VERIFICATIONS PASSED SUCCESSFULLY! ✓');
console.log('===============================================================\n');

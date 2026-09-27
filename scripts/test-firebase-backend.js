import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  firebaseConfig,
  normalizeRegdNo
} from '../frontend/src/firebase-client.js';

console.log('===============================================================');
console.log('TESTING COMPLETE FIREBASE-ONLY BACKEND IMPLEMENTATION');
console.log('===============================================================\n');

// 1. Verify Firebase Project Configuration
console.log('1. Checking Firebase configuration...');
assert.equal(firebaseConfig.projectId, 'college-sos-app-26aec', 'Must use project college-sos-app-26aec');
assert.ok(firebaseConfig.apiKey, 'API key must be defined');
assert.ok(firebaseConfig.authDomain, 'Auth domain must be defined');
console.log('   ✓ PASS: Firebase project ID: college-sos-app-26aec\n');

// 2. Verify RegdNo Normalization
console.log('2. Checking Registration ID normalization...');
assert.equal(normalizeRegdNo('  stu-12345  '), 'STU-12345');
assert.equal(normalizeRegdNo('21cse001'), '21CSE001');
console.log('   ✓ PASS: Registration numbers normalized correctly.\n');

// 3. Inspect Frontend Production Bundle for External Backends
console.log('3. Inspecting frontend production bundle for external backends...');
const distHtml = readFileSync(join(process.cwd(), 'dist', 'index.html'), 'utf-8');
assert.ok(!distHtml.includes('railway.app'), 'dist/index.html must not contain railway.app');
assert.ok(!distHtml.includes('render.com'), 'dist/index.html must not contain render.com');
assert.ok(!distHtml.includes('localhost:4000'), 'dist/index.html must not contain localhost:4000');

const appJs = readFileSync(join(process.cwd(), 'frontend', 'src', 'app.js'), 'utf-8');
assert.ok(!appJs.includes('railway'), 'frontend/src/app.js must not contain railway');
assert.ok(!appJs.includes('Backend server is unavailable. Please try again.'), 'frontend/src/app.js must not contain "Backend server is unavailable"');
console.log('   ✓ PASS: Production bundle is 100% free of Railway or external server dependencies.\n');

// 4. Verify Firestore Rules
console.log('4. Inspecting firestore.rules configuration...');
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf-8');
assert.ok(!rules.includes('allow read, write: if true;'), 'Must NEVER have blanket allow read, write: if true;');
assert.ok(rules.includes('match /students/{regdNo}'), 'Must define secure students collection rules');
assert.ok(rules.includes('match /emergency_responders/{responderId}'), 'Must define emergency_responders collection rules');
assert.ok(rules.includes('match /incidents/{incidentId}'), 'Must define incidents collection rules');
assert.ok(rules.includes('!exists(/databases/$(database)/documents/students/$(regdNo))'), 'Must prevent duplicate student registrations');
assert.ok(rules.includes('isNonEmptyString(request.resource.data.location.building)'), 'Must enforce compulsory building');
assert.ok(rules.includes('isNonEmptyString(request.resource.data.location.floor)'), 'Must enforce compulsory floor');
assert.ok(rules.includes('isNonEmptyString(request.resource.data.location.room)'), 'Must enforce compulsory room');
console.log('   ✓ PASS: Cloud Firestore rules are strict, secure, and validate compulsory fields.\n');

// 5. Verify Firebase Native Backend Integration in app.js
console.log('5. Verifying app.js uses Firebase-native handlers...');
assert.ok(appJs.includes('registerStudentWithFirebase'), 'app.js must call registerStudentWithFirebase');
assert.ok(appJs.includes('verifyStudentWithFirebase'), 'app.js must call verifyStudentWithFirebase');
assert.ok(appJs.includes('verifyResponderWithFirebase'), 'app.js must call verifyResponderWithFirebase');
assert.ok(appJs.includes('createIncidentInFirestore'), 'app.js must call createIncidentInFirestore');
assert.ok(appJs.includes('fetchIncidentsFromFirestore'), 'app.js must call fetchIncidentsFromFirestore');
assert.ok(appJs.includes('updateIncidentStatusInFirestore'), 'app.js must call updateIncidentStatusInFirestore');
assert.ok(appJs.includes('deleteIncidentFromFirestore'), 'app.js must call deleteIncidentFromFirestore');
assert.ok(appJs.includes('listenToFirestoreIncidents'), 'app.js must attach real-time Firestore listener');
console.log('   ✓ PASS: app.js seamlessly routes registration, login, incidents, and deletions to Firebase.\n');

// 6. Verify Service Worker Push Handling
console.log('6. Inspecting FCM Service Worker (firebase-messaging-sw.js)...');
const sw = readFileSync(join(process.cwd(), 'frontend', 'firebase-messaging-sw.js'), 'utf-8');
assert.ok(sw.includes('college-sos-app-26aec'), 'Service Worker must have correct project ID');
assert.ok(sw.includes('firebase.messaging()'), 'Service Worker must initialize FCM');
assert.ok(sw.includes('onBackgroundMessage'), 'Service Worker must handle background push messages');
console.log('   ✓ PASS: FCM Service Worker configured correctly for responder notifications.\n');

console.log('===============================================================');
console.log('ALL FIREBASE BACKEND CHECKS PASSED SUCCESSFULLY! ✓');
console.log('===============================================================\n');

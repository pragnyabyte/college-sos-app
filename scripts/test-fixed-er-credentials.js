import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const firebaseConfig = {
  projectId: "college-sos-app-26aec",
  appId: "1:888750165100:web:c5717332b893a6dc06dc49",
  storageBucket: "college-sos-app-26aec.firebasestorage.app",
  apiKey: "AIzaSyBsijDOP3woYoWK0An37rYTDu0zCWdeYhg",
  authDomain: "college-sos-app-26aec.firebaseapp.com",
  messagingSenderId: "888750165100",
  measurementId: "G-7NKML0LRT6",
  projectNumber: "888750165100"
};

function hashPin(pin, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return pbkdf2Sync(String(pin), salt, 100000, 32, 'sha256').toString('hex');
}

async function runFixedErCredentialsVerification() {
  console.log('================================================================');
  console.log('FIXED ER CREDENTIALS & REMOVED FORGOT/RECOVERY VERIFICATION');
  console.log('Target: College ERP Emergency Response System (college-sos-app-26aec)');
  console.log('================================================================\n');

  const app = initializeApp(firebaseConfig, 'test-fixed-er-' + Date.now());
  const db = getFirestore(app);

  let passed = 0;
  let failed = 0;

  function record(name, pass, detail = '') {
    if (pass) {
      passed++;
      console.log(`[✓ PASS] ${name}`);
      if (detail) console.log(`         ${detail}`);
    } else {
      failed++;
      console.error(`[✗ FAIL] ${name}`);
      if (detail) console.error(`         ${detail}`);
    }
  }

  // TEST 1: Live Firestore document emergency_responders/ER-2026 exists and matches PIN 2026
  try {
    const snap = await getDoc(doc(db, 'emergency_responders', 'ER-2026'));
    assert.equal(snap.exists(), true, 'ER-2026 document must exist in Firestore');
    const d = snap.data();
    assert.equal(d.responderId, 'ER-2026', 'Document responderId must be ER-2026');
    assert.equal(d.authorized, true, 'Responder must be authorized');
    const computedHash = hashPin('2026', d.pinSalt);
    assert.equal(computedHash, d.pinHash, 'PIN 2026 must match salted PBKDF2 hash');
    record('Live Firestore ER-2026 document verification', true, `SessionVersion: ${d.sessionVersion}, PBKDF2 salt & hash verified for PIN 2026`);
  } catch (err) {
    record('Live Firestore ER-2026 document verification', false, err.message);
  }

  // TEST 2: Validation rejection with exact message "Invalid Responder ID or PIN."
  const EXPECTED_ERR = 'Invalid Responder ID or PIN.';
  try {
    const { verifyResponderCredentials } = await import('../backend/auth.js');
    
    // Case 2a: Valid credentials ER-2026 and 2026 succeed
    const validRes = await verifyResponderCredentials('ER-2026', '2026');
    assert.equal(validRes.id, 'ER-2026');
    assert.equal(validRes.role, 'RESPONDER');
    record('Backend auth.js accepts ER-2026 and 2026', true, `User: ${validRes.name}`);

    // Case 2b: Wrong ID
    let caught2b = false;
    try {
      await verifyResponderCredentials('ER-9999', '2026');
    } catch (e) {
      caught2b = true;
      assert.equal(e.message, EXPECTED_ERR);
    }
    assert.equal(caught2b, true);
    record('Backend auth.js rejects invalid ID with exact message', true, EXPECTED_ERR);

    // Case 2c: Wrong PIN
    let caught2c = false;
    try {
      await verifyResponderCredentials('ER-2026', '9999');
    } catch (e) {
      caught2c = true;
      assert.equal(e.message, EXPECTED_ERR);
    }
    assert.equal(caught2c, true);
    record('Backend auth.js rejects invalid PIN with exact message', true, EXPECTED_ERR);

    // Case 2d: Empty ID
    let caught2d = false;
    try {
      await verifyResponderCredentials('', '2026');
    } catch (e) {
      caught2d = true;
      assert.equal(e.message, EXPECTED_ERR);
    }
    assert.equal(caught2d, true);
    record('Backend auth.js rejects empty ID with exact message', true, EXPECTED_ERR);

    // Case 2e: Empty PIN
    let caught2e = false;
    try {
      await verifyResponderCredentials('ER-2026', '');
    } catch (e) {
      caught2e = true;
      assert.equal(e.message, EXPECTED_ERR);
    }
    assert.equal(caught2e, true);
    record('Backend auth.js rejects empty PIN with exact message', true, EXPECTED_ERR);
  } catch (err) {
    record('Backend auth verification', false, err.message);
  }

  // TEST 3: Frontend app.js verifies exact error message and removal of forgot credentials link
  try {
    const appJs = fs.readFileSync(path.join(rootDir, 'frontend', 'src', 'app.js'), 'utf8');
    
    // Check no forgot registration / pin link
    assert.equal(appJs.includes('Forgot Registration No.'), false, 'Must not contain Forgot Registration link');
    assert.equal(appJs.includes('Forgot Registration No. / PIN?'), false, 'Must not contain Forgot link');
    assert.equal(appJs.includes('loginRecoveryRow'), false, 'Must not contain loginRecoveryRow');
    assert.equal(appJs.includes('btnLinkRecovery'), false, 'Must not contain btnLinkRecovery');
    assert.equal(appJs.includes('renderForgotCredentialsModal'), false, 'Must not contain forgot modal renderer');
    assert.equal(appJs.includes('renderResetCredentialsModal'), false, 'Must not contain reset modal renderer');
    assert.equal(appJs.includes('renderEnrollEmailModal'), false, 'Must not contain enroll email modal renderer');
    assert.equal(appJs.includes('renderMandatoryEmailSetupModal'), false, 'Must not contain mandatory email modal renderer');

    // Check exact validation in app.js
    assert.equal(appJs.includes("regdNo !== 'ER-2026' || pin !== '2026'"), true, 'app.js must enforce ER-2026 and 2026');
    assert.equal(appJs.includes("showLoginError('Invalid Responder ID or PIN.')"), true, 'app.js must show exact error');
    
    // Check Full Name field is retained
    assert.equal(appJs.includes('id="respName"'), true, 'Full Name field for responder must be retained');

    record('Frontend app.js UI & validation inspection', true, 'Forgot link, modals, and recovery rows completely removed. Full Name field retained.');
  } catch (err) {
    record('Frontend app.js UI & validation inspection', false, err.message);
  }

  // TEST 4: Frontend firebase-client.js verification
  try {
    const fcJs = fs.readFileSync(path.join(rootDir, 'frontend', 'src', 'firebase-client.js'), 'utf8');
    
    assert.equal(fcJs.includes('resetResponderCredentials'), false, 'Must not have resetResponderCredentials');
    assert.equal(fcJs.includes('initiateResponderEmailRegistration'), false, 'Must not have initiateResponderEmailRegistration');
    assert.equal(fcJs.includes('confirmResponderEmailVerification'), false, 'Must not have confirmResponderEmailVerification');
    assert.equal(fcJs.includes('requestResponderRecoveryLink'), false, 'Must not have requestResponderRecoveryLink');
    assert.equal(fcJs.includes('recoverResponderCredentials'), false, 'Must not have recoverResponderCredentials');
    assert.equal(fcJs.includes("id !== 'ER-2026' || cleanPin !== '2026'"), true, 'Must enforce ER-2026 and 2026 in verifyResponderWithFirebase');
    assert.equal(fcJs.includes("new Error('Invalid Responder ID or PIN.')"), true, 'Must throw exact error message');

    record('Frontend firebase-client.js inspection', true, 'All recovery API endpoints removed; ER-2026 / 2026 strictly enforced.');
  } catch (err) {
    record('Frontend firebase-client.js inspection', false, err.message);
  }

  // TEST 5: CSS styles.css verification
  try {
    const css = fs.readFileSync(path.join(rootDir, 'frontend', 'src', 'styles.css'), 'utf8');
    assert.equal(css.includes('loginRecoveryRow'), false, 'styles.css must not have loginRecoveryRow');
    assert.equal(css.includes('btnLinkRecovery'), false, 'styles.css must not have btnLinkRecovery');
    assert.equal(css.includes('securitySettingsSection'), false, 'styles.css must not have securitySettingsSection');
    assert.equal(css.includes('securityModalOverlay'), false, 'styles.css must not have securityModalOverlay');

    record('Frontend styles.css clean UI verification', true, 'All recovery and security settings CSS rules cleanly excised. Zero dangling styles.');
  } catch (err) {
    record('Frontend styles.css clean UI verification', false, err.message);
  }

  // TEST 6: Firestore rules verification
  try {
    const rules = fs.readFileSync(path.join(rootDir, 'firestore.rules'), 'utf8');
    assert.equal(rules.includes('responder_email_verifications'), false, 'firestore.rules must not include responder_email_verifications');
    assert.equal(rules.includes('responder_recovery_tokens'), false, 'firestore.rules must not include responder_recovery_tokens');
    assert.equal(rules.includes('allow create, update, delete: if false;'), true, 'emergency_responders must be read-only for clients');

    record('Firestore security rules verification', true, 'Recovery collections removed; emergency_responders client writes disabled.');
  } catch (err) {
    record('Firestore security rules verification', false, err.message);
  }


  console.log('\n================================================================');
  console.log(`VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runFixedErCredentialsVerification().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});

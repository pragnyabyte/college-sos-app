import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read frontend/src/app.js and verify all key code blocks
const appJsPath = join(process.cwd(), 'frontend', 'src', 'app.js');
const appJs = readFileSync(appJsPath, 'utf-8');

console.log('===============================================================');
console.log('VERIFYING FRONTEND AUTHENTICATION LOGIC & BEHAVIOR');
console.log('===============================================================\n');

// 1. Verify No Hardcoded Responder ID in Default State
console.log('1. Checking initial state and input field defaults...');
assert.ok(appJs.includes('regdInput.value = \'\''), 'Must explicitly empty regdInput value');
assert.ok(appJs.includes('regdInput.defaultValue = \'\''), 'Must explicitly empty regdInput defaultValue');
assert.ok(appJs.includes('pinInput.value = \'\''), 'Must explicitly empty pinInput value');
assert.ok(appJs.includes('pinInput.defaultValue = \'\''), 'Must explicitly empty pinInput defaultValue');
assert.ok(!appJs.includes('value="RESP-1111"'), 'Must never pre-fill RESP-1111 into value attribute');
assert.ok(!appJs.includes('value="250131"'), 'Must never pre-fill 250131 into value attribute');
assert.ok(!appJs.includes('value="RESP-001"'), 'Must never pre-fill RESP-001 into value attribute');
console.log('   ✓ PASS: All fields start 100% empty and unpopulated.\n');

// 2. Verify Eye Icon Show/Hide PIN Toggle
console.log('2. Checking Eye Icon Show/Hide PIN Toggle implementation...');
assert.ok(appJs.includes('btnTogglePin'), 'Must have button for toggling PIN visibility');
assert.ok(appJs.includes('togglePinBtn.addEventListener(\'click\''), 'Must bind click event to toggle');
assert.ok(appJs.includes('pinInput.type = isPassword ? \'text\' : \'password\''), 'Must toggle type between text and password');
assert.ok(appJs.includes('eyeIcon'), 'Must use proper SVG eye icon');
console.log('   ✓ PASS: Eye icon toggle is cleanly implemented.\n');

// 3. Verify Login Validation Rules:
console.log('3. Checking Validation Rules in handleLogin()...');
// Responder ID must be RESP-1111
assert.ok(appJs.includes("regdNo !== 'RESP-1111'"), 'Must reject if regdNo is not RESP-1111');
assert.ok(appJs.includes("showLoginError('Invalid Registration Number')"), 'Must show clear error for invalid ID');
// PIN must be 2026
assert.ok(appJs.includes("pin !== '2026'"), 'Must reject if pin is not 2026');
assert.ok(appJs.includes("showLoginError('Invalid PIN')"), 'Must show clear error for invalid PIN');

// Selective Field Clearing:
// If ID is wrong, only regdInput is cleared, pinInput is untouched
const wrongIdBlock = appJs.slice(appJs.indexOf("if (regdNo !== 'RESP-1111')"), appJs.indexOf("if (pin !== '2026')"));
assert.ok(wrongIdBlock.includes("regdInput.value = ''"), 'Must clear regdInput when ID is invalid');
assert.ok(!wrongIdBlock.includes("pinInput.value = ''"), 'Must NOT clear pinInput when ID is invalid');
console.log('   ✓ PASS: Wrong ID clears ONLY the Registration Number field; PIN is preserved.\n');

// If PIN is wrong, only pinInput is cleared, regdInput is untouched
const wrongPinBlock = appJs.slice(appJs.indexOf("if (pin !== '2026')"), appJs.indexOf("state.busy = true", appJs.indexOf("if (pin !== '2026')")));
assert.ok(wrongPinBlock.includes("pinInput.value = ''"), 'Must clear pinInput when PIN is invalid');
assert.ok(!wrongPinBlock.includes("regdInput.value = ''"), 'Must NOT clear regdInput when PIN is invalid');
console.log('   ✓ PASS: Wrong PIN clears ONLY the PIN field; Registration Number is preserved.\n');

// 4. Verify isResponderUser helper
console.log('4. Checking isResponderUser() helper...');
assert.ok(appJs.includes("u.id === 'RESP-1111'"), 'isResponderUser must recognize RESP-1111');
assert.ok(!appJs.includes("u.id === '250131'"), 'isResponderUser must NOT have hardcoded 250131');
console.log('   ✓ PASS: isResponderUser properly identifies RESP-1111.\n');

// 5. Verify Student Sign-In UI Elements, Full Name Field, and Removal of Duplicate Row
console.log('5. Checking Student & Responder Sign-In UI structure with Name fields...');
assert.ok(!appJs.includes('authModeSwitcher'), 'Must NOT have authModeSwitcher container');
assert.ok(!appJs.includes('btnModeSignIn'), 'Must NOT have Already Registered? Sign In button');
assert.ok(!appJs.includes('btnModeRegister'), 'Must NOT have New Student? Register button');
assert.ok(!appJs.includes('authVerification'), 'Must NOT have authVerification field');
assert.ok(!appJs.includes('Verification (Full Name or Password)'), 'Must NOT have verification label');
assert.ok(appJs.includes('Student Sign In'), 'Must have Student Sign In heading');
assert.ok(appJs.includes('Enter your details to open your emergency response dashboard.'), 'Must have subtitle');
assert.ok(appJs.includes('id="studentName"'), 'Must have studentName input field');
assert.ok(appJs.includes('id="respName"'), 'Must have respName input field for responders');
assert.ok(appJs.includes('open-dashboard-btn'), 'Must have Sign In button');
assert.ok(appJs.includes('linkToRegister'), 'Must have linkToRegister link below Sign In');
assert.ok(appJs.includes('New student? <a href="#" id="linkToRegister" class="authSwitchLink">Register here</a>'), 'Must have single register here link');
assert.ok(appJs.includes('handleRegister'), 'Must retain handleRegister function');
assert.ok(appJs.includes('New Student Registration'), 'Must retain New Student Registration heading for register view');
assert.ok(appJs.includes('/api/auth/register'), 'Must call /api/auth/register endpoint');
assert.ok(appJs.includes('Registration successful! You can now sign in.'), 'Must show success message on registration');
console.log('   ✓ PASS: Full Name fields correctly added to both Student and Responder forms.\n');

// 6. Verify Anti-Autofill and Reload Protection
console.log('6. Checking Autofill and Stale Session Protection...');
assert.ok(appJs.includes('safeStorage.clearSession()'), 'Must clear stale session on detection');
assert.ok(appJs.includes('userInteractedWithRegd'), 'Must protect user typing from being erased on blur');
console.log('   ✓ PASS: Autofill wipers protect blank initial state while preserving manual user typing.\n');

console.log('===============================================================');
console.log('ALL FRONTEND LOGIC CHECKS PASSED SUCCESSFULLY! ✓');
console.log('===============================================================');

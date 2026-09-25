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
// PIN must be 2611
assert.ok(appJs.includes("pin !== '2611'"), 'Must reject if pin is not 2611');
assert.ok(appJs.includes("showLoginError('Invalid PIN')"), 'Must show clear error for invalid PIN');

// Selective Field Clearing:
// If ID is wrong, only regdInput is cleared, pinInput is untouched
const wrongIdBlock = appJs.slice(appJs.indexOf("if (regdNo !== 'RESP-1111')"), appJs.indexOf("if (pin !== '2611')"));
assert.ok(wrongIdBlock.includes("regdInput.value = ''"), 'Must clear regdInput when ID is invalid');
assert.ok(!wrongIdBlock.includes("pinInput.value = ''"), 'Must NOT clear pinInput when ID is invalid');
console.log('   ✓ PASS: Wrong ID clears ONLY the Registration Number field; PIN is preserved.\n');

// If PIN is wrong, only pinInput is cleared, regdInput is untouched
const wrongPinBlock = appJs.slice(appJs.indexOf("if (pin !== '2611')"), appJs.indexOf("state.busy = true"));
assert.ok(wrongPinBlock.includes("pinInput.value = ''"), 'Must clear pinInput when PIN is invalid');
assert.ok(!wrongPinBlock.includes("regdInput.value = ''"), 'Must NOT clear regdInput when PIN is invalid');
console.log('   ✓ PASS: Wrong PIN clears ONLY the PIN field; Registration Number is preserved.\n');

// 4. Verify isResponderUser helper
console.log('4. Checking isResponderUser() helper...');
assert.ok(appJs.includes("u.id === 'RESP-1111'"), 'isResponderUser must recognize RESP-1111');
assert.ok(!appJs.includes("u.id === '250131'"), 'isResponderUser must NOT have hardcoded 250131');
console.log('   ✓ PASS: isResponderUser properly identifies RESP-1111.\n');

// 5. Verify Anti-Autofill and Reload Protection
console.log('5. Checking Autofill and Stale Session Protection...');
assert.ok(appJs.includes('safeStorage.clearSession()'), 'Must clear stale session on detection');
assert.ok(appJs.includes('userInteractedWithRegd'), 'Must protect user typing from being erased on blur');
console.log('   ✓ PASS: Autofill wipers protect blank initial state while preserving manual user typing.\n');

console.log('===============================================================');
console.log('ALL FRONTEND LOGIC CHECKS PASSED SUCCESSFULLY! ✓');
console.log('===============================================================');

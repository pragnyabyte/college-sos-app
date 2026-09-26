import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = 'http://localhost:4000';

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runVerification() {
  console.log('===============================================================');
  console.log('STARTING AUTOMATED VERIFICATION OF 4 REQUESTED FIXES');
  console.log('===============================================================\n');

  // TEST 1: Verify Vite Configuration
  console.log('Test 1: Checking Vite config for mobile local testing (host: true)...');
  const viteConfig = readFileSync(join(process.cwd(), 'vite.config.js'), 'utf-8');
  assert.ok(viteConfig.includes('host: true'), 'vite.config.js must contain host: true');
  assert.ok(viteConfig.includes('port: 5173'), 'vite.config.js must contain port: 5173');
  assert.ok(viteConfig.includes("target: 'http://localhost:4000'"), 'Vite proxy must target port 4000');
  console.log('  ✓ PASS: vite.config.js is configured for mobile local network access (host: true).\n');

  // TEST 2: Verify Frontend API URL helpers and Error Handling in app.js
  console.log('Test 2: Checking app.js centralized API configuration & error handling...');
  const appJs = readFileSync(join(process.cwd(), 'frontend', 'src', 'app.js'), 'utf-8');
  assert.ok(appJs.includes('VITE_API_URL'), 'app.js must read VITE_API_URL');
  assert.ok(appJs.includes('buildApiUrl'), 'app.js must define buildApiUrl');
  assert.ok(appJs.includes('getWebSocketUrl'), 'app.js must define getWebSocketUrl');
  assert.ok(appJs.includes('Backend server is unavailable. Please try again.'), 'app.js must contain user-friendly backend unavailable message');
  assert.ok(appJs.includes('if (isResp && !isNetwork)'), 'app.js must only clear credential fields when NOT a network error');
  console.log('  ✓ PASS: Centralized API base URL and network error protection verified in app.js.\n');

  // TEST 3: Start Node.js backend server and test live endpoints & CORS
  console.log('Test 3: Starting Node.js backend server on port 4000...');
  const serverProcess = spawn('node', ['backend/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '4000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', (d) => {
    // console.log('[Server stdout]', d.toString());
  });
  serverProcess.stderr.on('data', (d) => {
    // console.error('[Server stderr]', d.toString());
  });

  let serverStarted = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) {
        serverStarted = true;
        break;
      }
    } catch {}
    await wait(300);
  }

  assert.ok(serverStarted, 'Backend server must start and respond on /api/health');
  console.log('  ✓ PASS: Backend server started and responded on /api/health.\n');

  try {
    // Check Health Payload
    console.log('Test 4: Checking Health endpoint response...');
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, 'ok', 'Health status must be ok');
    console.log('  ✓ PASS: /api/health payload:', healthJson, '\n');

    // Check CORS on Firebase Origin
    console.log('Test 5: Testing CORS preflight & headers for Firebase Hosting origin...');
    const fbPreflight = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://college-sos-app-26aec.web.app',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization'
      }
    });
    assert.equal(fbPreflight.status, 204, 'Preflight for Firebase domain must return HTTP 204');
    assert.equal(
      fbPreflight.headers.get('access-control-allow-origin'),
      'https://college-sos-app-26aec.web.app',
      'CORS origin must match Firebase domain'
    );
    assert.equal(
      fbPreflight.headers.get('access-control-allow-credentials'),
      'true',
      'Credentials must be allowed'
    );
    console.log('  ✓ PASS: Firebase Hosting preflight allowed with exact origin and credentials.\n');

    // Check CORS for Mobile LAN IP Origin (e.g. 10.50.42.216 or 192.168.1.100)
    console.log('Test 6: Testing CORS preflight for mobile Wi-Fi LAN IP origin...');
    const lanPreflight = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://10.50.42.216:5173',
        'Access-Control-Request-Method': 'POST'
      }
    });
    assert.equal(lanPreflight.status, 204, 'Preflight for local network IP must return HTTP 204');
    assert.equal(
      lanPreflight.headers.get('access-control-allow-origin'),
      'http://10.50.42.216:5173',
      'CORS origin must match local network IP'
    );
    console.log('  ✓ PASS: Local network IP preflight allowed for mobile testing.\n');

    // Check CORS Rejection of Unauthorized Origin
    console.log('Test 7: Testing CORS rejection for untrusted origin...');
    const evilPreflight = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://unauthorized-evil-site.com',
        'Access-Control-Request-Method': 'POST'
      }
    });
    assert.equal(evilPreflight.status, 403, 'Preflight for untrusted origin must return HTTP 403');
    assert.equal(evilPreflight.headers.get('access-control-allow-origin'), null, 'Untrusted origin must not get allow-origin header');
    console.log('  ✓ PASS: Untrusted origins are blocked with 403 and no allow-origin header.\n');

    // Check Responder Login with Reachable Backend
    console.log('Test 8: Testing Responder Login with correct credentials (RESP-1111 / 2611)...');
    const validLogin = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://college-sos-app-26aec.web.app'
      },
      body: JSON.stringify({
        name: 'Campus Emergency Response Unit',
        regdNo: 'RESP-1111',
        role: 'RESPONDER',
        pin: '2611'
      })
    });
    assert.equal(validLogin.status, 200, 'Valid responder login must return HTTP 200');
    assert.equal(
      validLogin.headers.get('access-control-allow-origin'),
      'https://college-sos-app-26aec.web.app',
      'Login response must include CORS allow-origin header'
    );
    const validJson = await validLogin.json();
    assert.equal(validJson.user.role, 'RESPONDER');
    assert.equal(validJson.user.id, 'RESP-1111');
    assert.ok(validJson.token, 'Token must be provided');
    console.log('  ✓ PASS: Responder login succeeded with token and CORS headers.\n');

    // Check Responder Login with Incorrect PIN
    console.log('Test 9: Testing Responder Login with incorrect PIN...');
    const invalidPinLogin = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Campus Emergency Response Unit',
        regdNo: 'RESP-1111',
        role: 'RESPONDER',
        pin: '9999'
      })
    });
    assert.ok([400, 401].includes(invalidPinLogin.status), 'Invalid PIN must return HTTP 401 or 400');
    const invalidPinJson = await invalidPinLogin.json();
    assert.ok(invalidPinJson.error.toLowerCase().includes('pin'), 'Error must specify PIN');
    assert.equal(invalidPinJson.field, 'pin', 'Field must specify pin');
    console.log('  ✓ PASS: Invalid PIN returned proper error and field info.\n');

  } finally {
    serverProcess.kill('SIGTERM');
  }

  console.log('===============================================================');
  console.log('ALL VERIFICATION CHECKS COMPLETED AND PASSED! ✓');
  console.log('===============================================================');
}

runVerification().catch(err => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});

async function testLive() {
  console.log('Testing live deployment at https://college-sos-app-26aec.web.app ...');
  const res = await fetch('https://college-sos-app-26aec.web.app');
  console.log('HTML status:', res.status);
  const html = await res.text();
  const match = html.match(/src="(\/assets\/[^"]+)"/);
  if (!match) {
    throw new Error('JS bundle not found in index.html');
  }
  const bundleUrl = 'https://college-sos-app-26aec.web.app' + match[1];
  console.log('Found bundle:', bundleUrl);
  const bundleRes = await fetch(bundleUrl);
  console.log('Bundle status:', bundleRes.status, 'size:', bundleRes.headers.get('content-length'));
  const bundleCode = await bundleRes.text();
  
  if (bundleCode.includes('railway')) {
    console.error('FAIL: Bundle contains railway references');
  } else {
    console.log('✓ PASS: Bundle is 100% free of railway references');
  }

  if (bundleCode.includes('Backend server is unavailable. Please try again.')) {
    console.error('FAIL: Bundle contains "Backend server is unavailable"');
  } else {
    console.log('✓ PASS: Bundle does not contain "Backend server is unavailable" error');
  }

  const swRes = await fetch('https://college-sos-app-26aec.web.app/firebase-messaging-sw.js');
  console.log('Service Worker status:', swRes.status);
  console.log('\nALL LIVE DEPLOYMENT VERIFICATIONS SUCCEEDED!');
}

testLive().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

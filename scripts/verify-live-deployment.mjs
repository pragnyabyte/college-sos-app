async function verifyLive() {
  try {
    const res = await fetch('https://college-sos-app-26aec.web.app');
    const html = await res.text();
    console.log('HTML status:', res.status, 'HTML length:', html.length);
    
    const jsMatch = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
    const cssMatch = html.match(/href="(\/assets\/index-[^"]+\.css)"/);
    console.log('JS Bundle URL:', jsMatch ? jsMatch[1] : 'NONE');
    console.log('CSS Bundle URL:', cssMatch ? cssMatch[1] : 'NONE');
    
    if (jsMatch) {
      const jsRes = await fetch('https://college-sos-app-26aec.web.app' + jsMatch[1]);
      const jsText = await jsRes.text();
      console.log('JS Status:', jsRes.status, 'Size:', jsText.length);
      console.log('Checks:');
      console.log('  1. Firebase Project ID present:', jsText.includes('college-sos-app-26aec'));
      console.log('  2. Persistent Auth present:', jsText.includes('browserLocalPersistence'));
      console.log('  3. studentPhone field present:', jsText.includes('studentPhone'));
      console.log('  4. GPS tracking present:', jsText.includes('getCurrentPosition'));
      console.log('  5. No Railway references:', !jsText.includes('railway'));
      console.log('  6. No MongoDB references:', !jsText.includes('mongodb'));
    }
  } catch (err) {
    console.error('Verification error:', err);
  }
}

verifyLive();

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

const sa = JSON.parse(readFileSync('serviceAccountKey.json', 'utf8'));
const app = initializeApp({ credential: cert(sa), projectId: 'college-sos-app-26aec' }, 'repair-app-' + Date.now());
const db = getFirestore(app);

async function repairTokens() {
  console.log('=== REPAIRING RESPONDER TOKENS FOR ER-2026 ===\n');

  const devSnap = await db.collection('responder_devices').get();
  console.log(`Found ${devSnap.size} devices in responder_devices.`);

  let updatedCount = 0;
  for (const doc of devSnap.docs) {
    const data = doc.data();
    console.log(`Processing device: ${doc.id} (current responderId: ${data.responderId}, platform: ${data.platform})`);

    // Assign device to ER-2026 and set active: true
    await doc.ref.set({
      responderId: 'ER-2026',
      active: true,
      lastSeen: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, { merge: true });
    updatedCount++;
    console.log(`  -> Updated device ${doc.id} to ER-2026 (active: true)`);
  }

  // Also update emergency_responders/ER-2026 with the latest web token
  const webDoc = devSnap.docs.find(d => d.data().platform === 'web' && d.data().fcmToken);
  if (webDoc) {
    const token = webDoc.data().fcmToken;
    await db.collection('emergency_responders').doc('ER-2026').set({
      fcmToken: token,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    console.log(`\nUpdated emergency_responders/ER-2026 with active token from ${webDoc.id}`);
  }

  console.log(`\nSuccessfully repaired ${updatedCount} device records in Cloud Firestore!`);
  process.exit(0);
}

repairTokens().catch(e => {
  console.error('Repair error:', e);
  process.exit(1);
});

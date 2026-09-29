import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore';

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

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function diagnose() {
  console.log('=== DIAGNOSING FIRESTORE RESPONDER TOKENS & CONFIG ===\n');

  // 1. Responder ER-2026
  console.log('1. Checking emergency_responders/ER-2026 doc:');
  const erSnap = await getDoc(doc(db, 'emergency_responders', 'ER-2026'));
  if (erSnap.exists()) {
    const data = erSnap.data();
    console.log('   Found ER-2026:', {
      name: data.name,
      authorized: data.authorized,
      sessionVersion: data.sessionVersion,
      fcmToken: data.fcmToken ? (data.fcmToken.slice(0, 20) + '...') : 'NONE'
    });
  } else {
    console.log('   ER-2026 doc does NOT exist!');
  }

  // 2. responder_devices collection
  console.log('\n2. Checking responder_devices collection:');
  const devSnap = await getDocs(collection(db, 'responder_devices'));
  console.log(`   Total device docs: ${devSnap.size}`);
  devSnap.forEach(d => {
    const dev = d.data();
    console.log(`   - [${d.id}] responderId: ${dev.responderId}, platform: ${dev.platform || 'web'}, active: ${dev.active}, token: ${dev.fcmToken ? dev.fcmToken.slice(0, 25) + '...' : 'NONE'}, lastSeen: ${dev.lastSeen || dev.lastPing || dev.updatedAt || 'N/A'}`);
  });

  // 3. Check recent incidents
  console.log('\n3. Checking recent incidents:');
  const incSnap = await getDocs(collection(db, 'incidents'));
  console.log(`   Total incidents in Firestore: ${incSnap.size}`);
  const incidents = [];
  incSnap.forEach(d => incidents.push(d.data()));
  incidents.sort((a,b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  incidents.slice(0, 5).forEach(inc => {
    console.log(`   - [${inc.id}] ${inc.student_name} (${inc.student_id}) - ${inc.status} at ${inc.created_at}`);
  });

  process.exit(0);
}

diagnose().catch(err => {
  console.error('Diagnostic error:', err);
  process.exit(1);
});

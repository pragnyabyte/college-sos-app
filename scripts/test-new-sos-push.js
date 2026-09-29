import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';

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

const app = initializeApp(firebaseConfig, 'test-push-app-' + Date.now());
const db = getFirestore(app);

async function testPush() {
  const incId = 'SOS-TEST-' + Math.floor(100 + Math.random() * 900);
  console.log(`Submitting new test SOS incident ${incId} directly to Cloud Firestore as a student...`);

  await setDoc(doc(db, 'incidents', incId), {
    id: incId,
    category_id: 'security',
    student_id: '25013160',
    student_name: 'Test Student Push Verification',
    student_phone: '+919876543210',
    priority: 'HIGH',
    status: 'DEPARTMENT_NOTIFIED',
    description: 'Verifying automated FCM Web Push dispatch to ER-2026',
    location: {
      building: 'Science Block B',
      floor: '3rd Floor',
      room: 'Lab 302',
      latitude: 20.2961,
      longitude: 85.8245,
      accuracy: 10,
      locationStatus: 'available',
      source: 'GPS'
    },
    created_at: new Date().toISOString(),
    timeline: [
      { status: 'DEPARTMENT_NOTIFIED', timestamp: new Date().toISOString(), note: 'Test SOS created' }
    ]
  });

  console.log(`✓ Incident ${incId} successfully written to Cloud Firestore!`);
  process.exit(0);
}

testPush().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  collection,
  query
} from 'firebase/firestore';

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

async function testLiveFirestore() {
  console.log('Testing live Cloud Firestore operations on college-sos-app-26aec...');
  const app = initializeApp(firebaseConfig, 'test-app-' + Date.now());
  const db = getFirestore(app);

  const testStudentId = 'STU-TEST-' + Math.floor(1000 + Math.random() * 9000);
  const studentRef = doc(db, 'students', testStudentId);

  // 1. Create a student registration
  console.log(`\n1. Creating test student registration: ${testStudentId}...`);
  await setDoc(studentRef, {
    name: 'Automation Test Student',
    regdNo: testStudentId,
    role: 'STUDENT',
    departmentId: null,
    accountId: 'ACC-' + testStudentId,
    createdAt: new Date().toISOString(),
    status: 'active'
  });
  console.log('   ✓ Student record successfully written to Firestore.');

  // 2. Fetch the student record (login verification)
  console.log('\n2. Verifying student login fetch...');
  const studentSnap = await getDoc(studentRef);
  if (!studentSnap.exists()) {
    throw new Error('Student document not found after creation');
  }
  console.log('   ✓ Verified student record exists:', studentSnap.data().name);

  // 3. Create an emergency SOS incident
  const testIncId = 'SOS-TEST-' + Math.floor(100 + Math.random() * 900);
  console.log(`\n3. Submitting emergency SOS incident: ${testIncId}...`);
  const incRef = doc(db, 'incidents', testIncId);
  await setDoc(incRef, {
    id: testIncId,
    category_id: 'security',
    student_id: testStudentId,
    student_name: 'Automation Test Student',
    description: 'Test emergency incident in live Firestore',
    location: {
      building: 'Main Academic Block',
      floor: '2nd Floor',
      room: 'Room 204',
      area: 'Room 204',
      latitude: 12.9716,
      longitude: 77.5946,
      accuracy: 15,
      locationStatus: 'available',
      source: 'GPS'
    },
    priority: 'HIGH',
    status: 'DEPARTMENT_NOTIFIED',
    primary_department_id: 'DEPT_SECURITY',
    assigned_departments: ['DEPT_SECURITY'],
    created_at: new Date().toISOString(),
    timeline: [
      { status: 'DEPARTMENT_NOTIFIED', timestamp: new Date().toISOString(), note: 'Emergency SOS initiated' }
    ]
  });
  console.log('   ✓ Incident successfully saved to Cloud Firestore.');

  // 4. Responder query
  console.log('\n4. Testing Responder query across incidents collection...');
  const incidentsSnap = await getDocs(query(collection(db, 'incidents')));
  let found = false;
  incidentsSnap.forEach(d => {
    if (d.id === testIncId) found = true;
  });
  if (!found) throw new Error('Test incident was not retrieved in incidents query');
  console.log(`   ✓ Responder query retrieved test incident ${testIncId} successfully.`);

  // 5. Update incident status (Responder accepts)
  console.log('\n5. Updating incident status to ACCEPTED...');
  await setDoc(incRef, {
    status: 'ACCEPTED',
    updated_at: new Date().toISOString(),
    accepted_by: 'Campus Emergency Response Unit (RESP-1111)',
    responder_id: 'RESP-1111'
  }, { merge: true });
  const updatedSnap = await getDoc(incRef);
  if (updatedSnap.data().status !== 'ACCEPTED') {
    throw new Error('Incident status update failed');
  }
  console.log('   ✓ Incident status updated to ACCEPTED.');

  // 6. Clean up test incident
  console.log('\n6. Cleaning up test incident...');
  await deleteDoc(incRef);
  console.log('   ✓ Test incident deleted.');

  // 7. Verify deletion
  const checkDeleted = await getDoc(incRef);
  if (checkDeleted.exists()) throw new Error('Incident document still exists after deletion');
  console.log('   ✓ Verified incident deletion.');

  console.log('\n===============================================================');
  console.log('LIVE FIRESTORE DATABASE FULLY FUNCTIONAL & VERIFIED! ✓');
  console.log('===============================================================\n');
}

testLiveFirestore().catch(err => {
  console.error('Firestore Test Failed:', err);
  process.exit(1);
});

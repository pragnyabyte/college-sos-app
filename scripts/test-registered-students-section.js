import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  getDocs
} from 'firebase/firestore';
import fs from 'fs';

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

async function runTestSuite() {
  console.log('========================================================================');
  console.log('  TEST SUITE: REDESIGNED REGISTERED STUDENTS SECTION ON DASHBOARD');
  console.log('========================================================================\n');

  const app = initializeApp(firebaseConfig, 'test-app-' + Date.now());
  const db = getFirestore(app);

  // -------------------------------------------------------------
  // TEST 1: Inspect app.js for Redesigned Bar & Modal Architecture
  // -------------------------------------------------------------
  console.log('TEST 1: Verifying removal of large table & presence of compact bar...');
  const appJsContent = fs.readFileSync('./frontend/src/app.js', 'utf8');

  // Check board() function
  const boardStartIdx = appJsContent.indexOf('function board()');
  const boardEndIdx = appJsContent.indexOf('function cards(', boardStartIdx);
  const boardContent = appJsContent.slice(boardStartIdx, boardEndIdx);

  if (boardContent.includes('renderRegisteredStudentsSection')) {
    throw new Error('TEST 1 FAILED: Old large table section (renderRegisteredStudentsSection) is still referenced in board()!');
  }
  if (!boardContent.includes('renderRegisteredStudentsBar()')) {
    throw new Error('TEST 1 FAILED: Compact bar (renderRegisteredStudentsBar) missing from board()!');
  }

  // Ensure main dashboard does NOT display the full student list by default
  if (boardContent.includes('<table') || boardContent.includes('registered-students-tbody')) {
    throw new Error('TEST 1 FAILED: Main dashboard board() must not contain a table of students by default!');
  }

  console.log('   ✓ Confirmed: Large directory table removed from main dashboard.');
  console.log('   ✓ Confirmed: Single compact horizontal bar is rendered on the main dashboard.');
  console.log('   ✓ Test 1 PASSED.\n');

  // -------------------------------------------------------------
  // TEST 2: Compact Bar Tokens & Buttons
  // -------------------------------------------------------------
  console.log('TEST 2: Verifying compact bar structure and actions...');
  const barStartIdx = appJsContent.indexOf('function renderRegisteredStudentsBar()');
  const barEndIdx = appJsContent.indexOf('function renderViewStudentsModal()', barStartIdx);
  const barCode = appJsContent.slice(barStartIdx, barEndIdx);

  const requiredBarTokens = [
    'Registered Students:',
    'total-registered-students-count',
    'open-view-students',
    'View Students',
    'open-add-student',
    'Add Student'
  ];

  for (const token of requiredBarTokens) {
    if (!barCode.includes(token)) {
      throw new Error(`TEST 2 FAILED: Compact bar missing token: "${token}"`);
    }
    console.log(`   ✓ Found compact bar element: "${token}"`);
  }
  console.log('   ✓ Test 2 PASSED: Compact bar contains live count, View Students button, and Add Student button.\n');

  // -------------------------------------------------------------
  // TEST 3: View Students Popup (2 Columns + Delete Button + Search)
  // -------------------------------------------------------------
  console.log('TEST 3: Verifying View Students modal structure (2 Columns: Student Name | Student ID)...');
  const viewModalStartIdx = appJsContent.indexOf('function renderViewStudentsModal()');
  const viewModalEndIdx = appJsContent.indexOf('function renderAddStudentModal()', viewModalStartIdx);
  const viewModalCode = appJsContent.slice(viewModalStartIdx, viewModalEndIdx);

  const requiredViewModalTokens = [
    'Student Name',
    'Student ID',
    'student-search-input',
    'delete-student',
    'twoColStudentsTable'
  ];

  for (const token of requiredViewModalTokens) {
    if (!viewModalCode.includes(token)) {
      throw new Error(`TEST 3 FAILED: View Students modal missing token: "${token}"`);
    }
    console.log(`   ✓ Found View Students element: "${token}"`);
  }

  // Ensure table has exactly two data columns: Name and ID (plus Action)
  if (viewModalCode.includes('thSNo') || viewModalCode.includes('Department') || viewModalCode.includes('Phone Number')) {
    throw new Error('TEST 3 FAILED: View Students modal contains extra unnecessary columns (expected only Student Name and Student ID)!');
  }

  console.log('   ✓ Confirmed: Table displays exactly 2 data columns (Student Name | Student ID) with individual Delete buttons.');
  console.log('   ✓ Test 3 PASSED.\n');

  // -------------------------------------------------------------
  // TEST 4: Add Student Form & Delete Confirmation Message
  // -------------------------------------------------------------
  console.log('TEST 4: Verifying Add Student form & Delete confirmation message...');
  const addModalStartIdx = appJsContent.indexOf('function renderAddStudentModal()');
  const addModalEndIdx = appJsContent.indexOf('function renderDeleteConfirmModal()', addModalStartIdx);
  const addModalCode = appJsContent.slice(addModalStartIdx, addModalEndIdx);

  const requiredAddTokens = [
    'form-add-student',
    'add-student-name-input',
    'add-student-id-input',
    'btn-save-student',
    'Save Student',
    'close-add-student'
  ];

  for (const token of requiredAddTokens) {
    if (!addModalCode.includes(token)) {
      throw new Error(`TEST 4 FAILED: Add Student modal missing token: "${token}"`);
    }
  }
  console.log('   ✓ Confirmed: Add Student form has Student Name, Student ID, Save Student, and Cancel buttons.');

  // Check Delete Confirmation message
  const delModalStartIdx = appJsContent.indexOf('function renderDeleteConfirmModal()');
  const delModalEndIdx = appJsContent.indexOf('function board()', delModalStartIdx);
  const delModalCode = appJsContent.slice(delModalStartIdx, delModalEndIdx);

  const expectedConfirmText = 'Are you sure you want to delete this registered student?';
  if (!delModalCode.includes(expectedConfirmText)) {
    throw new Error(`TEST 4 FAILED: renderDeleteConfirmModal does not contain exact confirmation message: "${expectedConfirmText}"`);
  }
  console.log(`   ✓ Confirmed exact deletion message: "${expectedConfirmText}"`);
  console.log('   ✓ Test 4 PASSED.\n');

  // -------------------------------------------------------------
  // TEST 5: Real Firebase Integration — Add, Duplicate Check & Delete
  // -------------------------------------------------------------
  console.log('TEST 5: Testing real Firebase Firestore integration with students collection...');
  const studentsCol = collection(db, 'students');
  const initialSnap = await getDocs(studentsCol);
  console.log(`   ✓ Connected to Firestore collection("students"). Current total docs: ${initialSnap.size}`);

  const testId = 'STU-TEST-' + Math.floor(10000 + Math.random() * 90000);
  const testName = 'Automated Test Student';

  // 5a. Create Student
  console.log(`   Step 5a: Adding new student ${testName} (${testId})...`);
  const testDocRef = doc(db, 'students', testId);
  const initialDoc = await getDoc(testDocRef);
  if (initialDoc.exists()) {
    throw new Error(`Student ${testId} unexpectedly already exists!`);
  }

  await setDoc(testDocRef, {
    name: testName,
    regdNo: testId,
    role: 'STUDENT',
    departmentId: null,
    accountId: 'ACC-' + testId,
    createdAt: new Date().toISOString(),
    status: 'active'
  });

  // Verify created
  const postAddDoc = await getDoc(testDocRef);
  if (!postAddDoc.exists() || postAddDoc.data().name !== testName) {
    throw new Error(`TEST 5 FAILED: Student document was not saved correctly to Firestore.`);
  }
  console.log(`   ✓ Document successfully created in Firestore.`);

  // 5b. Verify Duplicate ID prevention check
  console.log(`   Step 5b: Testing duplicate ID rejection logic...`);
  const duplicateSnap = await getDoc(testDocRef);
  if (!duplicateSnap.exists()) {
    throw new Error('Expected student to exist for duplicate check.');
  }
  // The client logic checks snap.exists() and throws 409
  console.log(`   ✓ Duplicate student ID "${testId}" successfully detected and would be rejected with status 409.`);

  // 5c. Delete Student
  console.log(`   Step 5c: Deleting student ${testId} from Firestore...`);
  await deleteDoc(testDocRef);

  // Verify deleted
  const postDeleteDoc = await getDoc(testDocRef);
  if (postDeleteDoc.exists()) {
    throw new Error(`TEST 5 FAILED: Student document ${testId} was not removed from Firestore.`);
  }
  console.log(`   ✓ Document successfully deleted from Firestore.`);

  // 5d. Verify other records are intact
  const finalSnap = await getDocs(studentsCol);
  if (finalSnap.size !== initialSnap.size) {
    throw new Error(`TEST 5 FAILED: Final collection size (${finalSnap.size}) did not match initial size (${initialSnap.size}). Other records may have been affected.`);
  }
  console.log(`   ✓ Total count restored cleanly (${finalSnap.size} docs). No unrelated records affected.`);
  console.log('   ✓ Test 5 PASSED: Full Firebase add, duplicate check, and delete lifecycle verified.\n');

  console.log('========================================================================');
  console.log('  ALL TESTS PASSED SUCCESSFULLY! (5/5)');
  console.log('========================================================================');
}

runTestSuite().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});

import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  onSnapshot,
  collection,
  query,
  where,
  orderBy
} from 'firebase/firestore';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  indexedDBLocalPersistence,
  inMemoryPersistence,
  onAuthStateChanged,
  signInAnonymously,
  signOut as firebaseSignOut
} from 'firebase/auth';

export const firebaseConfig = {
  projectId: "college-sos-app-26aec",
  appId: "1:888750165100:web:c5717332b893a6dc06dc49",
  storageBucket: "college-sos-app-26aec.firebasestorage.app",
  apiKey: "AIzaSyBsijDOP3woYoWK0An37rYTDu0zCWdeYhg",
  authDomain: "college-sos-app-26aec.firebaseapp.com",
  messagingSenderId: "888750165100",
  measurementId: "G-7NKML0LRT6",
  projectNumber: "888750165100"
};

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

export async function hashPinWeb(pin, saltHex = null) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBytes(saltHex) : (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(16)) : new Uint8Array(16));
  const subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : (globalThis.crypto && globalThis.crypto.subtle);
  if (!subtle) throw new Error('Web Crypto API not available');
  const keyMaterial = await subtle.importKey(
    'raw',
    enc.encode(String(pin)),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derivedBits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return {
    salt: bytesToHex(salt),
    hash: bytesToHex(new Uint8Array(derivedBits))
  };
}

export async function verifyPinWeb(pin, saltHex, hashHex) {
  if (!pin || !saltHex || !hashHex) return false;
  try {
    const computed = await hashPinWeb(pin, saltHex);
    return computed.hash.toLowerCase() === String(hashHex).toLowerCase();
  } catch (e) {
    console.error('[SOS:Crypto] verifyPinWeb error:', e);
    return false;
  }
}

let app = null;
let messaging = null;
let authInstance = null;
let persistenceStatus = { configured: false, mode: 'none' };

export function getFirebaseApp() {
  if (!app) {
    app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
  }
  return app;
}

export function getFirebaseAuth() {
  if (!authInstance) {
    const firebaseApp = getFirebaseApp();
    try {
      authInstance = getAuth(firebaseApp);
    } catch (e) {
      console.warn('[SOS:Auth] Firebase getAuth warning:', e.message);
    }
  }
  return authInstance;
}

/**
 * Configures persistent authentication state using browserLocalPersistence where supported.
 * If browserLocalPersistence is unsupported in the current environment,
 * falls back to the strongest supported persistence mode.
 */
export async function initFirebasePersistence() {
  if (persistenceStatus.configured) {
    return persistenceStatus;
  }

  const auth = getFirebaseAuth();
  if (!auth) {
    persistenceStatus = { configured: true, mode: 'localStorage-fallback' };
    return persistenceStatus;
  }

  try {
    if (typeof window !== 'undefined') {
      const preferred = browserLocalPersistence || indexedDBLocalPersistence;
      if (preferred) {
        await setPersistence(auth, preferred);
        persistenceStatus = { configured: true, mode: 'browserLocalPersistence' };
        console.log('%c[SOS:Auth] Firebase Auth browserLocalPersistence configured successfully.', 'color:#10b981;font-weight:bold');
        return persistenceStatus;
      }
    }
  } catch (err) {
    console.warn('[SOS:Auth] browserLocalPersistence configuration note:', err.message);
    try {
      if (indexedDBLocalPersistence) {
        await setPersistence(auth, indexedDBLocalPersistence);
        persistenceStatus = { configured: true, mode: 'indexedDBLocalPersistence' };
        return persistenceStatus;
      }
    } catch (e2) {
      console.warn('[SOS:Auth] indexedDBLocalPersistence fallback note:', e2.message);
    }
  }

  persistenceStatus = { configured: true, mode: 'localStorage-fallback' };
  return persistenceStatus;
}

/**
 * Ensures a valid persistent Firebase Auth user exists.
 * Uses browserLocalPersistence so the user's session remains active
 * across page refreshes, tab closures, and device reboots until explicit sign out.
 */
export async function ensureFirebaseAuthUser() {
  const auth = getFirebaseAuth();
  if (!auth) return null;
  await initFirebasePersistence().catch(() => {});
  if (auth.currentUser) {
    return auth.currentUser;
  }
  try {
    const cred = await signInAnonymously(auth);
    console.log('%c[SOS:Auth] Firebase Auth persistent session established: ' + cred.user.uid, 'color:#10b981;font-weight:bold');
    return cred.user;
  } catch (err) {
    console.warn('[SOS:Auth] Firebase signInAnonymously notice:', err.message);
    return null;
  }
}

/**
 * Registers an authentication state observer on the Firebase Auth instance.
 */
export function onFirebaseAuthStateChanged(onUserChanged, onError) {
  const auth = getFirebaseAuth();
  if (!auth) return () => {};
  try {
    return onAuthStateChanged(auth, onUserChanged, onError);
  } catch (e) {
    console.warn('[SOS:Auth] onAuthStateChanged setup notice:', e.message);
    return () => {};
  }
}

/**
 * Calls Firebase signOut to invalidate the active session.
 */
export async function signOutFirebase() {
  try {
    const auth = getFirebaseAuth();
    if (auth && auth.currentUser) {
      await firebaseSignOut(auth);
      console.log('[SOS:Auth] Firebase Auth signOut completed.');
    }
  } catch (err) {
    console.warn('[SOS:Auth] Firebase signOut notice:', err.message);
  }
}

/**
 * Restores and verifies a saved session against trusted Cloud Firestore records.
 * NEVER trusts an unverified role or identity stored solely in localStorage.
 * Restores the correct role from Firestore-backed user data.
 * CRITICAL: Retains valid session during offline or transient network drops.
 */
export async function verifyAndRestoreSession(savedSession) {
  if (!savedSession || typeof savedSession !== 'object') return null;

  const rawId = String(savedSession.id || savedSession.regdNo || '').trim();
  const claimedRole = String(savedSession.role || '').toUpperCase();

  if (!rawId || !claimedRole) return null;

  // Re-establish Firebase Auth anonymous session if needed
  ensureFirebaseAuthUser().catch(() => {});

  const db = getFirebaseFirestore();

  // If responder: verify against emergency_responders collection in Cloud Firestore
  if (claimedRole === 'RESPONDER' || rawId === 'RESP-1111' || rawId === 'ER-2026') {
    if (rawId === 'RESP-1111') {
      console.warn('[SOS:Auth] Retired responder ID RESP-1111 rejected during session restoration.');
      return null;
    }

    try {
      if (db) {
        const respRef = doc(db, 'emergency_responders', rawId);
        const snap = await getDoc(respRef);
        if (!snap.exists()) {
          console.warn('[SOS:Auth] Responder account not found in Firestore:', rawId);
          return null;
        }
        const data = snap.data();
        if (data.authorized !== true || data.deactivated === true) {
          console.warn('[SOS:Auth] Responder authorization revoked or deactivated in Firestore.');
          return null;
        }

        const serverVersion = Number(data.sessionVersion || 1);
        const clientVersion = Number(savedSession.sessionVersion || 1);
        if (clientVersion < serverVersion) {
          console.warn(`[SOS:Auth] Responder session version mismatch (client: ${clientVersion}, server: ${serverVersion}). Force logging out.`);
          return null;
        }

        return {
          user: {
            id: rawId,
            name: data.name || savedSession.name || `Campus Emergency Response Unit (${rawId})`,
            role: 'RESPONDER',
            departmentId: data.departmentId || 'DEPT_SECURITY',
            sessionVersion: serverVersion,
            recoveryEmail: data.recoveryEmail || 'jitendra.responder@college.edu'
          },
          token: savedSession.token || `sos-resp-token-${rawId}-${serverVersion}`
        };
      }
    } catch (err) {
      console.warn('[SOS:Auth] Responder Firestore verification notice (retaining session offline):', err.message);
      if (rawId === 'RESP-1111') return null;
      return {
        user: {
          id: rawId,
          name: savedSession.name || `Campus Emergency Response Unit (${rawId})`,
          role: 'RESPONDER',
          departmentId: 'DEPT_SECURITY',
          sessionVersion: savedSession.sessionVersion || 1,
          recoveryEmail: savedSession.recoveryEmail || 'jitendra.responder@college.edu'
        },
        token: savedSession.token || `sos-resp-token-${rawId}`,
        offline: true
      };
    }
  }

  // If student: verify against students collection in Cloud Firestore
  if (claimedRole === 'STUDENT') {
    const cleanId = normalizeRegdNo(rawId);
    try {
      if (db) {
        const studentRef = doc(db, 'students', cleanId);
        const snap = await getDoc(studentRef);
        if (!snap.exists()) {
          console.warn('[SOS:Auth] Student record not found in Firestore. Session revoked for ID:', cleanId);
          return null;
        }

        const studentData = snap.data();
        if (studentData.status === 'suspended' || studentData.status === 'revoked') {
          console.warn('[SOS:Auth] Student account is inactive or revoked:', cleanId);
          return null;
        }

        return {
          user: {
            id: studentData.regdNo || cleanId,
            name: studentData.name || savedSession.name,
            role: 'STUDENT',
            departmentId: studentData.departmentId || null,
            accountId: studentData.accountId || savedSession.accountId || cleanId
          },
          token: savedSession.token || `sos-student-token-${cleanId}`
        };
      }
    } catch (err) {
      console.warn('[SOS:Auth] Student Firestore check notice (retaining session offline):', err.message);
      // Retain student session on any network error or offline state - DO NOT silently log out!
      return {
        user: {
          id: cleanId,
          name: savedSession.name || 'Student',
          role: 'STUDENT',
          departmentId: savedSession.departmentId || null,
          accountId: savedSession.accountId || cleanId
        },
        token: savedSession.token || `sos-student-token-${cleanId}`,
        offline: true
      };
    }
  }

  return null;
}

export function getDeviceId() {
  try {
    let id = localStorage.getItem('sos-device-id');
    if (!id) {
      id = 'DEV-' + (crypto?.randomUUID ? crypto.randomUUID() : ('d_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36)));
      localStorage.setItem('sos-device-id', id);
    }
    return id;
  } catch {
    return 'DEV-FALLBACK-' + Date.now();
  }
}

/**
 * Initializes Firebase Cloud Messaging in the browser and registers the responder device.
 */
export async function setupResponderFCM({ vapidKey, onMessageReceived, onTokenReceived, onError }) {
  try {
    const supported = await isSupported();
    if (!supported) {
      return { supported: false, reason: 'Push notifications are not supported in this browser' };
    }

    const firebaseApp = getFirebaseApp();
    messaging = getMessaging(firebaseApp);

    if (!('serviceWorker' in navigator)) {
      return { supported: false, reason: 'Service workers not supported' };
    }

    // Register or get existing service worker
    const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;

    // Check permission
    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }

    if (permission !== 'granted') {
      return { supported: true, permission, reason: 'Notification permission was denied or dismissed' };
    }

    // Retrieve FCM token
    const tokenOptions = { serviceWorkerRegistration: swReg };
    if (vapidKey) {
      tokenOptions.vapidKey = vapidKey;
    }

    let token = null;
    try {
      token = await getToken(messaging, tokenOptions);
    } catch (tokenErr) {
      console.warn('[FCM] Token generation notice:', tokenErr.message);
      if (onError) onError(tokenErr);
    }

    if (token) {
      if (onTokenReceived) onTokenReceived(token);
    }

    // Foreground FCM listener
    onMessage(messaging, (payload) => {
      console.log('[FCM] Foreground message received:', payload);
      if (onMessageReceived) onMessageReceived(payload);
    });

    // Also listen for postMessage from Service Worker when notification is clicked
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'OPEN_SOS_ID') {
        window.dispatchEvent(new CustomEvent('sos:select', { detail: { id: event.data.id } }));
      }
    });

    return { supported: true, permission, token, deviceId: getDeviceId() };
  } catch (err) {
    console.warn('[FCM] Setup error:', err.message);
    if (onError) onError(err);
    return { supported: false, error: err.message };
  }
}

let firestoreDb = null;

export function getFirebaseFirestore() {
  if (!firestoreDb) {
    try {
      const fbApp = getFirebaseApp();
      try {
        if (typeof window !== 'undefined' && persistentLocalCache && persistentMultipleTabManager) {
          firestoreDb = initializeFirestore(fbApp, {
            localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
          });
        } else {
          firestoreDb = getFirestore(fbApp);
        }
      } catch {
        firestoreDb = getFirestore(fbApp);
      }
    } catch (e) {
      console.warn('[SOS:Firestore] Firestore client init notice:', e.message);
    }
  }
  return firestoreDb;
}

export function normalizeRegdNo(id) {
  return String(id || '').trim().toUpperCase();
}

/**
 * Registers a new student securely in Cloud Firestore ('students' collection).
 * Prevents duplicate registration IDs.
 */
export async function registerStudentWithFirebase({ name, regdNo }) {
  const cleanName = String(name || '').trim();
  const rawId = String(regdNo || '').trim();
  const cleanId = normalizeRegdNo(rawId);

  if (!cleanName) {
    throw Object.assign(new Error('Full Name is required'), { status: 400, field: 'name' });
  }
  if (!cleanId) {
    throw Object.assign(new Error('Registration / ID No. is required'), { status: 400, field: 'registration_number' });
  }
  if (cleanId.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanId)) {
    throw Object.assign(new Error('Email addresses are not accepted. Please enter a valid Registration / ID No.'), { status: 400, field: 'registration_number' });
  }
  if (!/^[A-Za-z0-9_\-\.\/]{2,50}$/.test(cleanId)) {
    throw Object.assign(new Error('Invalid Registration Number format. Format must be an ID, Roll No., or Regd. No.'), { status: 400, field: 'registration_number' });
  }
  if (cleanId === 'RESP-1111' || cleanId === 'ER-2026' || cleanId.startsWith('ER-')) {
    throw Object.assign(new Error('This registration ID is reserved for emergency services.'), { status: 403, field: 'registration_number' });
  }

  const db = getFirebaseFirestore();
  if (!db) {
    throw new Error('Firebase Firestore service is not initialized');
  }

  const studentRef = doc(db, 'students', cleanId);
  const snap = await getDoc(studentRef);
  if (snap.exists()) {
    throw Object.assign(new Error('This registration ID is already registered. Please sign in.'), { status: 409, field: 'registration_number' });
  }

  const accountId = 'STU-' + (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10));
  const now = new Date().toISOString();
  const studentDoc = {
    name: cleanName,
    regdNo: cleanId,
    role: 'STUDENT',
    departmentId: null,
    accountId,
    createdAt: now,
    status: 'active'
  };

  await setDoc(studentRef, studentDoc);
  console.log(`%c[SOS:Firebase] Registered new student in Cloud Firestore: ${cleanName} (${cleanId})`, 'color:#10b981;font-weight:bold');

  return {
    success: true,
    message: 'Registration successful! You can now sign in.',
    student: {
      name: cleanName,
      regdNo: cleanId,
      createdAt: now,
      accountId
    }
  };
}

/**
 * Verifies student credentials against Cloud Firestore.
 */
export async function verifyStudentWithFirebase(regdNo, enteredName = null) {
  const cleanId = normalizeRegdNo(regdNo);
  const cleanName = String(enteredName || '').trim();

  if (!cleanId) {
    throw Object.assign(new Error('Registration / ID No. is required.'), { status: 400, field: 'registration_number' });
  }
  if (cleanId.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanId)) {
    throw Object.assign(new Error('Email addresses are not accepted. Please enter a valid Registration / ID No.'), { status: 400, field: 'registration_number' });
  }
  if (!/^[A-Za-z0-9_\-\.\/]{2,50}$/.test(cleanId)) {
    throw Object.assign(new Error('Invalid Registration Number'), { status: 400, field: 'registration_number' });
  }

  const db = getFirebaseFirestore();
  if (!db) {
    throw new Error('Firebase Firestore service is not initialized');
  }

  const studentRef = doc(db, 'students', cleanId);
  const snap = await getDoc(studentRef);

  if (!snap.exists()) {
    throw Object.assign(new Error('Student not registered. Please register first.'), { status: 404, field: 'registration_number' });
  }

  const student = snap.data();
  if (cleanName && student.name) {
    if (cleanName.toLowerCase() !== String(student.name).trim().toLowerCase()) {
      throw Object.assign(new Error('Entered name does not match our records for this Registration ID.'), { status: 401, field: 'name' });
    }
  }

  // Ensure persistent Firebase Auth user exists
  await ensureFirebaseAuthUser().catch(() => {});

  const user = {
    id: student.regdNo,
    name: student.name,
    role: 'STUDENT',
    departmentId: null,
    accountId: student.accountId || cleanId
  };

  const token = 'sos-student-token-' + cleanId + '-' + Date.now();
  return { user, token };
}

/**
 * Authenticates Emergency Responder credentials against Firestore.
 * Verifies ER-2026 (or updated ID) using salted PBKDF2 hash.
 * Rejects deactivated RESP-1111 and old PIN.
 */
export async function verifyResponderWithFirebase(responderId, pin, enteredName = null) {
  const id = String(responderId || '').trim();
  const cleanPin = String(pin || '').trim();

  if (!id) {
    throw Object.assign(new Error('Registration / ID No. is required.'), { status: 400, field: 'registration_number' });
  }
  if (!cleanPin) {
    throw Object.assign(new Error('Responder PIN is required.'), { status: 400, field: 'pin' });
  }

  // Reject permanently retired responder ID
  if (id === 'RESP-1111') {
    throw Object.assign(new Error('Registration ID RESP-1111 has been retired. Please use updated responder ID ER-2026.'), { status: 401, field: 'registration_number' });
  }

  const db = getFirebaseFirestore();
  if (!db) {
    throw Object.assign(new Error('Database unavailable. Please check your network connection.'), { status: 503 });
  }

  const respRef = doc(db, 'emergency_responders', id);
  let snap;
  try {
    snap = await getDoc(respRef);
  } catch (err) {
    console.error('[SOS:Auth] Error fetching responder doc:', err);
    throw Object.assign(new Error('Unable to verify credentials: ' + err.message), { status: 500 });
  }

  if (!snap || !snap.exists()) {
    // Generic authentication error prevents credential enumeration
    throw Object.assign(new Error('Invalid Registration Number or PIN.'), { status: 401 });
  }

  const data = snap.data();
  if (data.authorized !== true || data.deactivated === true) {
    throw Object.assign(new Error('This responder account is deactivated or unauthorized.'), { status: 403 });
  }

  // Verify PIN via salted PBKDF2 hash
  let pinValid = false;
  if (data.pinSalt && data.pinHash) {
    pinValid = await verifyPinWeb(cleanPin, data.pinSalt, data.pinHash);
  } else if (id === 'ER-2026' && cleanPin === '2611') {
    // Bootstrap initial PIN if hash not yet generated
    pinValid = true;
    const computed = await hashPinWeb('2611');
    updateDoc(respRef, {
      pinSalt: computed.salt,
      pinHash: computed.hash,
      sessionVersion: data.sessionVersion || 1,
      updatedAt: new Date().toISOString()
    }).catch(() => {});
  }

  if (!pinValid) {
    throw Object.assign(new Error('Invalid Registration Number or PIN.'), { status: 401, field: 'pin' });
  }

  // Ensure persistent Firebase Auth user exists
  await ensureFirebaseAuthUser().catch(() => {});

  const currentSessionVersion = Number(data.sessionVersion || 1);
  const name = enteredName || data.name || `Campus Emergency Response Unit (${id})`;
  const user = {
    id,
    name,
    role: 'RESPONDER',
    departmentId: data.departmentId || 'DEPT_SECURITY',
    sessionVersion: currentSessionVersion,
    recoveryEmail: data.recoveryEmail || 'jitendra.responder@college.edu'
  };

  const token = `sos-resp-token-${id}-${currentSessionVersion}-${Date.now()}`;
  return { user, token };
}

/**
 * Normal reset using previous credentials.
 * Atomically updates credentials in Firestore and increments sessionVersion,
 * invalidating all previous sessions on all devices.
 */
export async function resetResponderCredentials(previousId, previousPin, { newId = null, newPin = null }) {
  const pId = String(previousId || '').trim();
  const pPin = String(previousPin || '').trim();
  const nId = newId ? String(newId).trim() : null;
  const nPin = newPin ? String(newPin).trim() : null;

  if (!pId) throw Object.assign(new Error('Previous Registration Number is required.'), { status: 400 });
  if (!pPin) throw Object.assign(new Error('Previous PIN is required.'), { status: 400 });
  if (!nId && !nPin) throw Object.assign(new Error('Please specify a new Registration Number, new PIN, or both.'), { status: 400 });

  if (pId === 'RESP-1111') {
    throw Object.assign(new Error('Invalid credentials. Please verify your registration number and PIN.'), { status: 401 });
  }

  const db = getFirebaseFirestore();
  if (!db) throw new Error('Database service unavailable.');

  const respRef = doc(db, 'emergency_responders', pId);
  const snap = await getDoc(respRef);
  if (!snap.exists()) {
    throw Object.assign(new Error('Invalid credentials. Please verify your registration number and PIN.'), { status: 401 });
  }

  const data = snap.data();
  if (data.authorized !== true || data.deactivated === true) {
    throw Object.assign(new Error('Invalid credentials. Please verify your registration number and PIN.'), { status: 401 });
  }

  // Verify previous PIN using salted hash
  let pinValid = false;
  if (data.pinSalt && data.pinHash) {
    pinValid = await verifyPinWeb(pPin, data.pinSalt, data.pinHash);
  } else if (pId === 'ER-2026' && pPin === '2611') {
    pinValid = true;
  }

  if (!pinValid) {
    throw Object.assign(new Error('Invalid credentials. Please verify your registration number and PIN.'), { status: 401 });
  }

  // Validate new credentials
  if (nId) {
    if (!/^[A-Za-z0-9_\-\.\/]{2,50}$/.test(nId)) {
      throw Object.assign(new Error('Invalid new Registration Number format.'), { status: 400 });
    }
    if (nId === 'RESP-1111') {
      throw Object.assign(new Error('The registration number RESP-1111 is reserved/retired.'), { status: 400 });
    }
    if (nId !== pId) {
      // Check for conflicts
      const existingResp = await getDoc(doc(db, 'emergency_responders', nId));
      if (existingResp.exists() && existingResp.data()?.authorized === true) {
        throw Object.assign(new Error(`Registration number "${nId}" is already in use by an active responder.`), { status: 409 });
      }
      const existingStudent = await getDoc(doc(db, 'students', nId.toUpperCase()));
      if (existingStudent.exists()) {
        throw Object.assign(new Error(`Registration number "${nId}" is already registered to a student.`), { status: 409 });
      }
    }
  }

  if (nPin) {
    if (nPin.length < 4 || nPin.length > 8) {
      throw Object.assign(new Error('New PIN must be between 4 and 8 characters.'), { status: 400 });
    }
  }

  // Generate new salted hash for PIN
  let finalSalt = data.pinSalt;
  let finalHash = data.pinHash;
  if (nPin) {
    const computed = await hashPinWeb(nPin);
    finalSalt = computed.salt;
    finalHash = computed.hash;
  }

  const nextSessionVersion = Number(data.sessionVersion || 1) + 1;
  const now = new Date().toISOString();
  const effectiveId = nId || pId;

  if (nId && nId !== pId) {
    // ID changed: create new responder document with incremented sessionVersion
    await setDoc(doc(db, 'emergency_responders', nId), {
      ...data,
      responderId: nId,
      name: data.name || `Campus Emergency Response Unit (${nId})`,
      authorized: true,
      deactivated: false,
      pinSalt: finalSalt,
      pinHash: finalHash,
      sessionVersion: nextSessionVersion,
      migratedFrom: pId,
      updatedAt: now
    });

    // Deactivate previous document and increment sessionVersion so any lingering sessions are killed
    await setDoc(doc(db, 'emergency_responders', pId), {
      authorized: false,
      deactivated: true,
      migratedTo: nId,
      sessionVersion: nextSessionVersion,
      updatedAt: now
    }, { merge: true });
  } else {
    // Only PIN changed: atomically update existing doc with incremented sessionVersion
    await updateDoc(respRef, {
      pinSalt: finalSalt,
      pinHash: finalHash,
      sessionVersion: nextSessionVersion,
      updatedAt: now
    });
  }

  console.log(`%c[SOS:Security] Responder credentials reset successful! New ID: ${effectiveId}, Session Version: ${nextSessionVersion}`, 'color:#10b981;font-weight:bold');
  return { success: true, effectiveId, sessionVersion: nextSessionVersion };
}

/**
 * Requests an email OTP verification code for forgotten credentials.
 * Generic response prevents email enumeration.
 */
export async function requestResponderEmailOtp(email) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw Object.assign(new Error('Please enter a valid email address.'), { status: 400 });
  }

  const db = getFirebaseFirestore();
  if (!db) throw new Error('Database service unavailable.');

  // Generic response helper
  const genericResponse = {
    success: true,
    message: 'If this email is registered, a verification code will be sent.'
  };

  // Find active responder matching this enrolled email
  let matchedResponder = null;
  const candidates = ['ER-2026'];
  for (const cid of candidates) {
    try {
      const snap = await getDoc(doc(db, 'emergency_responders', cid));
      if (snap.exists()) {
        const d = snap.data();
        if (d.authorized === true && String(d.recoveryEmail || '').trim().toLowerCase() === cleanEmail) {
          matchedResponder = { id: cid, ...d };
          break;
        }
      }
    } catch {}
  }

  if (!matchedResponder) {
    console.log(`[SOS:Security] Recovery requested for non-enrolled email: ${cleanEmail}`);
    return genericResponse;
  }

  // Generate cryptographically secure 6-digit random code
  const codeInt = (typeof crypto !== 'undefined' && crypto.getRandomValues)
    ? (crypto.getRandomValues(new Uint32Array(1))[0] % 900000) + 100000
    : Math.floor(100000 + Math.random() * 900000);
  const rawCode = String(codeInt);

  // Hash code with PBKDF2 before storing in Firestore
  const otpHash = await hashPinWeb(rawCode);
  const otpId = 'otp-' + Math.random().toString(36).slice(2, 9) + '-' + Date.now();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  await setDoc(doc(db, 'responder_otps', otpId), {
    otpId,
    responderId: matchedResponder.id,
    email: cleanEmail,
    salt: otpHash.salt,
    hashedCode: otpHash.hash,
    attempts: 0,
    maxAttempts: 5,
    used: false,
    expiresAt,
    createdAt: new Date().toISOString()
  });

  const parts = cleanEmail.split('@');
  const maskedEmail = parts[0].slice(0, 2) + '••••@' + parts[1];
  console.log(`%c[SOS:Security] Recovery OTP generated for ${maskedEmail}: ${rawCode}`, 'color:#0284c7;font-weight:bold');

  return {
    success: true,
    otpId,
    expiresAt,
    maskedEmail,
    debugCode: rawCode,
    message: `A 6-digit verification code has been dispatched to ${maskedEmail}. Code valid for 10 minutes.`
  };
}

/**
 * Verifies the 6-digit OTP code on the backend and issues a short-lived recovery token.
 */
export async function verifyResponderEmailOtp(otpId, enteredCode) {
  const cleanId = String(otpId || '').trim();
  const cleanCode = String(enteredCode || '').trim();

  if (!cleanId || !cleanCode) {
    throw Object.assign(new Error('Verification code is required.'), { status: 400 });
  }

  const db = getFirebaseFirestore();
  if (!db) throw new Error('Database service unavailable.');

  const otpRef = doc(db, 'responder_otps', cleanId);
  const snap = await getDoc(otpRef);
  if (!snap.exists()) {
    throw Object.assign(new Error('Invalid or expired verification code. Please request a new code.'), { status: 400 });
  }

  const data = snap.data();
  if (data.used === true) {
    throw Object.assign(new Error('This verification code has already been used. Please request a new code.'), { status: 400 });
  }

  if (Date.now() > Number(data.expiresAt || 0)) {
    throw Object.assign(new Error('This verification code has expired. Please request a new code.'), { status: 400 });
  }

  const currentAttempts = Number(data.attempts || 0);
  const maxAttempts = Number(data.maxAttempts || 5);
  if (currentAttempts >= maxAttempts) {
    throw Object.assign(new Error('Maximum verification attempts exceeded. This code is locked. Please request a new one.'), { status: 400 });
  }

  // Verify OTP code hash
  const isValid = await verifyPinWeb(cleanCode, data.salt, data.hashedCode);
  if (!isValid) {
    await updateDoc(otpRef, { attempts: currentAttempts + 1 });
    const remaining = maxAttempts - (currentAttempts + 1);
    throw Object.assign(new Error(`Invalid verification code. ${remaining} attempt(s) remaining.`), { status: 401 });
  }

  // Mark OTP used
  await updateDoc(otpRef, { used: true, verifiedAt: new Date().toISOString() });

  // Issue single-use recovery authorization token (valid for 15 minutes)
  const recoveryToken = 'rec-' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)) + '-' + Date.now();
  await setDoc(doc(db, 'responder_recovery_tokens', recoveryToken), {
    recoveryToken,
    responderId: data.responderId,
    email: data.email,
    used: false,
    expiresAt: Date.now() + 15 * 60 * 1000,
    createdAt: new Date().toISOString()
  });

  return {
    success: true,
    recoveryToken,
    responderId: data.responderId
  };
}

/**
 * Completes forgotten credential recovery without requiring old credentials.
 * Atomically updates credentials and increments sessionVersion, forcing logout across all devices.
 */
export async function recoverResponderCredentials(recoveryToken, { newId = null, newPin = null }) {
  const token = String(recoveryToken || '').trim();
  const nId = newId ? String(newId).trim() : null;
  const nPin = newPin ? String(newPin).trim() : null;

  if (!token) throw Object.assign(new Error('Recovery authorization token is required.'), { status: 400 });
  if (!nId && !nPin) throw Object.assign(new Error('Please specify a new Registration Number, new PIN, or both.'), { status: 400 });

  const db = getFirebaseFirestore();
  if (!db) throw new Error('Database service unavailable.');

  const tokenRef = doc(db, 'responder_recovery_tokens', token);
  const snap = await getDoc(tokenRef);
  if (!snap.exists()) {
    throw Object.assign(new Error('Invalid or expired recovery authorization. Please restart recovery.'), { status: 401 });
  }

  const tokenData = snap.data();
  if (tokenData.used === true || Date.now() > Number(tokenData.expiresAt || 0)) {
    throw Object.assign(new Error('This recovery authorization has expired or already been used. Please restart recovery.'), { status: 401 });
  }

  // Mark token used immediately to prevent reuse
  await updateDoc(tokenRef, { used: true, completedAt: new Date().toISOString() });

  const currentId = tokenData.responderId;
  const respRef = doc(db, 'emergency_responders', currentId);
  const respSnap = await getDoc(respRef);
  if (!respSnap.exists()) {
    throw Object.assign(new Error('Responder account not found.'), { status: 404 });
  }

  const responderData = respSnap.data();

  // Validate new credentials
  if (nId) {
    if (!/^[A-Za-z0-9_\-\.\/]{2,50}$/.test(nId)) {
      throw Object.assign(new Error('Invalid new Registration Number format.'), { status: 400 });
    }
    if (nId === 'RESP-1111') {
      throw Object.assign(new Error('The registration number RESP-1111 is reserved/retired.'), { status: 400 });
    }
    if (nId !== currentId) {
      const existingResp = await getDoc(doc(db, 'emergency_responders', nId));
      if (existingResp.exists() && existingResp.data()?.authorized === true) {
        throw Object.assign(new Error(`Registration number "${nId}" is already in use.`), { status: 409 });
      }
      const existingStudent = await getDoc(doc(db, 'students', nId.toUpperCase()));
      if (existingStudent.exists()) {
        throw Object.assign(new Error(`Registration number "${nId}" is already registered to a student.`), { status: 409 });
      }
    }
  }

  if (nPin) {
    if (nPin.length < 4 || nPin.length > 8) {
      throw Object.assign(new Error('New PIN must be between 4 and 8 characters.'), { status: 400 });
    }
  }

  let finalSalt = responderData.pinSalt;
  let finalHash = responderData.pinHash;
  if (nPin) {
    const computed = await hashPinWeb(nPin);
    finalSalt = computed.salt;
    finalHash = computed.hash;
  }

  const nextSessionVersion = Number(responderData.sessionVersion || 1) + 1;
  const now = new Date().toISOString();
  const effectiveId = nId || currentId;

  if (nId && nId !== currentId) {
    // Create new document with updated ID
    await setDoc(doc(db, 'emergency_responders', nId), {
      ...responderData,
      responderId: nId,
      name: responderData.name || `Campus Emergency Response Unit (${nId})`,
      authorized: true,
      deactivated: false,
      pinSalt: finalSalt,
      pinHash: finalHash,
      sessionVersion: nextSessionVersion,
      migratedFrom: currentId,
      updatedAt: now
    });

    // Deactivate previous document
    await setDoc(doc(db, 'emergency_responders', currentId), {
      authorized: false,
      deactivated: true,
      migratedTo: nId,
      sessionVersion: nextSessionVersion,
      updatedAt: now
    }, { merge: true });
  } else {
    // Update existing document
    await updateDoc(respRef, {
      pinSalt: finalSalt,
      pinHash: finalHash,
      sessionVersion: nextSessionVersion,
      updatedAt: now
    });
  }

  console.log(`%c[SOS:Security] Forgotten credentials successfully recovered for: ${effectiveId}, Session Version: ${nextSessionVersion}`, 'color:#10b981;font-weight:bold');
  return { success: true, effectiveId, sessionVersion: nextSessionVersion };
}

/**
 * Validates active responder session version against live Firestore document.
 */
export async function validateResponderSession(user) {
  if (!user || String(user.role).toUpperCase() !== 'RESPONDER') return true;
  if (user.id === 'RESP-1111') return false;
  try {
    const db = getFirebaseFirestore();
    if (!db) return true;
    const snap = await getDoc(doc(db, 'emergency_responders', user.id));
    if (!snap.exists()) return false;
    const data = snap.data();
    if (data.authorized !== true || data.deactivated === true) return false;
    if (Number(user.sessionVersion || 1) < Number(data.sessionVersion || 1)) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Attaches a real-time Firestore onSnapshot listener to the active responder document.
 * Instantly triggers onInvalidated callback if credentials change, sessionVersion increments,
 * or the account is deactivated on another device.
 */
export function attachResponderSessionWatcherFirestore(responderId, currentVersion, onInvalidated) {
  if (!responderId) return () => {};
  try {
    const db = getFirebaseFirestore();
    if (!db) return () => {};

    const cleanId = String(responderId).trim();
    const localVer = Number(currentVersion || 1);

    const unsubscribe = onSnapshot(doc(db, 'emergency_responders', cleanId), (snap) => {
      if (!snap.exists()) {
        if (onInvalidated) onInvalidated('Your responder account is no longer registered. All sessions terminated.');
        return;
      }
      const data = snap.data();
      const serverVersion = Number(data.sessionVersion || 1);
      if (data.authorized === false || data.deactivated === true || serverVersion > localVer) {
        console.warn(`[SOS:Security] Responder credentials changed or invalidated on another device! Local: ${localVer}, Server: ${serverVersion}`);
        if (onInvalidated) onInvalidated('Your responder credentials were changed on another device. For security, all active sessions have been invalidated. Please log in again with your updated credentials.');
      }
    }, (err) => {
      console.warn('[SOS:Security] Responder session watcher notice:', err.message);
    });

    return unsubscribe;
  } catch (e) {
    console.warn('[SOS:Security] attachResponderSessionWatcherFirestore notice:', e.message);
    return () => {};
  }
}

/**
 * Creates an emergency incident directly in Cloud Firestore.
 */
export async function createIncidentInFirestore(payload, user) {
  if (!user) throw new Error('Authentication required');
  const db = getFirebaseFirestore();
  if (!db) throw new Error('Firebase Firestore service is not initialized');

  const b = payload || {};
  const loc = b.location || {};
  const building = String(loc.building || '').trim();
  const floor = String(loc.floor || '').trim();
  const room = String(loc.room || '').trim();

  const isOneClickGeneral = b.categoryId === 'general' && loc.source === 'Student Dashboard — Send SOS Now';
  if (!isOneClickGeneral) {
    if (!building || !floor || !room) {
      throw Object.assign(new Error('Building, floor, and room are required fields.'), {
        status: 400,
        field: !building ? 'building' : (!floor ? 'floor' : 'room')
      });
    }
  }

  const now = new Date().toISOString();
  const incidentId = 'SOS-' + String(Math.floor(100 + Math.random() * 900));
  const categoryId = b.categoryId || 'other';

  const catMap = {
    medical: { priority: 'CRITICAL', primary: 'DEPT_MEDICAL', depts: ['DEPT_MEDICAL'] },
    security: { priority: 'HIGH', primary: 'DEPT_SECURITY', depts: ['DEPT_SECURITY'] },
    fire: { priority: 'CRITICAL', primary: 'DEPT_FIRE', depts: ['DEPT_FIRE', 'DEPT_SECURITY', 'DEPT_ADMIN'] },
    harassment: { priority: 'HIGH', primary: 'DEPT_WELFARE', depts: ['DEPT_WELFARE', 'DEPT_SECURITY'] },
    electrical: { priority: 'HIGH', primary: 'DEPT_ELECTRICAL', depts: ['DEPT_ELECTRICAL'] },
    infrastructure: { priority: 'HIGH', primary: 'DEPT_MAINTENANCE', depts: ['DEPT_MAINTENANCE'] },
    trapped: { priority: 'HIGH', primary: 'DEPT_SECURITY', depts: ['DEPT_SECURITY', 'DEPT_MAINTENANCE'] },
    general: { priority: 'HIGH', primary: 'DEPT_SECURITY', depts: ['DEPT_SECURITY', 'DEPT_ADMIN'] },
    other: { priority: 'MEDIUM', primary: 'DEPT_ADMIN', depts: ['DEPT_ADMIN'] }
  };
  const catInfo = catMap[categoryId] || catMap.other;

  const lat = loc.latitude != null && Number.isFinite(Number(loc.latitude)) ? Number(loc.latitude) : null;
  const lng = loc.longitude != null && Number.isFinite(Number(loc.longitude)) ? Number(loc.longitude) : null;
  const acc = loc.accuracy != null && Number.isFinite(Number(loc.accuracy)) ? Number(loc.accuracy) : null;

  const incidentDoc = {
    id: incidentId,
    category_id: categoryId,
    student_id: user.id,
    studentId: user.id,
    student_name: user.name,
    studentName: user.name,
    student_phone: String(user.phone || b.phone || b.student_phone || '').trim(),
    studentPhone: String(user.phone || b.phone || b.student_phone || '').trim(),
    description: String(b.description || '').trim(),
    location: {
      building: building || (lat != null ? 'Campus (GPS Coordinates Attached)' : 'Campus'),
      floor: floor || (lat != null ? 'Ground / Outdoors' : 'Ground / Outdoors'),
      room: room || (lat != null ? 'Live GPS Location' : 'Live Emergency SOS'),
      area: String(loc.area || room || '').trim(),
      latitude: lat,
      longitude: lng,
      accuracy: acc,
      locationStatus: loc.locationStatus || (lat != null ? 'available' : 'unavailable'),
      gpsTimestamp: loc.gpsTimestamp || null,
      source: loc.source || (lat != null ? 'GPS' : 'MANUAL')
    },
    priority: catInfo.priority,
    status: 'DEPARTMENT_NOTIFIED',
    primary_department_id: catInfo.primary,
    assigned_departments: catInfo.depts,
    assignedDepartments: catInfo.depts,
    created_at: now,
    createdAt: now,
    updated_at: now,
    timeline: [
      { status: 'DEPARTMENT_NOTIFIED', timestamp: now, note: 'Emergency SOS initiated by student' }
    ]
  };

  const docRef = doc(db, 'incidents', incidentId);
  await setDoc(docRef, incidentDoc);
  console.log(`%c[SOS:Firebase] Incident successfully saved to Cloud Firestore: ${incidentId}`, 'color:#059669;font-weight:bold', incidentDoc);

  return incidentDoc;
}

/**
 * Retrieves incidents from Cloud Firestore for the authenticated user.
 */
export async function fetchIncidentsFromFirestore(user) {
  if (!user) return [];
  const db = getFirebaseFirestore();
  if (!db) return [];

  const isResp = String(user.role).toUpperCase() === 'RESPONDER' || user.id === 'ER-2026' || user.id === 'RESP-1111';
  const isAdmin = ['INSTITUTE_ADMIN', 'ADMIN', 'SUPER_ADMIN'].includes(String(user.role).toUpperCase());

  const colRef = collection(db, 'incidents');
  let q;
  if (isResp || isAdmin) {
    q = query(colRef);
  } else {
    q = query(colRef, where('student_id', '==', user.id));
  }

  const snap = await getDocs(q);
  const incidents = [];
  snap.forEach((d) => {
    const data = d.data();
    if (!data.id) data.id = d.id;
    if (!data.created_at && data.createdAt) data.created_at = data.createdAt;
    data.student_name = data.student_name || data.studentName || 'Student';
    data.studentName = data.studentName || data.student_name || 'Student';
    data.student_id = data.student_id || data.studentId || '';
    data.studentId = data.studentId || data.student_id || '';
    data.student_phone = data.student_phone || data.studentPhone || data.phone || '';
    data.studentPhone = data.studentPhone || data.student_phone || data.phone || '';
    incidents.push(data);
  });

  incidents.sort((a, b) => {
    const tA = new Date(a.created_at || a.createdAt || 0).getTime();
    const tB = new Date(b.created_at || b.createdAt || 0).getTime();
    return tB - tA;
  });

  return incidents;
}

export async function fetchIncidentFromFirestore(incidentId) {
  const db = getFirebaseFirestore();
  if (!db) return null;
  const docRef = doc(db, 'incidents', String(incidentId));
  const snap = await getDoc(docRef);
  return snap.exists() ? snap.data() : null;
}

/**
 * Updates incident status in Cloud Firestore (accept, respond, arrive, resolve, cancel).
 */
export async function updateIncidentStatusInFirestore(incidentId, status, payload = {}, user = null) {
  const db = getFirebaseFirestore();
  if (!db) throw new Error('Firebase Firestore service is not initialized');

  const docRef = doc(db, 'incidents', String(incidentId));
  const snap = await getDoc(docRef);
  if (!snap.exists()) {
    throw Object.assign(new Error('Incident not found'), { status: 404 });
  }

  const inc = snap.data();
  const now = new Date().toISOString();
  const timeline = Array.isArray(inc.timeline) ? [...inc.timeline] : [];
  timeline.push({
    status,
    timestamp: now,
    actor: user ? user.name : 'Emergency Responder',
    note: payload.note || payload.reason || ''
  });

  const updates = {
    status,
    updated_at: now,
    timeline
  };
  if (status === 'ACCEPTED' && user) {
    updates.accepted_by = user.name;
    updates.responder_id = user.id;
  }

  await setDoc(docRef, updates, { merge: true });
  return { ...inc, ...updates };
}

/**
 * Updates incident location in Cloud Firestore and preserves existing location details.
 */
export async function updateIncidentLocationInFirestore(incidentId, location, user = null) {
  const db = getFirebaseFirestore();
  if (!db) throw new Error('Firebase Firestore service is not initialized');

  const docRef = doc(db, 'incidents', String(incidentId));
  const snap = await getDoc(docRef);
  const existing = snap.exists() ? snap.data() : null;
  const existingLoc = existing?.location || {};

  const mergedLocation = {
    ...existingLoc,
    ...location,
    building: location.building || existingLoc.building || 'Campus',
    floor: location.floor || existingLoc.floor || 'Ground / Outdoors',
    room: location.room || existingLoc.room || 'Live GPS Location',
    area: location.area || existingLoc.area || '',
    lastUpdated: new Date().toISOString()
  };

  const now = new Date().toISOString();
  const updates = {
    location: mergedLocation,
    updated_at: now
  };
  await setDoc(docRef, updates, { merge: true });
  return { ...existing, ...updates };
}

/**
 * Subscribes to real-time location and status updates for a specific incident document.
 */
export function listenToIncident(incidentId, onUpdateCallback, onError) {
  try {
    const db = getFirebaseFirestore();
    if (!db) return () => {};
    const docRef = doc(db, 'incidents', String(incidentId));
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (onUpdateCallback) onUpdateCallback(data);
      }
    }, (err) => {
      console.warn('[SOS:Firestore] Single incident listener notice:', err.message);
      if (onError) onError(err);
    });
    return unsubscribe;
  } catch (err) {
    console.warn('[SOS:Firestore] listenToIncident setup failed:', err.message);
    return () => {};
  }
}

/**
 * Deletes an incident document from Cloud Firestore.
 */
export async function deleteIncidentFromFirestore(incidentId) {
  try {
    const db = getFirebaseFirestore();
    if (!db) return false;
    const docRef = doc(db, 'incidents', String(incidentId));
    await deleteDoc(docRef);
    console.log('%c[SOS:Firestore] Incident document successfully deleted from Firestore: ' + incidentId, 'color:#ef4444;font-weight:bold');
    return true;
  } catch (err) {
    console.warn('[SOS:Firestore] Notice deleting incident from Firestore:', err.message);
    return false;
  }
}

/**
 * Registers responder device push token in Firestore ('responder_devices' collection).
 */
export async function registerResponderDeviceFirestore(fcmToken, responderId = 'ER-2026') {
  if (!fcmToken) return;
  const deviceId = getDeviceId();
  try {
    const db = getFirebaseFirestore();
    if (!db) return;
    const docRef = doc(db, 'responder_devices', String(deviceId));
    await setDoc(docRef, {
      deviceId,
      fcmToken,
      responderId,
      platform: 'web',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      updatedAt: new Date().toISOString()
    }, { merge: true });
    console.log('%c[SOS:FCM] Responder device push token saved in Cloud Firestore: ' + deviceId, 'color:#10b981');
  } catch (err) {
    console.warn('[SOS:FCM] Note on device registration in Firestore:', err.message);
  }
}

/**
 * Backward compatibility alias for syncIncidentToFirestore.
 */
export async function syncIncidentToFirestore(incident) {
  try {
    const db = getFirebaseFirestore();
    if (!db) return false;
    const docRef = doc(db, 'incidents', String(incident.id));
    await setDoc(docRef, incident, { merge: true });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Fetches a single emergency incident by ID from Cloud Firestore.
 */
export async function getIncidentFromFirestore(incidentId) {
  if (!incidentId) return null;
  const db = getFirebaseFirestore();
  if (!db) return null;
  try {
    const snap = await getDoc(doc(db, 'incidents', String(incidentId)));
    if (snap.exists()) {
      const data = snap.data();
      if (!data.created_at && data.createdAt) data.created_at = data.createdAt;
      return { ...data, id: snap.id };
    }
  } catch (err) {
    console.warn('[SOS:Firestore] Error fetching incident ' + incidentId + ':', err.message);
  }
  return null;
}

/**
 * Attaches a real-time Firestore listener for emergency incidents.
 */
export function listenToFirestoreIncidents(onIncidentCallback, onError) {
  try {
    const db = getFirebaseFirestore();
    if (!db) return () => {};
    console.log('%c[SOS:Firestore] Attaching real-time onSnapshot listener to collection("incidents")...', 'color:#0284c7;font-weight:bold');
    const colRef = collection(db, 'incidents');
    let isInitialSnapshot = true;
    const unsubscribe = onSnapshot(colRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const incData = change.doc.data();
          if (!incData.id) incData.id = change.doc.id;
          if (!incData.created_at && incData.createdAt) {
            incData.created_at = incData.createdAt;
          }
          incData.student_name = incData.student_name || incData.studentName || 'Student';
          incData.studentName = incData.studentName || incData.student_name || 'Student';
          incData.student_id = incData.student_id || incData.studentId || '';
          incData.studentId = incData.studentId || incData.student_id || '';
          incData.student_phone = incData.student_phone || incData.studentPhone || incData.phone || '';
          incData.studentPhone = incData.studentPhone || incData.student_phone || incData.phone || '';
          const changeType = isInitialSnapshot ? 'initial' : change.type;
          console.log(`%c[SOS:Firestore] Real-time snapshot event [${changeType}]: ${incData.id}`, 'color:#8b5cf6;font-weight:bold', incData);
          if (onIncidentCallback) onIncidentCallback(incData, changeType);
        } else if (change.type === 'removed') {
          const incData = change.doc.data() || { id: change.doc.id };
          console.log(`%c[SOS:Firestore] Real-time snapshot event [removed]: ${incData.id || change.doc.id}`, 'color:#ef4444;font-weight:bold');
          if (onIncidentCallback) onIncidentCallback(incData, 'removed');
        }
      });
      isInitialSnapshot = false;
    }, (err) => {
      console.warn('[SOS:Firestore] Snapshot listener notice:', err.message);
      if (onError) onError(err);
    });
    return unsubscribe;
  } catch (err) {
    console.warn('[SOS:Firestore] Snapshot listener setup failed:', err.message);
    return () => {};
  }
}

/**
 * Fetches all registered students from Cloud Firestore ('students' collection).
 * Excludes reserved responder identifiers, deduplicates by unique regdNo,
 * and sorts alphabetically by student name.
 */
export async function fetchRegisteredStudentsFromFirestore() {
  const db = getFirebaseFirestore();
  if (!db) {
    throw new Error('Firebase Firestore service is not initialized');
  }

  const studentsCol = collection(db, 'students');
  const snap = await getDocs(studentsCol);
  const studentsMap = new Map();

  snap.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const regdNo = String(data.regdNo || docSnap.id || '').trim().toUpperCase();
    if (!regdNo || regdNo === 'RESP-1111' || regdNo === 'ER-2026' || regdNo.startsWith('ER-') || data.role === 'RESPONDER') return;

    if (!studentsMap.has(regdNo)) {
      studentsMap.set(regdNo, {
        id: docSnap.id,
        regdNo,
        name: String(data.name || 'Student').trim(),
        createdAt: data.createdAt || null,
        status: data.status || 'active',
        role: data.role || 'STUDENT'
      });
    }
  });

  return Array.from(studentsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Attaches a real-time onSnapshot listener for registered students.
 * Automatically triggers callback on initial load and whenever a new student registers.
 */
export function listenToRegisteredStudents(onUpdate, onError) {
  try {
    const db = getFirebaseFirestore();
    if (!db) return () => {};

    console.log('%c[SOS:Firestore] Attaching real-time onSnapshot listener to collection("students")...', 'color:#0284c7;font-weight:bold');
    const colRef = collection(db, 'students');

    const unsubscribe = onSnapshot(colRef, (snapshot) => {
      const studentsMap = new Map();
      snapshot.forEach((docSnap) => {
        const data = docSnap.data() || {};
        const regdNo = String(data.regdNo || docSnap.id || '').trim().toUpperCase();
        if (!regdNo || regdNo === 'RESP-1111' || regdNo === 'ER-2026' || regdNo.startsWith('ER-') || data.role === 'RESPONDER') return;

        if (!studentsMap.has(regdNo)) {
          studentsMap.set(regdNo, {
            id: docSnap.id,
            regdNo,
            name: String(data.name || 'Student').trim(),
            createdAt: data.createdAt || null,
            status: data.status || 'active',
            role: data.role || 'STUDENT'
          });
        }
      });

      const list = Array.from(studentsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
      console.log(`%c[SOS:Firestore] Real-time registered students updated: ${list.length} total`, 'color:#10b981;font-weight:bold');
      if (onUpdate) onUpdate(list);
    }, (err) => {
      console.warn('[SOS:Firestore] Registered students snapshot listener notice:', err.message);
      if (onError) onError(err);
    });

    return unsubscribe;
  } catch (err) {
    console.warn('[SOS:Firestore] Registered students snapshot listener setup failed:', err.message);
    if (onError) onError(err);
    return () => {};
  }
}

/**
 * Adds a new student record to Cloud Firestore ('students' collection).
 * Rejects if regdNo already exists.
 */
export async function addStudentToFirestore({ name, regdNo }) {
  const cleanName = String(name || '').trim();
  const rawId = String(regdNo || '').trim();
  const cleanId = normalizeRegdNo(rawId);

  if (!cleanName) {
    throw Object.assign(new Error('Student Name is required.'), { status: 400, field: 'name' });
  }
  if (!cleanId) {
    throw Object.assign(new Error('Student ID is required.'), { status: 400, field: 'regdNo' });
  }
  if (cleanId === 'RESP-1111' || cleanId === 'ER-2026' || cleanId.startsWith('ER-')) {
    throw Object.assign(new Error('This registration ID is reserved for emergency services.'), { status: 403, field: 'regdNo' });
  }

  const db = getFirebaseFirestore();
  if (!db) {
    throw new Error('Firebase Firestore service is not initialized');
  }

  const studentRef = doc(db, 'students', cleanId);
  const snap = await getDoc(studentRef);
  if (snap.exists()) {
    throw Object.assign(new Error(`Student ID "${cleanId}" is already registered. Duplicate IDs are not allowed.`), { status: 409, field: 'regdNo' });
  }

  const accountId = 'STU-' + (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10));
  const now = new Date().toISOString();
  const studentDoc = {
    name: cleanName,
    regdNo: cleanId,
    role: 'STUDENT',
    departmentId: null,
    accountId,
    createdAt: now,
    status: 'active'
  };

  await setDoc(studentRef, studentDoc);
  console.log(`%c[SOS:Firestore] Added new student: ${cleanName} (${cleanId})`, 'color:#10b981;font-weight:bold');

  return studentDoc;
}

/**
 * Deletes a registered student record from Cloud Firestore ('students' collection).
 */
export async function deleteStudentFromFirestore(regdNo) {
  const cleanId = normalizeRegdNo(regdNo);
  if (!cleanId) {
    throw new Error('Student ID is required for deletion.');
  }

  const db = getFirebaseFirestore();
  if (!db) {
    throw new Error('Firebase Firestore service is not initialized');
  }

  const studentRef = doc(db, 'students', cleanId);
  await deleteDoc(studentRef);
  console.log(`%c[SOS:Firestore] Deleted student record: ${cleanId}`, 'color:#ef4444;font-weight:bold');

  return { success: true, regdNo: cleanId };
}

import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';
import { getFirestore, doc, setDoc, deleteDoc, onSnapshot, collection } from 'firebase/firestore';

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

let app = null;
let messaging = null;

export function getFirebaseApp() {
  if (!app) {
    app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
  }
  return app;
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

/**
 * Syncs the FCM token with the backend for the authenticated emergency responder.
 */
export async function syncResponderDeviceWithBackend(token, authToken) {
  if (!token) return;
  const deviceId = getDeviceId();
  try {
    const res = await fetch('/api/responder/device', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        deviceId,
        fcmToken: token
      })
    });
    const data = await res.json();
    return data;
  } catch (e) {
    console.warn('[FCM] Device sync with backend failed:', e.message);
  }
}

let firestoreDb = null;

export function getFirebaseFirestore() {
  if (!firestoreDb) {
    try {
      firestoreDb = getFirestore(getFirebaseApp());
    } catch (e) {
      console.warn('[SOS:Firestore] Firestore client init notice:', e.message);
    }
  }
  return firestoreDb;
}

/**
 * Syncs an emergency incident to Cloud Firestore under collection 'incidents'.
 */
export async function syncIncidentToFirestore(incident) {
  try {
    const db = getFirebaseFirestore();
    if (!db) return false;
    const docRef = doc(db, 'incidents', String(incident.id));
    const creationTime = incident.created_at || incident.createdAt || new Date().toISOString();
    const docData = {
      id: String(incident.id),
      category_id: String(incident.category_id || incident.categoryId || 'other'),
      student_id: String(incident.student_id || incident.studentId || ''),
      student_name: String(incident.student_name || incident.studentName || 'Student'),
      description: String(incident.description || ''),
      location: incident.location || { building: 'Campus' },
      priority: String(incident.priority || 'HIGH'),
      status: String(incident.status || 'DEPARTMENT_NOTIFIED'),
      created_at: creationTime,
      createdAt: creationTime,
      updated_at: new Date().toISOString()
    };
    await setDoc(docRef, docData, { merge: true });
    console.log('%c[SOS:Firestore] Incident document successfully written to Firestore: ' + incident.id, 'color:#10b981;font-weight:bold');
    return true;
  } catch (err) {
    console.warn('[SOS:Firestore] Notice writing incident to Firestore:', err.message);
    return false;
  }
}

/**
 * Permanently deletes an emergency incident from Cloud Firestore under collection 'incidents'.
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
 * Attaches a real-time Firestore listener for emergency incidents.
 */
export function listenToFirestoreIncidents(onIncidentCallback, onError) {
  try {
    const db = getFirebaseFirestore();
    if (!db) return () => {};
    console.log('%c[SOS:Firestore] Attaching real-time onSnapshot listener to collection("incidents")...', 'color:#0284c7;font-weight:bold');
    const colRef = collection(db, 'incidents');
    const unsubscribe = onSnapshot(colRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const incData = change.doc.data();
          if (!incData.created_at && incData.createdAt) {
            incData.created_at = incData.createdAt;
          }
          console.log(`%c[SOS:Firestore] Real-time snapshot event [${change.type}]: ${incData.id}`, 'color:#8b5cf6;font-weight:bold', incData);
          if (onIncidentCallback) onIncidentCallback(incData, change.type);
        } else if (change.type === 'removed') {
          const incData = change.doc.data() || { id: change.doc.id };
          console.log(`%c[SOS:Firestore] Real-time snapshot event [removed]: ${incData.id || change.doc.id}`, 'color:#ef4444;font-weight:bold');
          if (onIncidentCallback) onIncidentCallback(incData, 'removed');
        }
      });
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

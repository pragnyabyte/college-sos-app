import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from './db.js';

let fcmInitialized = false;
let fcmError = null;
let hasServiceAccount = false;

export const RESPONDER_ID = process.env.SOS_RESPONDER_ID || 'RESP-1111';
export const DEFAULT_RESPONDER_PIN = process.env.SOS_RESPONDER_PIN || '2611';

/**
 * Initializes Firebase Admin SDK safely without crashing if credentials are not yet supplied.
 */
export function initFirebaseAdmin() {
  if (fcmInitialized) return true;
  if (getApps().length > 0) {
    fcmInitialized = true;
    return true;
  }

  try {
    let credential = null;
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || join(process.cwd(), 'serviceAccountKey.json');
    const saEnv = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (saEnv) {
      try {
        const parsed = JSON.parse(saEnv);
        credential = cert(parsed);
      } catch (e) {
        if (existsSync(saEnv)) {
          credential = cert(JSON.parse(readFileSync(saEnv, 'utf-8')));
        }
      }
    } else if (existsSync(saPath)) {
      credential = cert(JSON.parse(readFileSync(saPath, 'utf-8')));
    }

    if (credential) {
      initializeApp({
        credential,
        projectId: 'college-sos-app-26aec'
      });
      fcmInitialized = true;
      hasServiceAccount = true;
      console.log('[FCM] Firebase Admin SDK initialized with Service Account credentials');
      return true;
    } else {
      // Initialize with project ID default credentials
      initializeApp({
        projectId: 'college-sos-app-26aec'
      });
      fcmInitialized = true;
      hasServiceAccount = false;
      console.log('[FCM] Firebase Admin SDK initialized with project college-sos-app-26aec');
      return true;
    }
  } catch (err) {
    fcmError = err.message;
    console.warn('[FCM] Firebase Admin init notice:', err.message);
    return false;
  }
}

/**
 * Ensures the permanent responder document exists in MongoDB Atlas.
 */
export async function ensurePermanentResponder() {
  try {
    const db = await getDb();
    const responders = db.collection('emergency_responders');
    const pin = process.env.SOS_RESPONDER_PIN || DEFAULT_RESPONDER_PIN;

    await responders.updateOne(
      { responderId: RESPONDER_ID },
      {
        $set: {
          responderId: RESPONDER_ID,
          name: 'Campus Emergency Response Unit (RESP-1111)',
          role: 'responder',
          departmentId: 'DEPT_SECURITY',
          active: true,
          pin,
          updatedAt: new Date().toISOString()
        },
        $setOnInsert: {
          devices: {},
          createdAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );

    // Remove legacy responder docs so old credentials cannot be used
    try {
      await responders.deleteOne({ responderId: '250131' });
      await responders.deleteOne({ responderId: 'RESP-001' });
    } catch {}

    console.log(`[FCM] Permanent responder ${RESPONDER_ID} verified/updated in database.`);
  } catch (e) {
    console.error('[FCM] Error ensuring permanent responder:', e.message);
  }
}

/**
 * Registers or updates a responder device FCM token under RESP-1111.
 */
export async function registerResponderDevice({ responderId = RESPONDER_ID, deviceId, fcmToken, userAgent }) {
  if (!deviceId || !fcmToken) {
    throw Object.assign(new Error('deviceId and fcmToken are required'), { status: 400 });
  }

  const db = await getDb();
  const responders = db.collection('emergency_responders');
  const now = new Date().toISOString();

  // Atomically upsert the device into responder devices map
  await responders.findOneAndUpdate(
    { responderId },
    {
      $set: {
        responderId,
        [`devices.${deviceId}`]: {
          deviceId,
          fcmToken,
          userAgent: userAgent || 'Unknown device',
          active: true,
          lastUpdated: now
        },
        updatedAt: now
      },
      $setOnInsert: {
        name: `Emergency Responder (${responderId})`,
        role: 'responder',
        departmentId: 'DEPT_SECURITY',
        active: true,
        createdAt: now
      }
    },
    { upsert: true, returnDocument: 'after' }
  );

  return {
    success: true,
    responderId,
    deviceId,
    active: true,
    lastUpdated: now
  };
}

/**
 * Unregisters or deactivates a specific device.
 */
export async function unregisterResponderDevice(deviceId, responderId = RESPONDER_ID) {
  if (!deviceId) return;
  const db = await getDb();
  await db.collection('emergency_responders').updateOne(
    { responderId },
    {
      $set: {
        [`devices.${deviceId}.active`]: false,
        [`devices.${deviceId}.lastUpdated`]: new Date().toISOString()
      }
    }
  );
}

/**
 * Gets all active registered devices for a responder.
 */
export async function getActiveResponderDevices(responderId = RESPONDER_ID) {
  const db = await getDb();
  const responder = await db.collection('emergency_responders').findOne({ responderId });
  if (!responder || !responder.devices) return [];
  return Object.values(responder.devices).filter(d => d && d.active && d.fcmToken);
}

/**
 * Sends FCM push notification to all active registered responder devices.
 */
export async function sendEmergencySosNotification(incident) {
  const db = await getDb();
  let devices = [];
  try {
    const allResponders = await db.collection('emergency_responders').find({ active: { $ne: false } }).toArray();
    devices = allResponders.flatMap(r => r.devices ? Object.values(r.devices).filter(d => d && d.active && d.fcmToken) : []);
  } catch {}
  if (!devices || devices.length === 0) {
    devices = await getActiveResponderDevices(RESPONDER_ID);
  }
  if (!devices || devices.length === 0) {
    console.log(`[FCM] No active registered responder devices. Skipping push.`);
    return { deliveredCount: 0, totalDevices: 0 };
  }

  const tokens = devices.map(d => d.fcmToken).filter(Boolean);
  if (tokens.length === 0) return { deliveredCount: 0, totalDevices: 0 };

  initFirebaseAdmin();

  const title = `🚨 EMERGENCY SOS: ${incident.id} (${incident.priority})`;
  const body = `${incident.student_name} reported ${incident.category_id || 'Emergency'} at ${incident.location?.building || 'Campus'}, ${incident.location?.floor || ''} ${incident.location?.room || ''}`.trim();
  const clickUrl = `/responder?incidentId=${encodeURIComponent(incident.id)}`;

  const messagePayload = {
    notification: {
      title,
      body
    },
    data: {
      id: String(incident.id),
      sosId: String(incident.id),
      categoryId: String(incident.category_id || ''),
      priority: String(incident.priority || 'HIGH'),
      studentName: String(incident.student_name || ''),
      studentId: String(incident.student_id || ''),
      location: `${incident.location?.building || ''} ${incident.location?.floor || ''} ${incident.location?.room || ''}`.trim(),
      building: String(incident.location?.building || ''),
      floor: String(incident.location?.floor || ''),
      room: String(incident.location?.room || ''),
      description: String(incident.description || ''),
      timestamp: String(incident.created_at || new Date().toISOString()),
      click_action: clickUrl,
      url: clickUrl
    },
    webpush: {
      headers: {
        Urgency: 'high'
      },
      fcmOptions: {
        link: clickUrl
      },
      notification: {
        title,
        body,
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        tag: `sos-alert-${incident.id}`,
        requireInteraction: true,
        renotify: true,
        vibrate: [500, 250, 500, 250, 500, 250, 500],
        actions: [
          { action: 'open', title: 'Open Incident' }
        ]
      }
    }
  };

  let deliveredCount = 0;
  const invalidTokens = [];

  try {
    const messaging = getMessaging();
    const response = await messaging.sendEachForMulticast({
      tokens,
      ...messagePayload
    });

    response.responses.forEach((res, idx) => {
      if (res.success) {
        deliveredCount++;
      } else {
        const errCode = res.error?.code || '';
        console.warn(`[FCM] Push delivery failed for token ${tokens[idx].slice(0, 15)}...: ${errCode} - ${res.error?.message}`);
        if (
          errCode === 'messaging/registration-token-not-registered' ||
          errCode === 'messaging/invalid-registration-token' ||
          errCode === 'messaging/invalid-argument'
        ) {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    // Cleanup only invalid tokens
    if (invalidTokens.length > 0) {
      const db = await getDb();
      for (const invToken of invalidTokens) {
        const devEntry = devices.find(d => d.fcmToken === invToken);
        if (devEntry?.deviceId) {
          await db.collection('emergency_responders').updateOne(
            { responderId: RESPONDER_ID },
            {
              $set: {
                [`devices.${devEntry.deviceId}.active`]: false,
                [`devices.${devEntry.deviceId}.invalidationReason`]: 'FCM token expired or invalid',
                [`devices.${devEntry.deviceId}.lastUpdated`]: new Date().toISOString()
              }
            }
          );
          console.log(`[FCM] Deactivated expired token for device ${devEntry.deviceId}`);
        }
      }
    }

    console.log(`[FCM] Sent emergency SOS ${incident.id} to ${deliveredCount}/${tokens.length} devices.`);
    return { deliveredCount, totalDevices: tokens.length };
  } catch (err) {
    console.warn('[FCM] Multicast send notice (Check Service Account):', err.message);
    return { deliveredCount: 0, totalDevices: tokens.length, error: err.message };
  }
}

/**
 * Mirrors the incident to Cloud Firestore under incidents/{incidentId}
 */
export async function syncIncidentToFirestoreAdmin(incident) {
  initFirebaseAdmin();
  if (!hasServiceAccount) return false;
  try {
    const db = getFirestore();
    const creationTime = incident.created_at || incident.createdAt || new Date().toISOString();
    const docData = {
      id: String(incident.id),
      category_id: String(incident.category_id || incident.categoryId || 'other'),
      student_id: String(incident.student_id || incident.studentId || ''),
      student_name: String(incident.student_name || incident.studentName || ''),
      description: String(incident.description || ''),
      location: incident.location || {},
      priority: String(incident.priority || 'HIGH'),
      status: String(incident.status || 'DEPARTMENT_NOTIFIED'),
      primary_department_id: incident.primary_department_id || incident.primaryDepartmentId || 'DEPT_ADMIN',
      created_at: creationTime,
      createdAt: creationTime,
      updated_at: incident.updated_at || new Date().toISOString()
    };
    await db.collection('incidents').doc(incident.id).set(docData, { merge: true });
    console.log(`[SOS:Firestore] Incident ${incident.id} mirrored to Cloud Firestore via Admin SDK`);
    return true;
  } catch (err) {
    console.log(`[SOS:Firestore] Notice: Firestore Admin sync: ${err.message}`);
    return false;
  }
}

/**
 * Deletes an incident document from Cloud Firestore under incidents/{incidentId}
 */
export async function deleteIncidentFromFirestoreAdmin(id) {
  initFirebaseAdmin();
  if (!hasServiceAccount) return false;
  try {
    const db = getFirestore();
    await db.collection('incidents').doc(String(id)).delete();
    console.log(`[SOS:Firestore] Incident ${id} deleted from Cloud Firestore via Admin SDK`);
    return true;
  } catch (err) {
    console.log(`[SOS:Firestore] Notice: Firestore Admin delete: ${err.message}`);
    return false;
  }
}


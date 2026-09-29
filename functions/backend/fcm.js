import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let fcmInitialized = false;
let fcmError = null;
let hasServiceAccount = false;

export const RESPONDER_ID = process.env.SOS_RESPONDER_ID || 'ER-2026';
export const DEFAULT_RESPONDER_PIN = process.env.SOS_RESPONDER_PIN || '2026';

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
 * Ensures the permanent responder document exists in Cloud Firestore.
 */
export async function ensurePermanentResponder() {
  try {
    initFirebaseAdmin();
    if (!hasServiceAccount) {
      console.log('[FCM] Notice: Running in local environment without service account credentials. Permanent responder check skipped.');
      return;
    }
    const firestore = getFirestore();
    const pin = process.env.SOS_RESPONDER_PIN || DEFAULT_RESPONDER_PIN;

    await firestore.collection('emergency_responders').doc(RESPONDER_ID).set({
      responderId: RESPONDER_ID,
      name: 'Campus Emergency Response Unit (ER-2026)',
      role: 'responder',
      departmentId: 'DEPT_SECURITY',
      active: true,
      pin,
      updatedAt: new Date().toISOString()
    }, { merge: true });

    console.log(`[FCM] Permanent responder ${RESPONDER_ID} verified/updated in Cloud Firestore.`);
  } catch (e) {
    console.warn('[FCM] Notice ensuring permanent responder:', e.message);
  }
}

/**
 * Registers or updates a responder device FCM token under ER-2026 in Cloud Firestore.
 * Supports multiple independent phones and web installations per responder.
 */
export async function registerResponderDevice({
  responderId = RESPONDER_ID,
  deviceId,
  installationId,
  fcmToken,
  platform,
  appVersion,
  model,
  userAgent
}) {
  if (!deviceId || !fcmToken) {
    throw Object.assign(new Error('deviceId and fcmToken are required'), { status: 400 });
  }

  initFirebaseAdmin();
  const firestore = getFirestore();
  const now = new Date().toISOString();
  const detectedPlatform = platform || (userAgent?.toLowerCase().includes('android') ? 'android' : 'web');

  const deviceData = {
    deviceId,
    installationId: installationId || deviceId,
    fcmToken,
    responderId,
    platform: detectedPlatform,
    appVersion: appVersion || '1.0.0',
    model: model || (detectedPlatform === 'android' ? 'Android Device' : 'Web Browser'),
    userAgent: userAgent || 'Unknown client',
    active: true,
    lastActiveAt: now,
    lastUpdated: now,
    updatedAt: now
  };

  await firestore.collection('responder_devices').doc(deviceId).set(deviceData, { merge: true });

  // Also ensure responder profile exists in Firestore
  await firestore.collection('emergency_responders').doc(responderId).set({
    responderId,
    name: `Emergency Responder (${responderId})`,
    role: 'responder',
    departmentId: 'DEPT_SECURITY',
    active: true,
    updatedAt: now
  }, { merge: true });

  return {
    success: true,
    responderId,
    deviceId,
    installationId: installationId || deviceId,
    platform: detectedPlatform,
    active: true,
    lastUpdated: now
  };
}

/**
 * Updates last active timestamp for a responder device in Cloud Firestore.
 */
export async function updateDevicePing(deviceId, responderId = RESPONDER_ID) {
  if (!deviceId) return;
  try {
    initFirebaseAdmin();
    const firestore = getFirestore();
    const now = new Date().toISOString();
    await firestore.collection('responder_devices').doc(deviceId).set({
      lastActiveAt: now,
      lastUpdated: now,
      lastPing: now,
      status: 'online'
    }, { merge: true });
  } catch (err) {
    console.warn('[FCM] Device ping notice:', err.message);
  }
}

/**
 * Unregisters or deactivates a specific device (e.g. on phone logout).
 * Other devices of the responder remain completely unaffected.
 */
export async function unregisterResponderDevice(deviceId, responderId = RESPONDER_ID) {
  if (!deviceId) return;
  try {
    initFirebaseAdmin();
    const firestore = getFirestore();
    const now = new Date().toISOString();
    await firestore.collection('responder_devices').doc(deviceId).set({
      active: false,
      lastUpdated: now,
      loggedOutAt: now
    }, { merge: true });
  } catch (err) {
    console.warn('[FCM] Device unregister notice:', err.message);
  }
}

/**
 * Gets active registered devices for a responder from Cloud Firestore.
 * If maskTokens is true, sensitive FCM tokens are securely redacted.
 */
export async function getActiveResponderDevices(responderId = RESPONDER_ID, maskTokens = false) {
  try {
    initFirebaseAdmin();
    const firestore = getFirestore();
    const snap = await firestore.collection('responder_devices').get();
    const list = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d && d.active !== false && d.fcmToken) {
        if (!responderId || d.responderId === responderId) {
          list.push({
            deviceId: d.deviceId || doc.id,
            installationId: d.installationId || d.deviceId || doc.id,
            platform: d.platform || 'web',
            appVersion: d.appVersion || '1.0.0',
            model: d.model || 'Device',
            registeredAt: d.registeredAt || d.lastUpdated || '',
            lastActiveAt: d.lastActiveAt || d.lastUpdated || '',
            active: true,
            fcmToken: maskTokens ? undefined : d.fcmToken,
            fcmTokenMasked: d.fcmToken ? `${d.fcmToken.slice(0, 10)}...${d.fcmToken.slice(-6)}` : ''
          });
        }
      }
    });
    return list;
  } catch (err) {
    console.warn('[FCM] Get devices notice:', err.message);
    return [];
  }
}

/**
 * Checks if a device ID is registered in Cloud Firestore.
 */
export async function isRegisteredDeviceId(deviceId) {
  if (!deviceId) return false;
  try {
    initFirebaseAdmin();
    const firestore = getFirestore();
    const doc = await firestore.collection('responder_devices').doc(deviceId).get();
    return doc.exists;
  } catch {
    return false;
  }
}

/**
 * Logs an event in Cloud Firestore audit logs.
 */
export async function logNotificationAudit(incidentId, event, details = {}) {
  try {
    initFirebaseAdmin();
    const firestore = getFirestore();
    const now = new Date().toISOString();
    const auditEntry = {
      incident_id: String(incidentId),
      event,
      details,
      timestamp: now
    };
    await firestore.collection('notification_audit_logs').add(auditEntry);
    if (incidentId && incidentId !== 'SMS_BROADCAST' && incidentId !== 'VOICE_CALL_BROADCAST') {
      await firestore.collection('incidents').doc(String(incidentId)).collection('audit_logs').add(auditEntry);
    }
  } catch (e) {
    console.warn('[AuditLog] Notice logging audit:', e.message);
  }
}

/**
 * Records device delivery receipt when an Android phone receives the push notification.
 */
export async function recordDeviceReceipt({ incidentId, deviceId, responderId = RESPONDER_ID, clientTimestamp }) {
  const now = new Date().toISOString();
  try {
    initFirebaseAdmin();
    const firestore = getFirestore();
    await firestore.collection('incidents').doc(String(incidentId)).collection('delivery_receipts').doc(String(deviceId)).set({
      deviceId,
      responderId,
      deliveredAt: now,
      clientTimestamp: clientTimestamp || now,
      platform: 'android'
    }, { merge: true });
  } catch (err) {
    console.warn('[FCM] Receipt save notice:', err.message);
  }

  await logNotificationAudit(incidentId, 'DEVICE_DELIVERY_CONFIRMED', {
    deviceId,
    responderId,
    clientTimestamp: clientTimestamp || now,
    serverTimestamp: now
  });
  return { success: true, incidentId, deviceId, receivedAt: now };
}

/**
 * Records when a responder opens/views an emergency alert on their phone.
 */
export async function recordDeviceOpen({ incidentId, deviceId, responderId = RESPONDER_ID, clientTimestamp }) {
  const now = new Date().toISOString();
  try {
    initFirebaseAdmin();
    const firestore = getFirestore();
    await firestore.collection('incidents').doc(String(incidentId)).collection('delivery_receipts').doc(String(deviceId)).set({
      deviceId,
      responderId,
      openedAt: now,
      clientTimestamp: clientTimestamp || now,
      platform: 'android'
    }, { merge: true });
  } catch (err) {
    console.warn('[FCM] Open receipt save notice:', err.message);
  }

  await logNotificationAudit(incidentId, 'NOTIFICATION_DISPLAYED', {
    deviceId,
    responderId,
    clientTimestamp: clientTimestamp || now,
    serverTimestamp: now
  });
  return { success: true, incidentId, deviceId, openedAt: now };
}

/**
 * Checks for unacknowledged incidents older than escalationMinutes and triggers escalation reminder via Cloud Firestore.
 */
export async function checkAndEscalateIncidents(escalationMinutes = 3) {
  try {
    initFirebaseAdmin();
    const firestore = getFirestore();
    const threshold = new Date(Date.now() - escalationMinutes * 60 * 1000).toISOString();

    const snapshot = await firestore.collection('incidents')
      .where('status', '==', 'DEPARTMENT_NOTIFIED')
      .get();

    const results = [];
    for (const doc of snapshot.docs) {
      const incident = doc.data();
      const createdAt = incident.created_at || incident.createdAt || '';
      if (createdAt && createdAt <= threshold && !incident.escalated_at) {
        const now = new Date().toISOString();
        await doc.ref.update({
          escalated_at: now,
          escalation_level: 1,
          updated_at: now
        });

        await logNotificationAudit(incident.id, 'ESCALATION_TRIGGERED', {
          escalated_at: now,
          reason: `Unacknowledged after ${escalationMinutes} minutes`
        });

        const escIncident = {
          ...incident,
          priority: 'CRITICAL',
          description: `⚠️ [ESCALATION REMINDER - UNACKNOWLEDGED]: ${incident.description || 'Immediate response required.'}`
        };
        const pushRes = await sendEmergencySosNotification(escIncident, true);
        results.push({ id: incident.id, pushRes });
      }
    }
    return results;
  } catch (err) {
    console.warn('[Escalation] Notice checking escalation:', err.message);
    return [];
  }
}

/**
 * Helper to pause execution for backoff delay
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sends high-priority emergency FCM push notifications to active registered responder devices.
 * Uses targeted platform payloads:
 * - Android: High-priority data message ensuring SosFirebaseMessagingService.onMessageReceived
 *   is invoked even when screen is locked or app is backgrounded.
 * - Web: notification + webpush headers with requireInteraction, renotify, and vibration.
 * Includes bounded exponential backoff for transient FCM transport errors.
 */
export async function sendEmergencySosNotification(incident, isEscalation = false) {
  initFirebaseAdmin();
  const firestore = getFirestore();
  let devices = [];

  // Query Cloud Firestore 'responder_devices' collection directly (100% Firebase - No external DB)
  try {
    const snap = await firestore.collection('responder_devices').get();
    snap.forEach(doc => {
      const d = doc.data();
      if (d && d.fcmToken && d.active !== false) {
        if (!devices.some(existing => existing.fcmToken === d.fcmToken)) {
          devices.push({
            deviceId: d.deviceId || doc.id,
            fcmToken: d.fcmToken,
            platform: d.platform || 'android',
            responderId: d.responderId || RESPONDER_ID,
            active: true
          });
        }
      }
    });
  } catch (err) {
    console.log('[FCM] Firestore responder_devices query notice:', err.message);
  }

  if (!devices || devices.length === 0) {
    console.log(`[FCM] No active registered responder devices found in Cloud Firestore. Push skipped.`);
    await logNotificationAudit(incident.id, 'NO_DEVICES_REGISTERED', {
      timestamp: new Date().toISOString(),
      note: 'No responder devices currently registered or active in Cloud Firestore'
    });
    return { fcmAcceptedCount: 0, fcmFailedCount: 0, totalDevices: 0, deliveredCount: 0 };
  }

  initFirebaseAdmin();

  const title = isEscalation
    ? `⚠️ URGENT REMINDER: SOS ${incident.id} UNACKNOWLEDGED`
    : `🚨 EMERGENCY SOS: ${incident.id} (${incident.priority})`;
  const locSummary = [incident.location?.building, incident.location?.floor, incident.location?.room].filter(Boolean).join(', ')
    || (incident.location?.latitude != null ? `GPS: ${Number(incident.location.latitude).toFixed(4)}, ${Number(incident.location.longitude).toFixed(4)}` : 'Campus Location');
  const body = `${incident.student_name} reported ${incident.category_id || 'Emergency'} at ${locSummary}`.trim();
  const clickUrl = `/responder?incidentId=${encodeURIComponent(incident.id)}`;

  const commonData = {
    id: String(incident.id),
    sosId: String(incident.id),
    categoryId: String(incident.category_id || ''),
    priority: String(incident.priority || 'HIGH'),
    studentName: String(incident.student_name || ''),
    studentId: String(incident.student_id || ''),
    location: locSummary,
    building: String(incident.location?.building || ''),
    floor: String(incident.location?.floor || ''),
    room: String(incident.location?.room || ''),
    area: String(incident.location?.area || incident.location?.room || ''),
    latitude: String(incident.location?.latitude ?? ''),
    longitude: String(incident.location?.longitude ?? ''),
    accuracy: String(incident.location?.accuracy ?? ''),
    locationStatus: String(incident.location?.locationStatus || incident.location?.location_status || ''),
    gpsTimestamp: String(incident.location?.gpsTimestamp || incident.location?.gps_timestamp || ''),
    studentPhone: String(incident.student_phone || incident.studentPhone || incident.phone || ''),
    description: String(incident.description || ''),
    timestamp: String(incident.created_at || new Date().toISOString()),
    isEscalation: String(isEscalation),
    click_action: clickUrl,
    url: clickUrl
  };

  // Group devices by platform
  const androidDevices = devices.filter(d => d.platform === 'android');
  const webDevices = devices.filter(d => d.platform !== 'android');

  let totalAccepted = 0;
  let totalFailed = 0;
  const invalidTokens = [];

  // Helper to execute multicast with bounded exponential backoff
  async function dispatchBatch(tokens, payload, platformName) {
    if (tokens.length === 0) return { accepted: 0, failed: 0 };

    let accepted = 0;
    let failed = 0;
    let tokensToAttempt = [...tokens];
    let attempt = 0;
    const maxRetries = 2;
    const backoffMs = [500, 1500];

    const messaging = getMessaging();

    while (tokensToAttempt.length > 0 && attempt <= maxRetries) {
      if (attempt > 0) {
        const delay = backoffMs[attempt - 1] || 1500;
        console.log(`[FCM] Retrying ${tokensToAttempt.length} ${platformName} token(s) after transient failure (attempt ${attempt}/${maxRetries} in ${delay}ms)...`);
        await sleep(delay);
      }

      try {
        const res = await messaging.sendEachForMulticast({
          tokens: tokensToAttempt,
          ...payload
        });

        const retryTokens = [];

        res.responses.forEach((resp, idx) => {
          const tok = tokensToAttempt[idx];
          if (resp.success) {
            accepted++;
          } else {
            const errCode = resp.error?.code || '';
            const errMsg = resp.error?.message || '';
            console.warn(`[FCM] ${platformName} push error for token ${tok.slice(0, 12)}...: ${errCode} - ${errMsg}`);

            // Transient error check
            const isTransient = [
              'messaging/server-unavailable',
              'messaging/internal-error',
              'messaging/quota-exceeded',
              'messaging/unavailable'
            ].includes(errCode);

            if (isTransient && attempt < maxRetries) {
              retryTokens.push(tok);
            } else {
              failed++;
              if (
                errCode === 'messaging/registration-token-not-registered' ||
                errCode === 'messaging/invalid-registration-token' ||
                errCode === 'messaging/invalid-argument'
              ) {
                invalidTokens.push(tok);
              }
            }
          }
        });

        tokensToAttempt = retryTokens;
      } catch (fatalSendErr) {
        console.warn(`[FCM] Fatal error sending ${platformName} multicast:`, fatalSendErr.message);
        if (attempt >= maxRetries) {
          failed += tokensToAttempt.length;
          break;
        }
      }

      attempt++;
    }

    return { accepted, failed };
  }

  // 1. Send Android payload: Data-first message to guarantee onMessageReceived execution
  if (androidDevices.length > 0) {
    const androidTokens = androidDevices.map(d => d.fcmToken).filter(Boolean);
    const androidPayload = {
      data: commonData,
      android: {
        priority: 'high',
        ttl: 86400 * 1000 // 24 hours retention
      }
    };
    const res = await dispatchBatch(androidTokens, androidPayload, 'Android');
    totalAccepted += res.accepted;
    totalFailed += res.failed;
  }

  // 2. Send Web payload: notification + webpush headers for service worker display
  if (webDevices.length > 0) {
    const webTokens = webDevices.map(d => d.fcmToken).filter(Boolean);
    const webPayload = {
      notification: { title, body },
      data: commonData,
      webpush: {
        headers: { Urgency: 'high' },
        fcmOptions: { link: clickUrl },
        notification: {
          title,
          body,
          icon: '/favicon.ico',
          badge: '/favicon.ico',
          tag: `sos-alert-${incident.id}`,
          requireInteraction: true,
          renotify: true,
          vibrate: [500, 250, 500, 250, 500, 250, 500],
          actions: [{ action: 'open', title: 'Open Incident' }]
        }
      }
    };
    const res = await dispatchBatch(webTokens, webPayload, 'Web');
    totalAccepted += res.accepted;
    totalFailed += res.failed;
  }

  // Deactivate expired or invalid tokens in Firestore
  if (invalidTokens.length > 0) {
    try {
      const firestore = getFirestore();
      for (const invToken of invalidTokens) {
        const devEntry = devices.find(d => d.fcmToken === invToken);
        if (devEntry?.deviceId) {
          try {
            await firestore.collection('responder_devices').doc(devEntry.deviceId).update({
              active: false,
              invalidationReason: 'FCM token expired or invalid',
              lastUpdated: new Date().toISOString()
            });
          } catch {}
          console.log(`[FCM] Deactivated expired token in Cloud Firestore for device ${devEntry.deviceId}`);
        }
      }
    } catch (e) {
      console.warn('[FCM] Token deactivation notice:', e.message);
    }
  }

  // Record delivery log in Cloud Firestore for audit & idempotency
  try {
    const firestore = getFirestore();
    await firestore.collection('incidents').doc(String(incident.id)).collection('delivery_logs').doc('fcm_dispatch').set({
      fcmAcceptedCount: totalAccepted,
      fcmFailedCount: totalFailed,
      totalTargetDevices: devices.length,
      androidDevices: androidDevices.length,
      webDevices: webDevices.length,
      invalidTokensRemoved: invalidTokens.length,
      isEscalation,
      transportStatus: 'ACCEPTED_BY_FCM_GATEWAY',
      timestamp: new Date().toISOString()
    }, { merge: true });
  } catch (err) {
    console.log('[FCM] Notice recording Firestore delivery log:', err.message);
  }

  // Explicit server-side audit logging: FCM acceptance is transport only, NOT physical delivery proof
  await logNotificationAudit(incident.id, 'FCM_GATEWAY_DISPATCH', {
    fcmAcceptedCount: totalAccepted,
    fcmFailedCount: totalFailed,
    totalTargetDevices: devices.length,
    androidDevices: androidDevices.length,
    webDevices: webDevices.length,
    invalidTokensRemoved: invalidTokens.length,
    isEscalation,
    transportStatus: 'ACCEPTED_BY_FCM_GATEWAY',
    verificationNotice: 'FCM gateway accepted transport. Physical device receipt and sound playback are pending until device posts receipt.'
  });

  console.log(`[FCM] Dispatch completed for ${incident.id}: ${totalAccepted}/${devices.length} tokens accepted by FCM server (${totalFailed} failed, ${invalidTokens.length} invalidated). Physical phone receipt pending.`);

  return {
    fcmAcceptedCount: totalAccepted,
    fcmFailedCount: totalFailed,
    totalDevices: devices.length,
    deliveredCount: totalAccepted // Backwards-compatibility alias
  };
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

/**
 * Real-time Cloud Firestore incident listener that automatically triggers FCM Web Push
 * notifications whenever ANY student creates an SOS incident directly in Cloud Firestore.
 * Prevents re-alerting for historical or already handled incidents.
 */
export function startFirestoreIncidentPushWatcher() {
  initFirebaseAdmin();
  const db = getFirestore();
  let isInitial = true;

  console.log('[SOS:PushWatcher] Attaching real-time Cloud Firestore incidents listener for automated FCM push...');

  return db.collection('incidents').onSnapshot(async (snapshot) => {
    if (isInitial) {
      isInitial = false;
      console.log(`[SOS:PushWatcher] Initial snapshot synchronized (${snapshot.size} existing incidents). Standing by for new SOS events.`);
      return;
    }

    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        const incident = change.doc.data();
        const id = change.doc.id;

        // Skip non-active incidents
        if (['RESOLVED', 'CANCELLED', 'REJECTED', 'ACCEPTED', 'RESPONDING', 'ARRIVED'].includes(incident.status)) {
          continue;
        }

        // Check recency: only alert for genuinely new SOS created within past 10 minutes
        const createdTime = new Date(incident.created_at || incident.createdAt || Date.now()).getTime();
        if (Date.now() - createdTime > 10 * 60 * 1000) {
          continue;
        }

        // Idempotency check: prevent duplicate FCM alerts for same incident
        const logRef = db.collection('incidents').doc(id).collection('delivery_logs').doc('fcm_dispatch');
        const logSnap = await logRef.get();
        if (logSnap.exists) {
          continue;
        }

        console.log(`[SOS:PushWatcher] 🚨 NEW EMERGENCY SOS DETECTED IN FIRESTORE: ${id} from ${incident.student_name}. Dispatched automated FCM push!`);
        try {
          await sendEmergencySosNotification(incident, false);
        } catch (err) {
          console.warn(`[SOS:PushWatcher] Push dispatch error:`, err.message);
        }
      }
    }
  }, (err) => {
    console.warn('[SOS:PushWatcher] Firestore listener notice:', err.message);
  });
}



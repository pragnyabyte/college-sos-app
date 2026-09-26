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

  const db = await getDb();
  const responders = db.collection('emergency_responders');
  const now = new Date().toISOString();

  const detectedPlatform = platform || (userAgent?.toLowerCase().includes('android') ? 'android' : 'web');

  // Atomically upsert the device into responder devices map
  await responders.findOneAndUpdate(
    { responderId },
    {
      $set: {
        responderId,
        [`devices.${deviceId}`]: {
          deviceId,
          installationId: installationId || deviceId,
          fcmToken,
          platform: detectedPlatform,
          appVersion: appVersion || '1.0.0',
          model: model || (detectedPlatform === 'android' ? 'Android Device' : 'Web Browser'),
          userAgent: userAgent || 'Unknown client',
          active: true,
          registeredAt: now,
          lastActiveAt: now,
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
    installationId: installationId || deviceId,
    platform: detectedPlatform,
    active: true,
    lastUpdated: now
  };
}

/**
 * Updates last active timestamp for a responder device.
 */
export async function updateDevicePing(deviceId, responderId = RESPONDER_ID) {
  if (!deviceId) return;
  const db = await getDb();
  const now = new Date().toISOString();
  await db.collection('emergency_responders').updateOne(
    { responderId, [`devices.${deviceId}`]: { $exists: true } },
    {
      $set: {
        [`devices.${deviceId}.lastActiveAt`]: now,
        [`devices.${deviceId}.lastUpdated`]: now
      }
    }
  );
}

/**
 * Unregisters or deactivates a specific device (e.g. on phone logout).
 * Other devices of the responder remain completely unaffected.
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
 * Gets active registered devices for a responder.
 * If maskTokens is true, sensitive FCM tokens are securely redacted.
 */
export async function getActiveResponderDevices(responderId = RESPONDER_ID, maskTokens = false) {
  const db = await getDb();
  const responder = await db.collection('emergency_responders').findOne({ responderId });
  if (!responder || !responder.devices) return [];
  const list = Object.values(responder.devices).filter(d => d && d.active && d.fcmToken);
  if (!maskTokens) return list;
  return list.map(d => ({
    deviceId: d.deviceId,
    installationId: d.installationId || d.deviceId,
    platform: d.platform || 'web',
    appVersion: d.appVersion || '1.0.0',
    model: d.model || 'Device',
    registeredAt: d.registeredAt || d.lastUpdated,
    lastActiveAt: d.lastActiveAt || d.lastUpdated,
    active: d.active,
    fcmTokenMasked: d.fcmToken ? `${d.fcmToken.slice(0, 10)}...${d.fcmToken.slice(-6)}` : ''
  }));
}

/**
 * Checks if a device ID is registered under any emergency responder.
 */
export async function isRegisteredDeviceId(deviceId) {
  if (!deviceId) return false;
  const db = await getDb();
  const responder = await db.collection('emergency_responders').findOne({ [`devices.${deviceId}`]: { $exists: true } });
  return !!responder;
}

/**
 * Logs an event in notification_audit_logs in MongoDB Atlas.
 */
export async function logNotificationAudit(incidentId, event, details = {}) {
  try {
    const db = await getDb();
    await db.collection('notification_audit_logs').insertOne({
      incident_id: incidentId,
      event,
      details,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.warn('[AuditLog] Notice logging audit:', e.message);
  }
}

/**
 * Records device delivery receipt when an Android phone receives the push notification.
 */
export async function recordDeviceReceipt({ incidentId, deviceId, responderId = RESPONDER_ID, clientTimestamp }) {
  const now = new Date().toISOString();
  await logNotificationAudit(incidentId, 'DEVICE_RECEIPT', {
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
  await logNotificationAudit(incidentId, 'RESPONDER_OPENED', {
    deviceId,
    responderId,
    clientTimestamp: clientTimestamp || now,
    serverTimestamp: now
  });
  return { success: true, incidentId, deviceId, openedAt: now };
}

/**
 * Checks for unacknowledged incidents older than escalationMinutes and triggers escalation reminder.
 */
export async function checkAndEscalateIncidents(escalationMinutes = 3) {
  try {
    const db = await getDb();
    const threshold = new Date(Date.now() - escalationMinutes * 60 * 1000).toISOString();

    const unacknowledged = await db.collection('incidents').find({
      status: 'DEPARTMENT_NOTIFIED',
      created_at: { $lte: threshold },
      escalated_at: { $exists: false }
    }).toArray();

    const results = [];
    for (const incident of unacknowledged) {
      const now = new Date().toISOString();
      await db.collection('incidents').updateOne(
        { id: incident.id },
        {
          $set: {
            escalated_at: now,
            escalation_level: 1,
            updated_at: now
          }
        }
      );

      await logNotificationAudit(incident.id, 'ESCALATION_TRIGGERED', {
        escalated_at: now,
        reason: `Unacknowledged after ${escalationMinutes} minutes`
      });

      // Send urgent escalation push
      const escIncident = {
        ...incident,
        priority: 'CRITICAL',
        description: `⚠️ [ESCALATION REMINDER - UNACKNOWLEDGED]: ${incident.description || 'Immediate response required.'}`
      };
      const pushRes = await sendEmergencySosNotification(escIncident, true);
      results.push({ id: incident.id, pushRes });
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
    console.log(`[FCM] No active registered responder devices found in database. Push skipped.`);
    await logNotificationAudit(incident.id, 'NO_DEVICES_REGISTERED', {
      timestamp: new Date().toISOString(),
      note: 'No responder devices currently registered or active'
    });
    return { fcmAcceptedCount: 0, fcmFailedCount: 0, totalDevices: 0, deliveredCount: 0 };
  }

  initFirebaseAdmin();

  const title = isEscalation
    ? `⚠️ URGENT REMINDER: SOS ${incident.id} UNACKNOWLEDGED`
    : `🚨 EMERGENCY SOS: ${incident.id} (${incident.priority})`;
  const body = `${incident.student_name} reported ${incident.category_id || 'Emergency'} at ${incident.location?.building || 'Campus'}, ${incident.location?.floor || ''} ${incident.location?.room || ''}`.trim();
  const clickUrl = `/responder?incidentId=${encodeURIComponent(incident.id)}`;

  const commonData = {
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
        // Retry all on transport failure
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

  // Deactivate expired or invalid tokens in MongoDB
  if (invalidTokens.length > 0) {
    try {
      for (const invToken of invalidTokens) {
        const devEntry = devices.find(d => d.fcmToken === invToken);
        if (devEntry?.deviceId) {
          await db.collection('emergency_responders').updateOne(
            { responderId: devEntry.responderId || RESPONDER_ID },
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
    } catch (e) {
      console.warn('[FCM] Token deactivation notice:', e.message);
    }
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


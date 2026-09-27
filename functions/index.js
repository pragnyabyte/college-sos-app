import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { authenticate, createSessionUser, issueToken, isAdmin, isResponder, verifyResponderCredentials, registerStudent, verifyStudentCredentials } from './backend/auth.js';
import { categories } from './backend/domain.js';
import { initDatabase } from './backend/db.js';
import { changeStatus, createIncident, deleteIncident, exportCsv, getIncident, listIncidents, stats, updateIncidentLocation } from './backend/service.js';
import {
  initFirebaseAdmin,
  ensurePermanentResponder,
  registerResponderDevice,
  unregisterResponderDevice,
  getActiveResponderDevices,
  sendEmergencySosNotification,
  syncIncidentToFirestoreAdmin,
  deleteIncidentFromFirestoreAdmin,
  recordDeviceReceipt,
  recordDeviceOpen,
  updateDevicePing,
  checkAndEscalateIncidents,
  logNotificationAudit,
  RESPONDER_ID
} from './backend/fcm.js';
import {
  sendEmergencySms,
  sendEmergencyVoiceCall,
  generateEmergencyTwiML,
  handleTwiMLGather,
  processEscalations,
  ALERT_STATUSES,
  formatLocationLink,
  getRegisteredResponderPhones
} from './backend/escalation.js';

let dbInitialized = false;

async function ensureInit() {
  if (!dbInitialized) {
    await initDatabase();
    initFirebaseAdmin();
    await ensurePermanentResponder();
    dbInitialized = true;
  }
}

export const api = onRequest({ cors: true, maxInstances: 10, timeoutSeconds: 60 }, async (req, res) => {
  try {
    await ensureInit();

    const rawPath = req.path || '/';
    // Normalize path so /api/sos and /sos both resolve correctly
    const path = rawPath.startsWith('/api') ? rawPath : `/api${rawPath.startsWith('/') ? '' : '/'}${rawPath}`;
    const method = req.method;

    if (path === '/api/health' || path === '/health') {
      return res.status(200).json({ status: 'ok', environment: 'firebase-functions', time: new Date().toISOString() });
    }

    if (path === '/api/config') {
      return res.status(200).json({
        firebaseConfig: {
          projectId: "college-sos-app-26aec",
          appId: "1:888750165100:web:c5717332b893a6dc06dc49",
          storageBucket: "college-sos-app-26aec.firebasestorage.app",
          apiKey: "AIzaSyBsijDOP3woYoWK0An37rYTDu0zCWdeYhg",
          authDomain: "college-sos-app-26aec.firebaseapp.com",
          messagingSenderId: "888750165100",
          measurementId: "G-7NKML0LRT6",
          projectNumber: "888750165100"
        },
        vapidKey: process.env.FIREBASE_VAPID_KEY || ""
      });
    }

    if (path === '/api/auth/register' && method === 'POST') {
      const b = req.body || {};
      const result = await registerStudent(b);
      return res.status(201).json(result);
    }

    if ((path === '/api/auth/login' || path === '/api/auth/demo') && method === 'POST') {
      const b = req.body || {};
      const regd = String(b.regdNo || b.userId || b.id || '').trim();
      const role = String(b.role || 'STUDENT').trim().toUpperCase();

      if (!regd) return res.status(400).json({ error: 'Registration / ID No. is required.' });
      if (regd.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(regd)) {
        return res.status(400).json({ error: 'Email addresses are not accepted. Please enter a valid Registration / ID No.' });
      }
      if (role === 'TEACHER') return res.status(400).json({ error: 'Invalid role. Teacher role is not supported.' });
      if (role !== 'STUDENT' && role !== 'RESPONDER') {
        return res.status(400).json({ error: 'Invalid role. Only Student and Emergency Responder roles are supported.' });
      }

      let u;
      if (role === 'RESPONDER') {
        u = await verifyResponderCredentials(regd, b.pin || b.password, b.name);
      } else {
        u = await verifyStudentCredentials(regd, b.name);
      }
      return res.status(200).json({ token: issueToken(u), user: u });
    }

    if (path === '/api/auth/responder-login' && method === 'POST') {
      const b = req.body || {};
      const id = String(b.responderId || b.regdNo || b.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Responder ID is required' });
      const u = await verifyResponderCredentials(id, b.pin || b.password, b.name);
      return res.status(200).json({ token: issueToken(u), user: u });
    }

    if (path === '/api/categories') return res.status(200).json(categories);

    // Twilio Voice TwiML webhook (Incident ID parameter)
    const twimlCallMatch = path.match(/^\/api\/responder\/twiml\/emergency-call\/([^/]+)$/);
    if (twimlCallMatch && (method === 'GET' || method === 'POST')) {
      const [, incId] = twimlCallMatch;
      try {
        const db = await initDatabase();
        const inc = await db.collection('incidents').findOne({ id: incId });
        if (!inc) {
          res.set('Content-Type', 'application/xml');
          return res.status(404).send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Incident not found.</Say><Hangup/></Response>');
        }
        const twiml = generateEmergencyTwiML(inc);
        res.set('Content-Type', 'application/xml');
        return res.status(200).send(twiml);
      } catch (err) {
        res.set('Content-Type', 'application/xml');
        return res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Error loading alert.</Say><Hangup/></Response>');
      }
    }

    // Twilio Gather IVR Response webhook (press 1 to acknowledge)
    const twimlGatherMatch = path.match(/^\/api\/responder\/twiml\/gather-response\/([^/]+)$/);
    if (twimlGatherMatch && method === 'POST') {
      const [, incId] = twimlGatherMatch;
      const b = req.body || {};
      const digits = b.Digits || b.digits || '';
      const caller = b.From || b.from || b.Caller || 'Emergency Responder Phone';
      const twimlResponse = await handleTwiMLGather(incId, digits, caller);
      res.set('Content-Type', 'application/xml');
      return res.status(200).send(twimlResponse);
    }

    // Twilio SMS Delivery Status Callback
    if (path === '/api/responder/twilio/sms-status-callback' && method === 'POST') {
      const b = req.body || {};
      const smsSid = b.MessageSid || b.SmsSid;
      const status = b.MessageStatus || b.SmsStatus;
      const to = b.To || '';
      if (status === 'delivered') {
        await logNotificationAudit(b.incidentId || 'SMS_BROADCAST', ALERT_STATUSES.DEVICE_DELIVERY_CONFIRMED, {
          channel: 'SMS',
          provider: 'twilio',
          messageSid: smsSid,
          to: to.slice(0, 4) + '***' + to.slice(-3),
          providerStatus: status,
          timestamp: new Date().toISOString()
        });
      }
      return res.status(200).json({ received: true, sid: smsSid, status });
    }

    // Twilio Call Status Callback
    if (path === '/api/responder/twilio/call-status-callback' && method === 'POST') {
      const b = req.body || {};
      const callSid = b.CallSid;
      const status = b.CallStatus;
      const to = b.To || '';
      await logNotificationAudit(b.incidentId || 'VOICE_CALL_BROADCAST', `VOICE_CALL_${(status || 'UNKNOWN').toUpperCase()}`, {
        channel: 'VOICE_CALL',
        provider: 'twilio',
        callSid,
        to: to.slice(0, 4) + '***' + to.slice(-3),
        providerStatus: status,
        duration: b.CallDuration || '0',
        timestamp: new Date().toISOString()
      });
      return res.status(200).json({ received: true, sid: callSid, status });
    }

    // Public / Durable Escalation Trigger Endpoint (Callable by Cloud Scheduler or cron)
    if ((path === '/api/escalation/process' || path === '/api/escalation/tick') && method === 'POST') {
      const results = await processEscalations();
      return res.status(200).json({ success: true, ...results, timestamp: new Date().toISOString() });
    }

    // Authenticated API routes
    if (path.startsWith('/api/')) {
      const u = authenticate(req);

      if (path === '/api/sos' && method === 'POST') {
        const result = await createIncident(req.body, u, req.ip);
        syncIncidentToFirestoreAdmin(result).catch(() => {});
        sendEmergencySosNotification(result).catch(e => console.warn('[FCM] Push dispatch notice:', e.message));
        return res.status(201).json(result);
      }

      if (path === '/api/responder/device' && method === 'POST') {
        if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
        const b = req.body || {};
        const reg = await registerResponderDevice({
          responderId: u.id,
          deviceId: b.deviceId,
          fcmToken: b.fcmToken,
          platform: b.platform || 'android',
          appVersion: b.appVersion,
          model: b.model,
          userAgent: req.headers['user-agent']
        });
        return res.status(200).json(reg);
      }

      if (path.startsWith('/api/responder/device/') && method === 'DELETE') {
        if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
        const devId = path.split('/')[4];
        await unregisterResponderDevice(devId, u.id);
        return res.status(200).json({ success: true });
      }

      if (path === '/api/responder/devices' && method === 'GET') {
        if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
        return res.status(200).json(await getActiveResponderDevices(u.id));
      }

      if (path === '/api/responder/device/ping' && method === 'POST') {
        if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
        const b = req.body || {};
        await updateDevicePing(b.deviceId, u.id);
        return res.status(200).json({ success: true, timestamp: new Date().toISOString() });
      }

      if (path === '/api/responder/phone' && method === 'POST') {
        if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
        const b = req.body || {};
        const rawPhone = String(b.phone || b.phoneNumber || '').trim();
        if (!rawPhone || !/^\+?[1-9]\d{7,14}$/.test(rawPhone.replace(/[\s\-()]/g, ''))) {
          return res.status(400).json({ error: 'Valid E.164 phone number is required (e.g. +1234567890)' });
        }
        const db = await initDatabase();
        await db.collection('emergency_responders').updateOne(
          { responderId: u.id },
          { $set: { phone: rawPhone, updatedAt: new Date().toISOString() } },
          { upsert: true }
        );
        return res.status(200).json({ success: true, responderId: u.id, phone: rawPhone });
      }

      if (path === '/api/responder/phones' && method === 'GET') {
        if (!isResponder(u) && !isAdmin(u)) return res.status(403).json({ error: 'Access denied: Responder or Admin required' });
        const phones = await getRegisteredResponderPhones();
        return res.status(200).json({ phones });
      }

      if (path === '/api/responder/escalate' && method === 'POST') {
        if (!isResponder(u) && !isAdmin(u)) return res.status(403).json({ error: 'Admin or Responder only' });
        const results = await processEscalations();
        return res.status(200).json({ success: true, ...results });
      }

      if (path === '/api/responder/test-alert' && method === 'POST') {
        if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
        const testIncident = {
          id: 'TEST-' + Math.floor(1000 + Math.random() * 9000),
          category_id: 'security',
          priority: 'CRITICAL',
          student_name: 'Test Emergency Drill',
          student_id: 'DRILL-01',
          location: { building: 'Command Center', floor: '1st Floor', room: 'Station 1' },
          description: `Emergency test notification trigger for ${u.id}.`,
          created_at: new Date().toISOString()
        };
        syncIncidentToFirestoreAdmin(testIncident).catch(() => {});
        const fcmRes = await sendEmergencySosNotification(testIncident);
        return res.status(200).json({ success: true, fcm: fcmRes, testIncident });
      }

      if ((path === '/api/sos/my' || path === '/api/sos/active' || path === '/api/sos/admin') && method === 'GET') {
        if (path.endsWith('/admin') && !isAdmin(u) && !isResponder(u) && u.role !== 'DEPARTMENT_HEAD') {
          return res.status(403).json({ error: 'Admin or Responder only' });
        }
        return res.status(200).json(await listIncidents(u, req.query));
      }

      if (path === '/api/sos/stats' && method === 'GET') {
        if (!isAdmin(u) && !isResponder(u) && u.role !== 'DEPARTMENT_HEAD') {
          return res.status(403).json({ error: 'Admin or Responder only' });
        }
        return res.status(200).json(await stats());
      }

      const receiptMatch = path.match(/^\/api\/sos\/([^/]+)\/(receipt|open)$/);
      if (receiptMatch && method === 'POST') {
        const [, incidentId, subAction] = receiptMatch;
        const b = req.body || {};
        if (subAction === 'receipt') {
          const rec = await recordDeviceReceipt({
            incidentId,
            deviceId: b.deviceId || req.ip,
            responderId: u.id,
            clientTimestamp: b.clientTimestamp
          });
          return res.status(200).json(rec);
        } else if (subAction === 'open') {
          const op = await recordDeviceOpen({
            incidentId,
            deviceId: b.deviceId || req.ip,
            responderId: u.id,
            clientTimestamp: b.clientTimestamp
          });
          return res.status(200).json(op);
        }
      }

      const match = path.match(/^\/api\/sos\/([^/]+)(?:\/(accept|respond|arrive|resolve|cancel|location|verify-sound|notification-audit))?$/);
      if (match) {
        const [, id, action] = match;
        if (method === 'GET' && !action) return res.status(200).json(await getIncident(id, u));
        if (action === 'verify-sound' && method === 'POST') {
          const b = req.body || {};
          await logNotificationAudit(id, ALERT_STATUSES.AUDIBLE_SOUND_VERIFIED, {
            deviceId: b.deviceId || 'manual-test-device',
            verifiedBy: u.id,
            verifiedByName: u.name,
            notes: b.notes || 'Audible emergency siren sound playback verified on physical device',
            timestamp: new Date().toISOString()
          });
          return res.status(200).json({ success: true, incidentId: id, status: ALERT_STATUSES.AUDIBLE_SOUND_VERIFIED });
        }
        if (action === 'notification-audit' && method === 'GET') {
          const db = await initDatabase();
          const logs = await db.collection('notification_audit_logs').find({ incident_id: id }).sort({ timestamp: 1 }).toArray();
          return res.status(200).json({ incidentId: id, totalEvents: logs.length, events: logs });
        }
        if (method === 'DELETE' && !action) {
          const resDel = await deleteIncident(id, u, req.ip);
          deleteIncidentFromFirestoreAdmin(resDel.id).catch(() => {});
          return res.status(200).json({ success: true, message: 'SOS alert deleted successfully.', id: resDel.id, _id: resDel._id });
        }
        if (action === 'location' && (method === 'PATCH' || method === 'PUT' || method === 'POST')) {
          const result = await updateIncidentLocation(id, req.body, u, req.ip);
          syncIncidentToFirestoreAdmin(result).catch(() => {});
          return res.status(200).json(result);
        }
        if (method === 'POST' && action) {
          const map = { accept: 'ACCEPTED', respond: 'RESPONDING', arrive: 'ARRIVED', resolve: 'RESOLVED', cancel: 'CANCELLED' };
          const result = await changeStatus(id, map[action], req.body, u, req.ip);
          if (action === 'accept') {
            await logNotificationAudit(id, ALERT_STATUSES.RESPONDER_ACKNOWLEDGED, {
              channel: 'WEB_OR_APP_DASHBOARD',
              responderId: u.id,
              responderName: u.name,
              timestamp: new Date().toISOString()
            });
          }
          return res.status(200).json(result);
        }
      }

      return res.status(404).json({ error: 'API route not found' });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Internal server error', field: e.field });
  }
});

/**
 * Server-side Firestore Cloud Function trigger.
 * Fires whenever a student creates an emergency SOS incident in Cloud Firestore.
 * Performs idempotency verification and triggers high-priority FCM emergency push to all active responder devices.
 */
export const onIncidentCreated = onDocumentCreated(
  { document: 'incidents/{incidentId}', maxInstances: 10, timeoutSeconds: 60 },
  async (event) => {
    try {
      const snap = event.data;
      if (!snap) {
        console.log('[onIncidentCreated] Snapshot missing, skipping.');
        return;
      }

      const incident = snap.data();
      const incidentId = event.params.incidentId;
      if (!incident) return;

      // Skip non-active incidents
      if (incident.status === 'RESOLVED' || incident.status === 'CANCELLED') {
        return;
      }

      // Idempotency check: prevent duplicate FCM alerts for same incident
      initFirebaseAdmin();
      const firestore = getFirestore();
      const logRef = firestore.collection('incidents').doc(incidentId).collection('delivery_logs').doc('fcm_dispatch');
      const logSnap = await logRef.get();
      if (logSnap.exists) {
        console.log(`[onIncidentCreated] FCM dispatch already executed for ${incidentId}. Skipping duplicate.`);
        return;
      }

      console.log(`[onIncidentCreated] Server-side trigger firing for SOS incident ${incidentId}`);
      await sendEmergencySosNotification(incident, false);
    } catch (err) {
      console.error(`[onIncidentCreated] Error processing incident push: ${err.message}`, err);
    }
  }
);

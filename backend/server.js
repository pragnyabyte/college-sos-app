import express from 'express';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { authenticate, createSessionUser, issueToken, isAdmin, isResponder, verifyResponderCredentials, registerStudent, verifyStudentCredentials, normalizeRegdNo } from './auth.js';
import { categories } from './domain.js';
import { initDatabase } from './db.js';
import { changeStatus, createIncident, deleteIncident, exportCsv, getIncident, listIncidents, stats, updateIncidentLocation } from './service.js';
import {
  initFirebaseAdmin,
  ensurePermanentResponder,
  registerResponderDevice,
  unregisterResponderDevice,
  getActiveResponderDevices,
  isRegisteredDeviceId,
  sendEmergencySosNotification,
  syncIncidentToFirestoreAdmin,
  deleteIncidentFromFirestoreAdmin,
  recordDeviceReceipt,
  recordDeviceOpen,
  updateDevicePing,
  checkAndEscalateIncidents,
  logNotificationAudit,
  RESPONDER_ID
} from './fcm.js';
import {
  sendEmergencySms,
  sendEmergencyVoiceCall,
  generateEmergencyTwiML,
  handleTwiMLGather,
  processEscalations,
  startEscalationWorker,
  stopEscalationWorker,
  ALERT_STATUSES,
  formatLocationLink,
  getRegisteredResponderPhones
} from './escalation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const port = Number(process.env.PORT || 4000);
const limits = new Map();

const DEFAULT_ALLOWED_ORIGINS = [
  'https://college-sos-app-26aec.web.app',
  'https://college-sos-app-26aec.firebaseapp.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'http://localhost:3000'
];

export function isOriginAllowed(origin) {
  if (!origin) return false;
  const envOrigins = (process.env.ALLOWED_ORIGINS || process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  if (envOrigins.includes(origin)) return true;
  if (DEFAULT_ALLOWED_ORIGINS.includes(origin)) return true;

  try {
    const u = new URL(origin);
    if (['localhost', '127.0.0.1'].includes(u.hostname)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(u.hostname)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(u.hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(u.hostname)) return true;
  } catch {}

  return false;
}

export function getCorsHeaders(req) {
  const origin = req?.headers?.origin;
  if (origin && isOriginAllowed(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin'
    };
  }
  return {};
}

const eventPayload = (event, incident) => ({
  event,
  id: incident.id,
  _id: incident._id ? String(incident._id) : undefined,
  status: incident.status,
  priority: incident.priority,
  categoryId: incident.category_id || incident.categoryId,
  studentId: incident.student_id || incident.studentId,
  studentName: incident.student_name || incident.studentName,
  assignedDepartments: incident.assignedDepartments,
  location: {
    building: incident.location?.building || '',
    floor: incident.location?.floor || '',
    room: incident.location?.room || '',
    area: incident.location?.area || '',
    latitude: incident.location?.latitude ?? null,
    longitude: incident.location?.longitude ?? null,
    accuracy: incident.location?.accuracy ?? null,
    locationStatus: incident.location?.locationStatus || incident.location?.location_status || (incident.location?.latitude != null ? 'available' : 'unavailable'),
    gpsTimestamp: incident.location?.gpsTimestamp || incident.location?.gps_timestamp || null,
    source: incident.location?.source || (incident.location?.latitude != null ? 'GPS' : 'MANUAL')
  },
  message: event === 'sos.created' ? `New ${incident.priority} SOS: ${incident.id}` : `SOS ${incident.id} is now ${incident.status.replaceAll('_', ' ').toLowerCase()}`,
  timestamp: new Date().toISOString()
});

// Initialize Express App and HTTP Server
const app = express();
const server = createServer(app);

// Trust proxy for reverse proxies
app.set('trust proxy', true);

// Standard security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Strict CORS middleware matching project security requirements
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) {
    return next();
  }
  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    return next();
  }
  if (req.method === 'OPTIONS') {
    return res.status(403).json({ error: 'CORS origin not allowed' });
  }
  return next();
});

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting middleware
app.use((req, res, next) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const v = limits.get(key) || { n: 0, t: now };
  if (now - v.t > 60_000) { v.n = 0; v.t = now; }
  if (++v.n > 80) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  limits.set(key, v);
  next();
});

// Sanitized request logging (masks tokens, passwords, PINs)
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/api/health') return next();
  console.log(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// ----------------------------------------------------------------------------
// Healthcheck Endpoints
// ----------------------------------------------------------------------------
const handleHealth = (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'college-sos-backend',
    environment: process.env.NODE_ENV || 'production',
    websocket: '/ws',
    time: new Date().toISOString()
  });
};
app.get('/health', handleHealth);
app.get('/api/health', handleHealth);

// ----------------------------------------------------------------------------
// Configuration Endpoint
// ----------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.status(200).json({
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
});

// ----------------------------------------------------------------------------
// Authentication Endpoints
// ----------------------------------------------------------------------------
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const result = await registerStudent(req.body || {});
    return res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

const handleLogin = async (req, res, next) => {
  try {
    const b = req.body || {};
    const regd = String(b.regdNo || b.userId || b.id || '').trim();
    const role = String(b.role || 'STUDENT').trim().toUpperCase();

    if (!regd) {
      return res.status(400).json({ error: 'Registration / ID No. is required.' });
    }

    if (regd.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(regd)) {
      return res.status(400).json({ error: 'Email addresses are not accepted. Please enter a valid Registration / ID No.' });
    }

    if (role === 'TEACHER') {
      return res.status(400).json({ error: 'Invalid role. Teacher role is not supported.' });
    }
    if (role !== 'STUDENT' && role !== 'RESPONDER') {
      return res.status(400).json({ error: 'Invalid role. Only Student and Emergency Responder roles are supported.' });
    }

    let u;
    if (role === 'RESPONDER') {
      const pin = b.pin || b.password;
      u = await verifyResponderCredentials(regd, pin, b.name);
    } else {
      u = await verifyStudentCredentials(regd, b.name);
    }
    return res.status(200).json({ token: issueToken(u), user: u });
  } catch (err) {
    next(err);
  }
};

app.post('/api/auth/login', handleLogin);
app.post('/api/auth/demo', handleLogin);

app.post('/api/auth/responder-login', async (req, res, next) => {
  try {
    const b = req.body || {};
    const id = String(b.responderId || b.regdNo || b.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Responder ID is required' });
    const u = await verifyResponderCredentials(id, b.pin || b.password, b.name);
    return res.status(200).json({ token: issueToken(u), user: u });
  } catch (err) {
    next(err);
  }
});

app.get('/api/auth/users', (req, res) => res.status(200).json([]));
app.get('/api/categories', (req, res) => res.status(200).json(categories));

// ----------------------------------------------------------------------------
// Service Worker Route
// ----------------------------------------------------------------------------
app.get('/firebase-messaging-sw.js', (req, res) => {
  const swCandidates = [
    join(process.cwd(), 'frontend', 'public', 'firebase-messaging-sw.js'),
    join(process.cwd(), 'frontend', 'firebase-messaging-sw.js'),
    join(process.cwd(), 'dist', 'firebase-messaging-sw.js'),
    join(__dirname, '..', 'frontend', 'public', 'firebase-messaging-sw.js'),
    join(__dirname, '..', 'dist', 'firebase-messaging-sw.js')
  ];
  for (const swPath of swCandidates) {
    if (existsSync(swPath)) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.send(readFileSync(swPath, 'utf8'));
    }
  }
  res.status(404).json({ error: 'Service worker not found' });
});

// ----------------------------------------------------------------------------
// SSE Real-Time Stream
// ----------------------------------------------------------------------------
const sseGlobalClients = new Set();

app.get('/api/sos/stream', (req, res) => {
  const tokenParam = req.query.token;
  if (tokenParam) req.headers.authorization = `Bearer ${tokenParam}`;
  let uStream = null;
  try {
    uStream = authenticate(req);
  } catch (err) {
    return res.status(401).json({ error: 'Authentication required for live stream' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    ...getCorsHeaders(req)
  });
  res.write(`data: ${JSON.stringify({ event: 'connection.ready', message: 'SSE stream connected', user: uStream.id })}\n\n`);

  const client = { res, user: uStream };
  sseGlobalClients.add(client);
  console.log(`[SOS:Backend] Real-time SSE listener attached for user ${uStream.name} (${uStream.role})`);

  req.on('close', () => {
    sseGlobalClients.delete(client);
    console.log(`[SOS:Backend] Real-time SSE listener closed for ${uStream.id}`);
  });
});

// ----------------------------------------------------------------------------
// Device delivery receipt & open auditing
// ----------------------------------------------------------------------------
const handleDeviceReceiptOrOpen = async (req, res, next) => {
  try {
    const { id: incidentId, action } = req.params;
    if (action !== 'receipt' && action !== 'open') {
      return next();
    }
    const b = req.body || {};
    let actorId = RESPONDER_ID;
    try {
      const u = authenticate(req);
      actorId = u.id;
    } catch {
      const devId = b.deviceId;
      const isRegistered = await isRegisteredDeviceId(devId);
      if (!isRegistered) {
        return res.status(401).json({ error: 'Authentication or registered responder device required' });
      }
    }

    if (action === 'receipt') {
      const rec = await recordDeviceReceipt({
        incidentId,
        deviceId: b.deviceId || req.ip,
        responderId: actorId,
        clientTimestamp: b.clientTimestamp
      });
      return res.status(200).json(rec);
    } else if (action === 'open') {
      const op = await recordDeviceOpen({
        incidentId,
        deviceId: b.deviceId || req.ip,
        responderId: actorId,
        clientTimestamp: b.clientTimestamp
      });
      return res.status(200).json(op);
    }
  } catch (err) {
    next(err);
  }
};
app.post('/api/sos/:id/receipt', (req, res, next) => { req.params.action = 'receipt'; handleDeviceReceiptOrOpen(req, res, next); });
app.post('/api/sos/:id/open', (req, res, next) => { req.params.action = 'open'; handleDeviceReceiptOrOpen(req, res, next); });

// ----------------------------------------------------------------------------
// Twilio Voice & SMS Webhooks
// ----------------------------------------------------------------------------
app.all('/api/responder/twiml/emergency-call/:id', async (req, res) => {
  try {
    const db = await initDatabase();
    const inc = await db.collection('incidents').findOne({ id: req.params.id });
    if (!inc) {
      return res.status(404).set('Content-Type', 'application/xml; charset=utf-8').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Incident not found.</Say><Hangup/></Response>');
    }
    const twiml = generateEmergencyTwiML(inc);
    return res.status(200).set('Content-Type', 'application/xml; charset=utf-8').send(twiml);
  } catch (err) {
    return res.status(500).set('Content-Type', 'application/xml; charset=utf-8').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Error loading emergency alert.</Say><Hangup/></Response>');
  }
});

app.post('/api/responder/twiml/gather-response/:id', async (req, res) => {
  const incId = req.params.id;
  const b = req.body || {};
  const digits = b.Digits || b.digits || '';
  const caller = b.From || b.from || b.Caller || 'Emergency Responder Phone';
  const twimlResponse = await handleTwiMLGather(incId, digits, caller, broadcast);
  return res.status(200).set('Content-Type', 'application/xml; charset=utf-8').send(twimlResponse);
});

app.post('/api/responder/twilio/sms-status-callback', async (req, res) => {
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
});

app.post('/api/responder/twilio/call-status-callback', async (req, res) => {
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
});

// ----------------------------------------------------------------------------
// Escalation Process Endpoint
// ----------------------------------------------------------------------------
const handleEscalationProcess = async (req, res, next) => {
  try {
    const results = await processEscalations(broadcast);
    return res.status(200).json({ success: true, ...results, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
};
app.post('/api/escalation/process', handleEscalationProcess);
app.post('/api/escalation/tick', handleEscalationProcess);

// ----------------------------------------------------------------------------
// SOS & Responder Operations
// ----------------------------------------------------------------------------
app.post('/api/sos', async (req, res, next) => {
  try {
    const u = authenticate(req);
    console.log(`[SOS:Backend] 1. Received SOS creation request from ${u.name} (${u.id})`);
    const result = await createIncident(req.body || {}, u, req.ip);
    console.log(`[SOS:Backend] 2. Incident created: ${result.id} (${result.priority}) at ${result.location.building}`);
    broadcast(eventPayload('sos.created', result));
    console.log(`[SOS:Backend] 3. Dispatched real-time broadcast to connected responder listeners`);
    syncIncidentToFirestoreAdmin(result).catch(() => {});
    sendEmergencySosNotification(result).then(fcmRes => {
      console.log(`[SOS:Backend] 4. FCM push notification result: ${fcmRes.deliveredCount}/${fcmRes.totalDevices} delivered`);
    }).catch(e => console.warn('[FCM] Push dispatch notice:', e.message));
    return res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/responder/device', async (req, res, next) => {
  try {
    const u = authenticate(req);
    if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
    const b = req.body || {};
    console.log(`[SOS:Backend] Registering device token for ${u.id} (Device ID: ${b.deviceId})`);
    const reg = await registerResponderDevice({
      responderId: u.id,
      deviceId: b.deviceId,
      fcmToken: b.fcmToken,
      userAgent: req.headers['user-agent']
    });
    return res.status(200).json(reg);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/responder/device/:id', async (req, res, next) => {
  try {
    const u = authenticate(req);
    if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
    await unregisterResponderDevice(req.params.id, u.id);
    return res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/responder/devices', async (req, res, next) => {
  try {
    const u = authenticate(req);
    if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
    return res.status(200).json(await getActiveResponderDevices(u.id));
  } catch (err) {
    next(err);
  }
});

app.post('/api/responder/device/ping', async (req, res, next) => {
  try {
    const u = authenticate(req);
    if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
    await updateDevicePing(req.body?.deviceId, u.id);
    return res.status(200).json({ success: true, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

app.post('/api/responder/escalate', async (req, res, next) => {
  try {
    const u = authenticate(req);
    if (!isResponder(u) && !isAdmin(u)) return res.status(403).json({ error: 'Admin or Responder only' });
    const results = await processEscalations(broadcast);
    return res.status(200).json({ success: true, ...results });
  } catch (err) {
    next(err);
  }
});

app.post('/api/responder/phone', async (req, res, next) => {
  try {
    const u = authenticate(req);
    if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
    const rawPhone = String(req.body?.phone || req.body?.phoneNumber || '').trim();
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
  } catch (err) {
    next(err);
  }
});

app.get('/api/responder/phones', async (req, res, next) => {
  try {
    const u = authenticate(req);
    if (!isResponder(u) && !isAdmin(u)) return res.status(403).json({ error: 'Access denied: Responder or Admin required' });
    const phones = await getRegisteredResponderPhones();
    return res.status(200).json({ phones });
  } catch (err) {
    next(err);
  }
});

app.post('/api/responder/test-alert', async (req, res, next) => {
  try {
    const u = authenticate(req);
    if (!isResponder(u)) return res.status(403).json({ error: 'Access denied: Responder role required' });
    console.log(`[SOS:Backend] Test drill emergency alert triggered by ${u.name}`);
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
    broadcast(eventPayload('sos.created', testIncident));
    syncIncidentToFirestoreAdmin(testIncident).catch(() => {});
    const fcmRes = await sendEmergencySosNotification(testIncident);
    return res.status(200).json({ success: true, fcm: fcmRes, testIncident });
  } catch (err) {
    next(err);
  }
});

const handleListIncidents = async (req, res, next) => {
  try {
    const u = authenticate(req);
    if (req.path.endsWith('/admin') && !isAdmin(u) && !isResponder(u) && u.role !== 'DEPARTMENT_HEAD') {
      return res.status(403).json({ error: 'Admin or Responder only' });
    }
    return res.status(200).json(await listIncidents(u, req.query));
  } catch (err) {
    next(err);
  }
};
app.get('/api/sos/my', handleListIncidents);
app.get('/api/sos/active', handleListIncidents);
app.get('/api/sos/admin', handleListIncidents);

app.get('/api/sos/stats', async (req, res, next) => {
  try {
    const u = authenticate(req);
    if (!isAdmin(u) && !isResponder(u) && u.role !== 'DEPARTMENT_HEAD') {
      return res.status(403).json({ error: 'Admin or Responder only' });
    }
    return res.status(200).json(await stats());
  } catch (err) {
    next(err);
  }
});

app.get('/api/sos/export.csv', async (req, res, next) => {
  try {
    const u = authenticate(req);
    const csv = await exportCsv(u);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sos-incidents.csv"');
    return res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
});

// Sound-Verify, Notification-Audit, Location
app.post('/api/sos/:id/verify-sound', async (req, res, next) => {
  try {
    const u = authenticate(req);
    const id = req.params.id;
    const b = req.body || {};
    await logNotificationAudit(id, ALERT_STATUSES.AUDIBLE_SOUND_VERIFIED, {
      deviceId: b.deviceId || 'manual-test-device',
      verifiedBy: u.id,
      verifiedByName: u.name,
      notes: b.notes || 'Audible emergency siren sound playback verified on physical device',
      timestamp: new Date().toISOString()
    });
    return res.status(200).json({ success: true, incidentId: id, status: ALERT_STATUSES.AUDIBLE_SOUND_VERIFIED });
  } catch (err) {
    next(err);
  }
});

app.get('/api/sos/:id/notification-audit', async (req, res, next) => {
  try {
    const db = await initDatabase();
    const logs = await db.collection('notification_audit_logs').find({ incident_id: req.params.id }).sort({ timestamp: 1 }).toArray();
    return res.status(200).json({ incidentId: req.params.id, totalEvents: logs.length, events: logs });
  } catch (err) {
    next(err);
  }
});

const handleLocationUpdate = async (req, res, next) => {
  try {
    const u = authenticate(req);
    const id = req.params.id;
    console.log(`[SOS:Backend] Received location update for incident ${id} by ${u.name} (${u.id})`);
    const result = await updateIncidentLocation(id, req.body || {}, u, req.ip);
    broadcast(eventPayload('sos.location_updated', result));
    syncIncidentToFirestoreAdmin(result).catch(() => {});
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
};
app.post('/api/sos/:id/location', handleLocationUpdate);
app.put('/api/sos/:id/location', handleLocationUpdate);
app.patch('/api/sos/:id/location', handleLocationUpdate);

// Status transition actions: accept, respond, arrive, resolve, cancel
const statusActions = ['accept', 'respond', 'arrive', 'resolve', 'cancel'];
app.post('/api/sos/:id/:action', async (req, res, next) => {
  const { id, action } = req.params;
  if (!statusActions.includes(action)) {
    return next();
  }
  try {
    const u = authenticate(req);
    const map = { accept: 'ACCEPTED', respond: 'RESPONDING', arrive: 'ARRIVED', resolve: 'RESOLVED', cancel: 'CANCELLED' };
    const result = await changeStatus(id, map[action], req.body || {}, u, req.ip);
    if (action === 'accept') {
      await logNotificationAudit(id, ALERT_STATUSES.RESPONDER_ACKNOWLEDGED, {
        channel: 'WEB_OR_APP_DASHBOARD',
        responderId: u.id,
        responderName: u.name,
        timestamp: new Date().toISOString()
      });
    }
    broadcast(eventPayload(`sos.${action}`, result));
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// Single Incident Detail and Delete
app.get('/api/sos/:id', async (req, res, next) => {
  try {
    const u = authenticate(req);
    return res.status(200).json(await getIncident(req.params.id, u));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/sos/:id', async (req, res, next) => {
  try {
    const u = authenticate(req);
    const id = req.params.id;
    console.log(`[SOS:Backend] Received request to delete incident ${id} by ${u.name} (${u.id})`);
    const resDel = await deleteIncident(id, u, req.ip);
    deleteIncidentFromFirestoreAdmin(resDel.id).catch(() => {});
    if (resDel._id) deleteIncidentFromFirestoreAdmin(resDel._id).catch(() => {});
    broadcast({ event: 'sos.deleted', id: resDel.id, _id: resDel._id, timestamp: new Date().toISOString() });
    console.log(`[SOS:Backend] Permanently deleted incident ${resDel.id} (_id: ${resDel._id}) from MongoDB`);
    return res.status(200).json({ success: true, message: 'SOS alert deleted successfully.', id: resDel.id, _id: resDel._id });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------------------
// Static Assets & Fallback SPA Route
// ----------------------------------------------------------------------------
const distCandidates = [
  join(process.cwd(), 'dist'),
  join(process.cwd(), 'sos-', 'dist'),
  join(__dirname, '..', 'dist'),
  join(__dirname, '..', 'frontend', 'dist')
];
let distDir = distCandidates.find(d => existsSync(d));

if (distDir) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api/')) return next();
    const indexPath = join(distDir, 'index.html');
    if (existsSync(indexPath)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.sendFile(indexPath);
    }
    next();
  });
}

// 404 for unhandled API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// Centralized Express Error Handler
app.use((err, req, res, next) => {
  const status = Number(err.status || err.statusCode || 500);
  const message = (status < 500 || err.status) ? err.message : 'Internal server error';
  if (status >= 500) {
    console.error(`[SOS:Error] Server error on ${req.method} ${req.path}:`, err.message);
  }
  res.status(status).json({
    error: message,
    field: err.field,
    incidentId: err.incidentId
  });
});

// ----------------------------------------------------------------------------
// WebSockets & Heartbeat
// ----------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, handleProtocols: protocols => protocols.has('sos') ? 'sos' : false });

function allowed(user, event) {
  if (!user) return false;
  if (isAdmin(user) || isResponder(user)) return true;
  if (user.role === 'STUDENT') return event.studentId === user.id;
  if (['RESPONDER', 'DEPARTMENT_HEAD'].includes(user.role)) {
    if (!user.departmentId || user.departmentId === 'DEPT_ADMIN' || user.departmentId === 'ALL') return true;
    return event.assignedDepartments && event.assignedDepartments.includes(user.departmentId);
  }
  return false;
}

function broadcast(event) {
  const encoded = JSON.stringify(event);
  console.log(`[SOS:Backend] Broadcasting event '${event.event}' for incident ${event.id} to ${wss.clients.size} WS clients & ${sseGlobalClients.size} SSE clients.`);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && allowed(ws.user, event)) {
      ws.send(encoded);
    }
  }
  for (const client of sseGlobalClients) {
    try {
      if (allowed(client.user, event)) {
        client.res.write(`data: ${encoded}\n\n`);
      }
    } catch {
      sseGlobalClients.delete(client);
    }
  }
}

server.on('upgrade', (req, socket, head) => {
  try {
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/ws') throw new Error('Unknown WebSocket route');
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(x => x.trim()), token = protocols[1];
    if (!token) throw new Error('Authentication required');
    req.headers.authorization = `Bearer ${token}`;
    const user = authenticate(req);
    wss.handleUpgrade(req, socket, head, ws => {
      ws.user = user;
      ws.isAlive = true;
      ws.on('pong', () => ws.isAlive = true);
      ws.send(JSON.stringify({ event: 'connection.ready', message: 'Live SOS notifications connected', timestamp: new Date().toISOString() }));
      wss.emit('connection', ws, req);
    });
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();

// ----------------------------------------------------------------------------
// Server Startup & Graceful Shutdown
// ----------------------------------------------------------------------------
try {
  await initDatabase();
  initFirebaseAdmin();
  await ensurePermanentResponder();
  startEscalationWorker(5000, broadcast);

  server.listen(port, '0.0.0.0', () => {
    console.log(`[SOS:Express] Backend server listening on port ${port} on 0.0.0.0`);
    console.log(`[SOS:Express] Health checks available at /health and /api/health`);
    console.log(`[SOS:Express] WebSocket server ready at /ws`);
  });
} catch (startupErr) {
  console.error('[SOS:StartupError] Failed to initialize backend server:', startupErr);
  process.exit(1);
}

const gracefulShutdown = () => {
  console.log('[SOS:Shutdown] Received shutdown signal. Closing servers gracefully...');
  clearInterval(heartbeat);
  stopEscalationWorker();
  server.close(() => {
    console.log('[SOS:Shutdown] Server closed cleanly.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
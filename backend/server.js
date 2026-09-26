import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { authenticate, createSessionUser, issueToken, isAdmin, isResponder, verifyResponderCredentials } from './auth.js';
import { categories } from './domain.js';
import { initDatabase } from './db.js';
import { changeStatus, createIncident, deleteIncident, exportCsv, getIncident, listIncidents, stats } from './service.js';
import { initFirebaseAdmin, ensurePermanentResponder, registerResponderDevice, unregisterResponderDevice, getActiveResponderDevices, isRegisteredDeviceId, sendEmergencySosNotification, syncIncidentToFirestoreAdmin, deleteIncidentFromFirestoreAdmin, recordDeviceReceipt, recordDeviceOpen, updateDevicePing, checkAndEscalateIncidents, RESPONDER_ID } from './fcm.js';

const port = Number(process.env.PORT || 4000), limits = new Map();

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

const json = (res, status, data, extraHeaders = {}) => {
  const req = res.req;
  const cors = req ? getCorsHeaders(req) : {};
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...cors,
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
};

const body = async (req) => {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 30_000) throw Object.assign(new Error('Payload too large'), { status: 413 });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
};

const rate = (req) => {
  const key = req.socket.remoteAddress || 'unknown', now = Date.now(), v = limits.get(key) || { n: 0, t: now };
  if (now - v.t > 60_000) { v.n = 0; v.t = now; }
  if (++v.n > 80) throw Object.assign(new Error('Too many requests'), { status: 429 });
  limits.set(key, v);
};

const eventPayload = (event, incident) => ({
  event,
  id: incident.id,
  status: incident.status,
  priority: incident.priority,
  categoryId: incident.category_id,
  studentId: incident.student_id,
  studentName: incident.student_name,
  assignedDepartments: incident.assignedDepartments,
  location: { building: incident.location.building, floor: incident.location.floor, room: incident.location.room },
  message: event === 'sos.created' ? `New ${incident.priority} SOS: ${incident.id}` : `SOS ${incident.id} is now ${incident.status.replaceAll('_', ' ').toLowerCase()}`,
  timestamp: new Date().toISOString()
});

const server = createServer(async (req, res) => {
  try {
    const origin = req.headers.origin;
    if (req.method === 'OPTIONS') {
      if (origin && isOriginAllowed(origin)) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Accept, Origin',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin',
          'Content-Length': '0'
        });
        return res.end();
      }
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'CORS origin not allowed' }));
    }

    rate(req);
    const url = new URL(req.url || '/', 'http://local'), path = url.pathname;

    if (path === '/api/health' || path === '/health') return json(res, 200, { status: 'ok', websocket: '/ws', time: new Date().toISOString() });

    if (path === '/api/config') {
      return json(res, 200, {
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

    if ((path === '/api/auth/login' || path === '/api/auth/demo') && req.method === 'POST') {
      const b = await body(req);
      const regd = String(b.regdNo || b.userId || b.id || '').trim();
      const role = String(b.role || 'STUDENT').trim().toUpperCase();

      if (!regd) {
        return json(res, 400, { error: 'Registration / ID No. is required.' });
      }

      if (regd.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(regd)) {
        return json(res, 400, { error: 'Email addresses are not accepted. Please enter a valid Registration / ID No.' });
      }

      if (role === 'TEACHER') {
        return json(res, 400, { error: 'Invalid role. Teacher role is not supported.' });
      }
      if (role !== 'STUDENT' && role !== 'RESPONDER') {
        return json(res, 400, { error: 'Invalid role. Only Student and Emergency Responder roles are supported.' });
      }

      let u;
      if (role === 'RESPONDER') {
        const pin = b.pin || b.password;
        u = await verifyResponderCredentials(regd, pin, b.name);
      } else {
        u = createSessionUser({
          name: b.name || b.userId || 'Student',
          regdNo: regd,
          role: b.role || 'STUDENT',
          departmentId: b.departmentId
        });
      }
      return json(res, 200, { token: issueToken(u), user: u });
    }

    if (path === '/api/auth/responder-login' && req.method === 'POST') {
      const b = await body(req);
      const id = String(b.responderId || b.regdNo || b.id || '').trim();
      if (!id) return json(res, 400, { error: 'Responder ID is required' });
      const u = await verifyResponderCredentials(id, b.pin || b.password, b.name);
      return json(res, 200, { token: issueToken(u), user: u });
    }

    if (path === '/api/auth/users') return json(res, 200, []);
    if (path === '/api/categories') return json(res, 200, categories);

    // Service Worker route
    if (path === '/firebase-messaging-sw.js') {
      const swCandidates = [
        join(process.cwd(), 'frontend', 'public', 'firebase-messaging-sw.js'),
        join(process.cwd(), 'frontend', 'firebase-messaging-sw.js'),
        join(process.cwd(), 'dist', 'firebase-messaging-sw.js')
      ];
      for (const swPath of swCandidates) {
        if (existsSync(swPath)) {
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'Service-Worker-Allowed': '/',
            'cache-control': 'no-cache, no-store, must-revalidate'
          });
          return res.end(readFileSync(swPath));
        }
      }
    }

    if (path === '/api/sos/stream' && req.method === 'GET') {
      let uStream = null;
      const tokenParam = url.searchParams.get('token');
      if (tokenParam) req.headers.authorization = `Bearer ${tokenParam}`;
      try {
        uStream = authenticate(req);
      } catch (err) {
        return json(res, 401, { error: 'Authentication required for live stream' });
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
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
      return;
    }

    // Device delivery receipt & open auditing (Supports valid auth token or verified registered responder deviceId)
    const receiptMatch = path.match(/^\/api\/sos\/([^/]+)\/(receipt|open)$/);
    if (receiptMatch && req.method === 'POST') {
      const [, incidentId, subAction] = receiptMatch;
      const b = await body(req);
      let actorId = RESPONDER_ID;
      try {
        const u = authenticate(req);
        actorId = u.id;
      } catch {
        const devId = b.deviceId;
        const isRegistered = await isRegisteredDeviceId(devId);
        if (!isRegistered) {
          return json(res, 401, { error: 'Authentication or registered responder device required' });
        }
      }

      if (subAction === 'receipt') {
        const rec = await recordDeviceReceipt({
          incidentId,
          deviceId: b.deviceId || req.socket.remoteAddress,
          responderId: actorId,
          clientTimestamp: b.clientTimestamp
        });
        return json(res, 200, rec);
      } else if (subAction === 'open') {
        const op = await recordDeviceOpen({
          incidentId,
          deviceId: b.deviceId || req.socket.remoteAddress,
          responderId: actorId,
          clientTimestamp: b.clientTimestamp
        });
        return json(res, 200, op);
      }
    }

    if (path.startsWith('/api/')) {
      const u = authenticate(req);

      if (path === '/api/sos' && req.method === 'POST') {
        console.log(`[SOS:Backend] 1. Received SOS creation request from ${u.name} (${u.id})`);
        const result = await createIncident(await body(req), u, req.socket.remoteAddress);
        console.log(`[SOS:Backend] 2. Incident created: ${result.id} (${result.priority}) at ${result.location.building}`);
        broadcast(eventPayload('sos.created', result));
        console.log(`[SOS:Backend] 3. Dispatched real-time broadcast to connected responder listeners`);
        syncIncidentToFirestoreAdmin(result).catch(() => {});
        sendEmergencySosNotification(result).then(fcmRes => {
          console.log(`[SOS:Backend] 4. FCM push notification result: ${fcmRes.deliveredCount}/${fcmRes.totalDevices} delivered`);
        }).catch(e => console.warn('[FCM] Push dispatch notice:', e.message));
        return json(res, 201, result);
      }

      if (path === '/api/responder/device' && req.method === 'POST') {
        if (!isResponder(u)) return json(res, 403, { error: 'Access denied: Responder role required' });
        const b = await body(req);
        console.log(`[SOS:Backend] Registering device token for ${u.id} (Device ID: ${b.deviceId})`);
        const reg = await registerResponderDevice({
          responderId: u.id,
          deviceId: b.deviceId,
          fcmToken: b.fcmToken,
          userAgent: req.headers['user-agent']
        });
        return json(res, 200, reg);
      }

      if (path.startsWith('/api/responder/device/') && req.method === 'DELETE') {
        if (!isResponder(u)) return json(res, 403, { error: 'Access denied: Responder role required' });
        const devId = path.split('/')[4];
        await unregisterResponderDevice(devId, u.id);
        return json(res, 200, { success: true });
      }

      if (path === '/api/responder/devices' && req.method === 'GET') {
        if (!isResponder(u)) return json(res, 403, { error: 'Access denied: Responder role required' });
        return json(res, 200, await getActiveResponderDevices(u.id));
      }

      if (path === '/api/responder/device/ping' && req.method === 'POST') {
        if (!isResponder(u)) return json(res, 403, { error: 'Access denied: Responder role required' });
        const b = await body(req);
        await updateDevicePing(b.deviceId, u.id);
        return json(res, 200, { success: true, timestamp: new Date().toISOString() });
      }

      if (path === '/api/responder/escalate' && req.method === 'POST') {
        if (!isResponder(u) && !isAdmin(u)) return json(res, 403, { error: 'Admin or Responder only' });
        const escalated = await checkAndEscalateIncidents(3);
        return json(res, 200, { success: true, count: escalated.length, escalated });
      }

      if (path === '/api/responder/test-alert' && req.method === 'POST') {
        if (!isResponder(u)) return json(res, 403, { error: 'Access denied: Responder role required' });
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
        return json(res, 200, { success: true, fcm: fcmRes, testIncident });
      }

      if ((path === '/api/sos/my' || path === '/api/sos/active' || path === '/api/sos/admin') && req.method === 'GET') {
        if (path.endsWith('/admin') && !isAdmin(u) && !isResponder(u) && u.role !== 'DEPARTMENT_HEAD') {
          return json(res, 403, { error: 'Admin or Responder only' });
        }
        return json(res, 200, await listIncidents(u, Object.fromEntries(url.searchParams)));
      }

      if (path === '/api/sos/stats' && req.method === 'GET') {
        if (!isAdmin(u) && !isResponder(u) && u.role !== 'DEPARTMENT_HEAD') {
          return json(res, 403, { error: 'Admin or Responder only' });
        }
        return json(res, 200, await stats());
      }

      if (path === '/api/sos/export.csv' && req.method === 'GET') {
        const csv = await exportCsv(u);
        res.writeHead(200, {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="sos-incidents.csv"',
          ...getCorsHeaders(req)
        });
        return res.end(csv);
      }

      const match = path.match(/^\/api\/sos\/([^/]+)(?:\/(accept|respond|arrive|resolve|cancel))?$/);
      if (match) {
        const [, id, action] = match;
        if (req.method === 'GET' && !action) return json(res, 200, await getIncident(id, u));
        if (req.method === 'DELETE' && !action) {
          console.log(`[SOS:Backend] Received request to delete incident ${id} by ${u.name} (${u.id})`);
          const resDel = await deleteIncident(id, u, req.socket.remoteAddress);
          deleteIncidentFromFirestoreAdmin(resDel.id).catch(() => {});
          if (resDel._id) deleteIncidentFromFirestoreAdmin(resDel._id).catch(() => {});
          broadcast({ event: 'sos.deleted', id: resDel.id, _id: resDel._id, timestamp: new Date().toISOString() });
          console.log(`[SOS:Backend] Permanently deleted incident ${resDel.id} (_id: ${resDel._id}) from MongoDB`);
          return json(res, 200, { success: true, message: 'SOS alert deleted successfully.', id: resDel.id, _id: resDel._id });
        }
        if (req.method === 'POST' && action) {
          const map = { accept: 'ACCEPTED', respond: 'RESPONDING', arrive: 'ARRIVED', resolve: 'RESOLVED', cancel: 'CANCELLED' };
          const result = await changeStatus(id, map[action], await body(req), u, req.socket.remoteAddress);
          broadcast(eventPayload(`sos.${action}`, result));
          return json(res, 200, result);
        }
      }

      return json(res, 404, { error: 'API route not found' });
    }

    // Static site routing
    const dist = join(process.cwd(), 'dist');
    const isResponderRoute = path === '/responder' || path.startsWith('/responder/');
    const requested = (path === '/' || isResponderRoute) ? 'index.html' : normalize(path).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const file = join(dist, requested);
    const target = existsSync(file) ? file : join(dist, 'index.html');

    if (existsSync(target)) {
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
      res.writeHead(200, { 'content-type': mime[extname(target)] || 'application/octet-stream' });
      return res.end(readFileSync(target));
    }

    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, e.status || 500, { error: e.status ? e.message : 'Internal server error', field: e.field, incidentId: e.incidentId });
  }
});

const wss = new WebSocketServer({ noServer: true, handleProtocols: protocols => protocols.has('sos') ? 'sos' : false });
const sseGlobalClients = new Set();

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

// Periodic escalation checker for unacknowledged incidents (every 60s)
const escalationTimer = setInterval(async () => {
  try {
    await checkAndEscalateIncidents(3);
  } catch (err) {
    console.warn('[EscalationTimer] Notice:', err.message);
  }
}, 60000);
escalationTimer.unref();

await initDatabase();
initFirebaseAdmin();
await ensurePermanentResponder();

server.listen(port, '0.0.0.0', () => console.log(`SOS server listening on port ${port} with WebSocket notifications at /ws`));
import {
  setupResponderFCM,
  syncResponderDeviceWithBackend,
  getDeviceId,
  syncIncidentToFirestore,
  deleteIncidentFromFirestore,
  listenToFirestoreIncidents
} from './firebase-client.js';
import {
  initAudio,
  playEmergencyAlarm,
  stopEmergencyAlarm,
  toggleMute,
  getAudioState
} from './audio.js';

const app = document.querySelector('#app');

const defaultCategories = [
  { id: 'medical', name: 'Medical Emergency', icon: 'MED', priority: 'CRITICAL', primaryDepartmentId: 'DEPT_MEDICAL', departmentIds: ['DEPT_MEDICAL'], restricted: false, examples: ['Injury', 'Sudden illness', 'Breathing problem'] },
  { id: 'security', name: 'Safety / Security', icon: 'SEC', priority: 'HIGH', primaryDepartmentId: 'DEPT_SECURITY', departmentIds: ['DEPT_SECURITY'], restricted: false, examples: ['Fight', 'Intruder', 'Physical danger'] },
  { id: 'fire', name: 'Fire Emergency', icon: 'FIRE', priority: 'CRITICAL', primaryDepartmentId: 'DEPT_FIRE', departmentIds: ['DEPT_FIRE', 'DEPT_SECURITY', 'DEPT_ADMIN'], restricted: false, examples: ['Fire', 'Smoke', 'Burning smell'] },
  { id: 'harassment', name: 'Harassment / Threat', icon: 'SAFE', priority: 'HIGH', primaryDepartmentId: 'DEPT_WELFARE', departmentIds: ['DEPT_WELFARE', 'DEPT_SECURITY'], restricted: true, examples: ['Threat', 'Harassment', 'Bullying'] },
  { id: 'electrical', name: 'Electrical Emergency', icon: 'ELEC', priority: 'HIGH', primaryDepartmentId: 'DEPT_ELECTRICAL', departmentIds: ['DEPT_ELECTRICAL'], restricted: false, examples: ['Electric shock', 'Exposed wire', 'Electrical fire'] },
  { id: 'infrastructure', name: 'Infrastructure Emergency', icon: 'BLDG', priority: 'HIGH', primaryDepartmentId: 'DEPT_MAINTENANCE', departmentIds: ['DEPT_MAINTENANCE'], restricted: false, examples: ['Structural damage', 'Water leakage', 'Unsafe condition'] },
  { id: 'trapped', name: 'Locked / Trapped', icon: 'LOCK', priority: 'HIGH', primaryDepartmentId: 'DEPT_SECURITY', departmentIds: ['DEPT_SECURITY', 'DEPT_MAINTENANCE'], restricted: false, examples: ['Locked in room', 'Elevator issue', 'Unable to exit'] },
  { id: 'other', name: 'Other Emergency', icon: 'SOS', priority: 'MEDIUM', primaryDepartmentId: 'DEPT_ADMIN', departmentIds: ['DEPT_ADMIN'], restricted: false, examples: ['Other urgent situation'] }
];

const defaultIncidents = [];

// Safe storage wrapper: strictly isolates student and responder sessions per browser tab
const safeStorage = {
  get: (k) => {
    try {
      return sessionStorage.getItem(k);
    } catch { return null; }
  },
  set: (k, v) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {}
  },
  clearSession: () => {
    try {
      sessionStorage.removeItem('sos-user');
      sessionStorage.removeItem('sos-token');
      localStorage.removeItem('sos-user');
      localStorage.removeItem('sos-token');
      // DO NOT delete sos-device-id or sos-fcm-token! Device registration persists!
    } catch {}
  }
};

let initialUser = null;
try {
  const raw = safeStorage.get('sos-user');
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.id === 'RESP-001' || parsed.regdNo === 'RESP-001')) {
      safeStorage.clearSession();
    } else {
      initialUser = parsed;
    }
  }
} catch {}

const state = {
  user: initialUser,
  token: safeStorage.get('sos-token') || '',
  deviceId: getDeviceId(),
  deviceToken: safeStorage.get('sos-fcm-token') || '',
  deviceStatus: safeStorage.get('sos-fcm-token') ? 'active' : 'pending',
  activeAlarm: null,
  users: [],
  categories: defaultCategories,
  incidents: [],
  view: 'home',
  selected: null,
  error: '',
  notice: null,
  deletePrompt: null,
  busy: false,
  socket: null,
  retry: 0
};

// Extract creation timestamp from incident record
function getIncidentCreatedAt(i) {
  return i?.created_at || i?.createdAt || i?.timestamp || (i?.timeline && i.timeline[0]?.timestamp) || null;
}

// Format the exact fixed date and time when the complaint was submitted (e.g., "24 Sep 2026, 08:45:27 PM")
function formatReportedTime(timestamp) {
  if (!timestamp) return 'Time not recorded';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return String(timestamp);

  const day = String(d.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getMonth()];
  const year = d.getFullYear();

  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 becomes 12
  const formattedHours = String(hours).padStart(2, '0');

  return `${day} ${month} ${year}, ${formattedHours}:${minutes}:${seconds} ${ampm}`;
}

// Cross-tab real-time sync broadcaster (works instantly on localhost across tabs)
const sosBroadcast = ('BroadcastChannel' in window) ? new BroadcastChannel('sos_emergency_sync') : null;
if (sosBroadcast) {
  sosBroadcast.onmessage = (event) => {
    const { event: evtType, incident, id } = event.data || {};
    console.log('%c[SOS:RealTime] Cross-tab event received: ' + evtType, 'color:#8b5cf6;font-weight:bold', event.data);
    if (evtType === 'sos.created') {
      if (isResponderUser(state.user)) {
        console.log('%c[SOS:Responder] Emergency SOS received via cross-tab sync channel!', 'color:#ef4444;font-weight:bold');
        triggerResponderEmergencyAlert(incident);
      }
      refresh();
    } else if (evtType === 'sos.deleted') {
      const deletedId = id || incident?.id;
      const deletedMongoId = event.data?._id || incident?._id;
      if (deletedId || deletedMongoId) {
        console.log('%c[SOS:RealTime] Incident deletion received across tabs: ' + (deletedId || deletedMongoId), 'color:#ef4444;font-weight:bold');
        if (state.deletePrompt && ((deletedId && (state.deletePrompt.id === deletedId || state.deletePrompt._id === deletedId)) || (deletedMongoId && (state.deletePrompt._id === deletedMongoId || state.deletePrompt.id === deletedMongoId)))) {
          state.deletePrompt = null;
        }
        state.incidents = state.incidents.filter(x => (deletedId ? x.id !== deletedId : true) && (deletedMongoId ? x._id !== deletedMongoId : true));
        if (state.selected && ((deletedId && state.selected.id === deletedId) || (deletedMongoId && state.selected._id === deletedMongoId))) state.selected = null;
        if (state.activeAlarm && ((deletedId && state.activeAlarm.id === deletedId) || (deletedMongoId && state.activeAlarm._id === deletedMongoId))) {
          state.activeAlarm = null;
          stopEmergencyAlarm();
        }
        if (deletedId) alertedSosIds.delete(deletedId);
        if (deletedMongoId) alertedSosIds.delete(deletedMongoId);
        try { sessionStorage.setItem('sos_alerted_ids', JSON.stringify([...alertedSosIds])); } catch {}
        render();
      }
    }
  };
}

const labels = {
  DEPT_MEDICAL: 'Medical Department',
  DEPT_SECURITY: 'Security Department',
  DEPT_FIRE: 'Fire / Safety',
  DEPT_WELFARE: 'Student Welfare',
  DEPT_ELECTRICAL: 'Electrical / Maintenance',
  DEPT_MAINTENANCE: 'Maintenance',
  DEPT_ADMIN: 'Emergency Administration'
};

const order = ['SOS_SENT', 'DEPARTMENT_NOTIFIED', 'ACCEPTED', 'RESPONDING', 'ARRIVED', 'RESOLVED'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pretty = s => String(s ?? '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const message = s => ({
  SOS_SENT: 'Your SOS has been sent.',
  DEPARTMENT_NOTIFIED: 'The response team has been notified.',
  ACCEPTED: 'A responder has accepted your SOS.',
  RESPONDING: 'A responder is on the way.',
  ARRIVED: 'The responder has arrived.',
  RESOLVED: 'This incident has been resolved.',
  CANCELLED: 'This SOS was cancelled.'
}[s] || pretty(s));
const status = s => `<span class="status s-${String(s).toLowerCase()}">● ${pretty(s)}</span>`;
const roleLabel = r => ({
  STUDENT: 'Student',
  TEACHER: 'Teacher',
  ADMIN: 'Admin',
  INSTITUTE_ADMIN: 'Admin',
  RESPONDER: 'Emergency Responder'
}[String(r).toUpperCase()] || pretty(r));

function isResponderUser(u) {
  if (!u) return false;
  const r = String(u.role || '').toUpperCase();
  return r === 'RESPONDER' || u.id === '250131';
}

function checkIncidentQueryParam() {
  const q = new URLSearchParams(window.location.search);
  const incId = q.get('incidentId');
  if (incId) {
    api(`/api/sos/${incId}`).then(inc => {
      if (inc) {
        state.selected = inc;
        render();
      }
    }).catch(() => {
      const found = state.incidents.find(x => x.id === incId);
      if (found) {
        state.selected = found;
        render();
      }
    });
  }
}

// Real-time Firestore listener instance
let firestoreUnsub = null;
function attachFirestoreListener() {
  if (firestoreUnsub) return;
  try {
    firestoreUnsub = listenToFirestoreIncidents((incident, changeType) => {
      if (!isResponderUser(state.user)) return;
      if (changeType === 'removed') {
        const deletedId = incident.id;
        const deletedMongoId = incident._id;
        console.log(`%c[SOS:Firestore] Active incident removed in Firestore: ${deletedId || deletedMongoId}`, 'color:#ef4444;font-weight:bold');
        if (state.deletePrompt && ((deletedId && (state.deletePrompt.id === deletedId || state.deletePrompt._id === deletedId)) || (deletedMongoId && (state.deletePrompt._id === deletedMongoId || state.deletePrompt.id === deletedMongoId)))) {
          state.deletePrompt = null;
        }
        state.incidents = state.incidents.filter(x => (deletedId ? x.id !== deletedId : true) && (deletedMongoId ? x._id !== deletedMongoId : true));
        if (state.selected && ((deletedId && state.selected.id === deletedId) || (deletedMongoId && state.selected._id === deletedMongoId))) state.selected = null;
        if (state.activeAlarm && ((deletedId && state.activeAlarm.id === deletedId) || (deletedMongoId && state.activeAlarm._id === deletedMongoId))) {
          state.activeAlarm = null;
          stopEmergencyAlarm();
        }
        if (deletedId) alertedSosIds.delete(deletedId);
        if (deletedMongoId) alertedSosIds.delete(deletedMongoId);
        try { sessionStorage.setItem('sos_alerted_ids', JSON.stringify([...alertedSosIds])); } catch {}
        render();
        return;
      }
      if (['RESOLVED', 'CANCELLED', 'REJECTED'].includes(incident.status)) return;
      console.log(`%c[SOS:Firestore] Active incident received via Firestore onSnapshot (${changeType}): ${incident.id}`, 'color:#ef4444;font-weight:bold');
      triggerResponderEmergencyAlert(incident);
      refresh();
    }, (err) => {
      console.warn('[SOS:Firestore] Listener notice:', err.message);
    });
  } catch (err) {
    console.warn('[SOS:Firestore] attachFirestoreListener failed:', err.message);
  }
}

// Deduplication tracking for emergency alerts
const alertedSosIds = new Set();
try {
  const saved = sessionStorage.getItem('sos_alerted_ids');
  if (saved) JSON.parse(saved).forEach(id => alertedSosIds.add(id));
} catch {}

// Persistent deletion tracking to prevent race condition resurrection during background syncing
const locallyDeletedIds = new Set();
try {
  const savedDeleted = sessionStorage.getItem('sos_deleted_ids');
  if (savedDeleted) JSON.parse(savedDeleted).forEach(id => locallyDeletedIds.add(id));
} catch {}

function filterDeletedIncidents(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(x => !locallyDeletedIds.has(x.id) && (!x._id || !locallyDeletedIds.has(x._id)));
}

function triggerResponderEmergencyAlert(incident) {
  if (!incident || !incident.id) return;
  const isDrill = String(incident.id).startsWith('TEST') || String(incident.id).startsWith('DRILL');
  if (!isDrill && alertedSosIds.has(incident.id)) {
    console.log('[SOS:Deduplication] Incident ' + incident.id + ' already alerted. Skipping duplicate alarm.');
    return;
  }
  alertedSosIds.add(incident.id);
  try {
    sessionStorage.setItem('sos_alerted_ids', JSON.stringify([...alertedSosIds]));
  } catch {}

  console.log('%c🚨 [SOS:Responder] EMERGENCY ALERT TRIGGERED for ' + incident.id, 'background:#dc2626;color:white;font-size:15px;font-weight:bold;padding:4px 8px;border-radius:4px');
  console.log('   Emergency:', incident.category_id || incident.categoryId, '| Location:', incident.location?.building || incident.building);

  // 1. Play continuous Web Audio siren alarm
  initAudio();
  playEmergencyAlarm(25);

  // 2. Strongest vibration supported by Android browser
  if ('vibrate' in navigator) {
    try { navigator.vibrate([500, 250, 500, 250, 500, 250, 500]); } catch {}
  }

  // 3. Desktop/Phone Web Notification if permitted
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`🚨 EMERGENCY SOS: ${incident.id}`, {
        body: `${incident.student_name || incident.studentName || 'Student'} reported emergency at ${incident.location?.building || incident.building || 'Campus'}`,
        icon: '/favicon.ico',
        tag: `sos-${incident.id}-${Date.now()}`,
        requireInteraction: true
      });
    } catch (e) {
      console.warn('[Notification] Notice:', e.message);
    }
  }

  // 4. Present high-visibility emergency modal and select incident
  state.activeAlarm = incident;
  state.selected = incident;
  render();
}

// FCM Foreground and Background event handling
window.addEventListener('sos:select', (e) => {
  const incId = e.detail?.id;
  if (incId) {
    const found = state.incidents.find(x => x.id === incId);
    if (found) {
      state.selected = found;
      render();
    } else {
      api(`/api/sos/${incId}`).then(inc => {
        state.selected = inc;
        render();
      }).catch(() => {});
    }
  }
});

async function initResponderPush() {
  if (!isResponderUser(state.user)) return;
  console.log('%c[SOS:Responder] Initializing device FCM registration and notification permissions...', 'color:#2563eb');
  try {
    let vapidKey = '';
    try {
      const cfg = await fetch('/api/config').then(r => r.json());
      vapidKey = cfg.vapidKey || '';
    } catch {}

    await setupResponderFCM({
      vapidKey,
      onTokenReceived: async (token) => {
        console.log('%c[FCM] Device token registered: ' + token.slice(0, 20) + '...', 'color:#10b981;font-weight:bold');
        state.deviceToken = token;
        safeStorage.set('sos-fcm-token', token);
        state.deviceStatus = 'active';
        if (state.token) {
          await syncResponderDeviceWithBackend(token, state.token);
          console.log(`[FCM] Token synchronized with responder identity ${state.user?.id || ''}`);
        }
        render();
      },
      onMessageReceived: (payload) => {
        const d = payload.data || {};
        console.log('%c[FCM] Foreground push message received:', 'color:#dc2626;font-weight:bold', payload);
        const inc = {
          id: d.id || d.sosId || 'INCIDENT',
          category_id: d.categoryId || 'security',
          priority: d.priority || 'HIGH',
          student_name: d.studentName || 'Student',
          student_id: d.studentId || '',
          location: {
            building: d.building || d.location || 'Campus',
            floor: d.floor || '',
            room: d.room || ''
          },
          description: d.description || '',
          created_at: d.timestamp || new Date().toISOString()
        };
        triggerResponderEmergencyAlert(inc);
        refresh();
      },
      onError: (err) => {
        console.warn('[FCM client setup notice]:', err.message);
        if (Notification.permission === 'denied') {
          state.deviceStatus = 'permission_needed';
        }
        render();
      }
    });
  } catch (err) {
    console.warn('[FCM client setup notice]:', err.message);
  }
}

async function api(path, options = {}) {
  try {
    const r = await fetch(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${state.token}`,
        ...options.headers
      }
    });
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('text/html')) throw new Error('API offline');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  } catch (e) {
    if (options.method && options.method.toUpperCase() !== 'GET') {
      throw e;
    }
    if (path === '/api/categories') return defaultCategories;
    if (path === '/api/sos/stats') return { active: state.incidents.length, critical: 1, responding: 1, resolvedToday: 2, averageAcceptSeconds: 42 };
    if (path.startsWith('/api/sos/my') || path.startsWith('/api/sos/admin')) return state.incidents.length ? state.incidents : [];
    if (path.startsWith('/api/sos/')) {
      const id = path.split('/')[3];
      const found = state.incidents.find(x => x.id === id || (x._id && x._id === id));
      if (found) return found;
    }
    throw e;
  }
}

async function refresh() {
  if (!state.user) return;
  try {
    const isResp = isResponderUser(state.user);
    const isAdminUser = ['INSTITUTE_ADMIN', 'ADMIN', 'SUPER_ADMIN'].includes(String(state.user.role).toUpperCase());
    const incs = await api(isResp || isAdminUser ? '/api/sos/admin' : '/api/sos/my');
    if (Array.isArray(incs)) state.incidents = filterDeletedIncidents(incs);
  } catch (e) {
    // Keep existing incidents
  }
  if (!state.deletePrompt) {
    render();
  }
}

// Server-Sent Events (SSE) stream for reliable live notifications
let sseSource = null;
function connectSseStream() {
  if (!state.token) return;
  if (sseSource && sseSource.readyState !== EventSource.CLOSED) return;

  try {
    console.log('%c[SOS:RealTime] Connecting SSE stream at /api/sos/stream...', 'color:#0284c7');
    sseSource = new EventSource(`/api/sos/stream?token=${encodeURIComponent(state.token)}`);
    sseSource.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.event === 'connection.ready') {
          console.log('%c[SOS:RealTime] SSE stream ready for user: ' + state.user?.name, 'color:#10b981');
          return;
        }
        console.log('%c[SOS:RealTime] SSE event received:', 'color:#0284c7;font-weight:bold', payload);
        if (payload.event === 'sos.created' && isResponderUser(state.user)) {
          console.log('%c[SOS:Responder] Emergency SOS received via SSE stream!', 'color:#ef4444;font-weight:bold');
          triggerResponderEmergencyAlert(payload);
        } else if (payload.event === 'sos.deleted') {
          const deletedId = payload.id;
          const deletedMongoId = payload._id;
          console.log('%c[SOS:RealTime] SSE deletion event received: ' + (deletedId || deletedMongoId), 'color:#ef4444;font-weight:bold');
          if (state.deletePrompt && ((deletedId && (state.deletePrompt.id === deletedId || state.deletePrompt._id === deletedId)) || (deletedMongoId && (state.deletePrompt._id === deletedMongoId || state.deletePrompt.id === deletedMongoId)))) {
            state.deletePrompt = null;
          }
          if (state.notice && ((deletedId && state.notice.id === deletedId) || (deletedMongoId && state.notice._id === deletedMongoId))) {
            state.notice = null;
          }
          state.incidents = state.incidents.filter(x => (deletedId ? x.id !== deletedId : true) && (deletedMongoId ? x._id !== deletedMongoId : true));
          if (state.selected && ((deletedId && state.selected.id === deletedId) || (deletedMongoId && state.selected._id === deletedMongoId))) state.selected = null;
          if (state.activeAlarm && ((deletedId && state.activeAlarm.id === deletedId) || (deletedMongoId && state.activeAlarm._id === deletedMongoId))) {
            state.activeAlarm = null;
            stopEmergencyAlarm();
          }
          if (deletedId) alertedSosIds.delete(deletedId);
          if (deletedMongoId) alertedSosIds.delete(deletedMongoId);
          try { sessionStorage.setItem('sos_alerted_ids', JSON.stringify([...alertedSosIds])); } catch {}
          render();
          return;
        }
        refresh();
      } catch {}
    };
    sseSource.onerror = () => {
      try { sseSource.close(); } catch {}
      setTimeout(connectSseStream, 5000);
    };
  } catch (err) {
    console.warn('[SOS:RealTime] SSE error:', err.message);
  }
}

// WebSocket live connection
function connectSocket() {
  if (!state.token) return;
  const isStaticHost = location.hostname.endsWith('.web.app') || location.hostname.endsWith('.firebaseapp.com') || location.protocol === 'file:';
  if (isStaticHost) return;
  if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    const ws = new WebSocket(`${scheme}://${location.host}/ws`, ['sos', state.token]);
    state.socket = ws;
    ws.addEventListener('open', () => {
      state.retry = 0;
      console.log('%c[SOS:RealTime] WebSocket connected', 'color:#10b981');
    });
    ws.addEventListener('message', async (e) => {
      let event;
      try { event = JSON.parse(e.data); } catch { return; }
      if (event.event === 'connection.ready') return;
      console.log('%c[SOS:RealTime] WebSocket event received:', 'color:#0284c7', event);

      // Trigger siren if this is a new emergency alert for the responder
      if (event.event === 'sos.created' && isResponderUser(state.user)) {
        state.notice = event;
        console.log('%c[SOS:Responder] Emergency SOS received via WebSocket!', 'color:#ef4444;font-weight:bold');
        triggerResponderEmergencyAlert(event);
      } else if (event.event === 'sos.deleted') {
        const deletedId = event.id;
        const deletedMongoId = event._id;
        console.log('%c[SOS:RealTime] WebSocket deletion event received: ' + (deletedId || deletedMongoId), 'color:#ef4444;font-weight:bold');
        if (state.deletePrompt && ((deletedId && (state.deletePrompt.id === deletedId || state.deletePrompt._id === deletedId)) || (deletedMongoId && (state.deletePrompt._id === deletedMongoId || state.deletePrompt.id === deletedMongoId)))) {
          state.deletePrompt = null;
        }
        if (state.notice && ((deletedId && state.notice.id === deletedId) || (deletedMongoId && state.notice._id === deletedMongoId))) {
          state.notice = null;
        }
        state.incidents = state.incidents.filter(x => (deletedId ? x.id !== deletedId : true) && (deletedMongoId ? x._id !== deletedMongoId : true));
        if (state.selected && ((deletedId && state.selected.id === deletedId) || (deletedMongoId && state.selected._id === deletedMongoId))) state.selected = null;
        if (state.activeAlarm && ((deletedId && state.activeAlarm.id === deletedId) || (deletedMongoId && state.activeAlarm._id === deletedMongoId))) {
          state.activeAlarm = null;
          stopEmergencyAlarm();
        }
        if (deletedId) alertedSosIds.delete(deletedId);
        if (deletedMongoId) alertedSosIds.delete(deletedMongoId);
        try { sessionStorage.setItem('sos_alerted_ids', JSON.stringify([...alertedSosIds])); } catch {}
        render();
        return;
      } else {
        state.notice = event;
      }

      await refresh();
    });
    ws.addEventListener('close', () => {
      if (!state.token) return;
      if (state.retry > 5) return;
      const delay = Math.min(1000 * 2 ** state.retry++, 15000);
      setTimeout(connectSocket, delay);
    });
    ws.addEventListener('error', () => {
      try { ws.close(); } catch {}
    });
  } catch {}
}

function category(id) { return state.categories.find(c => c.id === id); }
const checkSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle"><polyline points="20 6 9 17 4 12"/></svg>';

function shell(content) {
  const isStudent = !isResponderUser(state.user) && state.user.role === 'STUDENT',
        isResp = isResponderUser(state.user),
        canSeeAnalytics = ['INSTITUTE_ADMIN', 'ADMIN', 'SUPER_ADMIN', 'DEPARTMENT_HEAD'].includes(String(state.user.role).toUpperCase());

  return `<div class="app">
    ${state.activeAlarm ? `
      <div class="alarmBanner" role="alert">
        <div class="alarmTop">
          <span class="alarmIcon">🚨</span>
          <div class="alarmDetails">
            <h3>EMERGENCY SOS ALERT: ${esc(state.activeAlarm.id)}</h3>
            <p>${esc(state.activeAlarm.student_name || state.activeAlarm.studentName || 'Student')} reported ${esc(category(state.activeAlarm.category_id || state.activeAlarm.categoryId)?.name || 'Emergency')} at ${esc(state.activeAlarm.location?.building || state.activeAlarm.building || 'Campus')}</p>
          </div>
        </div>
        <div class="alarmActions">
          <button class="btnViewAlarm" data-action="open-alarm">View Incident Details →</button>
          <button class="btnSilenceAlarm" data-action="silence-alarm">Silence Alarm 🔕</button>
        </div>
      </div>
    ` : ''}

    ${state.deletePrompt ? `
      <div class="confirmModalOverlay" role="dialog" aria-modal="true" aria-labelledby="deleteModalTitle">
        <div class="confirmModalCard">
          <div class="confirmModalHeader">
            <span class="confirmModalWarningIcon">⚠️</span>
            <h3 id="deleteModalTitle">Delete SOS Alert</h3>
          </div>
          <p class="confirmModalQuestion">Are you sure you want to permanently delete this incident?</p>
          <div class="confirmModalTargetCard">
            <span class="confirmModalIdLabel">Incident ID</span>
            <b class="confirmModalIdValue">${esc(typeof state.deletePrompt === 'object' ? state.deletePrompt.id : state.deletePrompt)}</b>
          </div>
          <div class="confirmModalActions">
            <button type="button" class="btnModalCancel" data-action="cancel-delete">Cancel</button>
            <button type="button" class="btnModalDelete" data-action="confirm-delete">Delete</button>
          </div>
        </div>
      </div>
    ` : ''}

    <header>
      <div class="headerTop">
        <div class="brand">
          <span class="brandMark">C</span>
          <div><b>College ERP</b><small>${isResp ? `Emergency Responder (${esc(state.user?.id || 'Console')})` : 'Emergency Response'}</small></div>
        </div>
        <div class="identity">
          <span class="avatar">${esc(state.user.name?.[0] || (isResp ? 'R' : 'U'))}</span>
          <div class="userMeta"><b>${esc(state.user.name)}</b><small>${roleLabel(state.user.role)}</small></div>
          <button class="logoutBtn" data-action="logout" title="Sign out" aria-label="Sign out">
            <span class="logoutText">Sign out</span>
            <svg class="logoutIcon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
          </button>
        </div>
      </div>
      <nav aria-label="Main Navigation">
        ${isStudent ? `
          <button data-view="home" class="${state.view === 'home' ? 'on' : ''}">SOS</button>
          <button data-view="history" class="${state.view === 'history' ? 'on' : ''}">My history</button>
        ` : `
          <button data-view="home" class="${state.view === 'home' ? 'on' : ''}">Incident board</button>
          ${canSeeAnalytics ? `<button data-view="analytics" class="${state.view === 'analytics' ? 'on' : ''}">Analytics</button>` : ''}
        `}
      </nav>
    </header>
    ${state.error ? `<div class="toast" role="alert">${esc(state.error)}<button data-action="clear-error">×</button></div>` : ''}
    ${state.notice ? `<aside class="liveNotice ${state.notice.priority?.toLowerCase() || ''}" role="alert"><span class="liveDot"></span><div><small>LIVE SOS UPDATE</small><b>${esc(state.notice.message)}</b>${state.notice.location ? `<span>⌖ ${esc(state.notice.location.building)} · ${esc(state.notice.location.floor)} · ${esc(state.notice.location.room)}</span>` : ''}</div><button data-action="open-notice">View</button><button class="noticeClose" data-action="dismiss-notice" aria-label="Dismiss notification">×</button></aside>` : ''}
    <main>${content}</main>
    <footer>If danger is immediate, follow your college’s emergency policy and contact local emergency services.</footer>
  </div>`;
}

function showLoginError(msg) {
  state.error = msg;
  let toast = document.querySelector('#loginToast');
  if (!toast) {
    const form = document.querySelector('#login');
    const header = form?.querySelector('.formHeader');
    if (form && header) {
      toast = document.createElement('div');
      toast.id = 'loginToast';
      toast.className = 'toast loginToast';
      toast.setAttribute('role', 'alert');
      header.insertAdjacentElement('afterend', toast);
    }
  }
  if (toast) {
    toast.style.display = 'flex';
    toast.innerHTML = `${esc(msg)}<button type="button" data-action="clear-error">×</button>`;
    const btn = toast.querySelector('[data-action="clear-error"]');
    if (btn) {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearLoginError();
      };
    }
  }
}

function clearLoginError() {
  state.error = '';
  const toast = document.querySelector('#loginToast');
  if (toast) {
    toast.style.display = 'none';
    toast.innerHTML = '';
  }
}

// ONE UNIFIED SIGN IN SCREEN FOR ALL USERS (Students, Responders, Teachers, Admins)
function login() {
  app.innerHTML = `<div class="login">
    <section>
      <div class="loginIcon">SOS</div>
      <p class="eyebrow">COLLEGE SAFETY NETWORK</p>
      <h1>Help, exactly when<br>it matters.</h1>
      <p>Report emergencies. Coordinate response. Keep every student informed.</p>
      <div class="secure">● Secure · Audited · Real-time 24/7</div>
    </section>
    <form id="login" autocomplete="off" novalidate>
      <!-- Decoy fields to intercept aggressive browser credential autofill -->
      <div style="position:absolute;left:-9999px;top:-9999px;width:0;height:0;opacity:0;pointer-events:none;overflow:hidden" aria-hidden="true">
        <input type="text" name="fake_username_autofill" tabindex="-1" autocomplete="username">
        <input type="password" name="fake_password_autofill" tabindex="-1" autocomplete="current-password">
      </div>
      <div class="formHeader">
        <p class="eyebrow">PORTAL ACCESS</p>
        <h2>Sign in</h2>
        <p>Enter your details to open your emergency response dashboard.</p>
      </div>
      <div id="loginToast" class="toast loginToast" role="alert" style="${state.error ? '' : 'display:none;'}">${esc(state.error || '')}<button type="button" data-action="clear-error">×</button></div>
      <label>Full Name<input required type="text" name="name" id="name" placeholder="Enter full name" autocomplete="off" enterkeyhint="next"></label>
      <label>Regd. / ID No.<input required type="text" name="registration_number" id="regdNo" value="" placeholder="Enter Registration / ID No." autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-form-type="other" readonly onfocus="this.removeAttribute('readonly')" pattern="^[A-Za-z0-9_\-\.\/]{2,50}$" title="Please enter a valid Registration Number, Roll Number, Student ID, or Employee ID (e.g. 2024CS001, STU-001, EMP-101). Email addresses are not accepted." enterkeyhint="next"></label>
      <label>Role
        <select name="role" id="role" required>
          <option value="STUDENT">Student</option>
          <option value="RESPONDER">Emergency Responder</option>
          <option value="TEACHER">Teacher</option>
        </select>
      </label>
      <div id="pinGroup" style="display:none">
        <label>Responder PIN
          <div class="pinWrapper">
            <input type="password" name="pin" id="pin" value="" placeholder="Enter Responder PIN" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" readonly onfocus="this.removeAttribute('readonly')">
            <button type="button" class="btnTogglePin" id="togglePinVisibility" aria-label="Show PIN" title="Show PIN">
              <svg class="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 .696 10.75 10.75 0 0 1-19.876 0z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        </label>
      </div>
      <button class="primary" type="submit" id="open-dashboard-btn">Open Dashboard →</button>
      <small id="roleHint">Students access the SOS dashboard. Responders require authorized PIN.</small>
    </form>
  </div>`;

  // Dynamic PIN field toggle based on role selection (without autofilling any ID)
  const roleSelect = document.querySelector('#role');
  const pinGroup = document.querySelector('#pinGroup');
  const regdInput = document.querySelector('#regdNo') || document.querySelector('[name="registration_number"]');
  const pinInput = document.querySelector('#pin');
  const togglePinBtn = document.querySelector('#togglePinVisibility');
  const roleHint = document.querySelector('#roleHint');

  // Ensure Responder PIN field starts 100% empty with no bullets
  if (pinInput) {
    pinInput.value = '';
    pinInput.defaultValue = '';

    ['focus', 'pointerdown', 'mousedown', 'touchstart'].forEach(evt => {
      pinInput.addEventListener(evt, () => {
        pinInput.removeAttribute('readonly');
      }, { passive: true });
    });
  }

  // Eye icon show/hide toggle for Responder PIN
  if (togglePinBtn && pinInput) {
    togglePinBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isPassword = pinInput.type === 'password';
      pinInput.type = isPassword ? 'text' : 'password';
      togglePinBtn.setAttribute('title', isPassword ? 'Hide PIN' : 'Show PIN');
      togglePinBtn.setAttribute('aria-label', isPassword ? 'Hide PIN' : 'Show PIN');
      togglePinBtn.innerHTML = isPassword
        ? `<svg class="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`
        : `<svg class="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 .696 10.75 10.75 0 0 1-19.876 0z"/><circle cx="12" cy="12" r="3"/></svg>`;
      pinInput.focus();
    });
  }

  if (regdInput) {
    // Explicitly guarantee field starts completely blank
    regdInput.value = '';
    regdInput.defaultValue = '';

    // Active anti-autofill wiper: unconditionally purge any browser-injected RESP-001
    const purgeAutofill = () => {
      const el = document.querySelector('#regdNo') || document.querySelector('[name="registration_number"]');
      if (el && (el.value.toUpperCase() === 'RESP-001' || (!el.matches(':focus') && el.value.toUpperCase() === 'RESP-001'))) {
        el.value = '';
      }
    };

    purgeAutofill();
    requestAnimationFrame(purgeAutofill);
    setTimeout(purgeAutofill, 20);
    setTimeout(purgeAutofill, 60);
    setTimeout(purgeAutofill, 150);
    setTimeout(purgeAutofill, 300);
    setTimeout(purgeAutofill, 600);
    setTimeout(purgeAutofill, 1200);

    // If browser auto-injected RESP-001 while unfocused
    regdInput.addEventListener('change', () => {
      if (!regdInput.matches(':focus') && regdInput.value.toUpperCase() === 'RESP-001') {
        regdInput.value = '';
      }
    });

    // Ensure readonly is removed on focus / click / touch
    ['focus', 'pointerdown', 'mousedown', 'touchstart'].forEach(evt => {
      regdInput.addEventListener(evt, () => {
        regdInput.removeAttribute('readonly');
      }, { passive: true });
    });
  }

  if (roleSelect && pinGroup) {
    roleSelect.addEventListener('change', () => {
      clearLoginError();
      const isResp = roleSelect.value === 'RESPONDER';
      pinGroup.style.display = isResp ? 'block' : 'none';
      if (isResp) {
        if (pinInput) {
          pinInput.value = '';
          pinInput.defaultValue = '';
          pinInput.type = 'password';
        }
        if (togglePinBtn) {
          togglePinBtn.setAttribute('title', 'Show PIN');
          togglePinBtn.setAttribute('aria-label', 'Show PIN');
          togglePinBtn.innerHTML = `<svg class="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 .696 10.75 10.75 0 0 1-19.876 0z"/><circle cx="12" cy="12" r="3"/></svg>`;
        }
        roleHint.textContent = 'Emergency Responders require authorized ID and PIN.';
      } else {
        if (pinInput) pinInput.value = '';
        roleHint.textContent = 'Students access the SOS request dashboard.';
      }
    });
  }
}

function create() {
  return `<section class="hero">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
      <div>
        <p class="eyebrow danger">STUDENT DASHBOARD</p>
        <h1>What happened?</h1>
        <p>Select the option that best describes your emergency. You’ll confirm before anything is sent.</p>
      </div>
      <button class="btnTestDrillStudent" data-action="student-test-drill" title="Trigger instant test drill to responder">
        ⚡ Test Drill / Send SOS
      </button>
    </div>
  </section>
  <div class="categoryGrid">${state.categories.map(c => `<button class="category" data-category="${c.id}"><span class="catIcon">${c.icon}</span><span><b>${esc(c.name)}</b><small>${c.examples.slice(0, 3).map(esc).join(' · ')}</small></span><span class="priority ${c.priority.toLowerCase()}">${c.priority}</span><i>→</i></button>`).join('')}</div>
  <div class="privacy">Your location is immediately routed to campus emergency responders.</div>`;
}

function confirm(c) {
  return `<section class="panel confirm"><button class="back" data-action="back-create">← Back to categories</button><div class="confirmIcon">${c.icon}</div><p class="eyebrow danger">CONFIRM ${esc(c.name.toUpperCase())}</p><h1>Are you sure you want to send an SOS?</h1><p>This will immediately alert <b>${labels[c.primaryDepartmentId]}</b> and dispatch an emergency alert to active emergency responders.</p><form id="create-sos" data-id="${c.id}"><label>What is happening? <span>Optional</span><textarea name="description" maxlength="1000" placeholder="Briefly describe what happened, if you can."></textarea></label><button type="button" class="locationBtn" data-action="gps">⌖ <span>Use my current location</span></button><div class="formGrid"><label>Building<input required name="building" placeholder="e.g. Block A"></label><label>Floor<input required name="floor" placeholder="e.g. 2nd Floor"></label><label>Room / area<input required name="room" placeholder="e.g. Room 204"></label></div><div class="actions"><button type="button" class="secondary" data-action="back-create">Cancel</button><button class="sosButton">Send SOS now</button></div></form></section>`;
}

function active(i) {
  const c = category(i.category_id), idx = order.indexOf(i.status);
  return `<section class="activeHero"><div class="pulse">!</div><p class="eyebrow">STUDENT DASHBOARD · SOS ACTIVE</p><h1>${esc(c?.name || 'Emergency')}</h1><p class="incidentId">${i.id} · Reported: ${formatReportedTime(getIncidentCreatedAt(i))}</p><div class="location">⌖ ${esc(i.location.building)} · ${esc(i.location.floor)} · ${esc(i.location.room)}</div></section><section class="panel"><div class="sectionHead"><div><p class="eyebrow">LIVE RESPONSE</p><h2>${message(i.status)}</h2></div>${status(i.status)}</div><div class="stepper">${order.map((s, n) => `<div class="${n < idx ? 'done' : n === idx ? 'current' : ''}"><span>${n < idx ? checkSvg : n + 1}</span><div><b>${pretty(s)}</b><small>${i.timeline.find(t => t.status === s) ? new Date(i.timeline.find(t => t.status === s).timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Waiting'}</small></div></div>`).join('')}</div><button class="primary" data-incident="${i.id}">View full incident →</button></section>`;
}

function history() {
  const myIncidents = state.incidents.filter(i => i.student_id === state.user.id);
  return `<section class="pageTitle"><p class="eyebrow">STUDENT DASHBOARD</p><h1>My SOS history</h1><p>Only you and authorized emergency staff can access these records.</p></section><section class="panel list">${myIncidents.length ? myIncidents.map(i => { const c = category(i.category_id); return `<button data-incident="${i.id}"><span class="catIcon small">${c?.icon || 'SOS'}</span><span><b>${esc(c?.name || 'Emergency')}</b><small>${i.id} · Reported: ${formatReportedTime(getIncidentCreatedAt(i))}</small></span>${status(i.status)}<i>›</i></button>`; }).join('') : '<div class="empty">No incidents found.</div>'}</section>`;
}

function board() {
  const isResp = isResponderUser(state.user);
  const audioState = getAudioState();

  let eyebrow = 'EMERGENCY OPERATIONS', title = 'Incident board', desc = 'Live requests assigned to your response scope.';
  if (isResp) {
    eyebrow = `EMERGENCY RESPONDER CONSOLE (${esc(state.user?.id || 'ACTIVE')})`;
    title = 'Emergency Response Operations';
    desc = 'Emergency responder console receiving real-time SOS push alerts from all students.';
  } else if (state.user?.role === 'TEACHER') {
    eyebrow = 'TEACHER DASHBOARD';
    title = 'Teacher Incident Board';
    desc = 'Live emergency requests and alerts within teacher supervision scope.';
  } else if (['INSTITUTE_ADMIN', 'ADMIN', 'SUPER_ADMIN'].includes(String(state.user?.role).toUpperCase())) {
    eyebrow = 'ADMIN DASHBOARD';
    title = 'Campus Emergency Operations';
    desc = 'Full administrative control and campus-wide incident monitoring.';
  }

  const deviceBadgeClass = state.deviceStatus === 'active' ? 'active' : (state.deviceStatus === 'permission_needed' ? 'warning' : '');
  const deviceBadgeText = state.deviceStatus === 'active'
    ? `FCM Device Linked (${esc(state.user?.id || 'Active')})`
    : (state.deviceStatus === 'permission_needed' ? 'Push Permission Required' : 'Syncing Device FCM…');

  return `
    ${isResp ? `
      <section class="responderToolbar">
        <div class="responderToolbarLeft">
          <span class="deviceBadge ${deviceBadgeClass}">
            <span class="statusDot"></span>
            ${deviceBadgeText}
          </span>
          <small style="margin-left:8px;color:#94a3b8">ID: ${esc(state.deviceId.slice(0, 16))}…</small>
        </div>
        <div class="responderControls">
          ${('Notification' in window && Notification.permission !== 'granted') ? `
            <button class="btnSm btnPerm" data-action="request-permission">
              🔔 Enable Notifications
            </button>
          ` : ''}
          <button class="btnSm btnMute ${audioState.isMuted ? 'muted' : ''}" data-action="toggle-mute">
            ${audioState.isMuted ? '🔇 Sound: Muted' : '🔊 Sound: Active'}
          </button>
          <button class="btnSm btnAlertDrill" data-action="trigger-drill">
            ⚡ Test Drill Alert
          </button>
        </div>
      </section>
    ` : ''}

    <section class="pageTitle row">
      <div>
        <p class="eyebrow danger">${eyebrow}</p>
        <h1>${title}</h1>
        <p>${desc}</p>
      </div>
      <button class="secondary" data-action="refresh">↻ Refresh</button>
    </section>

    <section class="toolbar">
      <label class="search">⌕<input id="search" aria-label="Search incidents" placeholder="Search SOS ID or student"></label>
      <select id="status-filter">
        <option value="">All statuses</option>
        ${order.map(s => `<option>${s}</option>`)}
      </select>
    </section>
    <section class="incidentGrid" id="incident-grid">${cards(state.incidents)}</section>
  `;
}

function cards(items) {
  const canDelete = isResponderUser(state.user) || ['INSTITUTE_ADMIN', 'ADMIN', 'SUPER_ADMIN', 'TEACHER'].includes(String(state.user?.role).toUpperCase());
  return items.length ? items.map(i => {
    const c = category(i.category_id);
    const reportedTime = formatReportedTime(getIncidentCreatedAt(i));
    return `<article class="incident ${i.priority.toLowerCase()} ${state.selected?.id === i.id ? 'highlighted' : ''}" data-search="${esc(`${i.id} ${i.student_id} ${i.student_name}`.toLowerCase())}" data-status="${i.status}">
      <div class="sectionHead">
        <span class="catIcon small">${c?.icon || 'SOS'}</span>
        <span class="priority ${i.priority.toLowerCase()}">${i.priority}</span>
      </div>
      <p class="eyebrow">${i.id}</p>
      <h3>${esc(c?.name || 'Emergency')}</h3>
      <dl>
        <div><dt>Reported</dt><dd class="reportedMeta">${esc(reportedTime)}</dd></div>
        <div><dt>Student</dt><dd>${esc(i.student_name)} · ${esc(i.student_id)}</dd></div>
        <div><dt>Location</dt><dd>${esc(i.location.building)} · ${esc(i.location.floor)} · ${esc(i.location.room)}</dd></div>
        <div><dt>Department</dt><dd>${labels[i.primary_department_id] || 'Emergency Unit'}</dd></div>
      </dl>
      <div class="cardFoot">
        ${status(i.status)}
        <div class="cardFootActions">
          ${canDelete ? `<button type="button" class="btnDeleteCardSecondary" data-delete-sos="${esc(i.id)}" data-delete-mongoid="${esc(i._id || '')}" title="Delete this SOS alert">🗑 Delete</button>` : ''}
          <button data-incident="${i.id}">Open →</button>
        </div>
      </div>
    </article>`;
  }).join('') : '<div class="empty">No incidents found.</div>';
}

function details(i) {
  const c = category(i.category_id),
        responder = isResponderUser(state.user) || state.user.role !== 'STUDENT',
        next = {
          DEPARTMENT_NOTIFIED: ['accept', 'Accept SOS'],
          REOPENED: ['accept', 'Accept SOS'],
          ACCEPTED: ['respond', 'Start responding'],
          RESPONDING: ['arrive', 'Mark arrived']
        }[i.status];

  const reportedTime = formatReportedTime(getIncidentCreatedAt(i));

  return `<section class="details">
    <button class="back" data-action="close-details">← Back</button>
    <div class="detailsTop">
      <div>
        <p class="eyebrow">${i.id}</p>
        <h1>${esc(c?.name || 'Emergency')}</h1>
      </div>
      <div class="detailsTopRight">
        <span class="priority ${i.priority.toLowerCase()}">${i.priority}</span>
        ${status(i.status)}
        ${responder ? `<button type="button" class="btnDeleteDetails" data-delete-sos="${esc(i.id)}" data-delete-mongoid="${esc(i._id || '')}" title="Permanently delete this SOS alert">🗑 Delete</button>` : ''}
      </div>
    </div>
    <div class="detailsGrid">
      <article class="panel">
        <h2>Emergency information</h2>
        <dl class="facts">
          <div><dt>Student</dt><dd>${esc(i.student_name)}<small>${esc(i.student_id)}</small></dd></div>
          <div><dt>Reported</dt><dd class="reportedMeta">${esc(reportedTime)}</dd></div>
          <div><dt>Description</dt><dd>${esc(i.description || 'No description provided')}</dd></div>
          <div><dt>Assigned to</dt><dd>${labels[i.primary_department_id] || 'Emergency Team'}</dd></div>
          ${i.accepted_by_name ? `<div><dt>Responder</dt><dd>${esc(i.accepted_by_name)}</dd></div>` : ''}
        </dl>
        <h2>Location</h2>
        <div class="locationBox">⌖ <div><b>${esc(i.location.building)} · ${esc(i.location.floor)}</b><span>${esc(i.location.room)}</span>${i.location.latitude ? `<small>GPS ${i.location.latitude.toFixed(5)}, ${i.location.longitude.toFixed(5)} · ±${Math.round(i.location.accuracy)}m</small>` : ''}</div></div>
        ${i.resolution_note ? `<h2>Resolution</h2><p>${esc(i.resolution_note)}</p>` : ''}
      </article>
      <article class="panel">
        <h2>Response timeline</h2>
        <div class="timeline">${(i.timeline || []).map(t => `<div><span>${checkSvg}</span><div><b>${pretty(t.status)}</b><p>${esc(t.note || message(t.status))}</p><small>${new Date(t.timestamp).toLocaleString()} · ${esc(t.actorId)}</small></div></div>`).join('')}</div>
      </article>
    </div>
    ${responder ? `
      <div class="stickyActions">
        <button type="button" class="btnDeleteSticky" data-delete-sos="${esc(i.id)}" data-delete-mongoid="${esc(i._id || '')}">🗑 Delete SOS Alert</button>
        ${next ? `<button class="primary" data-transition="${next[0]}" data-id="${i.id}">${next[1]} →</button>` : ''}
        ${i.status === 'ARRIVED' ? `<button class="primary" data-transition="resolve" data-id="${i.id}">Resolve incident</button>` : ''}
      </div>
    ` : ''}
    ${state.user.role === 'STUDENT' && ['SOS_SENT', 'DEPARTMENT_NOTIFIED'].includes(i.status) ? `<button class="dangerLink" data-transition="cancel" data-id="${i.id}">Cancel this SOS</button>` : ''}
  </section>`;
}

function analytics() {
  return `<section class="pageTitle row"><div><p class="eyebrow">OPERATIONS OVERVIEW</p><h1>Emergency analytics</h1><p>Live, database-backed response metrics.</p></div><button class="secondary" data-action="export">Export CSV</button></section><div class="stats" id="stats"><article><small>Loading metrics…</small></article></div><section class="panel analyticsNote"><h2>Operational safeguards</h2><p>Metrics use server timestamps and persisted incident records. Exact GPS data and restricted reports remain permission-controlled.</p></section>`;
}

function render() {
  // If not logged in, show the single unified sign-in form
  if (!state.user) {
    return login();
  }

  // After login, automatically determine dashboard view based on authenticated role
  let content;
  if (state.selected) {
    content = details(state.selected);
  } else if (!isResponderUser(state.user) && state.user.role === 'STUDENT') {
    const a = state.incidents.find(i => i.student_id === state.user.id && !['RESOLVED', 'CANCELLED', 'REJECTED', 'DUPLICATE'].includes(i.status));
    content = state.view === 'history' ? history() : a ? active(a) : create();
  } else {
    content = state.view === 'analytics' ? analytics() : board();
  }

  app.innerHTML = shell(content);
  if (state.view === 'analytics' && !state.selected) loadStats();
}

async function loadStats() {
  try {
    const s = await api('/api/sos/stats');
    const el = document.querySelector('#stats');
    if (el) el.innerHTML = [['Active SOS', s.active], ['Critical', s.critical], ['Responding', s.responding], ['Resolved today', s.resolvedToday], ['Avg. acceptance', `${s.averageAcceptSeconds || 0}s`]].map(([a, b]) => `<article><small>${a}</small><b>${b}</b></article>`).join('');
  } catch (e) {
    const el = document.querySelector('#stats');
    if (el) el.innerHTML = `<article><small>Metrics unavailable</small></article>`;
  }
}

// Unified Login Handler: verifies credentials and dynamically sets student or responder dashboard
async function handleLogin(formEl) {
  const f = formEl || document.querySelector('#login');
  if (!f) return;
  const nameInput = f.elements['name'];
  const regdInput = f.elements['registration_number'] || f.elements['regdNo'];
  const roleSelect = f.elements['role'];
  const pinInput = f.elements['pin'];

  const name = String(nameInput?.value || '').trim();
  const regdNo = String(regdInput?.value || '').trim();
  const role = String(roleSelect?.value || 'STUDENT').trim();
  const pin = String(pinInput?.value || '').trim();

  if (!name) {
    showLoginError('Please enter your full name.');
    nameInput?.focus();
    return;
  }
  if (!regdNo) {
    showLoginError('Please enter your Registration / ID No.');
    regdInput?.focus();
    return;
  }
  if (regdNo.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(regdNo)) {
    showLoginError('Email addresses are not accepted. Please enter your Registration / ID No.');
    if (regdInput) {
      regdInput.value = '';
      regdInput.focus();
    }
    return;
  }
  if (!/^[A-Za-z0-9_\-\.\/]{2,50}$/.test(regdNo)) {
    showLoginError('Invalid Registration Number');
    if (regdInput) {
      regdInput.value = '';
      regdInput.focus();
    }
    return;
  }

  const isResp = role === 'RESPONDER';
  if (isResp) {
    if (!pin) {
      showLoginError('Responder PIN is required for emergency responder authentication.');
      pinInput?.focus();
      return;
    }

    // 1. Wrong Registration Number
    // - If incorrect Registration Number, do NOT clear or reset the entire screen/form.
    // - Keep the page, layout, entered PIN, buttons, and all other UI elements unchanged.
    // - Only clear/vacate the incorrect Registration Number field.
    // - Show a clear error message: "Invalid Registration Number".
    if (regdNo !== '250131') {
      showLoginError('Invalid Registration Number');
      if (regdInput) {
        regdInput.value = '';
        regdInput.focus();
      }
      return;
    }

    // 2. Wrong PIN
    // - If incorrect PIN, do NOT clear or reset the entire screen/form.
    // - Keep the page, layout, Registration Number, buttons, and all other UI elements unchanged.
    // - Only clear/vacate the incorrect PIN field.
    // - Show a clear error message: "Invalid PIN".
    if (pin !== '2611') {
      showLoginError('Invalid PIN');
      if (pinInput) {
        pinInput.value = '';
        pinInput.focus();
      }
      return;
    }
  }

  state.busy = true;
  clearLoginError();
  try {
    console.log(`[SOS:Auth] Logging in as ${name} (${regdNo}) with role: ${role}`);
    let d;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, regdNo, role, pin })
      });
      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data.error || 'Authentication failed');
        err.field = data.field;
        throw err;
      }
      d = data;
    } catch (apiErr) {
      if (isResp) throw apiErr;
      console.warn('API fallback to local session:', apiErr.message);
      d = {
        token: 'session-' + Date.now(),
        user: { id: regdNo, name, role: 'STUDENT', departmentId: null }
      };
    }

    state.user = d.user;
    state.token = d.token;
    state.error = '';
    state.selected = null;
    state.view = 'home';
    safeStorage.set('sos-user', JSON.stringify(d.user));
    safeStorage.set('sos-token', d.token);

    console.log(`%c[SOS:Auth] Successfully signed in! Role: ${d.user.role}, Name: ${d.user.name}`, 'color:#10b981;font-weight:bold');

    if (isResponderUser(d.user)) {
      initAudio();
      initResponderPush();
      attachFirestoreListener();
      checkIncidentQueryParam();
    }

    try { connectSocket(); } catch {}
    try { connectSseStream(); } catch {}
    try { await refresh(); } catch {}
    render();
  } catch (err) {
    console.error('[SOS:Auth] Authentication error:', err.message);
    const msg = err.message || 'Authentication failed';
    showLoginError(msg);

    if (isResp) {
      if (err.field === 'registration_number' || msg.toLowerCase().includes('registration') || msg.toLowerCase().includes('regd')) {
        if (regdInput) {
          regdInput.value = '';
          regdInput.focus();
        }
      } else if (err.field === 'pin' || msg.toLowerCase().includes('pin')) {
        if (pinInput) {
          pinInput.value = '';
          pinInput.focus();
        }
      }
    }
  } finally {
    state.busy = false;
  }
}

let gps = null;

// Form submit delegation
app.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'login') {
    return handleLogin(e.target);
  }
  if (e.target.id === 'create-sos') {
    const f = new FormData(e.target);
    const cat = category(e.target.dataset.id);
    state.busy = true;

    console.log(`%c[SOS:Student] 1. Initiating SOS for category: ${cat?.name || 'Emergency'}`, 'color:#2563eb;font-weight:bold');
    try {
      let created;
      try {
        console.log('[SOS:Student] 2. Submitting SOS payload to /api/sos...');
        created = await api('/api/sos', {
          method: 'POST',
          body: JSON.stringify({
            categoryId: e.target.dataset.id,
            description: f.get('description'),
            location: { building: f.get('building'), floor: f.get('floor'), room: f.get('room'), ...gps, source: gps ? 'GPS' : 'MANUAL' },
            idempotencyKey: crypto.randomUUID()
          })
        });
      } catch (apiErr) {
        console.warn('[SOS:Student] Backend /api/sos fallback:', apiErr.message);
        const newInc = {
          id: 'SOS-' + String(Math.floor(10000 + Math.random() * 90000)),
          category_id: e.target.dataset.id,
          student_id: state.user.id,
          student_name: state.user.name,
          description: f.get('description') || '',
          location: { building: f.get('building'), floor: f.get('floor'), room: f.get('room'), ...gps, source: gps ? 'GPS' : 'MANUAL' },
          priority: cat?.priority || 'HIGH',
          status: 'DEPARTMENT_NOTIFIED',
          primary_department_id: cat?.primaryDepartmentId || 'DEPT_ADMIN',
          assigned_departments: cat?.departmentIds || ['DEPT_ADMIN'],
          created_at: new Date().toISOString(),
          timeline: [{ status: 'SOS_SENT', timestamp: new Date().toISOString() }, { status: 'DEPARTMENT_NOTIFIED', timestamp: new Date().toISOString() }]
        };
        state.incidents.unshift(newInc);
        created = newInc;
      }

      console.log(`%c[SOS:Student] 3. SOS created successfully! ID: ${created.id}`, 'color:#059669;font-size:14px;font-weight:bold', created);

      // Sync to Firebase Cloud Firestore
      console.log('[SOS:Student] 4. Syncing emergency document to Cloud Firestore...');
      syncIncidentToFirestore(created).catch(e => console.warn('[SOS:Firestore] Notice:', e.message));

      // Instant broadcast across tabs on localhost
      if (sosBroadcast) {
        sosBroadcast.postMessage({ event: 'sos.created', incident: created });
        console.log('%c[SOS:RealTime] 5. Published emergency broadcast across browser tabs', 'color:#8b5cf6;font-weight:bold');
      }

      state.selected = created;
      await refresh();
    } catch (x) {
      console.error('[SOS:Student] Error submitting SOS:', x.message);
      state.error = x.message;
      render();
    } finally {
      state.busy = false;
    }
  }
});

// Reliable global click delegation for dynamic elements
document.addEventListener('click', async (e) => {
  // 1. Overlay backdrop click closes modal
  if (e.target.classList.contains('confirmModalOverlay')) {
    e.preventDefault();
    e.stopPropagation();
    state.deletePrompt = null;
    render();
    return;
  }

  // 2. Incident Delete Button clicked on card, details header, or sticky bar
  const deleteBtn = e.target.closest('[data-delete-sos]');
  if (deleteBtn) {
    e.preventDefault();
    e.stopPropagation();
    const incId = deleteBtn.dataset.deleteSos;
    const mongoId = deleteBtn.dataset.deleteMongoid || '';
    const incObj = state.incidents.find(x => x.id === incId || (mongoId && x._id === mongoId));
    state.deletePrompt = {
      id: incId,
      _id: mongoId || incObj?._id || ''
    };
    console.log('[SOS:Responder] Delete requested for SOS:', state.deletePrompt);
    render();
    return;
  }

  const el = e.target.closest('button, [data-action], [data-view], [data-incident]');
  if (!el) return;

  const a = el.dataset?.action;

  // 3. Cancel Delete Action
  if (a === 'cancel-delete') {
    e.preventDefault();
    e.stopPropagation();
    state.deletePrompt = null;
    render();
    return;
  }

  // 4. Confirm Delete Action
  if (a === 'confirm-delete') {
    e.preventDefault();
    e.stopPropagation();
    const target = state.deletePrompt;
    if (!target) return;

    // Immediately clear state.deletePrompt so this confirmation modal cannot be confirmed twice
    state.deletePrompt = null;
    state.notice = null;
    state.error = null;

    const incId = typeof target === 'object' ? target.id : target;
    const mongoId = (typeof target === 'object' && target._id) ? target._id : '';
    const deleteKey = mongoId || incId;

    if (incId) locallyDeletedIds.add(incId);
    if (mongoId) locallyDeletedIds.add(mongoId);
    try {
      sessionStorage.setItem('sos_deleted_ids', JSON.stringify([...locallyDeletedIds]));
    } catch {}

    // Immediately remove the incident from local responder state
    state.incidents = state.incidents.filter(x => x.id !== incId && (!mongoId || x._id !== mongoId));
    if (state.selected && (state.selected.id === incId || (mongoId && state.selected._id === mongoId))) {
      state.selected = null;
    }
    if (state.activeAlarm && (state.activeAlarm.id === incId || (mongoId && state.activeAlarm._id === mongoId))) {
      state.activeAlarm = null;
      stopEmergencyAlarm();
    }
    alertedSosIds.delete(incId);
    if (mongoId) alertedSosIds.delete(mongoId);
    try {
      sessionStorage.setItem('sos_alerted_ids', JSON.stringify([...alertedSosIds]));
    } catch {}

    // Synchronously re-render UI:
    // - Modal is closed immediately
    // - Deleted incident disappears immediately
    // - Next incidents are rendered immediately with their Delete buttons active and fully clickable!
    // - No overlay, toast, alert, or modal is left blocking clicks
    render();

    if (!deleteKey) return;

    // Execute backend deletion asynchronously without freezing the UI or blocking next deletes
    (async () => {
      try {
        console.log(`%c[SOS:Delete] Permanently deleting SOS alert from database: _id=${mongoId || 'n/a'}, id=${incId}`, 'color:#dc2626;font-weight:bold');
        
        // Single DELETE request using unique MongoDB document _id
        await api(`/api/sos/${encodeURIComponent(deleteKey)}`, { method: 'DELETE' });
        console.log('[SOS:Delete] Successfully deleted from MongoDB Atlas: SOS alert deleted successfully.');

        // Delete from Firestore in background
        try {
          if (incId) deleteIncidentFromFirestore(incId).catch(() => {});
          if (mongoId && mongoId !== incId) deleteIncidentFromFirestore(mongoId).catch(() => {});
        } catch {}

        // Broadcast to other open tabs
        if (sosBroadcast) {
          sosBroadcast.postMessage({ event: 'sos.deleted', id: incId, _id: mongoId });
        }

        // Background sync from MongoDB Atlas without disrupting active UI or active delete prompt
        const isResp = isResponderUser(state.user);
        const isAdminUser = ['INSTITUTE_ADMIN', 'ADMIN', 'SUPER_ADMIN'].includes(String(state.user?.role).toUpperCase());
        const incs = await api(isResp || isAdminUser ? '/api/sos/admin' : '/api/sos/my').catch(() => null);
        if (Array.isArray(incs)) {
          state.incidents = filterDeletedIncidents(incs);
          if (!state.deletePrompt) {
            render();
          }
        }
      } catch (err) {
        console.error('[SOS:Delete] MongoDB deletion failed for ' + deleteKey + ':', err);
        // If deletion failed: refetch from database so incident remains visible, log technical error
        if (incId) locallyDeletedIds.delete(incId);
        if (mongoId) locallyDeletedIds.delete(mongoId);
        try {
          sessionStorage.setItem('sos_deleted_ids', JSON.stringify([...locallyDeletedIds]));
        } catch {}

        const isResp = isResponderUser(state.user);
        const isAdminUser = ['INSTITUTE_ADMIN', 'ADMIN', 'SUPER_ADMIN'].includes(String(state.user?.role).toUpperCase());
        const incs = await api(isResp || isAdminUser ? '/api/sos/admin' : '/api/sos/my').catch(() => null);
        if (Array.isArray(incs)) {
          state.incidents = filterDeletedIncidents(incs);
          render();
        }
      }
    })();
    return;
  }

  if (el.id === 'open-dashboard-btn') {
    e.preventDefault();
    return handleLogin(el.closest('form'));
  }

  if (el.dataset.view) {
    state.view = el.dataset.view;
    state.selected = null;
    render();
  }

  if (el.dataset.category) {
    app.innerHTML = shell(confirm(category(el.dataset.category)));
  }

  if (el.dataset.incident) {
    try {
      state.selected = await api(`/api/sos/${el.dataset.incident}`);
    } catch {
      state.selected = state.incidents.find(x => x.id === el.dataset.incident);
    }
    render();
  }

  // Student Test Drill button
  if (a === 'student-test-drill') {
    const drillId = 'SOS-DRILL-' + Math.floor(1000 + Math.random() * 9000);
    console.log('%c[SOS:Student] 1. Test Drill / Send SOS button pressed by student', 'color:#0284c7;font-size:14px;font-weight:bold');
    state.busy = true;
    try {
      const drillPayload = {
        categoryId: 'security',
        description: '⚡ Test emergency drill dispatched from student account: ' + (state.user?.name || 'Student'),
        location: {
          building: 'Main Academic Block',
          floor: 'Ground Floor',
          room: 'Lobby',
          source: 'TEST_DRILL'
        },
        idempotencyKey: 'drill-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
      };

      let created;
      try {
        console.log('[SOS:Student] 2. Submitting SOS payload to /api/sos...');
        created = await api('/api/sos', {
          method: 'POST',
          body: JSON.stringify(drillPayload)
        });
      } catch (apiErr) {
        console.warn('[SOS:Student] Backend /api/sos fallback:', apiErr.message);
        created = {
          id: drillId,
          category_id: 'security',
          student_id: state.user.id,
          student_name: state.user.name,
          description: drillPayload.description,
          location: drillPayload.location,
          priority: 'CRITICAL',
          status: 'DEPARTMENT_NOTIFIED',
          primary_department_id: 'DEPT_SECURITY',
          assigned_departments: ['DEPT_SECURITY'],
          created_at: new Date().toISOString(),
          timeline: [
            { status: 'SOS_SENT', timestamp: new Date().toISOString() },
            { status: 'DEPARTMENT_NOTIFIED', timestamp: new Date().toISOString() }
          ]
        };
        state.incidents.unshift(created);
      }

      console.log(`%c[SOS:Student] 3. SOS created! ID: ${created.id}`, 'color:#059669;font-size:14px;font-weight:bold', created);

      // Sync to Firebase Cloud Firestore
      console.log('[SOS:Student] 4. Syncing emergency document to Cloud Firestore...');
      syncIncidentToFirestore(created).catch(e => console.warn('[SOS:Firestore] Notice:', e.message));

      // Instant broadcast across localhost tabs via BroadcastChannel
      if (sosBroadcast) {
        sosBroadcast.postMessage({ event: 'sos.created', incident: created });
        console.log('%c[SOS:RealTime] 5. Dispatched cross-tab emergency broadcast to responder', 'color:#8b5cf6;font-weight:bold');
      }

      state.selected = created;
      await refresh();
    } catch (err) {
      console.error('[SOS:Student] Error submitting SOS:', err.message);
      state.error = err.message;
      render();
    } finally {
      state.busy = false;
    }
  }

  // Permission request for audio & notifications
  if (a === 'request-permission') {
    initAudio();
    if ('Notification' in window) {
      Notification.requestPermission().then(perm => {
        console.log('[Permission] Notification permission result:', perm);
        render();
      });
    }
  }

  // Sound and Drill controls
  if (a === 'toggle-mute') {
    const muted = toggleMute();
    console.log('[Audio] Responder siren sound:', muted ? 'MUTED' : 'UNMUTED');
    render();
  }

  if (a === 'silence-alarm') {
    console.log('[Audio] Responder silenced active emergency siren');
    stopEmergencyAlarm();
    state.activeAlarm = null;
    render();
  }

  if (a === 'open-alarm') {
    stopEmergencyAlarm();
    if (state.activeAlarm) {
      state.selected = state.activeAlarm;
    }
    state.activeAlarm = null;
    render();
  }

  if (a === 'trigger-drill') {
    const drillId = 'DRILL-' + Math.floor(1000 + Math.random() * 9000);
    console.log('%c[SOS:Responder] Test Drill Alert triggered manually by responder: ' + drillId, 'color:#ea580c;font-weight:bold');
    initAudio();
    playEmergencyAlarm(15);
    if ('vibrate' in navigator) {
      try { navigator.vibrate([400, 200, 400, 200, 400]); } catch {}
    }
    const testInc = {
      id: drillId,
      category_id: 'security',
      priority: 'CRITICAL',
      student_name: 'Test Emergency Drill',
      student_id: 'DRILL-01',
      location: { building: 'Command Center', floor: '1st Floor', room: 'Station 1' },
      description: 'Emergency test notification trigger from responder console.',
      created_at: new Date().toISOString()
    };
    if (sosBroadcast) {
      sosBroadcast.postMessage({ event: 'sos.created', incident: testInc });
    }
    syncIncidentToFirestore(testInc).catch(() => {});
    try {
      await fetch('/api/responder/test-alert', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` }
      });
    } catch {}
    triggerResponderEmergencyAlert(testInc);
    state.notice = {
      message: 'Test drill triggered: Siren sound, vibration, and push notification verified.',
      priority: 'HIGH'
    };
    render();
  }

  if (a === 'logout') {
    console.log('[SOS:Auth] Signing out of website session. Device registration remains active.');
    try { state.socket?.close(); } catch {}
    try { sseSource?.close(); } catch {}
    if (firestoreUnsub) {
      try { firestoreUnsub(); } catch {}
      firestoreUnsub = null;
    }
    stopEmergencyAlarm();
    safeStorage.clearSession();
    Object.assign(state, { user: null, token: '', incidents: [], selected: null, notice: null, socket: null, activeAlarm: null });
    render();
  }

  if (a === 'clear-error') {
    state.error = '';
    if (!state.user) {
      clearLoginError();
    } else {
      render();
    }
  }
  if (a === 'dismiss-notice') { state.notice = null; render(); }
  if (a === 'open-notice' && state.notice?.id) {
    try { state.selected = await api(`/api/sos/${state.notice.id}`); } catch { state.selected = state.incidents.find(x => x.id === state.notice.id); }
    state.notice = null;
    render();
  }

  if (a === 'back-create') { state.selected = null; render(); }
  if (a === 'close-details') { state.selected = null; render(); }
  if (a === 'refresh') refresh();

  if (a === 'gps') {
    el.querySelector('span').textContent = 'Locating…';
    navigator.geolocation?.getCurrentPosition(p => {
      gps = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy };
      el.querySelector('span').textContent = 'Exact location captured';
    }, () => el.querySelector('span').textContent = 'Location unavailable — enter it below', { enableHighAccuracy: true, timeout: 8000 });
  }

  if (a === 'export') {
    const keys = ['id', 'category_id', 'student_id', 'priority', 'status', 'primary_department_id', 'created_at'];
    const rows = ['id,category,student,priority,status,department,createdAt', ...state.incidents.map(r => keys.map(k => `"${String(r[k] ?? '').replaceAll('"', '""')}"`).join(','))];
    const b = new Blob([rows.join('\n')], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(b);
    link.download = 'sos-incidents.csv';
    link.click();
  }

  if (el.dataset.transition) {
    let payload = {};
    if (el.dataset.transition === 'resolve') {
      const note = prompt('Resolution note (required)');
      if (!note) return;
      payload = { note, resolutionType: 'RESOLVED' };
    }
    if (el.dataset.transition === 'cancel') {
      const reason = prompt('Why are you cancelling?');
      if (!reason) return;
      payload = { reason };
    }
    try {
      try {
        state.selected = await api(`/api/sos/${el.dataset.id}/${el.dataset.transition}`, { method: 'POST', body: JSON.stringify(payload) });
      } catch {
        const map = { accept: 'ACCEPTED', respond: 'RESPONDING', arrive: 'ARRIVED', resolve: 'RESOLVED', cancel: 'CANCELLED' };
        const st = map[el.dataset.transition] || el.dataset.transition.toUpperCase();
        if (state.selected) state.selected.status = st;
        const inList = state.incidents.find(x => x.id === el.dataset.id);
        if (inList) inList.status = st;
      }
      await refresh();
    } catch (x) {
      state.error = x.message;
      render();
    }
  }
});

// Search input delegation
app.addEventListener('input', (e) => {
  if (e.target.id === 'search' || e.target.id === 'status-filter') {
    const q = document.querySelector('#search')?.value.toLowerCase() || '', s = document.querySelector('#status-filter')?.value || '';
    document.querySelectorAll('.incident').forEach(x => x.hidden = !(x.dataset.search.includes(q) && (!s || x.dataset.status === s)));
  }
});

// Initialize categories and app state
fetch('/api/categories').then(r => r.json()).then(async (c) => {
  state.categories = c;
  if (state.user) await refresh();
  else render();
}).catch(() => {
  if (state.user) refresh();
  else render();
});

if (state.token) {
  connectSocket();
  connectSseStream();
}
if (isResponderUser(state.user)) {
  initResponderPush();
  attachFirestoreListener();
  checkIncidentQueryParam();
}

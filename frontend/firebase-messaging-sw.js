/* Firebase Cloud Messaging Service Worker for College SOS Emergency Response */
/* global importScripts, firebase, self, clients */

importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

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

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

const handledPushes = new Set();

function formatEmergencyNotification(payload) {
  const d = payload.data || {};
  const n = payload.notification || {};

  const id = d.id || d.sosId || 'INCIDENT';
  const priority = d.priority || 'HIGH';
  const studentName = d.studentName || d.student_name || 'Student';
  const studentId = (d.studentId || d.student_id) ? ` (${d.studentId || d.student_id})` : '';
  const student = `${studentName}${studentId}`;
  const category = String(d.categoryId || d.category_id || 'Emergency').toUpperCase();
  const location = d.location || (d.building ? `${d.building} ${d.floor || ''} ${d.room || ''}`.trim() : 'Campus Location');
  const desc = d.description ? ` · "${d.description}"` : '';

  let timeStr = '';
  try {
    const rawTime = d.timestamp || d.created_at || d.createdAt;
    if (rawTime) {
      const dt = new Date(rawTime);
      timeStr = ` · ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  } catch {}

  const title = n.title || `🚨 EMERGENCY SOS: ${id} (${priority})`;
  const body = n.body || `${student} · ${category} at ${location}${desc}${timeStr}`;

  return {
    title,
    options: {
      body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: `sos-alert-${id}`,
      renotify: true,
      requireInteraction: true,
      vibrate: [500, 250, 500, 250, 500, 250, 500],
      data: {
        id,
        url: d.url || d.click_action || `/?incidentId=${encodeURIComponent(id)}`,
        timestamp: d.timestamp || new Date().toISOString()
      },
      actions: [
        { action: 'open', title: '🚨 View Emergency Alert' }
      ]
    }
  };
}

// Background handler for FCM
messaging.onBackgroundMessage((payload) => {
  const sosId = payload.data?.id || payload.data?.sosId || '';
  if (sosId && handledPushes.has(sosId)) {
    return;
  }
  if (sosId) handledPushes.add(sosId);

  const { title, options } = formatEmergencyNotification(payload);
  return self.registration.showNotification(title, options);
});

// Push event fallback
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const raw = event.data.json();
    const sosId = raw.data?.id || raw.data?.sosId;
    if (sosId && handledPushes.has(sosId)) return;
    if (sosId) handledPushes.add(sosId);

    const { title, options } = formatEmergencyNotification(raw);
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    // If not JSON, show text
    event.waitUntil(
      self.registration.showNotification('🚨 College SOS Alert', {
        body: event.data.text(),
        icon: '/favicon.ico',
        tag: 'sos-alert-generic',
        requireInteraction: true,
        vibrate: [500, 250, 500, 250, 500, 250, 500]
      })
    );
  }
});

// Notification click handling
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetSosId = event.notification.data?.id;
  const urlToOpen = event.notification.data?.url || (targetSosId ? `/?incidentId=${encodeURIComponent(targetSosId)}` : '/');

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If any tab of our web app is already open, focus it and notify it
      for (const client of windowClients) {
        if ('focus' in client) {
          if (targetSosId) {
            client.postMessage({ type: 'OPEN_SOS_ID', id: targetSosId });
          }
          return client.focus();
        }
      }
      // If no tab is open, open a new window pointing directly to the target emergency incident
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

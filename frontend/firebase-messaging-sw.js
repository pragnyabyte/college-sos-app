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
  const student = d.studentName ? `${d.studentName} (${d.studentId || ''})` : 'Student';
  const location = d.location || (d.building ? `${d.building} ${d.floor || ''} ${d.room || ''}` : 'Campus');
  const desc = d.description ? ` - ${d.description}` : '';

  const title = n.title || `🚨 EMERGENCY SOS: ${id} (${priority})`;
  const body = n.body || `${student} reported emergency at ${location}${desc}`;

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
        url: d.url || `/responder?incidentId=${encodeURIComponent(id)}`,
        timestamp: d.timestamp || new Date().toISOString()
      },
      actions: [
        { action: 'open', title: 'Open Incident' }
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
  const urlToOpen = event.notification.data?.url || '/responder';
  const targetSosId = event.notification.data?.id;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes('/responder') && 'focus' in client) {
          if (targetSosId) {
            client.postMessage({ type: 'OPEN_SOS_ID', id: targetSosId });
          }
          return client.focus();
        }
      }
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

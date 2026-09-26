import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './db.js';
import { createIncident, getIncident, changeStatus, updateIncidentLocation, deleteIncident } from './service.js';

const responder = { id: 'RESP-1111', name: 'Duty Officer', role: 'RESPONDER' };

test('TEST 1: Student clicks SOS with GPS permission granted and all optional fields empty', async () => {
  const testStudent = { id: 'STU-TEST1-' + Date.now(), name: 'Student 1', role: 'STUDENT' };
  const key1 = 'test-idemp-1-' + Date.now() + '-1234567890';
  const payload = {
    categoryId: 'medical',
    description: '',
    location: {
      latitude: 12.971598,
      longitude: 77.594566,
      accuracy: 6.2,
      locationStatus: 'available',
      gpsTimestamp: new Date().toISOString()
      // building, floor, room are completely omitted
    },
    idempotencyKey: key1
  };

  const inc = await createIncident(payload, testStudent);
  assert.ok(inc.id.startsWith('SOS-'), 'Valid SOS ID generated');
  assert.equal(inc.status, 'DEPARTMENT_NOTIFIED');
  assert.equal(inc.location.latitude, 12.971598, 'Latitude captured');
  assert.equal(inc.location.longitude, 77.594566, 'Longitude captured');
  assert.equal(inc.location.accuracy, 6.2, 'Accuracy captured');
  assert.equal(inc.location.locationStatus, 'available', 'Status is available');
  assert.equal(inc.location.building, '', 'Building is empty without error');
  assert.equal(inc.location.floor, '', 'Floor is empty without error');
  assert.equal(inc.location.room, '', 'Room is empty without error');

  // Verify responder view
  const respView = await getIncident(inc.id, responder);
  assert.equal(respView.location.latitude, 12.971598);
  assert.equal(respView.location.longitude, 77.594566);
  assert.equal(respView.location.accuracy, 6.2);

  // Clean up
  await deleteIncident(inc.id, responder);
});

test('TEST 2: Student enters Building A, 2nd Floor, Room 204 and clicks SOS', async () => {
  const testStudent = { id: 'STU-TEST2-' + Date.now(), name: 'Student 2', role: 'STUDENT' };
  const key2 = 'test-idemp-2-' + Date.now() + '-1234567890';
  const payload = {
    categoryId: 'security',
    description: 'Suspicious intruder reported near entrance',
    location: {
      building: 'Building A',
      floor: '2nd Floor',
      room: 'Room 204',
      area: 'Room 204',
      latitude: 12.972000,
      longitude: 77.595000,
      accuracy: 4.5,
      locationStatus: 'available'
    },
    idempotencyKey: key2
  };

  const inc = await createIncident(payload, testStudent);
  assert.equal(inc.location.building, 'Building A');
  assert.equal(inc.location.floor, '2nd Floor');
  assert.equal(inc.location.room, 'Room 204');
  assert.equal(inc.location.latitude, 12.972000);
  assert.equal(inc.location.longitude, 77.595000);
  assert.equal(inc.location.accuracy, 4.5);

  const respView = await getIncident(inc.id, responder);
  assert.equal(respView.location.building, 'Building A');
  assert.equal(respView.location.floor, '2nd Floor');
  assert.equal(respView.location.room, 'Room 204');
  assert.equal(respView.location.latitude, 12.972);

  // Clean up
  await deleteIncident(inc.id, responder);
});

test('TEST 3: Student clicks SOS and denies GPS permission', async () => {
  const testStudent = { id: 'STU-TEST3-' + Date.now(), name: 'Student 3', role: 'STUDENT' };
  const key3 = 'test-idemp-3-' + Date.now() + '-1234567890';
  const payload = {
    categoryId: 'fire',
    description: 'Smoke coming from utility room',
    location: {
      building: 'Science Block',
      floor: 'Basement',
      room: '',
      latitude: null,
      longitude: null,
      accuracy: null,
      locationStatus: 'permission_denied'
    },
    idempotencyKey: key3
  };

  const inc = await createIncident(payload, testStudent);
  assert.ok(inc.id, 'SOS alert must NOT be blocked when GPS permission is denied');
  assert.equal(inc.location.locationStatus, 'permission_denied');
  assert.equal(inc.location.latitude, null);
  assert.equal(inc.location.longitude, null);
  assert.equal(inc.location.building, 'Science Block');

  const respView = await getIncident(inc.id, responder);
  assert.equal(respView.location.locationStatus, 'permission_denied');
  assert.equal(respView.location.latitude, null);

  // Clean up
  await deleteIncident(inc.id, responder);
});

test('TEST 4: Student has GPS permission but location times out', async () => {
  const testStudent = { id: 'STU-TEST4-' + Date.now(), name: 'Student 4', role: 'STUDENT' };
  const key4 = 'test-idemp-4-' + Date.now() + '-1234567890';
  const payload = {
    categoryId: 'other',
    description: 'Immediate assistance required',
    location: {
      building: '',
      floor: '',
      room: '',
      latitude: null,
      longitude: null,
      accuracy: null,
      locationStatus: 'timeout'
    },
    idempotencyKey: key4
  };

  const inc = await createIncident(payload, testStudent);
  assert.ok(inc.id, 'SOS alert must submit even if location request times out');
  assert.equal(inc.location.locationStatus, 'timeout');
  assert.equal(inc.location.latitude, null);

  // Clean up
  await deleteIncident(inc.id, responder);
});

test('TEST 5: Student clicks SOS twice quickly - Duplicate Prevention', async () => {
  const db = await getDb();
  const testStudent = { id: 'STU-TEST5-' + Date.now(), name: 'Student 5', role: 'STUDENT' };
  const key5 = 'test-idemp-5-' + Date.now() + '-1234567890';
  const payload = {
    categoryId: 'electrical',
    description: 'Sparks flying from electrical panel',
    location: {
      building: 'Workshop',
      floor: 'Ground',
      room: 'Room 12',
      latitude: 12.973,
      longitude: 77.596,
      accuracy: 10,
      locationStatus: 'available'
    },
    idempotencyKey: key5
  };

  const [attempt1, attempt2] = await Promise.all([
    createIncident(payload, testStudent),
    createIncident(payload, testStudent)
  ]);

  assert.equal(attempt1.id, attempt2.id, 'Duplicate click must return the exact same incident ID');
  const countInDb = await db.collection('incidents').countDocuments({ idempotency_key: key5 });
  assert.equal(countInDb, 1, 'Exactly one incident document must exist in database');

  // Clean up
  await deleteIncident(attempt1.id, responder);
});

test('TEST 6: Student updates/retries live location on active incident', async () => {
  const testStudent = { id: 'STU-TEST6-' + Date.now(), name: 'Student 6', role: 'STUDENT' };
  const key6 = 'test-idemp-6-' + Date.now() + '-1234567890';
  const payload = {
    categoryId: 'trapped',
    description: 'Locked inside room',
    location: {
      building: 'Old Block',
      locationStatus: 'unavailable',
      latitude: null,
      longitude: null
    },
    idempotencyKey: key6
  };

  const inc = await createIncident(payload, testStudent);
  assert.equal(inc.location.locationStatus, 'unavailable');

  // Retry / update location with high-accuracy live GPS
  const updated = await updateIncidentLocation(
    inc.id,
    {
      latitude: 12.974500,
      longitude: 77.598500,
      accuracy: 3.5,
      locationStatus: 'available',
      building: 'Old Block North',
      floor: '3rd Floor',
      room: 'Room 301'
    },
    testStudent
  );

  assert.equal(updated.location.latitude, 12.974500);
  assert.equal(updated.location.longitude, 77.598500);
  assert.equal(updated.location.accuracy, 3.5);
  assert.equal(updated.location.locationStatus, 'available');
  assert.equal(updated.location.building, 'Old Block North');

  const respView = await getIncident(inc.id, responder);
  assert.equal(respView.location.latitude, 12.974500);
  assert.equal(respView.location.accuracy, 3.5);

  // Clean up
  await deleteIncident(inc.id, responder);
});

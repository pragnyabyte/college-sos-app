import { getDb } from './db.js';
import { changeStatus, getIncident } from './service.js';
import { sendEmergencySosNotification, logNotificationAudit, RESPONDER_ID } from './fcm.js';

/**
 * Standard Status Constants Mandated for Multi-Channel Alert Lifecycle
 * 1. DISPATCH_ATTEMPTED: Backend initiated dispatch
 * 2. PROVIDER_ACCEPTED: Gateway/Provider confirmed acceptance of transmission
 * 3. DEVICE_DELIVERY_CONFIRMED: Device/client receipt ping or delivery receipt confirmed
 * 4. NOTIFICATION_DISPLAYED: Verified alert display in notification tray/lockscreen
 * 5. RESPONDER_ACKNOWLEDGED: Emergency responder acknowledged SOS
 * 6. AUDIBLE_SOUND_VERIFIED: Physical/simulated audible alarm playback confirmed
 */
export const ALERT_STATUSES = {
  DISPATCH_ATTEMPTED: 'DISPATCH_ATTEMPTED',
  PROVIDER_ACCEPTED: 'PROVIDER_ACCEPTED',
  DEVICE_DELIVERY_CONFIRMED: 'DEVICE_DELIVERY_CONFIRMED',
  NOTIFICATION_DISPLAYED: 'NOTIFICATION_DISPLAYED',
  RESPONDER_ACKNOWLEDGED: 'RESPONDER_ACKNOWLEDGED',
  AUDIBLE_SOUND_VERIFIED: 'AUDIBLE_SOUND_VERIFIED'
};

/**
 * Escalation delays and settings (Configurable via environment variables)
 */
export const ESCALATION_CONFIG = {
  get PUSH_RETRY_SECONDS() {
    return Number(process.env.ESCALATION_PUSH_RETRY_SECONDS || 15);
  },
  get SMS_SECONDS() {
    return Number(process.env.ESCALATION_SMS_SECONDS || 30);
  },
  get VOICE_SECONDS() {
    return Number(process.env.ESCALATION_VOICE_SECONDS || 60);
  },
  get MAX_RETRIES() {
    return Number(process.env.MAX_ESCALATION_RETRIES || 3);
  },
  get TWILIO_ACCOUNT_SID() {
    return process.env.TWILIO_ACCOUNT_SID || '';
  },
  get TWILIO_AUTH_TOKEN() {
    return process.env.TWILIO_AUTH_TOKEN || '';
  },
  get TWILIO_PHONE_NUMBER() {
    return process.env.TWILIO_PHONE_NUMBER || '';
  },
  get PUBLIC_BASE_URL() {
    return process.env.APP_PUBLIC_URL || process.env.BASE_URL || 'https://college-sos-app-26aec.web.app';
  },
  get DEFAULT_RESPONDER_PHONES() {
    const raw = process.env.EMERGENCY_RESPONDER_PHONES || process.env.SOS_RESPONDER_PHONE || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
};

/**
 * Validates and formats a verified Google Maps location link from GPS coordinates
 */
export function formatLocationLink(loc) {
  if (!loc) return null;
  const lat = loc.latitude ?? loc.lat;
  const lng = loc.longitude ?? loc.lng;
  if (lat != null && lng != null && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
    const clat = Number(lat).toFixed(6);
    const clng = Number(lng).toFixed(6);
    return `https://www.google.com/maps/search/?api=1&query=${clat},${clng}`;
  }
  return null;
}

/**
 * Formats a readable location description string
 */
export function formatLocationSummary(loc) {
  if (!loc) return 'Campus Location';
  const parts = [loc.building, loc.floor, loc.room, loc.area].filter(Boolean);
  if (parts.length > 0) return parts.join(', ');
  if (loc.latitude != null && loc.longitude != null) {
    return `GPS (${Number(loc.latitude).toFixed(4)}, ${Number(loc.longitude).toFixed(4)})`;
  }
  return 'Campus Location';
}

/**
 * Retrieves all registered responder phone numbers from the database and environment
 */
export async function getRegisteredResponderPhones() {
  const phones = new Set(ESCALATION_CONFIG.DEFAULT_RESPONDER_PHONES);
  try {
    const db = await getDb();
    const responders = await db.collection('emergency_responders').find({ active: { $ne: false } }).toArray();
    for (const r of responders) {
      if (r.phone) phones.add(String(r.phone).trim());
      if (r.phoneNumber) phones.add(String(r.phoneNumber).trim());
      if (Array.isArray(r.phoneNumbers)) {
        r.phoneNumbers.forEach(p => p && phones.add(String(p).trim()));
      }
    }
  } catch (err) {
    console.warn('[Escalation] Notice querying responder phone numbers:', err.message);
  }
  return Array.from(phones).filter(p => /^\+?[1-9]\d{7,14}$/.test(p.replace(/[\s\-()]/g, '')));
}

/**
 * Dispatches real SMS alert via Twilio REST API
 */
export async function sendEmergencySms(incident) {
  const incidentId = incident.id;
  const now = new Date().toISOString();
  const phoneNumbers = await getRegisteredResponderPhones();

  const mapLink = formatLocationLink(incident.location);
  const locSummary = formatLocationSummary(incident.location);
  const studentInfo = `${incident.student_name || 'Student'} (${incident.student_id || 'ID N/A'})`;
  const category = incident.emergency_type || incident.category_id || 'General Emergency';

  const smsBody = [
    `🚨 EMERGENCY SOS: ${incidentId} [${incident.priority || 'HIGH'}]`,
    `Student: ${studentInfo}`,
    `Type: ${category}`,
    `Location: ${locSummary}`,
    mapLink ? `Map: ${mapLink}` : null,
    `Time: ${incident.created_at || now}`,
    `URGENT: Open responder console or reply to acknowledge.`
  ].filter(Boolean).join('\n');

  await logNotificationAudit(incidentId, ALERT_STATUSES.DISPATCH_ATTEMPTED, {
    channel: 'SMS',
    provider: 'twilio',
    recipientsCount: phoneNumbers.length,
    phoneNumbers: phoneNumbers.map(p => p.slice(0, 4) + '***' + p.slice(-3)),
    timestamp: now,
    messagePreview: smsBody.slice(0, 120) + '...'
  });

  const sid = ESCALATION_CONFIG.TWILIO_ACCOUNT_SID;
  const token = ESCALATION_CONFIG.TWILIO_AUTH_TOKEN;
  const fromPhone = ESCALATION_CONFIG.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !fromPhone) {
    const configNotice = 'Twilio SMS credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER) not configured.';
    console.warn(`[Escalation:SMS] ${configNotice} SMS dispatch attempted but skipped.`);
    await logNotificationAudit(incidentId, 'SMS_CONFIG_REQUIRED', {
      channel: 'SMS',
      notice: configNotice,
      recipients: phoneNumbers,
      body: smsBody
    });
    return {
      success: false,
      status: 'CONFIG_REQUIRED',
      notice: configNotice,
      attemptedCount: phoneNumbers.length,
      acceptedCount: 0
    };
  }

  if (phoneNumbers.length === 0) {
    console.log(`[Escalation:SMS] No responder phone numbers registered. SMS dispatch skipped for ${incidentId}.`);
    return { success: false, status: 'NO_PHONE_NUMBERS', attemptedCount: 0, acceptedCount: 0 };
  }

  const results = [];
  const statusCallbackUrl = `${ESCALATION_CONFIG.PUBLIC_BASE_URL}/api/responder/twilio/sms-status-callback`;

  for (const to of phoneNumbers) {
    try {
      const formData = new URLSearchParams({
        To: to,
        From: fromPhone,
        Body: smsBody,
        StatusCallback: statusCallbackUrl
      });

      const authHeader = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData.toString()
      });

      const data = await response.json();
      if (response.ok) {
        await logNotificationAudit(incidentId, ALERT_STATUSES.PROVIDER_ACCEPTED, {
          channel: 'SMS',
          provider: 'twilio',
          messageSid: data.sid,
          to: to.slice(0, 4) + '***' + to.slice(-3),
          providerStatus: data.status
        });
        results.push({ to, success: true, sid: data.sid, status: data.status });
      } else {
        console.warn(`[Escalation:SMS] Twilio SMS API error for ${to}:`, data.message);
        results.push({ to, success: false, error: data.message, code: data.code });
      }
    } catch (sendErr) {
      console.warn(`[Escalation:SMS] Network exception sending SMS to ${to}:`, sendErr.message);
      results.push({ to, success: false, error: sendErr.message });
    }
  }

  const acceptedCount = results.filter(r => r.success).length;
  console.log(`[Escalation:SMS] SMS escalation finished for ${incidentId}: ${acceptedCount}/${phoneNumbers.length} accepted by Twilio.`);
  return {
    success: acceptedCount > 0,
    status: acceptedCount > 0 ? 'ACCEPTED' : 'FAILED',
    attemptedCount: phoneNumbers.length,
    acceptedCount,
    details: results
  };
}

/**
 * Dispatches real automated voice call via Twilio Voice API with interactive TwiML IVR
 */
export async function sendEmergencyVoiceCall(incident) {
  const incidentId = incident.id;
  const now = new Date().toISOString();
  const phoneNumbers = await getRegisteredResponderPhones();

  await logNotificationAudit(incidentId, ALERT_STATUSES.DISPATCH_ATTEMPTED, {
    channel: 'VOICE_CALL',
    provider: 'twilio',
    recipientsCount: phoneNumbers.length,
    phoneNumbers: phoneNumbers.map(p => p.slice(0, 4) + '***' + p.slice(-3)),
    timestamp: now
  });

  const sid = ESCALATION_CONFIG.TWILIO_ACCOUNT_SID;
  const token = ESCALATION_CONFIG.TWILIO_AUTH_TOKEN;
  const fromPhone = ESCALATION_CONFIG.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !fromPhone) {
    const configNotice = 'Twilio Voice credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER) not configured.';
    console.warn(`[Escalation:Voice] ${configNotice} Voice call dispatch attempted but skipped.`);
    await logNotificationAudit(incidentId, 'VOICE_CONFIG_REQUIRED', {
      channel: 'VOICE_CALL',
      notice: configNotice,
      recipients: phoneNumbers
    });
    return {
      success: false,
      status: 'CONFIG_REQUIRED',
      notice: configNotice,
      attemptedCount: phoneNumbers.length,
      acceptedCount: 0
    };
  }

  if (phoneNumbers.length === 0) {
    console.log(`[Escalation:Voice] No responder phone numbers registered. Voice call skipped for ${incidentId}.`);
    return { success: false, status: 'NO_PHONE_NUMBERS', attemptedCount: 0, acceptedCount: 0 };
  }

  const twimlUrl = `${ESCALATION_CONFIG.PUBLIC_BASE_URL}/api/responder/twiml/emergency-call/${encodeURIComponent(incidentId)}`;
  const statusCallbackUrl = `${ESCALATION_CONFIG.PUBLIC_BASE_URL}/api/responder/twilio/call-status-callback`;

  const results = [];
  for (const to of phoneNumbers) {
    try {
      const formData = new URLSearchParams({
        To: to,
        From: fromPhone,
        Url: twimlUrl,
        StatusCallback: statusCallbackUrl,
        StatusCallbackMethod: 'POST',
        Timeout: '30'
      });

      const authHeader = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData.toString()
      });

      const data = await response.json();
      if (response.ok) {
        await logNotificationAudit(incidentId, ALERT_STATUSES.PROVIDER_ACCEPTED, {
          channel: 'VOICE_CALL',
          provider: 'twilio',
          callSid: data.sid,
          to: to.slice(0, 4) + '***' + to.slice(-3),
          providerStatus: data.status
        });
        results.push({ to, success: true, sid: data.sid, status: data.status });
      } else {
        console.warn(`[Escalation:Voice] Twilio Voice API error for ${to}:`, data.message);
        results.push({ to, success: false, error: data.message, code: data.code });
      }
    } catch (callErr) {
      console.warn(`[Escalation:Voice] Network exception initiating call to ${to}:`, callErr.message);
      results.push({ to, success: false, error: callErr.message });
    }
  }

  const acceptedCount = results.filter(r => r.success).length;
  console.log(`[Escalation:Voice] Voice call escalation finished for ${incidentId}: ${acceptedCount}/${phoneNumbers.length} accepted by Twilio.`);
  return {
    success: acceptedCount > 0,
    status: acceptedCount > 0 ? 'ACCEPTED' : 'FAILED',
    attemptedCount: phoneNumbers.length,
    acceptedCount,
    details: results
  };
}

/**
 * Generates interactive TwiML IVR XML for emergency phone calls
 */
export function generateEmergencyTwiML(incident) {
  const locSummary = formatLocationSummary(incident.location);
  const student = incident.student_name || 'A student';
  const category = incident.emergency_type || incident.category_id || 'General Emergency';
  const id = incident.id;
  const gatherAction = `${ESCALATION_CONFIG.PUBLIC_BASE_URL}/api/responder/twiml/gather-response/${encodeURIComponent(id)}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">
    Urgent emergency alert from Student S.O.S.
    Incident ${id}.
    Emergency category: ${category}.
    Student ${student} has requested immediate emergency response.
    Reported location: ${locSummary}.
  </Say>
  <Gather numDigits="1" action="${gatherAction}" method="POST" timeout="10">
    <Say voice="alice" language="en-US">
      Press 1 to acknowledge this emergency immediately.
    </Say>
  </Gather>
  <Say voice="alice" language="en-US">
    No input received. Repeating prompt.
  </Say>
  <Redirect method="POST">${ESCALATION_CONFIG.PUBLIC_BASE_URL}/api/responder/twiml/emergency-call/${encodeURIComponent(id)}</Redirect>
</Response>`;
}

/**
 * Handles IVR keypad response from emergency responder phone call
 */
export async function handleTwiMLGather(incidentId, digits, callerPhone = 'Unknown Phone', broadcastCallback = null) {
  const now = new Date().toISOString();
  if (String(digits).trim() === '1') {
    try {
      const u = {
        id: 'TWILIO_VOICE',
        name: `Emergency Responder (IVR ${callerPhone})`,
        role: 'RESPONDER',
        departmentId: 'DEPT_SECURITY'
      };

      const result = await changeStatus(
        incidentId,
        'ACCEPTED',
        { note: `Acknowledged via automated emergency voice call from ${callerPhone}` },
        u,
        'twilio-voice'
      );

      await logNotificationAudit(incidentId, ALERT_STATUSES.RESPONDER_ACKNOWLEDGED, {
        channel: 'VOICE_CALL_IVR',
        acknowledgedBy: u.name,
        callerPhone,
        timestamp: now
      });

      if (typeof broadcastCallback === 'function') {
        broadcastCallback({
          event: 'sos.accept',
          id: result.id,
          status: 'ACCEPTED',
          acceptedBy: u.id,
          acceptedByName: u.name,
          timestamp: now
        });
      }

      console.log(`[Escalation:IVR] Incident ${incidentId} successfully ACKNOWLEDGED over phone by ${callerPhone}`);

      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">
    Thank you. Incident ${incidentId} has been successfully acknowledged. All campus response units and the central dashboard have been synchronized. Please proceed to the location. Goodbye.
  </Say>
  <Hangup/>
</Response>`;
    } catch (e) {
      console.warn(`[Escalation:IVR] Notice acknowledging ${incidentId} via IVR:`, e.message);
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">
    Incident ${incidentId} is already acknowledged by another responder or resolved. Thank you.
  </Say>
  <Hangup/>
</Response>`;
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">
    Invalid entry. Press 1 to acknowledge the emergency.
  </Say>
  <Redirect method="POST">${ESCALATION_CONFIG.PUBLIC_BASE_URL}/api/responder/twiml/emergency-call/${encodeURIComponent(incidentId)}</Redirect>
</Response>`;
}

/**
 * Core escalation cycle processor:
 * - Immediately (0s): Handled on SOS creation
 * - 15s without acknowledgment: FCM Push retry
 * - 30s without acknowledgment: SMS Escalation
 * - 60s without acknowledgment: Automated Voice Call Escalation
 */
export async function processEscalations(broadcastCallback = null) {
  const db = await getDb();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Find all active unacknowledged incidents (status is DEPARTMENT_NOTIFIED or SOS_SENT)
  const unacknowledged = await db.collection('incidents').find({
    status: { $in: ['DEPARTMENT_NOTIFIED', 'SOS_SENT'] }
  }).toArray();

  if (unacknowledged.length === 0) return { processed: 0, actions: [] };

  const actions = [];
  const pushRetryThresholdMs = ESCALATION_CONFIG.PUSH_RETRY_SECONDS * 1000;
  const smsThresholdMs = ESCALATION_CONFIG.SMS_SECONDS * 1000;
  const voiceThresholdMs = ESCALATION_CONFIG.VOICE_SECONDS * 1000;

  for (const incident of unacknowledged) {
    const createdMs = new Date(incident.created_at || nowIso).getTime();
    const elapsedMs = nowMs - createdMs;

    // Stage 1: Push Retry at 15s
    if (elapsedMs >= pushRetryThresholdMs && !incident.escalation_push_retried_at) {
      console.log(`[Escalation] Stage 1 triggered for ${incident.id}: 15s push retry (elapsed: ${(elapsedMs/1000).toFixed(1)}s)`);
      await db.collection('incidents').updateOne(
        { id: incident.id },
        {
          $set: {
            escalation_push_retried_at: nowIso,
            escalation_level: 1,
            updated_at: nowIso
          }
        }
      );

      await logNotificationAudit(incident.id, ALERT_STATUSES.DISPATCH_ATTEMPTED, {
        channel: 'PUSH_RETRY',
        stage: 1,
        elapsedSeconds: Math.round(elapsedMs / 1000),
        reason: 'Unacknowledged after 15 seconds'
      });

      const pushRes = await sendEmergencySosNotification(incident, true);
      actions.push({ id: incident.id, stage: 1, type: 'PUSH_RETRY', pushRes });
    }

    // Stage 2: SMS Escalation at 30s
    if (elapsedMs >= smsThresholdMs && !incident.escalation_sms_sent_at) {
      console.log(`[Escalation] Stage 2 triggered for ${incident.id}: 30s SMS escalation (elapsed: ${(elapsedMs/1000).toFixed(1)}s)`);
      await db.collection('incidents').updateOne(
        { id: incident.id },
        {
          $set: {
            escalation_sms_sent_at: nowIso,
            escalation_level: 2,
            updated_at: nowIso
          }
        }
      );

      const smsRes = await sendEmergencySms(incident);
      actions.push({ id: incident.id, stage: 2, type: 'SMS_ESCALATION', smsRes });
    }

    // Stage 3: Automated Voice Call Escalation at 60s
    if (elapsedMs >= voiceThresholdMs && !incident.escalation_voice_call_sent_at) {
      console.log(`[Escalation] Stage 3 triggered for ${incident.id}: 60s Voice call escalation (elapsed: ${(elapsedMs/1000).toFixed(1)}s)`);
      await db.collection('incidents').updateOne(
        { id: incident.id },
        {
          $set: {
            escalation_voice_call_sent_at: nowIso,
            escalation_level: 3,
            updated_at: nowIso
          }
        }
      );

      const voiceRes = await sendEmergencyVoiceCall(incident);
      actions.push({ id: incident.id, stage: 3, type: 'VOICE_CALL_ESCALATION', voiceRes });
    }
  }

  return { processed: unacknowledged.length, actions };
}

/**
 * Background worker interval handle
 */
let workerInterval = null;

export function startEscalationWorker(intervalMs = 5000, broadcastCallback = null) {
  if (workerInterval) return;
  console.log(`[Escalation] Starting durable escalation worker (polling every ${intervalMs}ms)...`);
  workerInterval = setInterval(() => {
    processEscalations(broadcastCallback).catch(err => {
      console.warn('[Escalation:Worker] Uncaught cycle notice:', err.message);
    });
  }, intervalMs);
}

export function stopEscalationWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[Escalation] Escalation worker stopped.');
  }
}

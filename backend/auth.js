import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from './db.js';

const secret = process.env.SOS_SESSION_SECRET || 'development-only-change-me';

export const ROLES = ['STUDENT', 'INSTITUTE_ADMIN', 'ADMIN', 'TEACHER', 'DEPARTMENT_HEAD', 'RESPONDER'];
export const demoUsers = [];

export function getDefaultDepartment(role) {
    const r = String(role || '').toUpperCase();
    if (r === 'INSTITUTE_ADMIN' || r === 'ADMIN' || r === 'DEPARTMENT_HEAD' || r === 'TEACHER') return 'DEPT_ADMIN';
    if (r === 'RESPONDER') return 'DEPT_SECURITY';
    return null;
}

export function createSessionUser({ name, regdNo, role, departmentId, isResponderAuth = false }) {
    const cleanName = String(name || '').trim();
    const cleanId = String(regdNo || '').trim();
    const cleanRole = String(role || 'STUDENT').trim().toUpperCase();

    if (!cleanName) throw Object.assign(new Error('Name is required'), { status: 400 });
    if (!cleanId) throw Object.assign(new Error('Regd. No. is required'), { status: 400 });

    // Explicitly reject email addresses
    if (cleanId.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanId)) {
        throw Object.assign(new Error('Email addresses are not accepted. Please enter a valid Registration / Roll / ID No.'), { status: 400 });
    }

    // Must be a valid Registration Number / Roll Number / Student ID / Employee ID
    if (!/^[A-Za-z0-9_\-\.\/]{2,50}$/.test(cleanId)) {
        throw Object.assign(new Error('Invalid Registration / Roll / ID No. Format must be an ID, Roll No., or Regd. No.'), { status: 400 });
    }

    if (!ROLES.includes(cleanRole)) throw Object.assign(new Error('Invalid role specified'), { status: 400 });

    // Standard user login cannot claim the RESPONDER role
    if (cleanRole === 'RESPONDER' && !isResponderAuth) {
        throw Object.assign(new Error('Access Denied: Responder role requires authentication via /responder'), { status: 403 });
    }

    const dept = departmentId || getDefaultDepartment(cleanRole);
    return { id: cleanId, name: cleanName, role: cleanRole, departmentId: dept };
}

export async function verifyResponderCredentials(responderId, pin) {
    const id = String(responderId || '').trim();
    const cleanPin = String(pin || '').trim();
    if (id !== 'RESP-001') {
        throw Object.assign(new Error('Invalid responder identifier'), { status: 401 });
    }

    const expectedPin = process.env.SOS_RESPONDER_PIN || 'RESP-911';
    let dbPin = expectedPin;
    try {
        const db = await getDb();
        const doc = await db.collection('emergency_responders').findOne({ responderId: 'RESP-001' });
        if (doc && doc.pin) dbPin = doc.pin;
    } catch {}

    if (cleanPin !== expectedPin && cleanPin !== dbPin) {
        throw Object.assign(new Error('Invalid responder access key / PIN'), { status: 401 });
    }

    return {
        id: 'RESP-001',
        name: 'Campus Emergency Response Unit (RESP-001)',
        role: 'RESPONDER',
        departmentId: 'DEPT_SECURITY'
    };
}

const b64 = (s) => Buffer.from(s).toString('base64url');

export function issueToken(user) {
    const body = b64(JSON.stringify({ ...user, exp: Date.now() + 8 * 60 * 60 * 1000 }));
    const sig = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
}

export function authenticate(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const [body, sig] = token.split('.');
    if (!body || !sig) {
        throw Object.assign(new Error('Authentication required'), { status: 401 });
    }
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        throw Object.assign(new Error('Invalid session'), { status: 401 });
    }
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (data.exp < Date.now()) {
        throw Object.assign(new Error('Session expired'), { status: 401 });
    }
    return { id: data.id, name: data.name, role: data.role, departmentId: data.departmentId };
}

export const isAdmin = (u) => {
    const r = String(u?.role || '').toUpperCase();
    return r === 'INSTITUTE_ADMIN' || r === 'SUPER_ADMIN' || r === 'ADMIN';
};

export const isResponder = (u) => {
    const r = String(u?.role || '').toUpperCase();
    return r === 'RESPONDER' || u?.id === 'RESP-001';
};


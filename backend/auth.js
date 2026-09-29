import { createHmac, timingSafeEqual, randomBytes, scryptSync, randomUUID } from 'node:crypto';
import { getDb } from './db.js';

const secret = process.env.SOS_SESSION_SECRET || 'development-only-change-me';

export const ROLES = ['STUDENT', 'INSTITUTE_ADMIN', 'ADMIN', 'DEPARTMENT_HEAD', 'RESPONDER'];
export const demoUsers = [];

export function getDefaultDepartment(role) {
    const r = String(role || '').toUpperCase();
    if (r === 'INSTITUTE_ADMIN' || r === 'ADMIN' || r === 'DEPARTMENT_HEAD') return 'DEPT_ADMIN';
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

    if (cleanRole === 'TEACHER' || !ROLES.includes(cleanRole)) {
        throw Object.assign(new Error('Invalid role specified. Teacher role is not supported.'), { status: 400 });
    }

    // Standard user login cannot claim the RESPONDER role
    if (cleanRole === 'RESPONDER' && !isResponderAuth) {
        throw Object.assign(new Error('Access Denied: Responder role requires authentication via /responder'), { status: 403 });
    }

    const dept = departmentId || getDefaultDepartment(cleanRole);
    return { id: cleanId, name: cleanName, role: cleanRole, departmentId: dept };
}

export const AUTHORIZED_RESPONDER_ID = 'ER-2026';
export const AUTHORIZED_RESPONDER_PIN = '2611';

export async function verifyResponderCredentials(responderId, pin, name) {
    const id = String(responderId || '').trim();
    const cleanPin = String(pin || '').trim();
    if (!id) {
        throw Object.assign(new Error('Registration / ID No. is required'), { status: 400 });
    }

    if (id === 'RESP-1111') {
        throw Object.assign(new Error('Registration ID RESP-1111 has been retired. Please use ER-2026.'), { status: 401, field: 'registration_number' });
    }

    const expectedId = process.env.SOS_RESPONDER_ID || AUTHORIZED_RESPONDER_ID;
    const expectedPin = process.env.SOS_RESPONDER_PIN || AUTHORIZED_RESPONDER_PIN;

    let responderDoc = null;
    try {
        const db = await getDb();
        responderDoc = await db.collection('emergency_responders').findOne({ responderId: id });
    } catch {}

    // Allow primary responder ER-2026 or any authorized responder document in database
    if (id !== expectedId && !responderDoc) {
        throw Object.assign(new Error('Invalid Registration Number or PIN'), { status: 401 });
    }

    if (responderDoc && (responderDoc.authorized === false || responderDoc.deactivated === true)) {
        throw Object.assign(new Error('This responder account is deactivated or unauthorized.'), { status: 403 });
    }

    let pinMatches = false;
    if (responderDoc && responderDoc.pinSalt && responderDoc.pinHash) {
        const computed = scryptSync(String(cleanPin), responderDoc.pinSalt, 64).toString('hex');
        pinMatches = computed === responderDoc.pinHash;
    } else {
        const targetPin = (id === expectedId) ? expectedPin : (responderDoc?.pin || expectedPin);
        pinMatches = cleanPin === targetPin;
    }

    // Validate PIN
    if (!pinMatches) {
        throw Object.assign(new Error('Invalid Registration Number or PIN'), { status: 401, field: 'pin' });
    }

    return {
        id,
        name: name || responderDoc?.name || (id === expectedId ? 'Campus Emergency Response Unit (ER-2026)' : `Emergency Responder (${id})`),
        role: 'RESPONDER',
        departmentId: responderDoc?.departmentId || 'DEPT_SECURITY',
        sessionVersion: Number(responderDoc?.sessionVersion || 1)
    };
}


export function normalizeRegdNo(id) {
    return String(id || '').trim().toUpperCase();
}

export function hashPassword(plainText) {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(String(plainText), salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

export function verifyPassword(plainText, storedHash) {
    if (!plainText || !storedHash) return false;
    try {
        const [salt, hash] = storedHash.split(':');
        if (!salt || !hash) return false;
        const testHash = scryptSync(String(plainText), salt, 64).toString('hex');
        return timingSafeEqual(Buffer.from(testHash), Buffer.from(hash));
    } catch {
        return false;
    }
}

export async function registerStudent({ name, regdNo, password }) {
    const cleanName = String(name || '').trim();
    const rawId = String(regdNo || '').trim();
    const cleanId = normalizeRegdNo(rawId);

    // 1. Validate required fields
    if (!cleanName) {
        throw Object.assign(new Error('Full Name is required'), { status: 400 });
    }
    if (!cleanId) {
        throw Object.assign(new Error('Registration / ID No. is required'), { status: 400 });
    }

    // 2. Reject email addresses
    if (cleanId.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanId)) {
        throw Object.assign(new Error('Email addresses are not accepted. Please enter a valid Registration / Roll / ID No.'), { status: 400 });
    }

    // 3. ID format validation
    if (!/^[A-Za-z0-9_\-\.\/]{2,50}$/.test(cleanId)) {
        throw Object.assign(new Error('Invalid Registration / Roll / ID No. Format must be an ID, Roll No., or Regd. No.'), { status: 400 });
    }

    // 4. Cannot register as authorized responder ID
    if (cleanId === AUTHORIZED_RESPONDER_ID || cleanId === 'RESP-1111' || cleanId.startsWith('ER-')) {
        throw Object.assign(new Error('This registration ID is reserved for emergency services.'), { status: 403 });
    }

    const db = await getDb();
    
    // Ensure unique index exists on students collection
    try {
        await db.collection('students').createIndex({ regdNo: 1 }, { unique: true, name: 'student_regd_unique' });
    } catch {}

    // 5. Check if registration ID already exists in database
    const existing = await db.collection('students').findOne({ regdNo: cleanId });
    if (existing) {
        throw Object.assign(new Error('This registration ID is already registered. Please sign in.'), { status: 409 });
    }

    // 6. Securely hash password if provided
    let passwordHash = null;
    if (password && String(password).trim()) {
        passwordHash = hashPassword(String(password).trim());
    }

    const now = new Date().toISOString();
    const accountId = 'STU-' + (randomUUID ? randomUUID() : Math.random().toString(36).slice(2, 10));

    const studentDoc = {
        name: cleanName,
        regdNo: cleanId,
        createdAt: now,
        accountId,
        passwordHash,
        role: 'STUDENT',
        departmentId: null
    };

    try {
        await db.collection('students').insertOne(studentDoc);
    } catch (err) {
        if (err.code === 11000) {
            throw Object.assign(new Error('This registration ID is already registered. Please sign in.'), { status: 409 });
        }
        throw err;
    }

    console.log(`[SOS:Auth] Successfully registered new student: ${cleanName} (${cleanId}) [${accountId}]`);

    return {
        success: true,
        message: 'Registration successful! You can now sign in.',
        student: {
            name: cleanName,
            regdNo: cleanId,
            createdAt: now,
            accountId
        }
    };
}

export async function verifyStudentCredentials(regdNo, enteredName = null) {
    const rawId = String(regdNo || '').trim();
    const cleanId = normalizeRegdNo(rawId);
    const cleanName = String(enteredName || '').trim();

    if (!cleanId) {
        throw Object.assign(new Error('Registration / ID No. is required.'), { status: 400 });
    }

    const db = await getDb();
    const student = await db.collection('students').findOne({ regdNo: cleanId });

    // Requirement: Check whether the entered ID belongs to a registered student.
    // If not registered, show: "Student not registered. Please register first."
    if (!student) {
        throw Object.assign(new Error('Student not registered. Please register first.'), { status: 404 });
    }

    // If entered name is provided, validate/match it against registered name (case-insensitive)
    if (cleanName && student.name) {
        if (cleanName.toLowerCase() !== String(student.name).trim().toLowerCase()) {
            throw Object.assign(new Error('Entered name does not match our records for this Registration ID.'), { status: 401, field: 'name' });
        }
    }

    return {
        id: student.regdNo,
        name: student.name,
        role: 'STUDENT',
        departmentId: null,
        accountId: student.accountId || String(student._id || '')
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
    return r === 'RESPONDER' || u?.id === 'RESP-1111';
};


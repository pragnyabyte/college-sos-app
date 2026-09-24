import { createHmac, timingSafeEqual } from 'node:crypto';
const secret = process.env.SOS_SESSION_SECRET || 'development-only-change-me';

export const ROLES = ['STUDENT', 'INSTITUTE_ADMIN', 'TEACHER', 'DEPARTMENT_HEAD', 'RESPONDER'];
export const demoUsers = [];

export function getDefaultDepartment(role) {
    if (role === 'INSTITUTE_ADMIN' || role === 'DEPARTMENT_HEAD' || role === 'TEACHER') return 'DEPT_ADMIN';
    if (role === 'RESPONDER') return 'DEPT_SECURITY';
    return null;
}

export function createSessionUser({ name, regdNo, role, departmentId }) {
    const cleanName = String(name || '').trim();
    const cleanId = String(regdNo || '').trim();
    const cleanRole = String(role || 'STUDENT').trim().toUpperCase();
    if (!cleanName) throw Object.assign(new Error('Name is required'), { status: 400 });
    if (!cleanId) throw Object.assign(new Error('Regd. No. is required'), { status: 400 });
    if (!ROLES.includes(cleanRole)) throw Object.assign(new Error('Invalid role specified'), { status: 400 });
    const dept = departmentId || getDefaultDepartment(cleanRole);
    return { id: cleanId, name: cleanName, role: cleanRole, departmentId: dept };
}

const b64 = (s) => Buffer.from(s).toString('base64url');
export function issueToken(user) { const body = b64(JSON.stringify({ ...user, exp: Date.now() + 8 * 60 * 60 * 1000 })); const sig = createHmac('sha256', secret).update(body).digest('base64url'); return `${body}.${sig}`; }
export function authenticate(req) { const token = (req.headers.authorization || '').replace(/^Bearer /, ''); const [body, sig] = token.split('.'); if (!body || !sig)
    throw Object.assign(new Error('Authentication required'), { status: 401 }); const expected = createHmac('sha256', secret).update(body).digest('base64url'); if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    throw Object.assign(new Error('Invalid session'), { status: 401 }); const data = JSON.parse(Buffer.from(body, 'base64url').toString()); if (data.exp < Date.now())
    throw Object.assign(new Error('Session expired'), { status: 401 }); return { id: data.id, name: data.name, role: data.role, departmentId: data.departmentId }; }
export const isAdmin = (u) => u.role === 'INSTITUTE_ADMIN' || u.role === 'SUPER_ADMIN';

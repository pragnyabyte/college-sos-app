import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionUser, issueToken, authenticate, ROLES, isAdmin, isResponder, verifyResponderCredentials } from './auth.js';
import { closeDatabase } from './db.js';

test('createSessionUser succeeds for all valid roles', () => {
    for (const role of ROLES) {
        const u = createSessionUser({ name: 'Test User', regdNo: 'REG-1234', role, isResponderAuth: role === 'RESPONDER' });
        assert.equal(u.name, 'Test User');
        assert.equal(u.id, 'REG-1234');
        assert.equal(u.role, role);
    }
});

test('createSessionUser blocks students from claiming RESPONDER role', () => {
    assert.throws(
        () => createSessionUser({ name: 'Malicious Student', regdNo: 'STU-999', role: 'RESPONDER', isResponderAuth: false }),
        /Access Denied: Responder role requires authentication via \/responder/
    );
});

test('createSessionUser requires Name and Regd. No.', () => {
    assert.throws(() => createSessionUser({ name: '', regdNo: 'REG-1', role: 'STUDENT' }), /Name is required/);
    assert.throws(() => createSessionUser({ name: 'User', regdNo: '', role: 'STUDENT' }), /Regd. No. is required/);
    assert.throws(() => createSessionUser({ name: 'User', regdNo: 'REG-1', role: 'UNKNOWN_ROLE' }), /Invalid role/);
});

test('issueToken and authenticate round-trips correctly for created users', () => {
    const u = createSessionUser({ name: 'Prof. Sharma', regdNo: 'EMP-900', role: 'TEACHER' });
    const token = issueToken(u);
    const authed = authenticate({ headers: { authorization: `Bearer ${token}` } });
    assert.equal(authed.name, 'Prof. Sharma');
    assert.equal(authed.id, 'EMP-900');
    assert.equal(authed.role, 'TEACHER');
});

test('isAdmin returns true for INSTITUTE_ADMIN, SUPER_ADMIN, and ADMIN', () => {
    assert.equal(isAdmin({ role: 'INSTITUTE_ADMIN' }), true);
    assert.equal(isAdmin({ role: 'SUPER_ADMIN' }), true);
    assert.equal(isAdmin({ role: 'ADMIN' }), true);
    assert.equal(isAdmin({ role: 'STUDENT' }), false);
    assert.equal(isAdmin({ role: 'TEACHER' }), false);
});

test('createSessionUser rejects email addresses and enforces Registration/Roll/ID format', () => {
    assert.throws(
        () => createSessionUser({ name: 'Student One', regdNo: 'student@college.edu', role: 'STUDENT' }),
        /Email addresses are not accepted/
    );
    assert.throws(
        () => createSessionUser({ name: 'Student Two', regdNo: 'user.name+tag@domain.co.in', role: 'STUDENT' }),
        /Email addresses are not accepted/
    );

    // Valid formats: Registration / Roll / Student ID / Employee ID
    const validIds = ['2024CS001', 'REG-1234', 'EMP-900', 'STU_42', 'CS/2024/09', 'ROLL-101'];
    for (const validId of validIds) {
        const u = createSessionUser({ name: 'Valid User', regdNo: validId, role: 'STUDENT' });
        assert.equal(u.id, validId);
    }
});

test('verifyResponderCredentials accepts only authorized credentials 250131 and 2611', async () => {
    // Correct credentials
    const responder = await verifyResponderCredentials('250131', '2611', 'Campus Emergency Response Unit');
    assert.equal(responder.id, '250131');
    assert.equal(responder.role, 'RESPONDER');
    assert.equal(responder.departmentId, 'DEPT_SECURITY');

    // Reject wrong ID
    await assert.rejects(
        () => verifyResponderCredentials('RESP-001', '2611'),
        /Invalid Registration Number/
    );

    // Reject wrong PIN
    await assert.rejects(
        () => verifyResponderCredentials('250131', 'RESP-911'),
        /Invalid PIN/
    );

    await assert.rejects(
        () => verifyResponderCredentials('250131', '9999'),
        /Invalid PIN/
    );

    // Reject empty ID
    await assert.rejects(
        () => verifyResponderCredentials('', '2611'),
        /Registration \/ ID No. is required/
    );
});

test('isResponder recognizes 250131 and RESPONDER role, rejects old RESP-001', async () => {
    assert.equal(isResponder({ id: '250131', role: 'RESPONDER' }), true);
    assert.equal(isResponder({ id: '250131', role: 'STUDENT' }), true);
    assert.equal(isResponder({ id: 'ANY_ID', role: 'RESPONDER' }), true);
    assert.equal(isResponder({ id: 'RESP-001', role: 'STUDENT' }), false);
    await closeDatabase();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionUser, issueToken, authenticate, ROLES, isAdmin } from './auth.js';

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
    const validIds = ['2024CS001', 'REG-1234', 'EMP-900', 'STU_42', 'CS/2024/09', 'ROLL-101', 'RESP-001'];
    for (const validId of validIds) {
        const u = createSessionUser({ name: 'Valid User', regdNo: validId, role: 'STUDENT' });
        assert.equal(u.id, validId);
    }
});

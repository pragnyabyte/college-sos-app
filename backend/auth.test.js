import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionUser, issueToken, authenticate, ROLES, isAdmin, isResponder, verifyResponderCredentials, registerStudent, verifyStudentCredentials, normalizeRegdNo } from './auth.js';
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

test('createSessionUser rejects TEACHER role as unsupported', () => {
    assert.throws(
        () => createSessionUser({ name: 'Prof. Sharma', regdNo: 'EMP-900', role: 'TEACHER' }),
        /Invalid role specified\. Teacher role is not supported\./
    );
});

test('issueToken and authenticate round-trips correctly for created users', () => {
    const u = createSessionUser({ name: 'Admin User', regdNo: 'EMP-900', role: 'ADMIN' });
    const token = issueToken(u);
    const authed = authenticate({ headers: { authorization: `Bearer ${token}` } });
    assert.equal(authed.name, 'Admin User');
    assert.equal(authed.id, 'EMP-900');
    assert.equal(authed.role, 'ADMIN');
});

test('isAdmin returns true for INSTITUTE_ADMIN, SUPER_ADMIN, and ADMIN', () => {
    assert.equal(isAdmin({ role: 'INSTITUTE_ADMIN' }), true);
    assert.equal(isAdmin({ role: 'SUPER_ADMIN' }), true);
    assert.equal(isAdmin({ role: 'ADMIN' }), true);
    assert.equal(isAdmin({ role: 'STUDENT' }), false);
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

test('verifyResponderCredentials accepts only authorized credentials RESP-1111 and 2026', async () => {
    // Correct credentials with new PIN 2026
    const responder = await verifyResponderCredentials('RESP-1111', '2026', 'Campus Emergency Response Unit');
    assert.equal(responder.id, 'RESP-1111');
    assert.equal(responder.role, 'RESPONDER');
    assert.equal(responder.departmentId, 'DEPT_SECURITY');

    // Reject old PIN 2611
    await assert.rejects(
        () => verifyResponderCredentials('RESP-1111', '2611'),
        /Invalid PIN/
    );

    // Reject old / wrong ID (250131 and RESP-001)
    await assert.rejects(
        () => verifyResponderCredentials('250131', '2026'),
        /Invalid Registration Number/
    );
    await assert.rejects(
        () => verifyResponderCredentials('RESP-001', '2026'),
        /Invalid Registration Number/
    );

    // Reject wrong PIN
    await assert.rejects(
        () => verifyResponderCredentials('RESP-1111', 'RESP-911'),
        /Invalid PIN/
    );

    await assert.rejects(
        () => verifyResponderCredentials('RESP-1111', '9999'),
        /Invalid PIN/
    );

    // Reject empty ID
    await assert.rejects(
        () => verifyResponderCredentials('', '2026'),
        /Registration \/ ID No. is required/
    );
});

test('isResponder recognizes RESP-1111 and RESPONDER role, rejects old IDs', async () => {
    assert.equal(isResponder({ id: 'RESP-1111', role: 'RESPONDER' }), true);
    assert.equal(isResponder({ id: 'RESP-1111', role: 'STUDENT' }), true);
    assert.equal(isResponder({ id: 'ANY_ID', role: 'RESPONDER' }), true);
    assert.equal(isResponder({ id: '250131', role: 'STUDENT' }), false);
    assert.equal(isResponder({ id: 'RESP-001', role: 'STUDENT' }), false);
});

test('Student Registration (One-Time Only): registers a new student with unique registration ID', async () => {
    const uniqueId = 'STU-TEST-' + Math.floor(100000 + Math.random() * 900000);
    const regResult = await registerStudent({ name: 'Priya Sharma', regdNo: uniqueId });
    assert.equal(regResult.success, true);
    assert.equal(regResult.message, 'Registration successful! You can now sign in.');
    assert.equal(regResult.student.name, 'Priya Sharma');
    assert.equal(regResult.student.regdNo, uniqueId);
    assert.ok(regResult.student.accountId.startsWith('STU-'));
});

test('Student Registration: prevents duplicate registration with same ID', async () => {
    const uniqueId = 'STU-DUP-' + Math.floor(100000 + Math.random() * 900000);
    await registerStudent({ name: 'Amit Verma', regdNo: uniqueId });

    // Second registration with same ID must fail
    await assert.rejects(
        () => registerStudent({ name: 'Amit Verma', regdNo: uniqueId }),
        (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.message, 'This registration ID is already registered. Please sign in.');
            return true;
        }
    );

    // Case-insensitive duplicate check (e.g. lowercase vs uppercase)
    await assert.rejects(
        () => registerStudent({ name: 'Another Student', regdNo: uniqueId.toLowerCase() }),
        (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.message, 'This registration ID is already registered. Please sign in.');
            return true;
        }
    );
});

test('Student Registration: validates required fields, emails, and formats', async () => {
    // Missing name
    await assert.rejects(
        () => registerStudent({ name: '', regdNo: 'STU-VALID-01' }),
        /Full Name is required/
    );

    // Missing ID
    await assert.rejects(
        () => registerStudent({ name: 'Valid Name', regdNo: '' }),
        /Registration \/ ID No\. is required/
    );

    // Email rejection
    await assert.rejects(
        () => registerStudent({ name: 'Test Student', regdNo: 'student@college.edu' }),
        /Email addresses are not accepted/
    );

    // Reserved responder ID rejection
    await assert.rejects(
        () => registerStudent({ name: 'Fake Responder', regdNo: 'RESP-1111' }),
        /This registration ID is reserved for emergency services/
    );
});

test('Student Sign-In: authenticated successfully with registered ID and verification', async () => {
    const testId = 'STU-AUTH-' + Math.floor(100000 + Math.random() * 900000);
    await registerStudent({ name: 'Rahul Sen', regdNo: testId });

    // Sign in using registered Full Name as verification
    const session = await verifyStudentCredentials(testId, 'Rahul Sen');
    assert.equal(session.id, testId);
    assert.equal(session.name, 'Rahul Sen');
    assert.equal(session.role, 'STUDENT');

    // Case-insensitive name verification check
    const sessionLower = await verifyStudentCredentials(testId.toLowerCase(), 'rahul sen');
    assert.equal(sessionLower.id, testId);
});

test('Student Sign-In: supports optional password authentication', async () => {
    const testId = 'STU-PASS-' + Math.floor(100000 + Math.random() * 900000);
    await registerStudent({ name: 'Sneha Patel', regdNo: testId, password: 'SecurePassword123!' });

    // Sign in with password
    const session = await verifyStudentCredentials(testId, 'SecurePassword123!');
    assert.equal(session.id, testId);
    assert.equal(session.name, 'Sneha Patel');

    // Sign in with name also supported
    const sessionByName = await verifyStudentCredentials(testId, 'Sneha Patel');
    assert.equal(sessionByName.id, testId);

    // Reject wrong password
    await assert.rejects(
        () => verifyStudentCredentials(testId, 'WrongPassword'),
        (err) => {
            assert.equal(err.status, 401);
            assert.equal(err.message, 'Invalid login details. Please try again.');
            return true;
        }
    );
});

test('Student Sign-In: unregistered student cannot sign in (Account not found)', async () => {
    await assert.rejects(
        () => verifyStudentCredentials('UNREGISTERED-ID-999', 'Any Name'),
        (err) => {
            assert.equal(err.status, 404);
            assert.equal(err.message, 'Account not found. Please register first.');
            return true;
        }
    );
});

test('Student Sign-In: signs in with Registration ID alone and retrieves profile', async () => {
    const testId = 'STU-FAIL-' + Math.floor(100000 + Math.random() * 900000);
    await registerStudent({ name: 'Ananya Roy', regdNo: testId });

    // 1. Sign in with Registration ID alone (no verification field needed)
    const session = await verifyStudentCredentials(testId);
    assert.equal(session.id, testId);
    assert.equal(session.name, 'Ananya Roy');
    assert.equal(session.role, 'STUDENT');

    // 2. Reject if invalid verification is explicitly supplied
    await assert.rejects(
        () => verifyStudentCredentials(testId, 'Wrong Name'),
        (err) => {
            assert.equal(err.status, 401);
            assert.equal(err.message, 'Invalid login details. Please try again.');
            return true;
        }
    );

    // 3. Reject empty Registration ID
    await assert.rejects(
        () => verifyStudentCredentials(''),
        (err) => {
            assert.equal(err.status, 400);
            assert.equal(err.message, 'Please enter your Registration ID.');
            return true;
        }
    );

    await closeDatabase();
});

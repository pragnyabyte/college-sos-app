# College ERP SOS Emergency Response System

A unified campus emergency response system built with pure Firebase architecture (Cloud Firestore, Firebase Authentication, Firebase Hosting, and Firebase Cloud Messaging) supporting both **Students** and **Emergency Responders**.

## Live Production Deployment

- **Production URL**: [https://college-sos-app-26aec.web.app](https://college-sos-app-26aec.web.app)
- **Alternate URL**: [https://college-sos-app-26aec.firebaseapp.com](https://college-sos-app-26aec.firebaseapp.com)
- **Firebase Project**: `college-sos-app-26aec`

## Key Capabilities

- **Unified Authentication**: Single portal for Students (Registration ID & Name verification) and Emergency Responders (`RESP-1111` & PIN `2026`).
- **Real-Time Emergency SOS**: 1-click SOS broadcast with live browser/device GPS capture, category selection, and active status tracking.
- **Registered Students Directory**: Compact status bar on responder console with live student count, two-column search directory (Student Name | Student ID), and individual registration management.
- **24/7 Standby & Direct Cloud Firestore Connection**: Direct snapshot listeners ensure sub-second emergency alert delivery around the clock without relying on third-party proxies.
- **Persistent Sessions**: Browser local persistence (`browserLocalPersistence`) survives browser closures and reboots without logging users out.

## Local Development & Build

```powershell
# Install dependencies
npm install

# Start local development server
npm run dev

# Build production bundle
npm run build

# Deploy to Firebase Hosting
firebase deploy --only hosting
```

## Database migrations

Startup runs versioned migrations from `backend/migrations` and records each applied version in MongoDB's `schema_migrations` collection. Migration `001_sos_core` creates the query, idempotency, timeline, audit, and notification indexes and seeds category/department configuration.

Create a portable Extended JSON backup, including collection index definitions:

```powershell
npm run db:backup
```

Move to another MongoDB database safely. The command backs up the source before copying any records:

```powershell
$env:MONGODB_TARGET_URI='mongodb+srv://...'
$env:MONGODB_TARGET_DB='school_erp_sos'
npm run db:migrate
```

Optional variables are `MONGODB_SOURCE_URI`, `MONGODB_SOURCE_DB`, and `BACKUP_DIR`. Backups are written under `backups/` and excluded from Git because SOS data is sensitive.

## Roles and permissions

- Student: create an SOS, view only their records, and cancel before acceptance.
- Responder: see only incidents routed to their department; exact GPS is available only within that scope.
- Institute admin: see all authorized incidents, operational metrics, and permission-filtered exports.
- Harassment/threat incidents are restricted to Welfare, Security, and administrators.

Identity, student ID, priority, departments, status, and responder assignment are derived or validated server-side. Acceptance uses an atomic conditional MongoDB update to prevent multiple responders accepting the same incident.

## API

- `POST /api/sos`
- `GET /api/sos/my`, `/api/sos/active`, `/api/sos/admin`
- `GET /api/sos/:id`
- `POST /api/sos/:id/{accept|respond|arrive|resolve|cancel}`
- `GET /api/sos/stats`, `/api/sos/export.csv`
- Authenticated WebSocket `/ws`

## Status flow

`SOS_SENT -> DEPARTMENT_NOTIFIED -> ACCEPTED -> RESPONDING -> ARRIVED -> RESOLVED`

Early cancellation is allowed only from `SOS_SENT` or `DEPARTMENT_NOTIFIED`. Resolved incidents cannot move backward through responder APIs.

## Integration boundary

The supplied workspace contained no existing ERP. Demo accounts and persisted notifications stand in for ERP SSO and delivery adapters. External SMS/push, scheduled escalation workers, attachments, and PDF/Excel exports require the real ERP providers.
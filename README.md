# College ERP SOS Emergency Response

A full SOS workflow using a plain HTML/CSS/JavaScript Vite frontend, a Node.js backend, MongoDB Atlas persistence, and authenticated WebSocket notifications.

## Setup and run

```powershell
npm install
Copy-Item .env.example .env
# Set MONGODB_URI and SOS_SESSION_SECRET in .env
npm run dev
```

Open `http://localhost:5173`. Production deployments must use TLS and replace the demonstration identity endpoint with the ERP SSO/JWT adapter. Never commit `.env`.

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
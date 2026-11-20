# MediCare EHR: Smart Electronic Health Record and Prescription System
Prototype by Nishank Kumar (B.Tech CSE, IIIT Agartala). Uses **fictional data only**. Not certified for HIPAA or ABDM compliance.


live link -: https://medicare-2pc7.onrender.com/

## Run locally (Node 22.13+)
```bash
npm install
cp .env.example .env      # then: npm run secrets  -> paste the two values into .env (server refuses placeholders/short secrets)
npm run seed              # fictional demo accounts
npm start                 # http://localhost:3000
npm test                  # 46 automated tests (backend, security/consent, migration, combobox, jsdom UI flow)
npm run backup            # consistent SQLite backup to ./backups (keeps newest 14); restore = stop server, copy file over DB_PATH, start
npm run audit             # dependency vulnerability check (production deps)
```
Demo accounts (local only; password = `SEED_PASSWORD` in `.env`, default `Demo@12345`):
`admin@demo.test`, `reception@demo.test` (receptionist), `doctor@demo.test`, `doctor2@demo.test`, `asha@demo.test` (penicillin allergy, already linked to doctor), `ravi@demo.test` (not linked yet).

## Clinic queue (OpenEMR-inspired workflow, own implementation)
- **Receptionist** registers/finds a patient (matched by ID/email; same name + DOB asks for confirmation) and checks them in with a doctor. Each check-in is a new `visits` row with a queue number (`Q001...`) that restarts every clinic day (timezone `Asia/Kolkata`), a check-in time and status `waiting`.
- **Doctor** workspace: A) waiting queue, earliest first, **Call Next Patient** (atomic on the server), B) current consultation (allergies, previous encounters, diagnosis, notes, prescription editor, *Save progress*, *Complete encounter*), C) completed today.
- **Statuses**: `waiting`, `in_consultation`, `completed`, `cancelled`, `skipped`. Server-enforced transitions; reason required for cancel/skip; skipped can be re-queued and keeps its original number; reassign only while waiting. All queue changes are audit-logged with the reason.
- **Integrity**: unique index on (day, queue number); one active visit per patient per day; one in-consultation visit per doctor; check-in/call-next run in `BEGIN IMMEDIATE` transactions.
- **Reports** (doctor, receptionist): date navigation, doctor/status/patient filters, counts, average waiting and consultation time, all computed from stored timestamps.
- **Privacy**: receptionists see queue and demographics only (no allergies, diagnoses, notes, prescriptions); admins manage accounts only. Patients see their own queue position.
- **Sync**: pages poll every 4-8 s and only update the changed region (no Server-Sent Events yet).

## Migration (non-destructive, runs automatically on startup)
Existing databases are upgraded in place: `users` is rebuilt once to allow the `receptionist` role (rows copied unchanged), `visits` gains queue columns (old visits become `completed`, `queue_date = visit_date`), `audit_logs` gains `detail`, and queue indexes are added. Nothing is reset or reseeded. Back up `medicare.db` before the first run anyway.

## Medicine field fix
Cause: the editor re-rendered all inputs with `innerHTML` after every safety check. Now rows are built once (`public/combobox.js`), only the alert panel updates, searches are debounced and stale responses ignored. Mouse, arrows, Enter and Escape work; typed names outside the catalogue are saved but labelled **unverified**; duplicates are blocked client- and server-side. The catalogue (`src/data/medicines.js`) is names only, no doses, and incomplete.

## Patient consent (new)
A doctor sees a patient's record only through an **active** care link, and the patient controls it:
- **Doctor requests** access by Patient ID (Patients page) -> link is `pending` and the patient is notified. The response is identical for real and unknown IDs (no ID enumeration), and the endpoint is rate-limited.
- **Patient approves or declines** under *My Doctors*; a patient can also grant access directly, and **revoke at any time** (effective immediately).
- **Reception check-in** creates a revocable link only if none exists (labelled `source=checkin`, patient notified). It never overrides an earlier decline/revoke or an open request; the doctor then needs fresh approval.
- Links that existed before this upgrade keep working (`status=active`, `source=legacy`); patients can revoke them.
- Every request, grant, decline and revoke is audit-logged.

## Demo script
1. Sign in as doctor, open Prescribe, search "Asha", add **Amoxicillin**: the allergy alert appears immediately.
2. Fill dosage, frequency, duration. Finalize is refused until a clinical reason is entered (logged in `safety_logs`).
3. Open the saved prescription and scan the QR (or open its `/verify/<token>` link). Revoke it and re-verify to see the status change.
4. Sign in as Asha for the timeline and prescription. Sign in as admin to approve/deactivate accounts and view the audit log.

## Architecture
Frontend (vanilla JS SPA, `public/`) → REST API (Express, `src/app.js`) → SQLite (`src/db.js`).
Safety logic is a pure service (`src/safety.js`) with rule data in `src/data/rules.js`, re-run server-side at finalization.
Security: bcrypt, session in an **httpOnly, SameSite=Strict cookie** (Secure on https) with double-submit **CSRF** header on writes, JWT re-checked against live account status per request, strict Content-Security-Policy (no inline scripts), secret-strength check at startup, server-side role checks, rate limits on auth and verify, immutable finalized prescriptions (revoke only), HMAC-derived unguessable QR tokens (QR holds only a URL), audit logging, admin has no clinical access.

## API summary
`POST /api/auth/register|login|logout` · care consent: `POST /api/patients/link` (doctor, creates pending request) · `GET /api/care/requests` · `POST /api/care/requests/:doctorId/approve|decline` · `POST /api/care/doctors/:doctorId/revoke` · `POST /api/care/connect` · `GET|PUT /api/me` · `GET /api/patients?q=` · `GET /api/patients/:id` · `GET /api/patients/:id/timeline` · `POST /api/patients/:id/allergies` · `POST /api/safety/check` · `POST|GET /api/prescriptions` · `GET /api/prescriptions/:id` · `POST /api/prescriptions/:id/revoke` · `GET /api/verify/:token` (public) · `GET /api/admin/users|audit|stats` · `POST /api/admin/users/:id/status`

## Known limitations
- Rules are a **small prototype dataset**; needs pharmacist review before real use (the UI says so).
- Consent exists, but reception check-in still creates a first-time link without a prompt (point-of-care access, revocable, patient notified). Decide whether your clinic wants to require approval there too.
- Logout clears the cookie, but a stolen token stays valid until its 2-hour expiry (no server-side session revocation yet).
- Non-browser API clients can request a bearer token with the header `X-Client: api` at login.
- Notifications and queues use polling, not WebSockets/SSE.
- Call Next only looks at today's queue; patients left waiting from a previous day need to be cancelled or skipped by reception.
- The UI was exercised with jsdom against a live server, not in real browsers.
- Not built yet: doctor Settings, appointments, Server-Sent Events, multi-clinic support, migration tool (schema is created idempotently at startup), Framer Motion animations, browser E2E tests, lint config.
- Future scope (not implemented): lab uploads, ABHA integration, mobile app, AI diagnosis suggestions.

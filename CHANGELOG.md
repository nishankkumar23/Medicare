# Changelog

## Stage 1 — security and consent (this release)
**Security fixes**
- FIXED: any doctor could gain full access to any patient record by entering a Patient ID (no consent). Now a pending request the patient must approve; revocable; audit-logged.
- FIXED: Patient ID enumeration through different 404/201 answers on the link endpoint; now uniform + rate-limited.
- CHANGED: JWT moved out of sessionStorage into an httpOnly SameSite=Strict cookie; CSRF double-submit header on writes; `POST /api/auth/logout`.
- ADDED: Content-Security-Policy (no inline scripts; verify page script and Print button moved out of inline), `Cache-Control: no-store` on API.
- ADDED: server refuses to start with placeholder/short `JWT_SECRET`/`QR_SECRET`; `npm run secrets`; `.env.example` has no secrets; `.env`, `*.db`, backups, zips are git-ignored and excluded from the delivered ZIP.
- ADDED: `npm run backup` (consistent SQLite backup, rotation) and documented restore.
- FIXED: vulnerable `body-parser`/`qs` via `npm audit fix` (0 vulnerabilities now).
**Migration**: `care_links` gains `status`, `source`, `updated_at`; existing rows stay `active`/`legacy`. Non-destructive and idempotent (tested).
**Tests**: 31 -> 46 (new `test/security.test.js`). Fixed a pre-existing flaky test (token "tampering" sometimes produced the real token, ~1 in 64).

## Status of the requested scope
| Area | Status |
|---|---|
| Patient consent + revoke | Implemented, tested (API + UI flow via existing jsdom test) |
| Cookie sessions, CSRF, CSP, secret checks | Implemented, tested |
| Backup/recovery | Implemented, backup + restore verified manually |
| Dependency audit | Done, 0 vulnerabilities |
| Email verification, password reset, MFA | NOT started |
| Appointments + doctor availability | NOT started |
| Secure messaging, lab reports, file uploads | NOT started |
| Premium UI redesign, dark mode, Lucide, design system | NOT started |
| New dashboards/analytics/calendar | NOT started |
| Playwright E2E, mobile + accessibility tests | NOT started |

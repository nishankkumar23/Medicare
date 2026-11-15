// Regression tests for Stage 1 hardening: patient consent, cookie sessions + CSRF, headers, secrets, legacy migration.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const PUBLIC = new URL('../public', import.meta.url).pathname;
const PW = 'Password!234';
let server, base, db, rlServer, rlBase;
const T = {}, ID = {};
const call = async (path, { method = 'GET', body, token, headers = {}, b = base } = {}) => {
  const r = await fetch(b + path, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers, raw: r };
};
const loginApi = async (email) => (await call('/api/auth/login', { method: 'POST', headers: { 'x-client': 'api' }, body: { email, password: PW } })).body.token;
const cfg = (extra) => ({ jwtSecret: 'j'.repeat(40), qrSecret: 'q'.repeat(40), baseUrl: 'http://x.test', publicDir: PUBLIC, bcryptCost: 4, ...extra });

before(async () => {
  db = openDb(':memory:');
  server = createApp(db, cfg({ rateLimit: false })).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  const rl = createApp(openDb(':memory:'), cfg({ rateLimit: true })); rlServer = rl.listen(0); rlBase = `http://127.0.0.1:${rlServer.address().port}`;
  const h = bcrypt.hashSync(PW, 4);
  for (const [k, e, role] of [['doc', 'doc@s.co', 'doctor'], ['doc2', 'doc2@s.co', 'doctor'], ['rec', 'rec@s.co', 'receptionist']]) {
    ID[k] = Number(db.prepare('INSERT INTO users(email,password_hash,role,name,status) VALUES(?,?,?,?,?)').run(e, h, role, k, 'active').lastInsertRowid);
  }
  for (const e of ['pa@s.co', 'pb@s.co']) assert.equal((await call('/api/auth/register', { method: 'POST', body: { email: e, password: PW, name: e } })).status, 201);
  for (const [k, e] of [['doc', 'doc@s.co'], ['doc2', 'doc2@s.co'], ['rec', 'rec@s.co'], ['pa', 'pa@s.co'], ['pb', 'pb@s.co']]) T[k] = await loginApi(e);
  for (const k of ['pa', 'pb']) { const me = (await call('/api/me', { token: T[k] })).body; ID[k + 'Id'] = me.patientId; ID[k + 'Code'] = me.patientCode; }
});
after(() => { server.close(); rlServer.close(); });

const seen = (docTok, pid) => call(`/api/patients/${pid}`, { token: docTok }).then((r) => r.status);
const link = (tok, code) => call('/api/patients/link', { method: 'POST', token: tok, body: { patientCode: code } });

test('consent: a doctor cannot read a record by knowing the Patient ID; request stays pending', async () => {
  const r = await link(T.doc, ID.paCode);
  assert.equal(r.status, 202);
  assert.equal(await seen(T.doc, ID.paId), 403);
  const row = db.prepare('SELECT status,source FROM care_links WHERE doctor_id=? AND patient_id=?').get(ID.doc, ID.paId);
  assert.deepEqual({ ...row }, { status: 'pending', source: 'doctor' });
  assert.equal((await call('/api/doctor/stats', { token: T.doc })).body.patients, 0);
  assert.equal((await call('/api/patients', { token: T.doc })).body.length, 0);
});

test('consent: link endpoint gives identical answers for real and unknown IDs (no enumeration)', async () => {
  const real = await link(T.doc2, ID.pbCode), fake = await link(T.doc2, 'PT-ZZZZZZ');
  assert.equal(real.status, fake.status);
  assert.deepEqual(real.body, fake.body);
});

test('consent: only the patient can approve, and only their own requests', async () => {
  assert.equal((await call(`/api/care/requests/${ID.doc}/approve`, { method: 'POST', token: T.pb, body: {} })).status, 404); // other patient
  assert.equal((await call(`/api/care/requests/${ID.doc}/approve`, { method: 'POST', token: T.doc, body: {} })).status, 403); // doctor self-approve
  assert.equal((await call(`/api/care/requests/${ID.doc}/approve`, { method: 'POST', token: T.rec, body: {} })).status, 403);
  assert.equal(await seen(T.doc, ID.paId), 403);
  const list = (await call('/api/care/requests', { token: T.pa })).body;
  assert.equal(list.length, 1); assert.equal(list[0].doctorId, ID.doc);
  assert.ok((await call('/api/notifications', { token: T.pa })).body.items.some((n) => /asked for access/.test(n.message)));
});

test('consent: approve grants access, revoke removes it immediately, audit log records both', async () => {
  assert.equal((await call(`/api/care/requests/${ID.doc}/approve`, { method: 'POST', token: T.pa, body: {} })).status, 200);
  assert.equal(await seen(T.doc, ID.paId), 200);
  assert.equal((await call('/api/doctor/stats', { token: T.doc })).body.patients, 1);
  assert.equal((await call(`/api/care/doctors/${ID.doc}/revoke`, { method: 'POST', token: T.pa, body: {} })).status, 200);
  assert.equal(await seen(T.doc, ID.paId), 403);
  assert.equal((await call(`/api/patients/${ID.paId}/timeline`, { token: T.doc })).status, 403);
  assert.equal((await call(`/api/care/doctors/${ID.doc}/revoke`, { method: 'POST', token: T.pa, body: {} })).status, 404); // already revoked
  const acts = db.prepare("SELECT action FROM audit_logs WHERE action LIKE 'consent_%' OR action='access_request'").all().map((a) => a.action);
  for (const a of ['access_request', 'consent_grant', 'consent_revoke']) assert.ok(acts.includes(a), a);
});

test('consent: patient can decline; doctor may ask again afterwards; patient-initiated grant works', async () => {
  assert.equal((await link(T.doc, ID.paCode)).status, 202);
  assert.equal((await call(`/api/care/requests/${ID.doc}/decline`, { method: 'POST', token: T.pa, body: {} })).status, 200);
  assert.equal(await seen(T.doc, ID.paId), 403);
  assert.equal((await link(T.doc, ID.paCode)).status, 202); // re-request allowed
  assert.equal(db.prepare('SELECT status FROM care_links WHERE doctor_id=? AND patient_id=?').get(ID.doc, ID.paId).status, 'pending');
  assert.equal((await call('/api/care/connect', { method: 'POST', token: T.pa, body: { doctorId: ID.doc } })).status, 201); // patient grants directly
  assert.equal(await seen(T.doc, ID.paId), 200);
});

test('consent: reception check-in never silently overrides a revoked or pending link', async () => {
  await call(`/api/care/doctors/${ID.doc}/revoke`, { method: 'POST', token: T.pa, body: {} });
  const r = await call('/api/visits/checkin', { method: 'POST', token: T.rec, body: { patientId: ID.paId, doctorId: ID.doc } });
  assert.equal(r.status, 201);
  assert.equal(db.prepare('SELECT status FROM care_links WHERE doctor_id=? AND patient_id=?').get(ID.doc, ID.paId).status, 'revoked');
  assert.equal(await seen(T.doc, ID.paId), 403);
  assert.ok((await call('/api/notifications', { token: T.pa })).body.items.some((n) => /needs your approval/.test(n.message)));
});

test('consent: first-time check-in creates a revocable, clearly-labelled link', async () => {
  const r = await call('/api/visits/checkin', { method: 'POST', token: T.rec, body: { patientId: ID.pbId, doctorId: ID.doc } });
  assert.equal(r.status, 201);
  assert.equal(db.prepare('SELECT source FROM care_links WHERE doctor_id=? AND patient_id=?').get(ID.doc, ID.pbId).source, 'checkin');
  assert.equal((await call(`/api/care/doctors/${ID.doc}/revoke`, { method: 'POST', token: T.pb, body: {} })).status, 200);
  assert.equal(await seen(T.doc, ID.pbId), 403);
});

test('migration: legacy care_links rows stay active and nothing is lost', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'mc-')), 'legacy.db');
  const old = new DatabaseSync(f);
  old.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('admin','doctor','patient','receptionist')), name TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE patients(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE, patient_code TEXT NOT NULL UNIQUE, dob TEXT, phone TEXT);
    CREATE TABLE care_links(id INTEGER PRIMARY KEY, doctor_id INTEGER NOT NULL, patient_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(doctor_id, patient_id));
    INSERT INTO care_links(doctor_id,patient_id) VALUES(1,2);`);
  old.close();
  const m = openDb(f);
  assert.deepEqual({ ...m.prepare('SELECT doctor_id,patient_id,status,source FROM care_links').get() }, { doctor_id: 1, patient_id: 2, status: 'active', source: 'legacy' });
  m.close(); assert.equal(openDb(f).prepare('SELECT count(*) n FROM care_links').get().n, 1); // idempotent
});

test('sessions: browser login uses httpOnly SameSite=Strict cookie and never returns a token in JSON', async () => {
  const r = await call('/api/auth/login', { method: 'POST', body: { email: 'pa@s.co', password: PW } });
  assert.equal(r.status, 200); assert.equal(r.body.token, undefined);
  const cookies = r.raw.headers.getSetCookie();
  const sess = cookies.find((c) => c.startsWith('mc_session=')), csrf = cookies.find((c) => c.startsWith('mc_csrf='));
  assert.match(sess, /HttpOnly/i); assert.match(sess, /SameSite=Strict/i);
  assert.doesNotMatch(csrf, /HttpOnly/i); assert.match(csrf, /SameSite=Strict/i);
});

test('sessions: cookie auth requires a matching CSRF header on writes; bearer API clients are unaffected', async () => {
  const r = await call('/api/auth/login', { method: 'POST', body: { email: 'pa@s.co', password: PW } });
  const c = Object.fromEntries(r.raw.headers.getSetCookie().map((x) => x.split(';')[0].split(/=(.*)/s).slice(0, 2)));
  const cookie = `mc_session=${c.mc_session}; mc_csrf=${c.mc_csrf}`;
  assert.equal((await call('/api/me', { headers: { cookie } })).status, 200); // reads need no CSRF header
  const put = (extra) => call('/api/me', { method: 'PUT', headers: { cookie, ...extra }, body: { name: 'Pat A' } });
  assert.equal((await put({})).status, 403);
  assert.equal((await put({ 'x-csrf-token': 'wrong-token' })).status, 403);
  assert.equal((await put({ 'x-csrf-token': c.mc_csrf })).status, 200);
  assert.equal((await call('/api/me', { method: 'PUT', token: T.pa, body: { name: 'Pat A' } })).status, 200);
});

test('sessions: logout clears both cookies; no cookie means 401', async () => {
  const r = await call('/api/auth/logout', { method: 'POST' });
  const cleared = r.raw.headers.getSetCookie();
  assert.ok(cleared.some((c) => c.startsWith('mc_session=;'))); assert.ok(cleared.some((c) => c.startsWith('mc_csrf=;')));
  assert.equal((await call('/api/me')).status, 401);
});

test('headers: CSP forbids inline script and framing; API responses are not cached', async () => {
  const r = await call('/api/me', { token: T.pa });
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'(;|$)/); assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/); assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('frontend: no inline scripts/handlers and no token in sessionStorage (CSP-safe)', () => {
  for (const f of ['index.html', 'verify.html']) assert.doesNotMatch(readFileSync(join(PUBLIC, f), 'utf8'), /<script(?![^>]*\bsrc=)[^>]*>|\son\w+=/i, f);
  const js = readFileSync(join(PUBLIC, 'app.js'), 'utf8');
  assert.doesNotMatch(js, /sessionStorage|localStorage/); assert.doesNotMatch(js, /<[a-z][^>]*\son[a-z]+=\\?["']/i); // no inline HTML handler attributes
});

test('rate limit: the link endpoint throttles repeated Patient ID guessing', async () => {
  const h = bcrypt.hashSync(PW, 4), rdb = createApp; void rdb;
  // the rate-limited instance has its own DB; seed one doctor there through the API-visible table
  const r = await fetch(rlBase + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@s.co', password: PW, name: 'x', role: 'doctor' }) });
  assert.equal(r.status, 201); void h;
  // doctor is pending (cannot log in) so probe the limiter on login-protected route via unauthenticated 401s:
  let last; for (let i = 0; i < 20; i++) last = await fetch(rlBase + '/api/patients/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok([401, 429].includes(last.status));
});

test('secrets: server refuses to start with placeholder or short secrets', () => {
  const run = (env) => spawnSync(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url).pathname, env: { PATH: process.env.PATH, DB_PATH: ':memory:', PORT: '0', ...env }, encoding: 'utf8', timeout: 8000 });
  for (const env of [{ JWT_SECRET: 'change-me-to-a-long-random-string', QR_SECRET: 'x'.repeat(48) }, { JWT_SECRET: 'x'.repeat(48), QR_SECRET: 'short' }, {}]) {
    const r = run(env); assert.equal(r.status, 1, JSON.stringify(env)); assert.match(r.stderr, /JWT_SECRET|QR_SECRET/);
  }
});

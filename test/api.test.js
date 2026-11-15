import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base, db;
const tokens = {};
const call = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-client': 'api', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  db = openDb(':memory:');
  const app = createApp(db, { jwtSecret: 'j'.repeat(32), qrSecret: 'q'.repeat(32), baseUrl: 'http://x.test', publicDir: '.', rateLimit: false, bcryptCost: 4 });
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
  const h = bcrypt.hashSync('Password!234', 4);
  db.prepare("INSERT INTO users(email,password_hash,role,name,status) VALUES('a@t.co',?, 'admin','Admin','active')").run(h);
  db.prepare("INSERT INTO users(email,password_hash,role,name,status) VALUES('d@t.co',?, 'doctor','Dr T','active')").run(h);
  for (const e of ['p1@t.co', 'p2@t.co']) {
    const r = await call('/api/auth/register', { method: 'POST', body: { email: e, password: 'Password!234', name: e } });
    assert.equal(r.status, 201);
  }
  for (const [k, e] of [['admin', 'a@t.co'], ['doc', 'd@t.co'], ['p1', 'p1@t.co'], ['p2', 'p2@t.co']])
    tokens[k] = (await call('/api/auth/login', { method: 'POST', body: { email: e, password: 'Password!234' } })).body.token;
});
after(() => server.close());

test('doctor registration stays pending and cannot log in until approved', async () => {
  await call('/api/auth/register', { method: 'POST', body: { email: 'nd@t.co', password: 'Password!234', name: 'New Doc', role: 'doctor' } });
  const r = await call('/api/auth/login', { method: 'POST', body: { email: 'nd@t.co', password: 'Password!234' } });
  assert.equal(r.status, 403);
});
test('duplicate email and weak password rejected', async () => {
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { email: 'p1@t.co', password: 'Password!234', name: 'x' } })).status, 409);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { email: 'z@t.co', password: 'short', name: 'x' } })).status, 400);
});

let rx, pid1, pid2;
test('doctor prescribing: allergy blocks until acknowledged, then QR verifies', async () => {
  pid1 = (await call('/api/me', { token: tokens.p1 })).body.patientId;
  pid2 = (await call('/api/me', { token: tokens.p2 })).body.patientId;
  assert.equal((await call(`/api/patients/${pid1}`, { token: tokens.doc })).status, 403); // not connected yet
  const docs = (await call('/api/doctors', { token: tokens.p1 })).body;
  assert.equal((await call('/api/care/connect', { method: 'POST', token: tokens.p1, body: { doctorId: docs[0].id } })).status, 201);
  assert.equal((await call(`/api/patients/${pid1}`, { token: tokens.doc })).status, 200);
  await call(`/api/patients/${pid1}/allergies`, { method: 'POST', token: tokens.doc, body: { substance: 'Penicillin' } });
  const med = { name: 'Amoxicillin', strength: '500mg', dosage: '1 capsule', frequency: 'TID', duration: '5 days' };
  const blocked = await call('/api/prescriptions', { method: 'POST', token: tokens.doc, body: { patientId: pid1, diagnosis: 'Sinusitis', medicines: [med] } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.safety.alerts[0].type, 'allergy');
  const saved = await call('/api/prescriptions', { method: 'POST', token: tokens.doc, body: { patientId: pid1, diagnosis: 'Sinusitis', medicines: [med], acknowledgements: [{ reason: 'Allergy history reviewed; benefit outweighs risk (test)' }] } });
  assert.equal(saved.status, 201);
  assert.match(saved.body.qr, /^data:image\/png/);
  rx = saved.body;
  const token = rx.verifyUrl.split('/verify/')[1];
  assert.equal(JSON.stringify(rx).includes('Amoxicillin'), false); // no clinical data leaks into response URL/QR payload
  const v = await call(`/api/verify/${token}`);
  assert.equal(v.status, 200); assert.equal(v.body.authentic, true); assert.equal(v.body.status, 'active');
  assert.equal(v.body.diagnosis, undefined); assert.equal(v.body.medicines, undefined);
});
test('invalid and tampered tokens are rejected; revoked is reported', async () => {
  assert.equal((await call('/api/verify/not-a-token')).status, 404);
  const token = rx.verifyUrl.split('/verify/')[1];
  assert.equal((await call(`/api/verify/${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).status, 404); // always differs from the real token
  assert.equal((await call(`/api/prescriptions/${rx.id}/revoke`, { method: 'POST', token: tokens.doc, body: { reason: 'Issued in error' } })).status, 200);
  assert.equal((await call(`/api/verify/${token}`)).body.status, 'revoked');
});
test('patients cannot read other patients or use doctor/admin endpoints', async () => {
  assert.equal((await call(`/api/patients/${pid1}`, { token: tokens.p2 })).status, 403);
  assert.equal((await call(`/api/patients/${pid1}/timeline`, { token: tokens.p2 })).status, 403);
  assert.equal((await call(`/api/prescriptions/${rx.id}`, { token: tokens.p2 })).status, 404);
  assert.equal((await call(`/api/patients/${pid1}`, { token: tokens.p1 })).status, 200);
  assert.equal((await call('/api/patients', { token: tokens.p1 })).status, 403);
  assert.equal((await call('/api/admin/users', { token: tokens.doc })).status, 403);
  assert.equal((await call('/api/admin/users')).status, 401);
});
test('admin approves/deactivates accounts but cannot read patient records', async () => {
  const users = (await call('/api/admin/users?role=doctor', { token: tokens.admin })).body;
  const pending = users.find((u) => u.status === 'pending');
  assert.equal((await call(`/api/admin/users/${pending.id}/status`, { method: 'POST', token: tokens.admin, body: { status: 'active' } })).status, 200);
  assert.equal((await call(`/api/patients/${pid1}`, { token: tokens.admin })).status, 403);
  assert.equal((await call(`/api/admin/users/${pending.id}/status`, { method: 'POST', token: tokens.admin, body: { status: 'deactivated' } })).status, 200);
  assert.ok((await call('/api/admin/audit', { token: tokens.admin })).body.length > 0);
});
test('deactivated account loses access immediately', async () => {
  const p2 = db.prepare("SELECT id FROM users WHERE email='p2@t.co'").get().id;
  await call(`/api/admin/users/${p2}/status`, { method: 'POST', token: tokens.admin, body: { status: 'deactivated' } });
  assert.equal((await call('/api/me', { token: tokens.p2 })).status, 401);
});

test('prescription creates a notification on the connected patient dashboard', async () => {
  const n = (await call('/api/notifications', { token: tokens.p1 })).body;
  assert.equal(n.unread >= 1, true);
  assert.match(n.items[0].message, /new prescription/);
  await call('/api/notifications/read', { method: 'POST', token: tokens.p1, body: {} });
  assert.equal((await call('/api/notifications', { token: tokens.p1 })).body.unread, 0);
});
test('doctor can link a patient by ID and sees stats', async () => {
  assert.equal((await call('/api/patients/link', { method: 'POST', token: tokens.doc, body: { patientCode: 'PT-NOPE' } })).status, 202); // same answer as a real ID: no enumeration
  const s = (await call('/api/doctor/stats', { token: tokens.doc })).body;
  assert.equal(s.patients, 1); assert.equal(s.prescriptions, 1); assert.equal(s.perDay.length, 7);
});

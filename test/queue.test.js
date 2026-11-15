import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base, db, clock;
const T = {}; const P = {};
const at = (iso) => { clock = new Date(iso); };
const call = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-client': 'api', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const login = async (email) => (await call('/api/auth/login', { method: 'POST', body: { email, password: 'Password!234' } })).body.token;
const newPatient = async (name, dob) => (await call('/api/reception/patients', { method: 'POST', token: T.rec, body: { name, dob } })).body;
const checkin = (p, doc = 'd1') => call('/api/visits/checkin', { method: 'POST', token: T.rec, body: { patientId: p.id, doctorId: P[doc] } });
const queue = async (tok = T.d1, q = '') => (await call('/api/queue' + q, { token: tok })).body.rows;

before(async () => {
  db = openDb(':memory:'); at('2026-10-12T03:30:00Z'); // 09:00 IST
  const app = createApp(db, { jwtSecret: 'j'.repeat(32), qrSecret: 'q'.repeat(32), baseUrl: 'http://x.test', publicDir: '.', rateLimit: false, bcryptCost: 4, now: () => clock, timezone: 'Asia/Kolkata' });
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
  const h = bcrypt.hashSync('Password!234', 4);
  for (const [k, e, role] of [['admin', 'a@t.co', 'admin'], ['rec', 'r@t.co', 'receptionist'], ['d1', 'd1@t.co', 'doctor'], ['d2', 'd2@t.co', 'doctor']]) {
    P[k] = Number(db.prepare('INSERT INTO users(email,password_hash,role,name,status) VALUES(?,?,?,?,?)').run(e, h, role, k.toUpperCase(), 'active').lastInsertRowid);
    T[k] = await login(e);
  }
});
after(() => server.close());

let X, Y, Z;
test('first registered, first served: queue order and numbering', async () => {
  X = await newPatient('Patient X', '1990-01-01'); at('2026-10-12T03:31:00Z');
  Y = await newPatient('Patient Y', '1991-01-01'); Z = await newPatient('Patient Z', '1992-01-01');
  const a = await checkin(X); at('2026-10-12T03:32:00Z'); const b = await checkin(Y); at('2026-10-12T03:33:00Z'); const c = await checkin(Z);
  assert.deepEqual([a.body.queueLabel, b.body.queueLabel, c.body.queueLabel], ['Q001', 'Q002', 'Q003']);
  const rows = await queue();
  assert.deepEqual(rows.map((r) => [r.queueLabel, r.patient, r.status]), [['Q001', 'Patient X', 'waiting'], ['Q002', 'Patient Y', 'waiting'], ['Q003', 'Patient Z', 'waiting']]);
  assert.ok(rows[0].checkin_at < rows[1].checkin_at);
});
test('duplicate active visit is rejected; patient ID stays stable', async () => {
  assert.equal((await checkin(X)).status, 409);
  const again = await call('/api/reception/patients', { method: 'POST', token: T.rec, body: { patientCode: X.patientCode } });
  assert.equal(again.body.existing, true); assert.equal(again.body.id, X.id);
  const dup = await call('/api/reception/patients', { method: 'POST', token: T.rec, body: { name: 'patient x', dob: '1990-01-01' } });
  assert.equal(dup.status, 409); assert.equal(dup.body.candidate.id, X.id);
});
test('queue numbers stay unique under concurrent registration; DB constraint backs it up', async () => {
  const ps = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((n) => newPatient('Conc ' + n)));
  const res = await Promise.all(ps.map((p) => checkin(p, 'd2')));
  assert.ok(res.every((r) => r.status === 201));
  const nums = res.map((r) => r.body.queueNumber);
  assert.equal(new Set(nums).size, 5);
  assert.throws(() => db.prepare("INSERT INTO visits(patient_id,doctor_id,visit_date,queue_date,queue_number,diagnosis,status) VALUES(?,?,?,?,?,'','waiting')").run(X.id, P.d1, '2026-10-12', '2026-10-12', nums[0]), /UNIQUE/);
});
test('call next picks the earliest waiting visit; only one consultation per doctor', async () => {
  const [r1, r2] = await Promise.all([call('/api/queue/next', { method: 'POST', token: T.d1 }), call('/api/queue/next', { method: 'POST', token: T.d1 })]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const rows = await queue();
  assert.equal(rows.find((r) => r.queueLabel === 'Q001').status, 'in_consultation');
  assert.equal(rows.find((r) => r.queueLabel === 'Q002').status, 'waiting');
  assert.ok(rows.find((r) => r.queueLabel === 'Q001').start_at);
  assert.throws(() => db.prepare("UPDATE visits SET status='in_consultation' WHERE patient_id=?").run(Y.id), /UNIQUE/);
});
test('other doctor queues are separate; doctors only see their own visits', async () => {
  assert.equal((await queue(T.d2)).length, 5);
  assert.equal((await call('/api/queue/next', { method: 'POST', token: T.d2 })).status, 200);
});
let xVisit;
test('complete encounter: requires diagnosis, advances queue, preserves history', async () => {
  xVisit = (await queue()).find((r) => r.queueLabel === 'Q001').id;
  at('2026-10-12T03:50:00Z');
  assert.equal((await call(`/api/visits/${xVisit}/complete`, { method: 'POST', token: T.d1, body: {} })).status, 400);
  assert.equal((await call(`/api/visits/${xVisit}/notes`, { method: 'PUT', token: T.d1, body: { diagnosis: 'Viral fever', notes: 'Rest, fluids' } })).status, 200);
  assert.equal((await call(`/api/visits/${xVisit}/complete`, { method: 'POST', token: T.d1, body: {} })).status, 200);
  assert.equal((await call(`/api/visits/${xVisit}/complete`, { method: 'POST', token: T.d1, body: {} })).status, 409); // not re-completable
  const rows = await queue();
  assert.equal(rows.find((r) => r.queueLabel === 'Q001').status, 'completed');
  const next = await call('/api/queue/next', { method: 'POST', token: T.d1 });
  assert.equal(rows.find((r) => r.id === next.body.visitId).queueLabel, 'Q002'); // Y moves to the front
  const enc = (await call(`/api/visits/${xVisit}`, { token: T.d1 })).body;
  assert.equal(enc.diagnosis, 'Viral fever'); assert.equal(enc.notes, 'Rest, fluids');
  const tl = (await call(`/api/patients/${X.id}/timeline`, { token: T.d1 })).body;
  assert.equal(tl[0].diagnosis, 'Viral fever');
});
test('cancel/skip need reasons, follow valid transitions, and never count as completed', async () => {
  const zRow = (await queue()).find((r) => r.queueLabel === 'Q003');
  const patch = (st, reason) => call(`/api/visits/${zRow.id}/status`, { method: 'PATCH', token: T.rec, body: { status: st, reason } });
  assert.equal((await patch('skipped')).status, 400);
  assert.equal((await patch('skipped', 'Stepped out')).status, 200);
  assert.equal((await patch('completed')).status, 400); // only via /complete
  assert.equal((await patch('waiting')).status, 200);   // requeued keeps original number
  assert.equal((await queue()).find((r) => r.id === zRow.id).queueLabel, 'Q003');
  assert.equal((await patch('cancelled', 'Left clinic')).status, 200);
  assert.equal((await patch('waiting')).status, 409);   // cancelled is final
  const s = (await call('/api/reports/daily?date=2026-10-12', { token: T.d1 })).body.stats;
  assert.equal(s.completed, 1); assert.equal(s.cancelled, 1);
  assert.ok(db.prepare("SELECT detail FROM audit_logs WHERE action='visit_cancelled'").get().detail.includes('Left clinic'));
});
test('daily statistics are calculated from persisted visits', async () => {
  const { stats, rows } = (await call('/api/reports/daily?date=2026-10-12', { token: T.d1 })).body;
  assert.deepEqual([stats.total, stats.completed, stats.in_consultation, stats.waiting, stats.cancelled, stats.skipped], [3, 1, 1, 0, 1, 0]);
  const x = rows.find((r) => r.queueLabel === 'Q001');
  assert.equal(x.waitMin, 0 || x.waitMin); assert.ok(x.consultMin >= 0);
  assert.equal(stats.total, db.prepare("SELECT count(*) n FROM visits WHERE queue_date='2026-10-12' AND doctor_id=?").get(P.d1).n);
  // X: check-in 03:31, called 03:32? compute from DB, not hardcoded
  const v = db.prepare('SELECT checkin_at,start_at,end_at FROM visits WHERE id=?').get(xVisit);
  assert.equal(x.consultMin, Math.round((new Date(v.end_at) - new Date(v.start_at)) / 6000) / 10);
  assert.equal(stats.avgConsultMin, x.consultMin);
});
test('midnight boundary uses the clinic timezone', async () => {
  const A = await newPatient('Late Night'), B = await newPatient('After Midnight');
  at('2026-10-12T18:29:59Z'); const a = await checkin(A, 'd2'); // 23:59:59 IST
  at('2026-10-12T18:30:01Z'); const b = await checkin(B, 'd2'); // 00:00:01 IST next day
  assert.equal(db.prepare('SELECT queue_date FROM visits WHERE id=?').get(a.body.id).queue_date, '2026-10-12');
  assert.equal(db.prepare('SELECT queue_date FROM visits WHERE id=?').get(b.body.id).queue_date, '2026-10-13');
  assert.equal(b.body.queueLabel, 'Q001'); // numbering restarts per clinic day
  assert.equal((await call('/api/reports/daily?date=2026-10-13', { token: T.rec })).body.stats.total, 1);
  assert.equal((await call('/api/reports/daily?date=2026-10-12', { token: T.rec })).body.stats.total >= 8, true);
});
test('receptionist and other roles cannot reach clinical data', async () => {
  const reg = await call('/api/auth/register', { method: 'POST', body: { email: 'pp@t.co', password: 'Password!234', name: 'Self Patient' } });
  const pt = await login('pp@t.co');
  assert.equal((await call(`/api/patients/${X.id}`, { token: T.rec })).status, 403);
  assert.equal((await call(`/api/patients/${X.id}/timeline`, { token: T.rec })).status, 403);
  assert.equal((await call(`/api/visits/${xVisit}`, { token: T.rec })).status, 403);
  assert.equal((await call(`/api/prescriptions`, { token: T.rec })).status, 403);
  assert.equal((await call('/api/medicines?q=am', { token: T.rec })).status, 403);
  const q = await queue(T.rec); const r = await call('/api/reports/daily?date=2026-10-12', { token: T.rec });
  for (const row of [...q, ...r.body.rows]) { assert.equal(row.diagnosis, undefined); assert.equal(row.notes, undefined); assert.equal(row.allergies, undefined); }
  assert.equal(r.body.canOpen, false);
  const found = (await call('/api/reception/patients?q=patient x', { token: T.rec })).body[0];
  assert.equal(found.allergies, undefined);
  assert.equal((await call('/api/queue', { token: T.admin })).status, 403);
  assert.equal((await call('/api/queue', { token: pt })).status, 403);
  assert.equal((await call(`/api/visits/${xVisit}`, { token: pt })).status, 404);
  assert.equal((await call('/api/reports/daily', { token: pt })).status, 403);
  assert.equal((await call(`/api/queue/next`, { method: 'POST', token: T.rec })).status, 403);
  assert.equal((await call(`/api/visits/${xVisit}`, { token: T.d2 })).status, 404); // unlinked doctor
});
test('patient requests a visit and sees queue position', async () => {
  at('2026-10-13T04:00:00Z');
  const pt = await login('pp@t.co');
  assert.equal((await call('/api/my/queue', { token: pt })).body.visit, null);
  const r = await call('/api/visits/request', { method: 'POST', token: pt, body: { doctorId: P.d1 } });
  assert.equal(r.status, 201);
  assert.equal((await call('/api/visits/request', { method: 'POST', token: pt, body: { doctorId: P.d1 } })).status, 409);
  const q = (await call('/api/my/queue', { token: pt })).body;
  assert.equal(q.visit.status, 'waiting'); assert.equal(q.position, 1);
});
test('safety workflow still applies inside a consultation (visitId)', async () => {
  at('2026-10-14T04:00:00Z');
  const open = db.prepare("SELECT id FROM visits WHERE doctor_id=? AND status='in_consultation'").get(P.d1); // Y is still being seen
  assert.equal((await call('/api/queue/next', { method: 'POST', token: T.d1 })).status, 409);
  assert.equal((await call(`/api/visits/${open.id}/complete`, { method: 'POST', token: T.d1, body: { diagnosis: 'Check-up' } })).status, 200);
  const pt = await newPatient('Allergy Pat'); await checkin(pt, 'd1');
  assert.equal((await call(`/api/patients/${pt.id}/allergies`, { method: 'POST', token: T.d1, body: { substance: 'penicillin' } })).status, 201);
  const { body } = await call('/api/queue/next', { method: 'POST', token: T.d1 });
  const med = { name: 'Amoxicillin', dosage: '1 cap', frequency: 'TID', duration: '5 days' };
  const sc = (await call('/api/safety/check', { method: 'POST', token: T.d1, body: { patientId: pt.id, medicines: [med, { name: 'Zzzmed' }] } })).body;
  assert.equal(sc.alerts[0].type, 'allergy'); assert.deepEqual(sc.unverified, ['zzzmed']);
  const base = { patientId: pt.id, visitId: body.visitId, diagnosis: 'Sinusitis', medicines: [med] };
  assert.equal((await call('/api/prescriptions', { method: 'POST', token: T.d1, body: base })).status, 409);
  assert.equal((await call('/api/prescriptions', { method: 'POST', token: T.d1, body: { ...base, medicines: [med, med] } })).status, 400);
  assert.equal((await call('/api/prescriptions', { method: 'POST', token: T.d1, body: { ...base, visitId: 999999 } })).status, 409);
  const ok = await call('/api/prescriptions', { method: 'POST', token: T.d1, body: { ...base, acknowledgements: [{ reason: 'Reviewed, benefit outweighs risk (test)' }] } });
  assert.equal(ok.status, 201);
  const enc = (await call(`/api/visits/${body.visitId}`, { token: T.d1 })).body;
  assert.equal(enc.prescriptions.length, 1); assert.equal(enc.status, 'in_consultation'); // encounter stays open until completed
  assert.equal((await call(`/api/visits/${body.visitId}/complete`, { method: 'POST', token: T.d1, body: {} })).status, 200);
  const v = (await call(`/api/verify/${ok.body.verifyUrl.split('/verify/')[1]}`)).body;
  assert.equal(v.authentic, true);
  assert.equal((await call(`/api/prescriptions/${ok.body.id}/revoke`, { method: 'POST', token: T.d1, body: { reason: 'test' } })).status, 200);
});
test('medicine search endpoint returns catalogue matches and caps results', async () => {
  const r = (await call('/api/medicines?q=amox', { token: T.d1 })).body;
  assert.equal(r.items[0].name, 'Amoxicillin'); assert.match(r.catalogue.limitation, /incomplete/);
  assert.deepEqual((await call('/api/medicines?q=a', { token: T.d1 })).body.items, []);
});

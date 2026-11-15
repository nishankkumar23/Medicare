import express from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { checkSafety } from './safety.js';
import { searchMedicines, isKnownMedicine, CATALOGUE_INFO } from './data/medicines.js';

/** YYYY-MM-DD in the clinic's timezone (handles midnight boundaries correctly). */
export const clinicDate = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const ok = (res, data, code = 200) => res.status(code).json(data);
const fail = (res, code, error) => res.status(code).json({ error });
const nonEmpty = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function createApp(db, cfg) {
  const app = express();
  app.disable('x-powered-by');
  const tz = cfg.timezone || 'Asia/Kolkata';
  const now = () => (cfg.now ? cfg.now() : new Date());
  const today = () => clinicDate(now(), tz);
  app.use(express.json({ limit: '50kb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Cache-Control': req.path.startsWith('/api') ? 'no-store' : 'no-cache' });
    next();
  });
  const limiter = (max) => cfg.rateLimit === false ? (q, s, n) => n()
    : rateLimit({ windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false });

  const audit = (userId, action, entity = null, entityId = null, detail = null) =>
    db.prepare('INSERT INTO audit_logs(user_id,action,entity,entity_id,detail) VALUES(?,?,?,?,?)')
      .run(userId, action, entity, entityId == null ? null : String(entityId), detail);
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const tokenFor = (rxCode) => createHmac('sha256', cfg.qrSecret).update(rxCode).digest('base64url');
  const verifyUrl = (token) => `${cfg.baseUrl}/verify/${token}`;

  // ---------- auth ----------
  const SESSION_COOKIE = 'mc_session', CSRF_COOKIE = 'mc_csrf', SESSION_MS = 2 * 3600_000;
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split(/=(.*)/s)).filter((p) => p[0]).map(([k, v]) => [k, decodeURIComponent(v || '')]));
  const secure = String(cfg.baseUrl || '').startsWith('https://');
  const cookieOpts = (httpOnly) => ({ httpOnly, secure, sameSite: 'strict', path: '/', maxAge: SESSION_MS });
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const auth = (...roles) => (req, res, next) => {
    const h = req.headers.authorization || '';
    const ck = cookies(req);
    const viaBearer = h.startsWith('Bearer ');
    try {
      const raw = viaBearer ? h.slice(7) : ck[SESSION_COOKIE];
      if (!raw) return fail(res, 401, 'Authentication required');
      // Cookie sessions need a CSRF header on state-changing requests (double-submit token); Bearer clients are immune.
      if (!viaBearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !same(req.headers['x-csrf-token'], ck[CSRF_COOKIE]))
        return fail(res, 403, 'CSRF token missing or invalid');
      const { sub } = jwt.verify(raw, cfg.jwtSecret);
      const u = db.prepare('SELECT id,email,name,role,status FROM users WHERE id=?').get(sub);
      if (!u || u.status !== 'active') return fail(res, 401, 'Account inactive or not found');
      if (roles.length && !roles.includes(u.role)) return fail(res, 403, 'Forbidden');
      req.user = u; next();
    } catch { return fail(res, 401, 'Authentication required'); }
  };
  const patientRow = (userId) => db.prepare('SELECT * FROM patients WHERE user_id=?').get(userId);
  const linked = (doctorId, patientId) => !!db.prepare("SELECT 1 FROM care_links WHERE doctor_id=? AND patient_id=? AND status='active'").get(doctorId, patientId);
  // Doctors only reach patients they are connected to; patients only reach themselves.
  const canAccessPatient = (user, patientId) =>
    user.role === 'doctor' ? linked(user.id, patientId) : (user.role === 'patient' && patientRow(user.id)?.id === Number(patientId));

  app.post('/api/auth/register', limiter(10), (req, res) => {
    const { email, password, name, role = 'patient', dob } = req.body || {};
    if (!nonEmpty(name, 100) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return fail(res, 400, 'Valid name and email required');
    if (typeof password !== 'string' || password.length < 10) return fail(res, 400, 'Password must be at least 10 characters');
    if (!['patient', 'doctor'].includes(role)) return fail(res, 400, 'Role must be patient or doctor');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email.toLowerCase())) return fail(res, 409, 'Email already registered');
    const status = role === 'doctor' ? 'pending' : 'active'; // doctors need admin approval
    const hash = bcrypt.hashSync(password, cfg.bcryptCost ?? 12);
    const id = tx(() => {
      const uid = Number(db.prepare('INSERT INTO users(email,password_hash,role,name,status) VALUES(?,?,?,?,?)')
        .run(email.toLowerCase(), hash, role, name.trim(), status).lastInsertRowid);
      if (role === 'patient') {
        db.prepare('INSERT INTO patients(user_id,patient_code,dob) VALUES(?,?,?)')
          .run(uid, 'PT-' + randomBytes(3).toString('hex').toUpperCase(), dob || null);
      }
      return uid;
    });
    audit(id, 'register', 'user', id);
    ok(res, { id, status }, 201);
  });

  app.post('/api/auth/login', limiter(10), (req, res) => {
    const { email, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase());
    if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return fail(res, 401, 'Invalid credentials');
    if (u.status !== 'active') return fail(res, 403, `Account is ${u.status}`);
    audit(u.id, 'login', 'user', u.id);
    const token = jwt.sign({ sub: u.id }, cfg.jwtSecret, { expiresIn: '2h' });
    res.cookie(SESSION_COOKIE, token, cookieOpts(true));
    res.cookie(CSRF_COOKIE, randomBytes(24).toString('base64url'), cookieOpts(false));
    // Browsers use the httpOnly cookie. Non-browser API clients opt in to a bearer token with `X-Client: api`.
    ok(res, { ...(req.headers['x-client'] === 'api' && { token }), user: { id: u.id, name: u.name, role: u.role } });
  });
  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { ...cookieOpts(true), maxAge: undefined }); res.clearCookie(CSRF_COOKIE, { ...cookieOpts(false), maxAge: undefined });
    ok(res, { ok: true });
  });

  app.get('/api/me', auth(), (req, res) => {
    const p = req.user.role === 'patient' ? patientRow(req.user.id) : null;
    ok(res, { ...req.user, patientId: p?.id, patientCode: p?.patient_code, dob: p?.dob, phone: p?.phone });
  });
  app.put('/api/me', auth(), (req, res) => {
    const { name, phone, dob } = req.body || {};
    if (name !== undefined && !nonEmpty(name, 100)) return fail(res, 400, 'Invalid name');
    if (name) db.prepare('UPDATE users SET name=? WHERE id=?').run(name.trim(), req.user.id);
    if (req.user.role === 'patient') // clinician-entered data (allergies, visits) is not editable here
      db.prepare('UPDATE patients SET phone=COALESCE(?,phone), dob=COALESCE(?,dob) WHERE user_id=?').run(phone ?? null, dob ?? null, req.user.id);
    audit(req.user.id, 'profile_update', 'user', req.user.id);
    ok(res, { updated: true });
  });

  // ---------- patients ----------
  const patientView = (p) => ({
    id: p.id, patientCode: p.patient_code, name: p.name, dob: p.dob,
    allergies: db.prepare('SELECT substance FROM allergies WHERE patient_id=?').all(p.id).map((a) => a.substance)
  });
  const PQ = 'SELECT p.*, u.name FROM patients p JOIN users u ON u.id=p.user_id';

  app.get('/api/patients', auth('doctor'), (req, res) => {
    const q = `%${String(req.query.q || '').toLowerCase()}%`;
    const rows = db.prepare(`${PQ} JOIN care_links c ON c.patient_id=p.id AND c.doctor_id=? AND c.status='active'
      WHERE (lower(u.name) LIKE ? OR lower(p.patient_code) LIKE ?) ORDER BY u.name LIMIT 50`).all(req.user.id, q, q);
    ok(res, rows.map((p) => ({ id: p.id, patientCode: p.patient_code, name: p.name })));
  });
  app.get('/api/patients/:id', auth('doctor', 'patient'), (req, res) => {
    if (!canAccessPatient(req.user, req.params.id)) return fail(res, 403, 'Forbidden');
    const p = db.prepare(`${PQ} WHERE p.id=?`).get(req.params.id);
    if (!p) return fail(res, 404, 'Not found');
    audit(req.user.id, 'view_patient', 'patient', p.id);
    ok(res, patientView(p));
  });
  app.post('/api/patients/:id/allergies', auth('doctor'), (req, res) => {
    if (!nonEmpty(req.body?.substance, 80)) return fail(res, 400, 'Substance required');
    if (!canAccessPatient(req.user, req.params.id)) return fail(res, 403, 'Not connected to this patient');
    try { db.prepare('INSERT INTO allergies(patient_id,substance) VALUES(?,?)').run(req.params.id, req.body.substance.trim().toLowerCase()); }
    catch { return fail(res, 409, 'Allergy already recorded'); }
    audit(req.user.id, 'add_allergy', 'patient', req.params.id);
    ok(res, { added: true }, 201);
  });
  app.get('/api/patients/:id/timeline', auth('doctor', 'patient'), (req, res) => {
    if (!canAccessPatient(req.user, req.params.id)) return fail(res, 403, 'Forbidden');
    const visits = db.prepare(`SELECT v.id, v.visit_date, v.diagnosis, v.notes, v.queue_number, u.name AS doctor FROM visits v JOIN users u ON u.id=v.doctor_id
      WHERE v.patient_id=? AND v.status='completed' ORDER BY v.visit_date DESC, v.id DESC`).all(req.params.id);
    const rx = db.prepare('SELECT id, rx_code, visit_id, status FROM prescriptions WHERE patient_id=?').all(req.params.id);
    audit(req.user.id, 'view_timeline', 'patient', req.params.id);
    ok(res, visits.map((v) => ({ ...v, notes: req.user.role === 'doctor' ? v.notes : undefined, prescriptions: rx.filter((r) => r.visit_id === v.id) })));
  });

  // ---------- safety ----------
  const allergiesOf = (pid) => db.prepare('SELECT substance FROM allergies WHERE patient_id=?').all(pid).map((a) => a.substance);
  app.post('/api/safety/check', auth('doctor'), (req, res) => {
    const { patientId, medicines } = req.body || {};
    if (!Array.isArray(medicines) || !patientId) return fail(res, 400, 'patientId and medicines required');
    if (!canAccessPatient(req.user, patientId)) return fail(res, 403, 'Not connected to this patient');
    const result = checkSafety(medicines, allergiesOf(patientId));
    const unverified = [...new Set(medicines.map((m) => String(m.name || '').trim().toLowerCase()).filter((n) => n && !isKnownMedicine(n)))];
    ok(res, { ...result, unverified, catalogue: CATALOGUE_INFO });
  });

  // ---------- prescriptions ----------
  const validMed = (m) => nonEmpty(m?.name, 100) && nonEmpty(m.dosage) && nonEmpty(m.frequency) && nonEmpty(m.duration);
  app.post('/api/prescriptions', auth('doctor'), async (req, res) => {
    const { patientId, visitId, diagnosis, medicines, acknowledgements = [] } = req.body || {};
    if (!canAccessPatient(req.user, patientId)) return fail(res, 403, 'Not connected to this patient');
    if (!nonEmpty(diagnosis, 500)) return fail(res, 400, 'Diagnosis required');
    if (!Array.isArray(medicines) || !medicines.length || !medicines.every(validMed)) return fail(res, 400, 'Each medicine needs name, dosage, frequency and duration');
    const names = medicines.map((m) => String(m.name).trim().toLowerCase());
    if (new Set(names).size !== names.length) return fail(res, 400, 'Duplicate medicine in prescription');
    let visit = null;
    if (visitId != null) {
      visit = db.prepare('SELECT * FROM visits WHERE id=?').get(visitId);
      if (!visit || visit.doctor_id !== req.user.id || visit.patient_id !== Number(patientId) || visit.status !== 'in_consultation')
        return fail(res, 409, 'Visit is not an active consultation for this patient');
    }

    const safety = checkSafety(medicines, allergiesOf(patientId)); // re-checked server-side at finalization
    const blocking = safety.alerts.filter((a) => a.severity !== 'moderate');
    const ackd = acknowledgements.length > 0 && acknowledgements.every((a) => nonEmpty(a?.reason, 300));
    if (blocking.length && !ackd) return res.status(409).json({ error: 'Safety alerts require clinician acknowledgement with a reason', safety });

    const rxCode = `RX-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const token = tokenFor(rxCode);
    const rxId = tx(() => {
      let vid;
      if (visit) { vid = visit.id; db.prepare('UPDATE visits SET diagnosis=?, updated_at=? WHERE id=?').run(diagnosis.trim(), now().toISOString(), vid); }
      else vid = Number(db.prepare("INSERT INTO visits(patient_id,doctor_id,visit_date,queue_date,diagnosis,status,updated_at) VALUES(?,?,?,?,?, 'completed', ?)")
        .run(patientId, req.user.id, today(), today(), diagnosis.trim(), now().toISOString()).lastInsertRowid);
      const id = Number(db.prepare('INSERT INTO prescriptions(rx_code,verify_token,patient_id,doctor_id,visit_id,diagnosis) VALUES(?,?,?,?,?,?)')
        .run(rxCode, token, patientId, req.user.id, vid, diagnosis.trim()).lastInsertRowid);
      const ins = db.prepare('INSERT INTO rx_medicines(prescription_id,name,strength,dosage,frequency,duration,route,instructions) VALUES(?,?,?,?,?,?,?,?)');
      for (const m of medicines) ins.run(id, m.name.trim(), m.strength || null, m.dosage, m.frequency, m.duration, m.route || null, m.instructions || null);
      if (safety.alerts.length)
        db.prepare('INSERT INTO safety_logs(prescription_id,doctor_id,alert_json,acknowledged,ack_reason) VALUES(?,?,?,?,?)')
          .run(id, req.user.id, JSON.stringify(safety.alerts), ackd ? 1 : 0, ackd ? acknowledgements.map((a) => a.reason).join(' | ') : null);
      return id;
    });
    audit(req.user.id, 'create_prescription', 'prescription', rxId);
    const pUser = db.prepare('SELECT user_id FROM patients WHERE id=?').get(patientId).user_id;
    db.prepare('INSERT INTO notifications(user_id,message,link) VALUES(?,?,?)')
      .run(pUser, `${req.user.name} issued a new prescription (${rxCode})`, `#/rx/${rxId}`);
    ok(res, { id: rxId, rxCode, qr: await QRCode.toDataURL(verifyUrl(token)), verifyUrl: verifyUrl(token) }, 201);
  });

  const rxFull = (r) => ({
    ...r, verify_token: undefined,
    doctor: db.prepare('SELECT name FROM users WHERE id=?').get(r.doctor_id).name,
    patient: patientView(db.prepare(`${PQ} WHERE p.id=?`).get(r.patient_id)),
    medicines: db.prepare('SELECT * FROM rx_medicines WHERE prescription_id=?').all(r.id)
  });
  app.get('/api/prescriptions', auth('doctor', 'patient'), (req, res) => {
    if (req.user.role === 'doctor' && req.query.patientId) {
      if (!canAccessPatient(req.user, req.query.patientId)) return fail(res, 403, 'Not connected to this patient');
      return ok(res, db.prepare('SELECT id,rx_code,status,issued_at,diagnosis,patient_id FROM prescriptions WHERE patient_id=? ORDER BY id DESC LIMIT 100').all(req.query.patientId));
    }
    const where = req.user.role === 'doctor' ? 'doctor_id=?' : 'patient_id=?';
    const arg = req.user.role === 'doctor' ? req.user.id : patientRow(req.user.id).id;
    const status = req.query.status ? ' AND status=?' : '';
    const args = status ? [arg, req.query.status] : [arg];
    ok(res, db.prepare(`SELECT id,rx_code,status,issued_at,diagnosis,patient_id FROM prescriptions WHERE ${where}${status} ORDER BY issued_at DESC, id DESC LIMIT 100`).all(...args));
  });
  app.get('/api/prescriptions/:id', auth('doctor', 'patient'), async (req, res) => {
    const r = db.prepare('SELECT * FROM prescriptions WHERE id=?').get(req.params.id);
    const allowed = r && canAccessPatient(req.user, r.patient_id);
    if (!allowed) return fail(res, 404, 'Not found'); // 404 avoids confirming existence
    audit(req.user.id, 'view_prescription', 'prescription', r.id);
    ok(res, { ...rxFull(r), qr: await QRCode.toDataURL(verifyUrl(r.verify_token)) });
  });
  app.post('/api/prescriptions/:id/revoke', auth('doctor'), (req, res) => {
    const r = db.prepare('SELECT * FROM prescriptions WHERE id=? AND doctor_id=?').get(req.params.id, req.user.id);
    if (!r) return fail(res, 404, 'Not found');
    if (!nonEmpty(req.body?.reason, 300)) return fail(res, 400, 'Reason required');
    db.prepare("UPDATE prescriptions SET status='revoked', revoked_reason=? WHERE id=?").run(req.body.reason, r.id);
    audit(req.user.id, 'revoke_prescription', 'prescription', r.id);
    ok(res, { status: 'revoked' });
  });
  // Finalized prescriptions are immutable: no update/delete routes exist by design.

  // ---------- public verification ----------
  app.get('/api/verify/:token', limiter(30), (req, res) => {
    const t = String(req.params.token);
    const r = t.length === 43 ? db.prepare('SELECT * FROM prescriptions WHERE verify_token=?').get(t) : null;
    if (!r || tokenFor(r.rx_code) !== t) return res.status(404).json({ authentic: false });
    ok(res, {
      authentic: true, status: r.status, rxCode: r.rx_code, issuedAt: r.issued_at,
      issuedBy: db.prepare('SELECT name FROM users WHERE id=?').get(r.doctor_id).name,
      revoked: r.status === 'revoked', superseded: r.status === 'superseded'
    });
  });

  // ---------- admin (account administration only: no clinical data) ----------
  app.get('/api/admin/users', auth('admin'), (req, res) => {
    const q = `%${String(req.query.q || '').toLowerCase()}%`;
    const role = req.query.role ? ' AND role=?' : '';
    const args = role ? [q, q, req.query.role] : [q, q];
    const page = Math.max(1, Number(req.query.page) || 1);
    ok(res, db.prepare(`SELECT id,email,name,role,status,created_at FROM users WHERE (lower(name) LIKE ? OR lower(email) LIKE ?)${role}
      ORDER BY id DESC LIMIT 20 OFFSET ${(page - 1) * 20}`).all(...args));
  });
  app.post('/api/admin/users/:id/status', auth('admin'), (req, res) => {
    const { status } = req.body || {};
    if (!['active', 'deactivated'].includes(status)) return fail(res, 400, 'Invalid status');
    if (Number(req.params.id) === req.user.id) return fail(res, 400, 'Cannot change your own status');
    const n = db.prepare('UPDATE users SET status=? WHERE id=?').run(status, req.params.id).changes;
    if (!n) return fail(res, 404, 'Not found');
    audit(req.user.id, `set_status_${status}`, 'user', req.params.id);
    ok(res, { status });
  });
  app.get('/api/admin/audit', auth('admin'), (req, res) =>
    ok(res, db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all()));
  app.get('/api/admin/stats', auth('admin'), (req, res) =>
    ok(res, {
      users: db.prepare('SELECT role, count(*) n FROM users GROUP BY role').all(),
      pendingDoctors: db.prepare("SELECT count(*) n FROM users WHERE role='doctor' AND status='pending'").get().n,
      prescriptions: db.prepare('SELECT count(*) n FROM prescriptions').get().n
    }));

  // ---------- clinic queue, encounters, reports ----------
  const httpErr = (code, msg) => Object.assign(new Error(msg), { http: code });
  const wrap = (fn) => (req, res, next) => {
    try { fn(req, res, next); } catch (e) {
      if (e.http) return fail(res, e.http, e.message);
      if (/UNIQUE constraint/.test(e.message)) return fail(res, 409, 'Conflicting update. Please refresh and retry.');
      next(e);
    }
  };
  const label = (n) => (n == null ? null : 'Q' + String(n).padStart(3, '0'));
  const TRANSITIONS = { waiting: ['in_consultation', 'cancelled', 'skipped'], skipped: ['waiting', 'cancelled'], in_consultation: ['completed'], completed: [], cancelled: [] };
  const VQ = `SELECT v.id, v.queue_number, v.queue_date, v.status, v.checkin_at, v.start_at, v.end_at, v.reason, v.doctor_id,
    d.name doctor, p.id patient_id, p.patient_code, u.name patient
    FROM visits v JOIN patients p ON p.id=v.patient_id JOIN users u ON u.id=p.user_id JOIN users d ON d.id=v.doctor_id`;
  const shape = (v) => ({ ...v, queueLabel: label(v.queue_number) });
  const minutes = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 6000) / 10 : null);
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  const notify = (userId, message, link) => db.prepare('INSERT INTO notifications(user_id,message,link) VALUES(?,?,?)').run(userId, message, link);

  app.get('/api/config', (req, res) => ok(res, { timezone: tz, today: today() }));

  // Point-of-care check-in grants a revocable link only when none exists. A patient's earlier decision
  // (declined/revoked) or an open request is never silently overridden: the doctor then needs fresh approval.
  const ensureCheckinLink = (doctorId, patientId, patientUserId) => {
    const ex = db.prepare('SELECT status FROM care_links WHERE doctor_id=? AND patient_id=?').get(doctorId, patientId);
    if (!ex) db.prepare("INSERT INTO care_links(doctor_id,patient_id,status,source,updated_at) VALUES(?,?, 'active','checkin',?)").run(doctorId, patientId, now().toISOString());
    else if (ex.status !== 'active') db.prepare('INSERT INTO notifications(user_id,message,link) VALUES(?,?,?)').run(patientUserId, 'A doctor you checked in with needs your approval to view your record', '#/doctors');
  };
  const createVisit = (patientId, doctorId, actor) => tx(() => {
    const doc = db.prepare("SELECT id,name FROM users WHERE id=? AND role='doctor' AND status='active'").get(doctorId);
    if (!doc) throw httpErr(404, 'Doctor not found or inactive');
    const p = db.prepare('SELECT * FROM patients WHERE id=?').get(patientId);
    if (!p) throw httpErr(404, 'Patient not found');
    const date = today();
    if (db.prepare("SELECT 1 FROM visits WHERE patient_id=? AND queue_date=? AND status IN ('waiting','in_consultation')").get(patientId, date))
      throw httpErr(409, 'This patient already has an active visit today');
    const n = db.prepare('SELECT COALESCE(MAX(queue_number),0)+1 AS n FROM visits WHERE queue_date=?').get(date).n;
    const ts = now().toISOString();
    const id = Number(db.prepare("INSERT INTO visits(patient_id,doctor_id,visit_date,queue_date,queue_number,diagnosis,status,checkin_at,updated_at) VALUES(?,?,?,?,?, '', 'waiting', ?, ?)")
      .run(patientId, doc.id, date, date, n, ts, ts).lastInsertRowid);
    ensureCheckinLink(doc.id, patientId, p.user_id);
    notify(p.user_id, `Checked in as ${label(n)} with ${doc.name}`, '#/overview');
    audit(actor.id, 'visit_checkin', 'visit', id, `${label(n)} ${date}`);
    return { id, queueNumber: n, queueLabel: label(n) };
  });

  app.post('/api/visits/checkin', auth('receptionist'), wrap((req, res) =>
    ok(res, createVisit(Number(req.body?.patientId), Number(req.body?.doctorId), req.user), 201)));
  app.post('/api/visits/request', auth('patient'), wrap((req, res) =>
    ok(res, createVisit(patientRow(req.user.id).id, Number(req.body?.doctorId), req.user), 201)));

  const dayScope = (req) => ({
    date: ISO_DAY.test(req.query.date || '') ? req.query.date : today(),
    doctorId: req.user.role === 'doctor' ? req.user.id : (Number(req.query.doctorId) || null)
  });
  app.get('/api/queue', auth('doctor', 'receptionist'), wrap((req, res) => {
    const { date, doctorId } = dayScope(req);
    const rows = db.prepare(`${VQ} WHERE v.queue_date=? AND v.queue_number IS NOT NULL${doctorId ? ' AND v.doctor_id=?' : ''} ORDER BY v.queue_number`)
      .all(...(doctorId ? [date, doctorId] : [date]));
    ok(res, { date, now: now().toISOString(), rows: rows.map(shape) });
  }));

  // Atomic "call next": earliest waiting visit for this doctor today; one consultation per doctor.
  app.post('/api/queue/next', auth('doctor'), wrap((req, res) => {
    const visitId = tx(() => {
      if (db.prepare("SELECT 1 FROM visits WHERE doctor_id=? AND status='in_consultation'").get(req.user.id))
        throw httpErr(409, 'Finish the current consultation first');
      const next = db.prepare("SELECT v.id, p.user_id FROM visits v JOIN patients p ON p.id=v.patient_id WHERE v.doctor_id=? AND v.queue_date=? AND v.status='waiting' ORDER BY v.queue_number LIMIT 1")
        .get(req.user.id, today());
      if (!next) throw httpErr(404, 'No patients are waiting');
      const ts = now().toISOString();
      const r = db.prepare("UPDATE visits SET status='in_consultation', start_at=?, updated_at=? WHERE id=? AND status='waiting'").run(ts, ts, next.id);
      if (r.changes !== 1) throw httpErr(409, 'Visit changed. Please retry.');
      notify(next.user_id, `${req.user.name} is ready to see you`, '#/overview');
      audit(req.user.id, 'call_next', 'visit', next.id);
      return next.id;
    });
    ok(res, { visitId });
  }));

  app.patch('/api/visits/:id/status', auth('doctor', 'receptionist'), wrap((req, res) => {
    const { status, reason } = req.body || {};
    const v = db.prepare('SELECT * FROM visits WHERE id=?').get(req.params.id);
    if (!v || v.queue_number == null || (req.user.role === 'doctor' && v.doctor_id !== req.user.id)) throw httpErr(404, 'Not found');
    if (!['waiting', 'cancelled', 'skipped'].includes(status)) throw httpErr(400, 'Use call-next or complete for that status');
    if (!TRANSITIONS[v.status].includes(status)) throw httpErr(409, `Cannot change a ${v.status} visit to ${status}`);
    if (['cancelled', 'skipped'].includes(status) && !nonEmpty(reason, 300)) throw httpErr(400, 'A reason is required');
    const r = db.prepare('UPDATE visits SET status=?, reason=COALESCE(?, reason), updated_at=? WHERE id=? AND status=?').run(status, reason?.trim() || null, now().toISOString(), v.id, v.status);
    if (r.changes !== 1) throw httpErr(409, 'Visit changed. Please refresh.');
    audit(req.user.id, `visit_${status}`, 'visit', v.id, reason || null);
    ok(res, { status });
  }));

  app.post('/api/visits/:id/reassign', auth('receptionist'), wrap((req, res) => {
    const v = db.prepare('SELECT * FROM visits WHERE id=?').get(req.params.id);
    if (!v || v.queue_number == null) throw httpErr(404, 'Not found');
    if (v.status !== 'waiting') throw httpErr(409, 'Only waiting visits can be reassigned');
    if (!nonEmpty(req.body?.reason, 300)) throw httpErr(400, 'A reason is required');
    const d = db.prepare("SELECT id FROM users WHERE id=? AND role='doctor' AND status='active'").get(req.body.doctorId);
    if (!d) throw httpErr(404, 'Doctor not found');
    tx(() => {
      db.prepare('UPDATE visits SET doctor_id=?, updated_at=? WHERE id=?').run(d.id, now().toISOString(), v.id);
      ensureCheckinLink(d.id, v.patient_id, db.prepare('SELECT user_id FROM patients WHERE id=?').get(v.patient_id).user_id);
      audit(req.user.id, 'visit_reassign', 'visit', v.id, `to doctor ${d.id}: ${req.body.reason}`);
    });
    ok(res, { reassigned: true });
  }));

  const ownVisit = (req) => {
    const v = db.prepare('SELECT * FROM visits WHERE id=? AND doctor_id=?').get(req.params.id, req.user.id);
    if (!v) throw httpErr(404, 'Not found');
    if (v.status !== 'in_consultation') throw httpErr(409, 'This visit is not in consultation');
    return v;
  };
  app.put('/api/visits/:id/notes', auth('doctor'), wrap((req, res) => {
    const v = ownVisit(req); const { diagnosis = '', notes = '' } = req.body || {};
    if (String(diagnosis).length > 500 || String(notes).length > 5000) throw httpErr(400, 'Text too long');
    db.prepare('UPDATE visits SET diagnosis=?, notes=?, updated_at=? WHERE id=?').run(String(diagnosis).trim(), String(notes), now().toISOString(), v.id);
    audit(req.user.id, 'save_encounter', 'visit', v.id);
    ok(res, { saved: true });
  }));
  app.post('/api/visits/:id/complete', auth('doctor'), wrap((req, res) => {
    const v = ownVisit(req);
    const diagnosis = String(req.body?.diagnosis ?? v.diagnosis ?? '').trim();
    if (!diagnosis) throw httpErr(400, 'A diagnosis or clinical assessment is required to complete the encounter');
    const notes = req.body?.notes ?? v.notes;
    const ts = now().toISOString();
    const r = db.prepare("UPDATE visits SET status='completed', diagnosis=?, notes=?, end_at=?, updated_at=? WHERE id=? AND status='in_consultation'").run(diagnosis, notes, ts, ts, v.id);
    if (r.changes !== 1) throw httpErr(409, 'Visit changed. Please refresh.');
    notify(db.prepare('SELECT user_id FROM patients WHERE id=?').get(v.patient_id).user_id, `Your consultation with ${req.user.name} is complete`, '#/timeline');
    audit(req.user.id, 'complete_encounter', 'visit', v.id);
    ok(res, { status: 'completed' });
  }));

  app.get('/api/visits/:id', auth('doctor', 'patient'), wrap((req, res) => {
    const v = db.prepare(`${VQ} WHERE v.id=?`).get(req.params.id);
    if (!v || !canAccessPatient(req.user, v.patient_id)) throw httpErr(404, 'Not found');
    const clin = db.prepare('SELECT diagnosis, notes FROM visits WHERE id=?').get(v.id);
    audit(req.user.id, 'view_encounter', 'visit', v.id);
    ok(res, { ...shape(v), diagnosis: clin.diagnosis, notes: req.user.role === 'doctor' ? clin.notes : undefined,
      prescriptions: db.prepare('SELECT id, rx_code, status FROM prescriptions WHERE visit_id=?').all(v.id) });
  }));

  app.get('/api/my/queue', auth('patient'), wrap((req, res) => {
    const pid = patientRow(req.user.id).id;
    const v = db.prepare(`${VQ} WHERE v.patient_id=? AND v.queue_date=? ORDER BY v.id DESC LIMIT 1`).get(pid, today());
    if (!v) return ok(res, { visit: null });
    const ahead = v.status === 'waiting' ? db.prepare("SELECT count(*) n FROM visits WHERE doctor_id=? AND queue_date=? AND status='waiting' AND queue_number < ?").get(v.doctor_id, v.queue_date, v.queue_number).n : 0;
    ok(res, { visit: shape(v), position: v.status === 'waiting' ? ahead + 1 : null });
  }));

  app.get('/api/reports/daily', auth('doctor', 'receptionist'), wrap((req, res) => {
    const { date, doctorId } = dayScope(req);
    const nowTs = now().toISOString();
    const all = db.prepare(`${VQ} WHERE v.queue_date=?${doctorId ? ' AND v.doctor_id=?' : ''} ORDER BY COALESCE(v.queue_number, 999999), v.id`)
      .all(...(doctorId ? [date, doctorId] : [date])).map((v) => ({
        ...shape(v),
        waitMin: v.start_at ? minutes(v.checkin_at, v.start_at) : v.status === 'waiting' ? minutes(v.checkin_at, nowTs) : null,
        consultMin: v.status === 'completed' ? minutes(v.start_at, v.end_at) : null
      }));
    const count = (s) => all.filter((r) => r.status === s).length;
    const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
    const stats = { date, total: all.length, completed: count('completed'), waiting: count('waiting'), in_consultation: count('in_consultation'),
      cancelled: count('cancelled'), skipped: count('skipped'),
      avgWaitMin: avg(all.filter((r) => r.start_at && r.waitMin != null).map((r) => r.waitMin)),
      avgConsultMin: avg(all.filter((r) => r.consultMin != null).map((r) => r.consultMin)) };
    const q = String(req.query.q || '').toLowerCase();
    const rows = all.filter((r) => (!req.query.status || r.status === req.query.status)
      && (!q || r.patient.toLowerCase().includes(q) || r.patient_code.toLowerCase().includes(q)));
    ok(res, { stats, rows, canOpen: req.user.role === 'doctor' });
  }));

  // Receptionist: demographics only (no allergies, diagnoses, notes or prescriptions).
  app.get('/api/reception/patients', auth('receptionist'), (req, res) => {
    const q = `%${String(req.query.q || '').toLowerCase()}%`;
    ok(res, db.prepare(`SELECT p.id, p.patient_code patientCode, u.name, p.dob, p.phone FROM patients p JOIN users u ON u.id=p.user_id
      WHERE lower(u.name) LIKE ? OR lower(p.patient_code) LIKE ? ORDER BY u.name LIMIT 15`).all(q, q));
  });
  app.post('/api/reception/patients', auth('receptionist'), wrap((req, res) => {
    const { name, email, dob, phone, patientCode, confirmNew } = req.body || {};
    const byCode = patientCode && db.prepare('SELECT p.id, p.patient_code patientCode, u.name FROM patients p JOIN users u ON u.id=p.user_id WHERE p.patient_code=?').get(String(patientCode).trim().toUpperCase());
    if (byCode) return ok(res, { ...byCode, existing: true });
    if (email) {
      const hit = db.prepare('SELECT p.id, p.patient_code patientCode, u.name FROM patients p JOIN users u ON u.id=p.user_id WHERE u.email=?').get(String(email).toLowerCase());
      if (hit) return ok(res, { ...hit, existing: true });
    }
    if (!nonEmpty(name, 100)) throw httpErr(400, 'Patient name is required');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpErr(400, 'Invalid email');
    if (dob && !confirmNew) {
      const dup = db.prepare('SELECT p.id, p.patient_code patientCode, u.name, p.dob FROM patients p JOIN users u ON u.id=p.user_id WHERE lower(u.name)=? AND p.dob=?').get(name.trim().toLowerCase(), dob);
      if (dup) return res.status(409).json({ error: 'A patient with the same name and date of birth already exists', candidate: dup });
    }
    const code = 'PT-' + randomBytes(3).toString('hex').toUpperCase();
    const mail = email ? String(email).toLowerCase() : `${code.toLowerCase()}@walkin.invalid`;
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(mail)) throw httpErr(409, 'Email already belongs to a non-patient account');
    const hash = bcrypt.hashSync(randomBytes(18).toString('hex'), cfg.bcryptCost ?? 12); // unknown password: walk-in has no login until they register
    const out = tx(() => {
      const uid = Number(db.prepare("INSERT INTO users(email,password_hash,role,name,status) VALUES(?,?,'patient',?, 'active')").run(mail, hash, name.trim()).lastInsertRowid);
      const pid = Number(db.prepare('INSERT INTO patients(user_id,patient_code,dob,phone) VALUES(?,?,?,?)').run(uid, code, dob || null, phone || null).lastInsertRowid);
      audit(req.user.id, 'reception_register_patient', 'patient', pid);
      return { id: pid, patientCode: code, name: name.trim(), existing: false };
    });
    ok(res, out, 201);
  }));

  app.get('/api/medicines', auth('doctor'), limiter(120), (req, res) =>
    ok(res, { items: searchMedicines(req.query.q), catalogue: CATALOGUE_INFO }));

  app.post('/api/admin/users', auth('admin'), wrap((req, res) => {
    const { email, password, name, role } = req.body || {};
    if (!['receptionist', 'doctor'].includes(role)) throw httpErr(400, 'Role must be receptionist or doctor');
    if (!nonEmpty(name, 100) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw httpErr(400, 'Valid name and email required');
    if (typeof password !== 'string' || password.length < 10) throw httpErr(400, 'Password must be at least 10 characters');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email.toLowerCase())) throw httpErr(409, 'Email already registered');
    const id = Number(db.prepare("INSERT INTO users(email,password_hash,role,name,status) VALUES(?,?,?,?, 'active')")
      .run(email.toLowerCase(), bcrypt.hashSync(password, cfg.bcryptCost ?? 12), role, name.trim()).lastInsertRowid);
    audit(req.user.id, 'admin_create_user', 'user', id, role);
    ok(res, { id }, 201);
  }));

  // ---------- care connection ----------
  app.get('/api/doctors', auth('patient', 'receptionist'), (req, res) =>
    ok(res, db.prepare("SELECT id,name FROM users WHERE role='doctor' AND status='active' ORDER BY name").all()));
  app.get('/api/care/doctors', auth('patient'), (req, res) =>
    ok(res, db.prepare("SELECT u.id,u.name,c.status,c.source FROM care_links c JOIN users u ON u.id=c.doctor_id WHERE c.patient_id=? AND c.status IN ('active','pending') ORDER BY u.name").all(patientRow(req.user.id).id)));
  // Patient-initiated connection is itself explicit consent.
  app.post('/api/care/connect', auth('patient'), (req, res) => {
    const d = db.prepare("SELECT id FROM users WHERE id=? AND role='doctor' AND status='active'").get(req.body?.doctorId);
    if (!d) return fail(res, 404, 'Doctor not found');
    const pid = patientRow(req.user.id).id;
    db.prepare("INSERT INTO care_links(doctor_id,patient_id,status,source,updated_at) VALUES(?,?, 'active','patient',?) ON CONFLICT(doctor_id,patient_id) DO UPDATE SET status='active', source='patient', updated_at=excluded.updated_at").run(d.id, pid, now().toISOString());
    audit(req.user.id, 'consent_grant', 'user', d.id);
    ok(res, { connected: true }, 201);
  });
  // Doctor-initiated: creates a PENDING request only. Same response whether or not the ID exists (no ID enumeration).
  app.post('/api/patients/link', limiter(15), auth('doctor'), (req, res) => {
    const p = db.prepare(`${PQ} WHERE p.patient_code=?`).get(String(req.body?.patientCode || '').trim().toUpperCase());
    if (p) {
      const ex = db.prepare('SELECT status FROM care_links WHERE doctor_id=? AND patient_id=?').get(req.user.id, p.id);
      if (!ex || ex.status === 'revoked') {
        db.prepare("INSERT INTO care_links(doctor_id,patient_id,status,source,updated_at) VALUES(?,?, 'pending','doctor',?) ON CONFLICT(doctor_id,patient_id) DO UPDATE SET status='pending', source='doctor', updated_at=excluded.updated_at").run(req.user.id, p.id, now().toISOString());
        db.prepare('INSERT INTO notifications(user_id,message,link) VALUES(?,?,?)').run(p.user_id, `${req.user.name} asked for access to your record`, '#/doctors');
        audit(req.user.id, 'access_request', 'patient', p.id);
      }
    }
    ok(res, { requested: true, note: 'If that Patient ID exists, the patient has been asked to approve access.' }, 202);
  });
  app.get('/api/care/requests', auth('patient'), (req, res) =>
    ok(res, db.prepare("SELECT u.id doctorId,u.name,c.created_at FROM care_links c JOIN users u ON u.id=c.doctor_id WHERE c.patient_id=? AND c.status='pending'").all(patientRow(req.user.id).id)));
  const decide = (status, action) => (req, res) => {
    const pid = patientRow(req.user.id).id;
    const r = db.prepare("UPDATE care_links SET status=?, updated_at=? WHERE doctor_id=? AND patient_id=? AND status='pending'").run(status, now().toISOString(), Number(req.params.doctorId), pid);
    if (!r.changes) return fail(res, 404, 'No pending request from that doctor');
    db.prepare('INSERT INTO notifications(user_id,message,link) VALUES(?,?,?)').run(Number(req.params.doctorId), `A patient ${status === 'active' ? 'approved' : 'declined'} your access request`, '#/patients');
    audit(req.user.id, action, 'user', req.params.doctorId); ok(res, { status });
  };
  app.post('/api/care/requests/:doctorId/approve', auth('patient'), decide('active', 'consent_grant'));
  app.post('/api/care/requests/:doctorId/decline', auth('patient'), decide('revoked', 'consent_decline'));
  app.post('/api/care/doctors/:doctorId/revoke', auth('patient'), (req, res) => {
    const r = db.prepare("UPDATE care_links SET status='revoked', updated_at=? WHERE doctor_id=? AND patient_id=? AND status IN ('active','pending')").run(now().toISOString(), Number(req.params.doctorId), patientRow(req.user.id).id);
    if (!r.changes) return fail(res, 404, 'No such connection');
    audit(req.user.id, 'consent_revoke', 'user', req.params.doctorId); ok(res, { revoked: true });
  });
  app.get('/api/doctor/stats', auth('doctor'), (req, res) => {
    const one = (sql) => db.prepare(sql).get(req.user.id).n;
    const rows = db.prepare('SELECT substr(issued_at,1,10) d, count(*) n FROM prescriptions WHERE doctor_id=? GROUP BY d').all(req.user.id);
    const perDay = [...Array(7)].map((_, i) => {
      const dt = new Date(Date.now() - (6 - i) * 864e5), key = dt.toISOString().slice(0, 10);
      return { day: dt.toLocaleDateString('en', { weekday: 'short' }), n: rows.find((r) => r.d === key)?.n || 0 };
    });
    ok(res, {
      patients: one("SELECT count(*) n FROM care_links WHERE doctor_id=? AND status='active'"),
      visits: one('SELECT count(*) n FROM visits WHERE doctor_id=?'),
      prescriptions: one('SELECT count(*) n FROM prescriptions WHERE doctor_id=?'),
      perDay,
      recent: db.prepare(`SELECT r.id, r.rx_code, r.status, u.name patient, r.issued_at FROM prescriptions r JOIN patients p ON p.id=r.patient_id
        JOIN users u ON u.id=p.user_id WHERE r.doctor_id=? ORDER BY r.id DESC LIMIT 5`).all(req.user.id)
    });
  });
  // ---------- notifications (patient dashboard live updates) ----------
  app.get('/api/notifications', auth(), (req, res) => {
    const items = db.prepare('SELECT id,message,link,is_read,created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30').all(req.user.id);
    ok(res, { unread: items.filter((i) => !i.is_read).length, items });
  });
  app.post('/api/notifications/read', auth(), (req, res) => {
    db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=? AND (? IS NULL OR link=?)').run(req.user.id, req.body?.link ?? null, req.body?.link ?? null);
    ok(res, { ok: true });
  });

  // ---------- static ----------
  app.get('/verify/:token', (req, res) => res.sendFile('verify.html', { root: cfg.publicDir }));
  app.use(express.static(cfg.publicDir));
  app.use('/api', (req, res) => fail(res, 404, 'Unknown endpoint'));
  app.use((err, req, res, next) => { console.error(err.message); fail(res, 500, 'Internal server error'); });
  return app;
}

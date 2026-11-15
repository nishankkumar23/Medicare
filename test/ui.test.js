// Drives the REAL public/app.js inside jsdom against a live test server (no browser needed).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import bcrypt from 'bcryptjs';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, base, db, w, doc;
const until = async (fn, label, ms = 4000) => { const t = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch {} if (Date.now() - t > ms) assert.fail('Timed out waiting for: ' + label + ' | hash=' + w.location.hash + ' | page=' + doc.getElementById('app').textContent.slice(0, 250).replace(/\s+/g, ' ') + ' | toasts=' + [...doc.querySelectorAll('.toast')].map((x) => x.textContent)); await sleep(25); } };
const call = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-client': 'api', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const $ = (s) => doc.querySelector(s);
const text = () => doc.getElementById('app').textContent;
const fire = (el, type, init) => el.dispatchEvent(new w[init?.key ? 'KeyboardEvent' : 'Event'](type, { bubbles: true, cancelable: true, ...init }));
const typeInto = async (el, str) => { for (const ch of str) { el.value += ch; fire(el, 'input'); await sleep(12); } };
async function signIn(email) {
  w.location.hash = '#/login';
  const f = await until(() => $('#f'), 'login form');
  f.elements.email.value = email; f.elements.password.value = 'Password!234'; fire(f, 'submit');
}

before(async () => {
  db = openDb(':memory:');
  const app = createApp(db, { jwtSecret: 'j'.repeat(32), qrSecret: 'q'.repeat(32), baseUrl: 'http://x.test', publicDir: new URL('../public', import.meta.url).pathname, rateLimit: false, bcryptCost: 4 });
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
  const h = bcrypt.hashSync('Password!234', 4);
  for (const [e, role, name] of [['rec@t.co', 'receptionist', 'Rita Reception'], ['doc@t.co', 'doctor', 'Dr Ui']]) db.prepare('INSERT INTO users(email,password_hash,role,name,status) VALUES(?,?,?,?,?)').run(e, h, role, name, 'active');
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/', pretendToBeVisual: true });
  w = dom.window; doc = w.document;
  Object.assign(globalThis, { FormData: w.FormData, document: doc, window: w, location: w.location, sessionStorage: w.sessionStorage, matchMedia: () => ({ matches: true }), requestAnimationFrame: w.requestAnimationFrame.bind(w),
    addEventListener: w.addEventListener.bind(w), prompt: () => 'test reason', confirm: () => true, print() {} });
  // Minimal browser cookie jar: httpOnly session cookie stays out of document.cookie, the CSRF cookie is readable like in a real browser.
  const realFetch = globalThis.fetch, jar = new Map();
  globalThis.fetch = async (u, o = {}) => {
    const headers = { ...(o.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    const r = await realFetch(String(u).startsWith('/') ? base + u : u, { ...o, headers });
    for (const c of r.headers.getSetCookie?.() || []) {
      const [kv, ...attrs] = c.split(';'); const [k, v] = [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)];
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v === '') { jar.delete(k); doc.cookie = `${k}=; max-age=0`; } else { jar.set(k, v); if (!/httponly/i.test(attrs.join(';'))) doc.cookie = `${k}=${v}`; }
    }
    return r;
  };
  const si = globalThis.setInterval; globalThis.setInterval = (f, ms) => { const t = si(f, ms); t.unref?.(); return t; };
  await import('../public/app.js');
});
after(() => { w.close(); server.closeAllConnections?.(); server.close(); });

test('receptionist sees the persisted queue; doctor calls next and prescribes without typing glitches', async () => {
  // setup through the API: walk-in patient with a penicillin allergy, checked in with the doctor
  const rt = (await call('/api/auth/login', { method: 'POST', body: { email: 'rec@t.co', password: 'Password!234' } })).body.token;
  const dt = (await call('/api/auth/login', { method: 'POST', body: { email: 'doc@t.co', password: 'Password!234' } })).body.token;
  const doctorId = db.prepare("SELECT id FROM users WHERE email='doc@t.co'").get().id;
  const pat = (await call('/api/reception/patients', { method: 'POST', token: rt, body: { name: 'Uma UiPatient', dob: '1995-02-02' } })).body;
  assert.equal((await call('/api/visits/checkin', { method: 'POST', token: rt, body: { patientId: pat.id, doctorId } })).status, 201);
  await call(`/api/patients/${pat.id}/allergies`, { method: 'POST', token: dt, body: { substance: 'penicillin' } });

  // receptionist UI
  await signIn('rec@t.co');
  await until(() => /Today's queue/.test(text()) && /Uma UiPatient/.test(text()) && /Q001/.test(text()), 'receptionist queue');
  assert.doesNotMatch(text(), /penicillin|diagnosis/i); // no clinical data on the reception screen
  $('#lo').click();

  // doctor UI
  await signIn('doc@t.co');
  await until(() => /Welcome, Dr Ui/.test(text()), 'doctor dashboard after login');
  w.location.hash = '#/consult';
  const next = await until(() => $('#next') && !$('#next').disabled && $('#next'), 'Call Next enabled');
  next.click();
  const nameInput = await until(() => $('#cur [data-k=name]'), 'medicine input appears');
  assert.match($('#cur').textContent, /Uma UiPatient/);
  assert.match($('#cur').textContent, /penicillin/);

  // typing: same element, nothing lost, focus kept, even after the safety panel updates
  await typeInto(nameInput, 'amoxicillin');
  await until(() => $('#alerts .alert'), 'allergy alert appears for typed text');
  await until(() => $('.cb-list li[role=option]'), 'autocomplete option');
  assert.equal($('#cur [data-k=name]'), nameInput, 'input element was recreated');
  assert.equal(nameInput.value, 'amoxicillin');
  assert.equal(doc.activeElement, nameInput, 'focus was lost');
  assert.match($('#alerts').textContent, /Allergy conflict/);
  assert.match($('#cur [data-ver]').textContent, /Unverified/); // free text is not claimed as verified
  await typeInto(nameInput, ' ');           // keep typing after the re-render window
  assert.equal(nameInput.value, 'amoxicillin ');
  nameInput.value = 'amoxicillin';

  // keyboard selection from the dropdown
  fire(nameInput, 'keydown', { key: 'ArrowDown' }); fire(nameInput, 'keydown', { key: 'Enter' });
  assert.equal(nameInput.value, 'Amoxicillin');
  assert.match($('#cur [data-ver]').textContent, /catalogue/);

  // duplicate guard + required reason before finalizing
  $('#add').click();
  const rows = doc.querySelectorAll('#rows fieldset'); assert.equal(rows.length, 2);
  const second = rows[1].querySelector('[data-k=name]'); second.value = 'amoxicillin'; fire(second, 'input');
  assert.match(rows[1].textContent, /Already added/);
  rows[1].querySelector('[data-rm]').click();
  const first = doc.querySelector('#rows fieldset');
  for (const [k, v] of [['dosage', '1 capsule'], ['frequency', 'TID'], ['duration', '5 days']]) { const i = first.querySelector(`[data-k=${k}]`); i.value = v; fire(i, 'input'); }
  $('#dx').value = 'Sinusitis';
  $('#rx').click();
  await until(() => doc.querySelector('.toast') && /acknowledgement/i.test([...doc.querySelectorAll('.toast')].map((t) => t.textContent).join()), 'server blocks without a reason');
  assert.equal(doc.querySelector('.overlay'), null);
  const ack = await until(() => $('.ack'), 'override reason field');
  ack.value = 'Allergy reviewed; benefit outweighs risk (test)'; fire(ack, 'input');
  $('#rx').click();
  await until(() => doc.querySelector('.overlay'), 'prescription saved overlay');
  doc.querySelector('#go').click();
  assert.equal(db.prepare('SELECT count(*) n FROM prescriptions').get().n, 1);
  assert.equal(db.prepare("SELECT status FROM visits WHERE patient_id=?").get(pat.id).status, 'in_consultation'); // still open

  // complete the encounter; it leaves the queue and stays in history
  $('#fin').click();
  await until(() => db.prepare('SELECT status FROM visits WHERE patient_id=?').get(pat.id).status === 'completed', 'encounter completed in DB');
  await until(() => /Uma UiPatient/.test($('#done').textContent), 'completed list updated');
  assert.equal(db.prepare('SELECT diagnosis FROM visits WHERE patient_id=?').get(pat.id).diagnosis, 'Sinusitis');
});

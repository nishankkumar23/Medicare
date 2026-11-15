import { attachCombobox } from './combobox.js';
const $ = (s, r = document) => r.querySelector(s), app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let session = null, unread = 0, newLinks = new Set(), notePoll, timers = [], cfg = { today: new Date().toISOString().slice(0, 10), timezone: 'UTC' };
const reduce = matchMedia('(prefers-reduced-motion:reduce)').matches;
const toast = (m) => { const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: m, role: 'status' }); document.body.append(t); setTimeout(() => t.remove(), 4000); };
async function api(path, method = 'GET', body) {
  let r;
  // The session lives in an httpOnly cookie (never readable by JS). State-changing calls echo the CSRF cookie in a header.
  const csrf = decodeURIComponent((document.cookie.match(/(?:^|;\s*)mc_csrf=([^;]*)/) || [])[1] || '');
  try { r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(csrf && { 'x-csrf-token': csrf }) }, body: body && JSON.stringify(body) }); }
  catch { toast('Network error. Please retry.'); throw new Error('network'); }
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && session) logout();
  if (!r.ok) { const e = new Error(d.error || 'Request failed'); e.status = r.status; e.data = d; throw e; }
  return d;
}
const logout = () => { api('/auth/logout', 'POST').catch(() => {}); session = null; clearInterval(notePoll); location.hash = '#/login'; shell(); };
document.addEventListener('click', (e) => { if (e.target.closest?.('[data-print]')) print(); }); // no inline handlers (CSP)
const every = (fn, ms) => timers.push(setInterval(() => document.hidden || fn().catch(() => {}), ms));
const stopTimers = () => { timers.forEach(clearInterval); timers = []; };
const show = (html) => {
  app.innerHTML = `<div class="page">${html}</div>`;
  app.querySelectorAll('[data-count]').forEach((el) => {
    const to = +el.dataset.count; if (reduce) { el.textContent = to; return; }
    let s; const f = (t) => { s ??= t; const p = Math.min((t - s) / 700, 1); el.textContent = Math.round(to * (1 - (1 - p) ** 3)); if (p < 1) requestAnimationFrame(f); }; requestAnimationFrame(f);
  });
};
const skeleton = () => (app.innerHTML = '<div class="skel"></div><div class="skel"></div>');
const stat = (n, l, i = 0) => `<div class="card stat sm flat" style="--i:${i}"><h3 data-count="${n ?? 0}">0</h3>${l}</div>`;
const statTxt = (v, l) => `<div class="card stat sm flat"><h3>${v ?? '—'}</h3>${l}</div>`;
const fmtT = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const mins = (m) => (m == null ? '—' : m < 1 ? '<1 min' : `${Math.round(m)} min`);
const waitNow = (r) => (r.checkin_at ? (Date.now() - new Date(r.checkin_at)) / 60000 : null);
const badge = (s) => `<span class="badge ${s}">${s.replace('_', ' ')}</span>`;
const shiftDay = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

const NAV = {
  doctor: [['dashboard', '📊 Dashboard'], ['consult', '🩺 Consultation'], ['patients', '👥 Patients'], ['reports', '🗓 Reports'], ['history', '💊 Prescriptions'], ['profile', '👤 Profile']],
  receptionist: [['queue', '🧾 Queue'], ['register', '➕ Register patient'], ['reports', '🗓 Reports'], ['profile', '👤 Profile']],
  patient: [['overview', '🏠 Overview'], ['doctors', '🩺 My Doctors'], ['prescriptions', '💊 Prescriptions'], ['timeline', '🕒 Timeline'], ['profile', '👤 Profile']],
  admin: [['admin', '🔐 Accounts'], ['audit', '📜 Audit Log'], ['profile', '👤 Profile']]
};
const HOME = { doctor: '#/dashboard', receptionist: '#/queue', patient: '#/overview', admin: '#/admin' };
function shell() {
  $('#shell').className = session ? '' : 'public';
  const page = location.hash.split('/')[1] || '';
  $('#side').innerHTML = session ? `<a class="logo" href="${HOME[session.user.role]}" style="text-decoration:none;display:flex"><i>+</i> MediCare EHR</a>` +
    NAV[session.user.role].map(([h, l]) => `<a href="#/${h}" class="${page === h ? 'on' : ''}">${l}</a>`).join('') : '';
  const bell = session?.user.role === 'patient' ? `<button class="bell" id="bell" aria-label="Notifications, ${unread} unread">🔔${unread ? `<span class="dot">${unread}</span>` : ''}</button>` : '';
  $('#top').innerHTML = session ? `<span class="note">Clinic timezone: ${esc(cfg.timezone)} · ${esc(cfg.today)}</span><span>${bell}<span class="role">${esc(session.user.role)}</span><a href="#/profile"><b>${esc(session.user.name)}</b></a> <button class="btn alt sm" id="lo">Sign out</button></span>`
    : `<a class="logo" href="#/" style="text-decoration:none;color:inherit"><i>+</i>MediCare EHR</a><span><a href="#/login">Sign In</a></span>`;
  $('#lo')?.addEventListener('click', logout); $('#bell')?.addEventListener('click', () => (location.hash = '#/notifications'));
}
async function pollNotes() {
  if (session?.user.role !== 'patient') return;
  const n = await api('/notifications'); const fresh = n.unread > unread;
  newLinks = new Set(n.items.filter((i) => !i.is_read).map((i) => i.link)); unread = n.unread; shell();
  if (fresh) { toast('🔔 ' + n.items[0].message); $('#bell')?.classList.add('ring'); if (location.hash === '#/overview') route(true); }
}

const rxTable = (rows) => rows.length ? `<table><tr><th>ID</th><th>Diagnosis</th><th>Issued</th><th>Status</th><th></th></tr>${rows.map((r) => `<tr><td>${esc(r.rx_code)} ${newLinks.has('#/rx/' + r.id) ? '<span class="badge new">NEW</span>' : ''}</td><td>${esc(r.diagnosis)}</td><td>${esc(r.issued_at.slice(0, 10))}</td><td><span class="badge ${r.status}">${r.status}</span></td><td><a href="#/rx/${r.id}">Open</a></td></tr>`).join('')}</table>` : '<p>No prescriptions yet.</p>';
const timeline = (tl, doctorView) => tl.length ? tl.map((v, i) => `<div class="card flat" style="--i:${i}"><b>${esc(v.visit_date)}</b> ${v.queue_number ? 'Q' + String(v.queue_number).padStart(3, '0') : ''} · ${esc(v.doctor)}<br>Diagnosis: ${esc(v.diagnosis)}${doctorView && v.notes ? `<br><span class="note">Notes: ${esc(v.notes)}</span>` : ''}<br>${v.prescriptions.map((r) => `<a href="#/rx/${r.id}">${esc(r.rx_code)}</a>`).join(' ')} <a href="#/encounter/${v.id}">Open encounter</a></div>`).join('') : '<div class="card flat">No completed encounters yet.</div>';

const publicViews = {
  '': () => `<section class="hero"><span class="blob b1"></span><span class="blob b2"></span><h1>Smarter Healthcare. Safer Prescriptions.</h1>
    <p>Reception queue, doctor consultations, patient charts and prescription safety checks in one connected system.</p>
    <svg class="ecg" viewBox="0 0 520 60"><path d="M0 30H150L170 8L195 52L215 30H330L350 12L372 48L392 30H520"/></svg>
    <a class="btn" href="#/login">Get Started</a> <a class="btn alt" href="#/register">Register as patient</a></section>
    <div class="grid">${[['First come, first served', 'A real persisted queue with numbered visits per clinic day.'], ['Prescription Safety', 'Allergy and interaction rules shown while prescribing.'], ['QR Verification', 'Server-validated codes with no medical data inside.'], ['Role-based Access', 'Receptionists run the queue without seeing clinical records.']].map(([t, d], i) => `<div class="card" style="--i:${i}"><h3>${t}</h3><p>${d}</p></div>`).join('')}</div>
    <p class="note">Prototype for academic demonstration. Not certified for HIPAA/ABDM compliance. Fictional data only.</p>`,
  login: () => `<div class="card" style="max-width:420px;margin:auto"><h2>Sign in</h2><form id="f"><label>Email<input name="email" type="email" required autocomplete="username"></label>
    <label>Password<input name="password" type="password" required autocomplete="current-password"></label><button class="btn">Sign in</button> <a href="#/register" style="margin-left:12px">Register</a></form></div>`,
  register: () => `<div class="card" style="max-width:420px;margin:auto"><h2>Create account</h2><form id="f"><label>I am a<select name="role"><option value="patient">Patient</option><option value="doctor">Doctor (needs admin approval)</option></select></label>
    <label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Date of birth (patients)<input name="dob" type="date"></label>
    <label>Password (10+ characters)<input name="password" type="password" minlength="10" required></label><button class="btn">Create account</button></form><p class="note">Receptionist accounts are created by an administrator.</p></div>`
};

async function route(quiet) {
  const [, page = '', arg] = location.hash.split('/');
  stopTimers(); shell();
  if (publicViews[page] !== undefined && !(session && ['login', 'register'].includes(page))) { show(publicViews[page]()); bindForms(page); return; }
  if (!session) { location.hash = '#/login'; return; }
  const role = session.user.role; if (!quiet) skeleton();
  try {
    if (page === 'rx') return await rxView(arg);
    if (page === 'profile') return await profileView();
    if (page === 'notifications') return await notesView();
    if (page === 'encounter') return await encounterView(arg);
    if (page === 'reports' && ['doctor', 'receptionist'].includes(role)) return await reportsView();
    if (role === 'doctor') {
      if (page === 'history') return show(`<h2>Prescription History</h2><div class="card flat">${rxTable(await api('/prescriptions'))}</div>`);
      if (page === 'patients') return await patientsView();
      if (page === 'patient') return await chartView(arg);
      if (page === 'consult') return await consultView();
      return await doctorDash();
    }
    if (role === 'receptionist') return page === 'register' ? await registerView() : await queueView();
    if (role === 'patient') {
      const me = await api('/me');
      if (page === 'doctors') return await doctorsView();
      if (page === 'prescriptions') return show(`<h2>My Prescriptions</h2><div class="card flat">${rxTable(await api('/prescriptions'))}</div>`);
      if (page === 'timeline') return show(`<h2>Health Timeline</h2>${timeline(await api(`/patients/${me.patientId}/timeline`))}`);
      return await patientOverview(me);
    }
    if (page === 'audit') { const a = await api('/admin/audit'); return show(`<h2>Audit Log</h2><div class="card flat"><table><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Detail</th></tr>${a.map((x) => `<tr><td>${esc(x.created_at)}</td><td>${x.user_id}</td><td>${esc(x.action)}</td><td>${esc(x.entity)} ${esc(x.entity_id)}</td><td>${esc(x.detail)}</td></tr>`).join('')}</table></div>`); }
    return await adminView();
  } catch (e) { if (e.message !== 'network') show(`<div class="card alert" role="alert">${esc(e.message)}</div>`); }
}
function bindForms(page) {
  $('#f')?.addEventListener('submit', async (e) => {
    e.preventDefault(); const b = Object.fromEntries(new FormData(e.target));
    try {
      if (page === 'register') { const r = await api('/auth/register', 'POST', b); toast(r.status === 'pending' ? 'Registered. Wait for admin approval.' : 'Registered. Please sign in.'); location.hash = '#/login'; return; }
      session = await api('/auth/login', 'POST', b);
      clearInterval(notePoll); notePoll = setInterval(() => document.hidden || pollNotes().catch(() => {}), 6000); pollNotes().catch(() => {});
      location.hash = HOME[session.user.role];
    } catch (err) { toast(err.message); }
  });
}

// ---------------- shared queue rendering ----------------
function queueRows(rows, mode) {
  if (!rows.length) return '<p class="note">No visits in this queue.</p>';
  return `<table><tr><th>Queue</th><th>Patient</th><th>ID</th>${mode === 'reception' ? '<th>Doctor</th>' : ''}<th>Check-in</th><th>Waiting</th><th>Status</th><th></th></tr>${rows.map((r) => {
    const act = mode === 'reception'
      ? (r.status === 'waiting' ? `<button class="btn alt sm" data-act="skipped" data-id="${r.id}">Skip</button> <button class="btn alt sm" data-act="cancelled" data-id="${r.id}">Cancel</button> <button class="btn alt sm" data-act="reassign" data-id="${r.id}">Reassign</button>`
        : r.status === 'skipped' ? `<button class="btn alt sm" data-act="waiting" data-id="${r.id}">Requeue</button> <button class="btn alt sm" data-act="cancelled" data-id="${r.id}">Cancel</button>` : '')
      : (r.status === 'waiting' ? `<a class="btn alt sm" href="#/patient/${r.patient_id}">Open chart</a> <button class="btn alt sm" data-act="skipped" data-id="${r.id}">Skip</button>` : '');
    return `<tr><td><b>${r.queueLabel}</b></td><td>${esc(r.patient)}</td><td>${esc(r.patient_code)}</td>${mode === 'reception' ? `<td>${esc(r.doctor)}</td>` : ''}<td>${fmtT(r.checkin_at)}</td>
      <td>${r.status === 'waiting' ? mins(waitNow(r)) : r.start_at ? mins((new Date(r.start_at) - new Date(r.checkin_at)) / 60000) : '—'}</td><td>${badge(r.status)}${r.reason ? `<br><span class="note">${esc(r.reason)}</span>` : ''}</td><td>${act}</td></tr>`;
  }).join('')}</table>`;
}
async function statusAction(act, id) {
  if (act === 'reassign') {
    const docs = await api('/doctors'); const pick = prompt('Reassign to which doctor?\n' + docs.map((d, i) => `${i + 1}. ${d.name}`).join('\n')); const d = docs[Number(pick) - 1]; if (!d) return;
    const reason = prompt('Reason for reassignment?'); if (!reason) return;
    return api(`/visits/${id}/reassign`, 'POST', { doctorId: d.id, reason });
  }
  let reason; if (['skipped', 'cancelled'].includes(act)) { reason = prompt(`Reason for ${act === 'skipped' ? 'skipping' : 'cancelling'} this visit? (required)`); if (!reason?.trim()) return; }
  return api(`/visits/${id}/status`, 'PATCH', { status: act, reason });
}
const bindActions = (el, after) => el.addEventListener('click', async (e) => { const b = e.target.closest('[data-act]'); if (!b) return; try { await statusAction(b.dataset.act, b.dataset.id); toast('Queue updated'); after(); } catch (err) { if (err.message !== 'network') toast(err.message); } });

// ---------------- receptionist ----------------
async function queueView() {
  const docs = await api('/doctors'); let sel = null, last = '';
  show(`<h2>Today's queue</h2><div id="st" class="grid"></div>
    <div class="card flat"><h3>Check in a patient</h3><div class="row"><label style="position:relative">Find patient (name or ID)<input id="q" autocomplete="off"></label>
    <label>Doctor<select id="doc">${docs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label><button class="btn" id="ci" disabled>Check in</button></div>
    <div id="res"></div><p id="sel" class="note">No patient selected. <a href="#/register">Register a new patient</a></p></div>
    <div class="card flat" id="qt"></div>`);
  const refresh = async () => {
    const [qd, rp] = await Promise.all([api('/queue'), api('/reports/daily')]); const sig = JSON.stringify([qd.rows, rp.stats]);
    last = sig;
    const s = rp.stats;
    $('#st').innerHTML = stat(s.total, 'Registered today') + stat(s.waiting, 'Waiting') + stat(s.in_consultation, 'In consultation') + stat(s.completed, 'Completed') + statTxt(mins(s.avgWaitMin), 'Avg wait');
    $('#qt').innerHTML = queueRows(qd.rows, 'reception');
  };
  await refresh(); every(refresh, 5000); bindActions($('#qt'), refresh);
  let t; $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(async () => { const v = e.target.value.trim(); if (v.length < 2) { $('#res').innerHTML = ''; return; } const r = await api('/reception/patients?q=' + encodeURIComponent(v)); $('#res').innerHTML = r.map((p) => `<button class="btn alt sm" data-p='${esc(JSON.stringify(p))}' style="margin:3px">${esc(p.name)} · ${esc(p.patientCode)}${p.dob ? ' · ' + esc(p.dob) : ''}</button>`).join('') || '<p class="note">No match. Register a new patient.</p>'; }, 250); };
  $('#res').onclick = (e) => { const b = e.target.closest('[data-p]'); if (!b) return; sel = JSON.parse(b.dataset.p); $('#sel').textContent = `Selected: ${sel.name} (${sel.patientCode})`; $('#ci').disabled = false; };
  $('#ci').onclick = async () => { try { const r = await api('/visits/checkin', 'POST', { patientId: sel.id, doctorId: +$('#doc').value }); toast(`${sel.name} checked in as ${r.queueLabel}`); sel = null; $('#ci').disabled = true; $('#sel').textContent = 'No patient selected.'; $('#q').value = ''; $('#res').innerHTML = ''; refresh(); } catch (err) { if (err.message !== 'network') toast(err.message); } };
}
async function registerView() {
  show(`<h2>Register patient</h2><form class="card flat" id="rf"><div class="row"><label>Full name<input name="name" required></label><label>Date of birth<input type="date" name="dob"></label></div>
    <div class="row"><label>Phone<input name="phone"></label><label>Email (optional)<input type="email" name="email"></label></div><button class="btn">Register</button>
    <p class="note">Existing patients are matched by ID or email so no duplicate record is created.</p></form><div id="out"></div>`);
  const send = async (extra = {}) => {
    const b = { ...Object.fromEntries(new FormData($('#rf'))), ...extra };
    try {
      const r = await api('/reception/patients', 'POST', b);
      $('#out').innerHTML = `<div class="card flat"><b>${r.existing ? 'Existing patient found' : 'Patient registered'}:</b> ${esc(r.name)} · <b>${esc(r.patientCode)}</b><br><a class="btn sm" href="#/queue">Go to queue to check in</a></div>`;
    } catch (err) {
      if (err.status === 409 && err.data.candidate) { const c = err.data.candidate; $('#out').innerHTML = `<div class="card alert" role="alert">${esc(err.data.error)}: <b>${esc(c.name)}</b> (${esc(c.patientCode)})<br><button class="btn sm" id="use">Use existing</button> <button class="btn alt sm" id="mk">Create new anyway</button></div>`; $('#use').onclick = () => send({ patientCode: c.patientCode }); $('#mk').onclick = () => send({ confirmNew: true }); }
      else if (err.message !== 'network') toast(err.message);
    }
  };
  $('#rf').onsubmit = (e) => { e.preventDefault(); send(); };
}

// ---------------- reports (doctor + receptionist) ----------------
async function reportsView() {
  const isDoc = session.user.role === 'doctor'; let date = cfg.today, last = '';
  const docs = isDoc ? [] : await api('/doctors');
  show(`<h2>Daily reports / visit history</h2><div class="card flat"><div class="row"><button class="btn alt sm" id="pd">← Previous day</button><label>Date<input type="date" id="dt" value="${date}"></label><button class="btn alt sm" id="nd">Next day →</button>
    ${isDoc ? '' : `<label>Doctor<select id="fd"><option value="">All</option>${docs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label>`}
    <label>Status<select id="fs"><option value="">All</option>${['waiting', 'in_consultation', 'completed', 'cancelled', 'skipped'].map((s) => `<option>${s}</option>`).join('')}</select></label>
    <label>Patient name / ID<input id="fq"></label></div></div><div id="st" class="grid"></div><div class="card flat" id="tb"></div>`);
  const load = async () => {
    const qs = new URLSearchParams({ date, status: $('#fs').value, q: $('#fq').value, ...($('#fd')?.value && { doctorId: $('#fd').value }) });
    const r = await api('/reports/daily?' + qs); const sig = JSON.stringify(r); if (sig === last) return; last = sig; const s = r.stats;
    $('#st').innerHTML = stat(s.total, 'Total visits') + stat(s.completed, 'Completed') + stat(s.waiting, 'Waiting') + stat(s.in_consultation, 'In consultation') + stat(s.cancelled, 'Cancelled') + stat(s.skipped, 'Skipped') + statTxt(mins(s.avgWaitMin), 'Avg waiting') + statTxt(mins(s.avgConsultMin), 'Avg consultation');
    $('#tb').innerHTML = r.rows.length ? `<table><tr><th>Queue</th><th>Patient</th><th>ID</th><th>Doctor</th><th>Check-in</th><th>Started</th><th>Completed</th><th>Waiting</th><th>Consult</th><th>Status</th><th></th></tr>${r.rows.map((v) => `<tr><td>${v.queueLabel || '—'}</td><td>${esc(v.patient)}</td><td>${esc(v.patient_code)}</td><td>${esc(v.doctor)}</td><td>${fmtT(v.checkin_at)}</td><td>${fmtT(v.start_at)}</td><td>${fmtT(v.end_at)}</td><td>${mins(v.waitMin)}</td><td>${mins(v.consultMin)}</td><td>${badge(v.status)}</td><td>${r.canOpen && v.status !== 'waiting' ? `<a href="#/encounter/${v.id}">Open</a>` : ''}</td></tr>`).join('')}</table>` : '<p>No visits match for this date.</p>';
  };
  const go = (d) => { date = d; $('#dt').value = d; last = ''; load(); };
  $('#pd').onclick = () => go(shiftDay(date, -1)); $('#nd').onclick = () => go(shiftDay(date, 1)); $('#dt').onchange = (e) => e.target.value && go(e.target.value);
  ['#fs', '#fd'].forEach((s) => $(s)?.addEventListener('change', () => { last = ''; load(); })); let t; $('#fq').oninput = () => { clearTimeout(t); t = setTimeout(() => { last = ''; load(); }, 300); };
  await load(); every(load, 8000);
}

// ---------------- doctor ----------------
async function doctorDash() {
  const [s, rp, q] = await Promise.all([api('/doctor/stats'), api('/reports/daily'), api('/queue')]), max = Math.max(1, ...s.perDay.map((d) => d.n));
  show(`<h2>Welcome, ${esc(session.user.name)}</h2><div class="grid">${stat(rp.stats.waiting, 'Waiting now')}${stat(rp.stats.completed, 'Completed today')}${stat(s.patients, 'Connected patients')}${stat(s.prescriptions, 'Prescriptions issued')}${statTxt(mins(rp.stats.avgWaitMin), 'Avg wait today')}</div>
    <div class="card flat"><div class="row"><h3 style="flex:1">Next in queue</h3><a class="btn" href="#/consult">Open consultation workspace</a></div>${queueRows(q.rows.filter((r) => r.status === 'waiting').slice(0, 5), 'doctor')}</div>
    <div class="card flat"><h3>Prescriptions, last 7 days</h3><div class="bars">${s.perDay.map((d, i) => `<div class="bar" title="${d.n} on ${d.day}"><b>${d.n}</b><i style="--h:${d.n / max * 100}%;--i:${i}"></i><small>${d.day}</small></div>`).join('')}</div></div>`);
}
async function patientsView() {
  const list = await api('/patients');
  show(`<h2>My Patients</h2><div class="card flat"><form id="lk"><label>Add a patient by their Patient ID<input name="patientCode" placeholder="e.g. PT-DEMO02" required></label><button class="btn">Connect patient</button></form></div>
    <input id="q" placeholder="Search my patients by name or ID" aria-label="Search patients"><div class="grid" id="pl">${patCards(list)}</div>`);
  $('#lk').onsubmit = async (e) => { e.preventDefault(); try { const p = await api('/patients/link', 'POST', Object.fromEntries(new FormData(e.target))); toast(p.note); e.target.reset(); } catch (err) { toast(err.message); } };
  let t; $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(async () => { $('#pl').innerHTML = patCards(await api('/patients?q=' + encodeURIComponent(e.target.value))); }, 250); };
}
const patCards = (l) => l.length ? l.map((p, i) => `<a class="card" style="--i:${i};text-decoration:none;color:inherit" href="#/patient/${p.id}"><h3>${esc(p.name)}</h3>${esc(p.patientCode)}</a>`).join('') : '<p>No connected patients found.</p>';

async function chartView(id, tab = 'Demographics') {
  const [p, tl, rx] = await Promise.all([api('/patients/' + id), api(`/patients/${id}/timeline`), api('/prescriptions?patientId=' + id)]);
  const TABS = ['Demographics', 'Allergies', 'Encounters', 'Prescriptions', 'Notes', 'Timeline'];
  const body = {
    Demographics: () => `<table><tr><th>Name</th><td>${esc(p.name)}</td></tr><tr><th>Patient ID</th><td>${esc(p.patientCode)}</td></tr><tr><th>Date of birth</th><td>${esc(p.dob) || '—'}</td></tr></table>`,
    Allergies: () => `${p.allergies.map((a) => `<span class="chip">${esc(a)}</span>`).join('') || 'None recorded'}<form id="al" style="margin-top:10px" class="row"><input name="substance" placeholder="Add allergy, e.g. penicillin" required><button class="btn alt">Add allergy</button></form>`,
    Encounters: () => timeline(tl, true), Prescriptions: () => rxTable(rx),
    Notes: () => tl.filter((v) => v.notes).map((v) => `<div class="card flat"><b>${esc(v.visit_date)}</b> · ${esc(v.doctor)}<br>${esc(v.notes)}</div>`).join('') || '<p>No consultation notes yet.</p>',
    Timeline: () => `<table><tr><th>Date</th><th>Event</th></tr>${[...tl.map((v) => [v.visit_date, `Encounter: ${esc(v.diagnosis)}`]), ...rx.map((r) => [r.issued_at.slice(0, 10), `Prescription ${esc(r.rx_code)} (${r.status})`])].sort((a, b) => b[0].localeCompare(a[0])).map(([d, t]) => `<tr><td>${d}</td><td>${t}</td></tr>`).join('') || '<tr><td colspan=2>No history</td></tr>'}</table>`
  };
  show(`<div class="card flat"><div class="row"><div><h2>${esc(p.name)}</h2>${esc(p.patientCode)}${p.dob ? ' · DOB ' + esc(p.dob) : ''} · Allergies: <b>${p.allergies.map(esc).join(', ') || 'none recorded'}</b></div><a class="btn" href="#/consult">Consultation workspace</a></div></div>
    <div class="tabbar" role="tablist">${TABS.map((t) => `<button role="tab" class="${t === tab ? 'on' : ''}" data-t="${t}">${t}</button>`).join('')}</div><div class="card flat">${body[tab]()}</div>`);
  app.querySelector('.tabbar').onclick = (e) => e.target.dataset.t && chartView(id, e.target.dataset.t);
  $('#al')?.addEventListener('submit', async (e) => { e.preventDefault(); try { await api(`/patients/${id}/allergies`, 'POST', Object.fromEntries(new FormData(e.target))); toast('Allergy recorded'); chartView(id, 'Allergies'); } catch (err) { toast(err.message); } });
}
async function encounterView(id) {
  const v = await api('/visits/' + id), doc = session.user.role === 'doctor';
  show(`<div class="card flat"><h2>Encounter ${v.queueLabel || ''} · ${esc(v.queue_date)}</h2>${badge(v.status)}<p>Patient: <b>${esc(v.patient)}</b> (${esc(v.patient_code)}) · Doctor: ${esc(v.doctor)}<br>Check-in ${fmtT(v.checkin_at)} · Started ${fmtT(v.start_at)} · Completed ${fmtT(v.end_at)}</p>
    <p><b>Diagnosis:</b> ${esc(v.diagnosis) || '—'}</p>${doc ? `<p><b>Consultation notes:</b> ${esc(v.notes) || '—'}</p>` : ''}
    <h3>Prescriptions</h3>${v.prescriptions.map((r) => `<a href="#/rx/${r.id}">${esc(r.rx_code)}</a> ${badge(r.status === 'active' ? 'completed' : 'cancelled')}`).join('<br>') || 'None issued in this encounter.'}</div>`);
}

// ---------------- doctor consultation workspace ----------------
async function consultView() {
  show(`<h2>Consultation</h2><div class="card flat"><div class="row"><h3 style="flex:1">A. Waiting queue</h3><button class="btn next" id="next">Call Next Patient</button></div><div id="wq"></div></div>
    <div id="cur"></div><div class="card flat"><h3>C. Completed today</h3><div id="done"></div></div>`);
  let last = '', curId = null;
  const refresh = async () => {
    const { rows } = await api('/queue'); const sig = JSON.stringify(rows); if (sig === last) return; last = sig;
    const waiting = rows.filter((r) => r.status === 'waiting'), cur = rows.find((r) => r.status === 'in_consultation');
    $('#wq').innerHTML = queueRows(waiting.concat(rows.filter((r) => r.status === 'skipped')), 'doctor');
    $('#next').disabled = !!cur || !waiting.length; $('#next').title = cur ? 'Finish the current consultation first' : waiting.length ? '' : 'No patients waiting';
    $('#done').innerHTML = rows.filter((r) => r.status === 'completed').length ? `<table><tr><th>Queue</th><th>Patient</th><th>Started</th><th>Completed</th><th></th></tr>${rows.filter((r) => r.status === 'completed').map((r) => `<tr><td>${r.queueLabel}</td><td>${esc(r.patient)}</td><td>${fmtT(r.start_at)}</td><td>${fmtT(r.end_at)}</td><td><a href="#/encounter/${r.id}">Open</a></td></tr>`).join('')}</table>` : '<p class="note">No completed consultations yet today.</p>';
    if ((cur?.id ?? null) !== curId) { curId = cur?.id ?? null; cur ? await buildConsultation(cur, refresh) : ($('#cur').innerHTML = '<div class="card flat"><h3>B. Current consultation</h3><p class="note">No active consultation. Call the next patient to begin.</p></div>'); }
  };
  await refresh(); every(refresh, 4000); bindActions($('#wq'), () => { last = ''; refresh(); });
  $('#next').onclick = async () => { try { await api('/queue/next', 'POST'); last = ''; await refresh(); toast('Patient called'); } catch (err) { if (err.message !== 'network') toast(err.message); last = ''; refresh(); } };
}

/** The editor is built ONCE per consultation. Medicine rows are appended/removed as DOM nodes and the
 *  safety panel is the only region that re-renders, so typing is never interrupted. */
async function buildConsultation(visit, onDone) {
  const [p, tl] = await Promise.all([api('/patients/' + visit.patient_id), api(`/patients/${visit.patient_id}/timeline`)]);
  const enc = await api('/visits/' + visit.id);
  const FIELDS = [['strength', 'Strength'], ['dosage', 'Dosage'], ['frequency', 'Frequency'], ['duration', 'Duration'], ['route', 'Route'], ['instructions', 'Instructions']];
  const meds = [], acks = {}; let alertSig = '', timer, issued = [];
  const box = $('#cur');
  box.innerHTML = `<div class="card flat banner"><h3>B. Current consultation · ${visit.queueLabel}</h3><b>${esc(p.name)}</b> · ${esc(p.patientCode)}${p.dob ? ' · DOB ' + esc(p.dob) : ''} · Started ${fmtT(visit.start_at)}<br>Allergies: <b>${p.allergies.map(esc).join(', ') || 'none recorded'}</b></div>
    <div class="two"><div class="card flat"><h3>Previous encounters</h3>${tl.slice(0, 3).map((v) => `<p><b>${esc(v.visit_date)}</b> ${esc(v.doctor)}: ${esc(v.diagnosis)} <a href="#/encounter/${v.id}">open</a></p>`).join('') || '<p class="note">None.</p>'}</div>
    <div class="card flat"><label>Diagnosis / clinical assessment<input id="dx" value="${esc(enc.diagnosis)}"></label><label>Consultation notes<textarea id="nt" rows="4">${esc(enc.notes)}</textarea></label><button class="btn alt sm" id="sv">Save progress</button></div></div>
    <div class="card flat"><h3>Prescription</h3><div id="rows"></div><button class="btn alt sm" id="add">+ Add medicine</button>
    <div id="alerts" role="alert" aria-live="assertive"></div><div class="row" style="margin-top:12px"><button class="btn" id="rx">Finalize prescription</button><button class="btn bad" id="fin">Complete encounter</button></div><div id="issued" class="note"></div></div>`;
  const dxEl = $('#dx', box), rowsEl = $('#rows', box);

  function addRow() {
    const m = { verified: false }; meds.push(m);
    const row = document.createElement('fieldset'); row.className = 'card flat'; row._m = m;
    row.innerHTML = `<legend>Medicine</legend><div class="grid"><label>Medicine (type to search)<input data-k="name" required placeholder="e.g. Amox…"></label>${FIELDS.map(([k, l]) => `<label>${l}<input data-k="${k}"></label>`).join('')}</div><span class="hint" data-hint></span> <span class="note" data-ver></span> <button type="button" class="btn alt sm" data-rm>Remove</button>`;
    rowsEl.append(row);
    const nameEl = $('[data-k=name]', row), hint = $('[data-hint]', row), ver = $('[data-ver]', row);
    row.addEventListener('input', (e) => { const k = e.target.dataset.k; if (!k) return; m[k] = e.target.value; if (k === 'name') { m.verified = false; ver.textContent = e.target.value.trim() ? '⚠ Unverified (not selected from catalogue)' : ''; dupCheck(); queueCheck(); } });
    attachCombobox(nameEl, {
      search: async (q) => (await api('/medicines?q=' + encodeURIComponent(q))).items,
      onSelect: (it) => { m.name = it.name; m.verified = true; ver.textContent = '✔ From catalogue (name only; no dose suggested)'; dupCheck(); queueCheck(); $('[data-k=dosage]', row).focus(); }
    });
    $('[data-rm]', row).onclick = () => { meds.splice(meds.indexOf(m), 1); row.remove(); if (!meds.length) addRow(); dupCheck(); queueCheck(); };
    function dupCheck() { const d = meds.filter((x) => x !== m && x.name && m.name && x.name.trim().toLowerCase() === m.name.trim().toLowerCase()).length > 0; nameEl.classList.toggle('dupe', d); hint.textContent = d ? 'Already added to this prescription' : ''; }
    nameEl.focus();
  }
  const named = () => meds.filter((m) => m.name?.trim());
  const queueCheck = () => { clearTimeout(timer); timer = setTimeout(check, 400); };
  async function check() {
    if (!named().length) { $('#alerts', box).innerHTML = ''; alertSig = ''; return; }
    try {
      const s = await api('/safety/check', 'POST', { patientId: p.id, medicines: named() });
      const sig = JSON.stringify([s.alerts, s.notCovered, s.unverified]); if (sig === alertSig) return; alertSig = sig; // no re-render (and no lost input) unless something changed
      $('#alerts', box).innerHTML = s.alerts.map((a, i) => { const key = a.type + a.medicines.join('+'); return `<div class="alert ${a.severity === 'moderate' ? 'moderate' : ''}"><b>${a.type === 'allergy' ? 'Allergy conflict' : 'Interaction'} · ${esc(a.severity)}</b><br>${esc(a.medicines.join(' + '))}: ${esc(a.message)}${a.severity !== 'moderate' ? `<br><label>Clinical reason to proceed<input class="ack" data-key="${esc(key)}" value="${esc(acks[key] || '')}" placeholder="Required to override"></label>` : ''}</div>`; }).join('')
        + `<div class="card flat note">${esc(s.summary)}${s.notCovered.length ? ` Not covered by the rule set: ${s.notCovered.map(esc).join(', ')}.` : ''}${s.unverified.length ? ` Unverified medicine names: ${s.unverified.map(esc).join(', ')}.` : ''}<br>${esc(s.dataset.limitation)} ${esc(s.catalogue.limitation)}</div>`;
    } catch (e) { if (e.message !== 'network') toast(e.message); }
  }
  $('#alerts', box).addEventListener('input', (e) => { if (e.target.dataset.key) acks[e.target.dataset.key] = e.target.value; });
  $('#add', box).onclick = addRow;
  $('#sv', box).onclick = async () => { try { await api(`/visits/${visit.id}/notes`, 'PUT', { diagnosis: dxEl.value, notes: $('#nt', box).value }); toast('Progress saved ✔'); } catch (e) { toast(e.message); } };
  $('#rx', box).onclick = async () => {
    const list = named(); if (!list.length) return toast('Add at least one medicine');
    const names = list.map((m) => m.name.trim().toLowerCase()); if (new Set(names).size !== names.length) return toast('Remove the duplicate medicine first');
    const reasons = [...box.querySelectorAll('.ack')].map((i) => ({ reason: i.value }));
    try {
      const r = await api('/prescriptions', 'POST', { patientId: p.id, visitId: visit.id, diagnosis: dxEl.value, medicines: list.map(({ verified, ...m }) => m), acknowledgements: reasons.length && reasons.every((x) => x.reason.trim()) ? reasons : [] });
      issued.push(r); $('#issued', box).innerHTML = 'Issued in this consultation: ' + issued.map((x) => `<a href="#/rx/${x.id}">${esc(x.rxCode)}</a>`).join(', ');
      const o = document.createElement('div'); o.className = 'overlay';
      o.innerHTML = `<div class="card flat"><svg class="tick" viewBox="0 0 72 72"><circle cx="36" cy="36" r="30"/><path d="M22 37l10 10 18-20"/></svg><h2>Prescription saved</h2><p>${esc(r.rxCode)} was sent to <b>${esc(p.name)}</b>'s dashboard.</p><img src="${r.qr}" alt="QR" width="130" height="130"><br><button class="btn" id="go">Continue consultation</button></div>`;
      document.body.append(o); o.querySelector('#go').onclick = () => o.remove();
      rowsEl.replaceChildren(); meds.length = 0; alertSig = ''; $('#alerts', box).innerHTML = ''; addRow();
    } catch (err) { if (err.data?.safety) { alertSig = ''; check(); } if (err.message !== 'network') toast(err.message); }
  };
  $('#fin', box).onclick = async () => {
    if (!dxEl.value.trim()) return toast('Enter a diagnosis before completing the encounter');
    if (!confirm('Complete this encounter? The patient will leave the active queue.')) return;
    try { await api(`/visits/${visit.id}/complete`, 'POST', { diagnosis: dxEl.value, notes: $('#nt', box).value }); toast('Encounter completed ✔'); box.innerHTML = ''; onDone(); } catch (e) { if (e.message !== 'network') toast(e.message); }
  };
  addRow();
}

// ---------------- patient ----------------
async function patientOverview(me) {
  const [p, tl, rx, docs] = await Promise.all([api(`/patients/${me.patientId}`), api(`/patients/${me.patientId}/timeline`), api('/prescriptions'), api('/care/doctors')]);
  const all = await api('/doctors');
  show(`<h2>Hello, ${esc(p.name)} 👋</h2><div id="qc"></div><div class="grid">${stat(tl.length, 'Completed visits', 0)}${stat(rx.filter((r) => r.status === 'active').length, 'Active prescriptions', 1)}${stat(docs.length, 'Connected doctors', 2)}
    <div class="card" style="--i:3"><h3>Allergies</h3>${p.allergies.map((a) => `<span class="chip">${esc(a)}</span>`).join('') || 'None recorded'}</div></div>
    <h3>Latest prescriptions ${unread ? `<span class="badge new">${unread} new</span>` : ''}</h3><div class="card flat">${rxTable(rx.slice(0, 5))}</div>`);
  const qc = async () => {
    const q = await api('/my/queue'); const v = q.visit;
    $('#qc').innerHTML = v ? `<div class="card flat"><h3>Today's visit ${v.queueLabel} · ${badge(v.status)}</h3>With ${esc(v.doctor)} · Checked in ${fmtT(v.checkin_at)}${v.status === 'waiting' ? `<br><b>Your position in queue: ${q.position}</b>` : v.status === 'in_consultation' ? '<br><b>Your consultation is in progress.</b>' : ''}</div>`
      : `<div class="card flat"><h3>Visit the clinic today?</h3><div class="row"><label>Doctor<select id="vd">${all.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label><button class="btn" id="rv">Register for a visit</button></div></div>`;
    $('#rv') && ($('#rv').onclick = async () => { try { await api('/visits/request', 'POST', { doctorId: +$('#vd').value }); toast('You are in the queue'); qc(); } catch (e) { if (e.message !== 'network') toast(e.message); } });
  };
  await qc(); every(qc, 5000);
}
async function doctorsView() {
  const [all, mine, reqs] = await Promise.all([api('/doctors'), api('/care/doctors'), api('/care/requests')]), st = new Map(mine.map((d) => [d.id, d.status]));
  const reqHtml = reqs.length ? `<div class="card flat" role="region" aria-label="Access requests"><h3>Access requests</h3><p class="note">These doctors asked to view your record. Nothing is shared until you approve.</p>${reqs.map((r) => `<div class="row"><span style="flex:1">${esc(r.name)}</span><button class="btn" data-ap="${r.doctorId}">Approve</button> <button class="btn ghost" data-dc="${r.doctorId}">Decline</button></div>`).join('')}</div>` : '';
  show(`<h2>My Doctors</h2>${reqHtml}<p>You decide who can view your record. You can withdraw access at any time.</p><div class="grid">${all.map((d, i) => `<div class="card" style="--i:${i}"><h3>${esc(d.name)}</h3>${st.get(d.id) === 'active' ? `<span class="badge">Has access ✔</span> <button class="btn ghost" data-rv="${d.id}">Revoke access</button>` : st.get(d.id) === 'pending' ? '<span class="badge">Request pending</span>' : `<button class="btn" data-d="${d.id}">Grant access</button>`}</div>`).join('') || '<p>No doctors available yet.</p>'}</div>`);
  const act = async (path, msg, confirmMsg) => { if (confirmMsg && !confirm(confirmMsg)) return; try { await api(path, 'POST', path.endsWith('/connect') ? undefined : {}); toast(msg); route(); } catch (err) { toast(err.message); } };
  app.onclick = async (e) => {
    const d = e.target.dataset; if (!d) return;
    if (d.d) { try { await api('/care/connect', 'POST', { doctorId: +d.d }); toast('Access granted'); route(); } catch (err) { toast(err.message); } }
    else if (d.ap) act(`/care/requests/${d.ap}/approve`, 'Access approved');
    else if (d.dc) act(`/care/requests/${d.dc}/decline`, 'Request declined');
    else if (d.rv) act(`/care/doctors/${d.rv}/revoke`, 'Access revoked', 'Revoke this doctor\'s access to your record?');
  };
}
async function notesView() {
  const n = await api('/notifications'); await api('/notifications/read', 'POST', {}); unread = 0; newLinks = new Set(); shell();
  show(`<h2>Notifications</h2>${n.items.map((i, k) => `<a class="card" style="--i:${k};display:block;text-decoration:none;color:inherit" href="${esc(i.link || '#/overview')}">${i.is_read ? '' : '<span class="badge new">NEW</span> '}${esc(i.message)}<br><span class="note">${esc(i.created_at)}</span></a>`).join('') || '<div class="card">Nothing yet.</div>'}`);
}
async function profileView() {
  const me = await api('/me');
  show(`<h2>Profile</h2><form class="card flat" id="pf"><label>Name<input name="name" value="${esc(me.name)}"></label>${me.role === 'patient' ? `<label>Phone<input name="phone" value="${esc(me.phone)}"></label><label>Date of birth<input type="date" name="dob" value="${esc(me.dob)}"></label><p class="note">Patient ID: <b>${esc(me.patientCode)}</b>. Allergies and visits are entered by clinicians.</p>` : ''}<button class="btn">Save</button></form>`);
  $('#pf').onsubmit = async (e) => { e.preventDefault(); try { await api('/me', 'PUT', Object.fromEntries(new FormData(e.target))); toast('Profile saved ✔'); } catch (err) { toast(err.message); } };
}
async function rxView(id) {
  const r = await api('/prescriptions/' + id);
  if (session.user.role === 'patient') api('/notifications/read', 'POST', { link: '#/rx/' + id }).then(() => pollNotes()).catch(() => {});
  show(`<div class="card rx flat"><h2>Prescription ${esc(r.rx_code)}</h2><span class="badge ${r.status}">${r.status}</span>
    <p>Patient: <b>${esc(r.patient.name)}</b> (${esc(r.patient.patientCode)}) · Allergies: ${r.patient.allergies.map(esc).join(', ') || 'none recorded'}<br>Doctor: ${esc(r.doctor)} · Date: ${esc(r.issued_at.slice(0, 10))}<br>Diagnosis: ${esc(r.diagnosis)}</p>
    <table><tr><th>Medicine</th><th>Dose</th><th>Frequency</th><th>Duration</th><th>Notes</th></tr>${r.medicines.map((m) => `<tr><td>${esc(m.name)} ${esc(m.strength)}</td><td>${esc(m.dosage)} ${esc(m.route)}</td><td>${esc(m.frequency)}</td><td>${esc(m.duration)}</td><td>${esc(m.instructions)}</td></tr>`).join('')}</table>
    <img src="${r.qr}" alt="Verification QR code" width="150" height="150"><p class="note">Scan to verify. Prototype electronic prescription; no digital signature applied.</p>
    <button class="btn noprint" data-print="1">Print</button> ${session.user.role === 'doctor' && r.doctor_id === session.user.id && r.status === 'active' ? '<button class="btn bad noprint" id="rv">Revoke</button>' : ''}</div>`);
  $('#rv')?.addEventListener('click', async () => { const reason = prompt('Reason for revoking?'); if (!reason) return; try { await api(`/prescriptions/${id}/revoke`, 'POST', { reason }); toast('Revoked'); route(); } catch (e) { toast(e.message); } });
}
async function adminView() {
  const [s, users] = await Promise.all([api('/admin/stats'), api('/admin/users')]);
  show(`<h2>Account administration</h2><div class="grid">${stat(s.pendingDoctors, 'Doctors awaiting approval', 0)}${stat(s.prescriptions, 'Prescriptions issued', 1)}</div><p class="note">Administrators manage accounts only and cannot open clinical records.</p>
    <form class="card flat" id="nu"><h3>Create staff account</h3><div class="row"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Temporary password (10+)<input name="password" type="password" minlength="10" required></label><label>Role<select name="role"><option value="receptionist">Receptionist</option><option value="doctor">Doctor</option></select></label><button class="btn">Create</button></div></form>
    <div class="card flat"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role}</td><td><span class="badge ${u.status}">${u.status}</span></td><td>${u.id === session.user.id ? '' : u.status === 'active' ? `<button class="btn alt sm" data-s="deactivated" data-id="${u.id}">Deactivate</button>` : `<button class="btn sm" data-s="active" data-id="${u.id}">Approve / Activate</button>`}</td></tr>`).join('')}</table></div>`);
  $('#nu').onsubmit = async (e) => { e.preventDefault(); try { await api('/admin/users', 'POST', Object.fromEntries(new FormData(e.target))); toast('Account created'); route(true); } catch (err) { toast(err.message); } };
  app.onclick = async (e) => { if (!e.target.dataset.s) return; try { await api(`/admin/users/${e.target.dataset.id}/status`, 'POST', { status: e.target.dataset.s }); toast('Updated'); route(true); } catch (err) { toast(err.message); } };
}
addEventListener('hashchange', () => { app.onclick = null; route(); });
(async () => { try { cfg = await (await fetch('/api/config')).json(); } catch {} try { session = { user: await api('/me') }; } catch { session = null; } if (session) { notePoll = setInterval(() => document.hidden || pollNotes().catch(() => {}), 6000); pollNotes().catch(() => {}); } route(); })();

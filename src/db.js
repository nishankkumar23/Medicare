import { DatabaseSync } from 'node:sqlite';

const USERS_DDL = (name) => `CREATE TABLE ${name}(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('admin','doctor','patient','receptionist')),
  name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('active','pending','deactivated')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`;

const SCHEMA = `
${USERS_DDL('IF NOT EXISTS users')};
CREATE TABLE IF NOT EXISTS patients(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  patient_code TEXT NOT NULL UNIQUE, dob TEXT, phone TEXT);
CREATE TABLE IF NOT EXISTS allergies(
  id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id), substance TEXT NOT NULL,
  UNIQUE(patient_id, substance));
CREATE TABLE IF NOT EXISTS visits(
  id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER NOT NULL REFERENCES users(id), visit_date TEXT NOT NULL, diagnosis TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prescriptions(
  id INTEGER PRIMARY KEY, rx_code TEXT NOT NULL UNIQUE, verify_token TEXT NOT NULL UNIQUE,
  patient_id INTEGER NOT NULL REFERENCES patients(id), doctor_id INTEGER NOT NULL REFERENCES users(id),
  visit_id INTEGER NOT NULL REFERENCES visits(id), diagnosis TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked','superseded')),
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_reason TEXT);
CREATE TABLE IF NOT EXISTS rx_medicines(
  id INTEGER PRIMARY KEY, prescription_id INTEGER NOT NULL REFERENCES prescriptions(id),
  name TEXT NOT NULL, strength TEXT, dosage TEXT NOT NULL, frequency TEXT NOT NULL,
  duration TEXT NOT NULL, route TEXT, instructions TEXT);
CREATE TABLE IF NOT EXISTS safety_logs(
  id INTEGER PRIMARY KEY, prescription_id INTEGER REFERENCES prescriptions(id),
  doctor_id INTEGER NOT NULL, alert_json TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
  ack_reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS care_links(
  id INTEGER PRIMARY KEY, doctor_id INTEGER NOT NULL REFERENCES users(id), patient_id INTEGER NOT NULL REFERENCES patients(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(doctor_id, patient_id));
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL, link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_rx_patient ON prescriptions(patient_id);
CREATE INDEX IF NOT EXISTS idx_visit_patient ON visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_name ON users(name);
`;

/**
 * Additive, repeatable migration. Never deletes or resets data.
 *  1. Rebuilds `users` once if its role CHECK predates the receptionist role (rows copied as-is).
 *  2. Adds queue/encounter columns to `visits`; legacy visits become status 'completed'.
 *  3. Adds `detail` to audit_logs and queue integrity indexes.
 */
function migrate(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get().sql;
  if (!usersSql.includes("'receptionist'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(USERS_DDL('users_new'));
      db.exec('INSERT INTO users_new(id,email,password_hash,role,name,status,created_at) SELECT id,email,password_hash,role,name,status,created_at FROM users');
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('CREATE INDEX IF NOT EXISTS idx_patient_name ON users(name)');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  const vc = cols('visits');
  const add = (n, def) => { if (!vc.includes(n)) db.exec(`ALTER TABLE visits ADD COLUMN ${n} ${def}`); };
  add('queue_number', 'INTEGER'); add('queue_date', 'TEXT'); add('status', "TEXT NOT NULL DEFAULT 'completed'");
  add('checkin_at', 'TEXT'); add('start_at', 'TEXT'); add('end_at', 'TEXT'); add('reason', 'TEXT'); add('notes', 'TEXT'); add('updated_at', 'TEXT');
  db.exec('UPDATE visits SET queue_date = visit_date WHERE queue_date IS NULL');
  // Patient consent on care links. Existing links stay 'active' (source 'legacy') so nothing breaks;
  // new doctor-initiated links start 'pending' until the patient approves.
  const cl = cols('care_links');
  if (!cl.includes('status')) db.exec("ALTER TABLE care_links ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  if (!cl.includes('source')) db.exec("ALTER TABLE care_links ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy'");
  if (!cl.includes('updated_at')) db.exec('ALTER TABLE care_links ADD COLUMN updated_at TEXT');
  if (!cols('audit_logs').includes('detail')) db.exec('ALTER TABLE audit_logs ADD COLUMN detail TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_visit_queue ON visits(queue_date, queue_number) WHERE queue_number IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_visit_active_patient ON visits(patient_id, queue_date) WHERE status IN ('waiting','in_consultation');
    CREATE UNIQUE INDEX IF NOT EXISTS ux_visit_doctor_active ON visits(doctor_id) WHERE status = 'in_consultation';
    CREATE INDEX IF NOT EXISTS idx_visit_day ON visits(queue_date, doctor_id, status);`);
}

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Fictional demo data for LOCAL DEVELOPMENT ONLY.
import bcrypt from 'bcryptjs';
import { openDb } from './db.js';

const pw = process.env.SEED_PASSWORD;
if (!pw) { console.error('Set SEED_PASSWORD in .env'); process.exit(1); }
const db = openDb(process.env.DB_PATH || './medicare.db');
const hash = bcrypt.hashSync(pw, 12);
const user = (email, name, role) => {
  const ex = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  return ex ? ex.id : Number(db.prepare('INSERT INTO users(email,password_hash,role,name,status) VALUES(?,?,?,?,?)').run(email, hash, role, name, 'active').lastInsertRowid);
};
user('admin@demo.test', 'Demo Admin', 'admin');
user('reception@demo.test', 'Riya (Reception, demo)', 'receptionist');
const doc1 = user('doctor@demo.test', 'Dr. Meera Rao (demo)', 'doctor');
user('doctor2@demo.test', 'Dr. Arjun Das (demo)', 'doctor');
const patients = [['asha@demo.test', 'Asha Verma (demo)', 'PT-DEMO01', '1994-03-12', 'penicillin'],
                  ['ravi@demo.test', 'Ravi Nair (demo)', 'PT-DEMO02', '1981-07-30', null]];
for (const [email, name, code, dob, allergy] of patients) {
  const had = db.prepare('SELECT 1 FROM users WHERE email=?').get(email);
  const uid = user(email, name, 'patient');
  if (had) continue;
  const pid = Number(db.prepare('INSERT INTO patients(user_id,patient_code,dob) VALUES(?,?,?)').run(uid, code, dob).lastInsertRowid);
  if (code === 'PT-DEMO01') db.prepare('INSERT OR IGNORE INTO care_links(doctor_id,patient_id) VALUES(?,?)').run(doc1, pid);
  if (allergy) db.prepare('INSERT INTO allergies(patient_id,substance) VALUES(?,?)').run(pid, allergy);
}
console.log('Seeded. Accounts: admin@demo.test, reception@demo.test, doctor@demo.test, doctor2@demo.test, asha@demo.test, ravi@demo.test (password = SEED_PASSWORD)');

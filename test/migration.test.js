import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';

test('migration upgrades a pre-queue database without losing records, and is repeatable', () => {
  const path = join(tmpdir(), `legacy-${Date.now()}.db`);
  const old = new DatabaseSync(path);
  old.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN('admin','doctor','patient')), name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN('active','pending','deactivated')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE patients(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id), patient_code TEXT NOT NULL UNIQUE, dob TEXT, phone TEXT);
    CREATE TABLE visits(id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id), doctor_id INTEGER NOT NULL REFERENCES users(id), visit_date TEXT NOT NULL, diagnosis TEXT NOT NULL);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users(id,email,password_hash,role,name,status) VALUES(1,'d@x.co','h','doctor','Dr Old','active'),(2,'p@x.co','h','patient','Old Patient','active');
    INSERT INTO patients(id,user_id,patient_code,dob) VALUES(1,2,'PT-OLD001','1990-05-05');
    INSERT INTO visits(id,patient_id,doctor_id,visit_date,diagnosis) VALUES(1,1,1,'2026-09-01','Cold');
    INSERT INTO audit_logs(user_id,action,entity,entity_id) VALUES(1,'login','user','1');`);
  old.close();

  for (let run = 0; run < 2; run++) { // second pass proves idempotence
    const db = openDb(path);
    assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 2);
    assert.equal(db.prepare("SELECT name FROM users WHERE id=2").get().name, 'Old Patient');
    assert.equal(db.prepare('SELECT patient_code FROM patients').get().patient_code, 'PT-OLD001');
    const v = db.prepare('SELECT diagnosis,status,queue_date,queue_number FROM visits WHERE id=1').get();
    assert.deepEqual({ ...v }, { diagnosis: 'Cold', status: 'completed', queue_date: '2026-09-01', queue_number: null });
    assert.equal(db.prepare('SELECT count(*) n FROM audit_logs').get().n, 1);
    db.prepare("INSERT INTO users(email,password_hash,role,name,status) VALUES('r@x.co','h','receptionist','Rec','active')").run();
    db.prepare("DELETE FROM users WHERE email='r@x.co'").run();
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
  }
  rmSync(path);
});

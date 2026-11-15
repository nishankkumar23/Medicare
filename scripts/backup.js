// Consistent online backup of the SQLite database (safe while the server runs).
//   npm run backup                 -> backups/medicare-<timestamp>.db  (keeps newest 14)
// Restore: stop the server, copy the chosen backup over DB_PATH, start the server (migrations run on startup).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
const src = process.env.DB_PATH || './medicare.db', dir = process.env.BACKUP_DIR || './backups', keep = Number(process.env.BACKUP_KEEP || 14);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const out = join(dir, `medicare-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(src); db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); db.close();
chmodSync(out, 0o600);
const all = readdirSync(dir).filter((f) => /^medicare-.*\.db$/.test(f)).sort();
for (const f of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, f));
console.log(`Backup written: ${out}`);

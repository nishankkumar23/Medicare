import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';

const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing env var ${k}. Copy .env.example to .env`); process.exit(1); }
  if (v.length < 32 || /change-me|example|secret/i.test(v)) { console.error(`${k} is too short or a placeholder. Run: npm run secrets`); process.exit(1); }
  return v;
};
const port = Number(process.env.PORT || 3000);
const app = createApp(openDb(process.env.DB_PATH || './medicare.db'), {
  jwtSecret: need('JWT_SECRET'), qrSecret: need('QR_SECRET'),
  baseUrl: process.env.BASE_URL || `http://localhost:${port}`,
  publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
});
app.listen(port, () => console.log(`MediCare EHR running on http://localhost:${port}`));

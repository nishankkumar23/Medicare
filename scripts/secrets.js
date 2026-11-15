// Prints fresh random secrets to paste into .env. Nothing is written to disk.
import { randomBytes } from 'node:crypto';
const g = () => randomBytes(48).toString('base64url');
console.log(`JWT_SECRET=${g()}\nQR_SECRET=${g()}`);

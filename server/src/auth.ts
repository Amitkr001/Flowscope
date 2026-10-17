/** Password hashing (scrypt) + HS256 JWT using node:crypto only. */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './store/docs.ts';

function secret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = join(DATA_DIR, '.jwt-secret');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  const s = randomBytes(48).toString('hex');
  writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = secret();
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [, s, h] = stored.split('$');
  if (!s || !h) return false;
  const want = Buffer.from(h, 'base64url');
  const got = scryptSync(pw, Buffer.from(s, 'base64url'), want.length);
  return timingSafeEqual(want, got);
}

export function signToken(uid: string, days = 30): string {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ sub: uid, exp: Math.floor(Date.now() / 1000) + days * 86400 }));
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyToken(tok: string | undefined): string | null {
  if (!tok) return null;
  const [h, b, s] = tok.split('.');
  if (!h || !b || !s) return null;
  const want = createHmac('sha256', SECRET).update(`${h}.${b}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() / 1000 ? String(p.sub) : null;
  } catch { return null; }
}

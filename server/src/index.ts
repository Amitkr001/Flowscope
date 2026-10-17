/**
 * FlowScope server — data gateway + REST API + static web app.
 *   GET  /api/health
 *   GET  /api/symbols
 *   GET  /api/klines?sym=BTCUSD&tf=60&limit=1000
 *   GET  /api/ticks?sym=BTCUSD&from=ms&to=ms        (compressed [t,p,q,side])
 *   GET  /api/heat?sym=BTCUSD&from=ms&to=ms
 *   POST /api/auth/register {email,password,name}  → {token,user}
 *   POST /api/auth/login    {email,password}       → {token,user}
 *   GET  /api/me
 *   GET  /api/docs/:kind   PUT /api/docs/:kind     (layout | drawings | scripts | settings | watchlist)
 *   WS   /ws   → {op:'sub'|'unsub', sym}
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MarketHub, type Client } from './market.ts';
import { acceptUpgrade } from './wsserver.ts';
import { klines } from './history.ts';
import { persist } from './store/ticks.ts';
import { docs } from './store/docs.ts';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.ts';
import { log } from './log.ts';

const PORT = Number(process.env.PORT) || 8080;
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || join(HERE, '../../web/dist');
const DOC_KINDS = new Set(['layout', 'drawings', 'scripts', 'settings', 'watchlist']);

const hub = new MarketHub();

/* ---------------- helpers ---------------- */
const json = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
};
const readBody = (req: IncomingMessage, max = 2_500_000): Promise<any> => new Promise((ok, bad) => {
  let n = 0; const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => { n += c.length; if (n > max) { bad(new Error('body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { bad(new Error('invalid JSON')); } });
  req.on('error', bad);
});
const uidOf = (req: IncomingMessage) => verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
const publicUser = (u: { id: string; email: string; name: string }) => ({ id: u.id, email: u.email, name: u.name });

// naive per-IP rate limit for auth endpoints
const hits = new Map<string, number[]>();
const limited = (ip: string) => { const now = Date.now(); const a = (hits.get(ip) || []).filter(t => now - t < 60_000); a.push(now); hits.set(ip, a); return a.length > 20; };

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let p = normalize(join(WEB_DIST, url));
  if (!p.startsWith(normalize(WEB_DIST))) return json(res, 403, { error: 'forbidden' });
  try { if ((await stat(p)).isDirectory()) p = join(p, 'index.html'); }
  catch { p = join(WEB_DIST, 'index.html'); }       // SPA fallback
  try {
    const data = await readFile(p);
    const immutable = p.includes(`${'/'}assets${'/'}`);
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('FlowScope API is running. Build the web app with `npm run build` (or run `npm run dev:web` for development).');
  }
}

/* ---------------- routes ---------------- */
async function api(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams) {
  const m = req.method || 'GET';
  if (path === '/api/health') return json(res, 200, { ok: true, time: Date.now() });
  if (path === '/api/symbols') return json(res, 200, hub.info());

  if (path === '/api/klines') {
    const def = hub.def(q.get('sym') || ''); if (!def) return json(res, 404, { error: 'unknown symbol' });
    const tf = Math.max(1, Number(q.get('tf')) || 60), limit = Number(q.get('limit')) || 1000;
    const mk = hub.ensure(def.id)!;
    try { return json(res, 200, await klines(def, tf, limit, mk.ticks)); }
    catch (e) { log.warn(`klines ${def.id}: ${(e as Error).message}`); return json(res, 502, { error: 'history source unavailable' }); }
  }
  if (path === '/api/ticks') {
    const sym = q.get('sym') || ''; if (!hub.def(sym)) return json(res, 404, { error: 'unknown symbol' });
    const to = Number(q.get('to')) || Date.now(), from = Math.max(Number(q.get('from')) || to - 3_600_000, to - 7 * 86_400_000);
    return json(res, 200, await hub.ticksRange(sym, from, to));
  }
  if (path === '/api/heat') {
    const sym = q.get('sym') || ''; const mk = hub.markets.get(sym); if (!mk) return json(res, 404, { error: 'unknown symbol' });
    const to = Number(q.get('to')) || Date.now(), from = Number(q.get('from')) || to - 3_600_000;
    const mem = mk.heat.filter(c => c.t >= from && c.t <= to);
    const older = mk.heat.length && from < mk.heat[0].t ? await persist.heatRange(sym, from, mk.heat[0].t - 1) : [];
    return json(res, 200, [...older, ...mem]);
  }

  if (path === '/api/auth/register' && m === 'POST') {
    if (limited(req.socket.remoteAddress || '')) return json(res, 429, { error: 'too many attempts, wait a minute' });
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || ''), name = String(b.name || '').trim().slice(0, 60) || email.split('@')[0];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Enter a valid email' });
    if (pw.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
    if (await docs.findUser(email)) return json(res, 409, { error: 'An account with this email already exists' });
    const u = { id: randomUUID(), email, name, hash: hashPassword(pw), created: Date.now() };
    await docs.createUser(u);
    return json(res, 201, { token: signToken(u.id), user: publicUser(u) });
  }
  if (path === '/api/auth/login' && m === 'POST') {
    if (limited(req.socket.remoteAddress || '')) return json(res, 429, { error: 'too many attempts, wait a minute' });
    const b = await readBody(req);
    const u = await docs.findUser(String(b.email || '').trim().toLowerCase());
    if (!u || !verifyPassword(String(b.password || ''), u.hash)) return json(res, 401, { error: 'Wrong email or password' });
    return json(res, 200, { token: signToken(u.id), user: publicUser(u) });
  }
  if (path === '/api/me') {
    const uid = uidOf(req); const u = uid ? await docs.userById(uid) : null;
    return u ? json(res, 200, publicUser(u)) : json(res, 401, { error: 'not signed in' });
  }
  const dm = path.match(/^\/api\/docs\/([a-z]+)$/);
  if (dm) {
    const uid = uidOf(req); if (!uid) return json(res, 401, { error: 'not signed in' });
    if (!DOC_KINDS.has(dm[1])) return json(res, 404, { error: 'unknown document' });
    if (m === 'GET') return json(res, 200, { data: await docs.get(uid, dm[1]) });
    if (m === 'PUT') { const b = await readBody(req); await docs.put(uid, dm[1], b.data ?? null); return json(res, 200, { ok: true }); }
  }
  return json(res, 404, { error: 'not found' });
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  if (process.env.CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  try {
    if (u.pathname.startsWith('/api/')) return await api(req, res, u.pathname, u.searchParams);
    return await serveStatic(req, res);
  } catch (e) {
    log.warn(`${req.method} ${u.pathname}: ${(e as Error).message}`);
    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
  }
});

/* ---------------- websocket ---------------- */
let nextId = 1;
server.on('upgrade', (req, sock, head) => {
  if (!(req.url || '').startsWith('/ws')) return sock.destroy();
  const ws = acceptUpgrade(req, sock, head); if (!ws) return;
  const client: Client = { id: nextId++, subs: new Set(), send: (s) => ws.send(s) };
  ws.send(JSON.stringify({ t: 'hello', symbols: hub.info() }));
  ws.onMessage = (raw) => {
    let m: any; try { m = JSON.parse(raw); } catch { return; }
    if (m.op === 'sub' && typeof m.sym === 'string') { if (client.subs.size < 20) hub.subscribe(client, m.sym); }
    else if (m.op === 'unsub' && typeof m.sym === 'string') hub.unsubscribe(client, m.sym);
    else if (m.op === 'ping') ws.send('{"t":"pong"}');
  };
  ws.onClose = () => hub.drop(client);
});

server.listen(PORT, () => log.info(`FlowScope server on http://localhost:${PORT}  (web: ${WEB_DIST})`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { log.info('shutting down'); server.close(); process.exit(0); });

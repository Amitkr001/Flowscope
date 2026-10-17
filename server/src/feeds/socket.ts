import { log } from '../log.ts';

interface Handlers {
  open?(s: LiveSocket): void;
  msg(data: any): void;
  /** Return a heartbeat message to send every pingMs, or null. */
  ping?(): string | null;
  pingMs?: number;
  close?(): void;
}

/**
 * Auto-reconnecting WebSocket client built on Node's global WebSocket (Node >= 22).
 * Exponential backoff up to 30 s; resets after a successful open.
 */
export class LiveSocket {
  ws: WebSocket | null = null;
  ok = false;
  private retry = 0;
  private hb: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastMsg = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  name: string; url: string; private h: Handlers;
  constructor(name: string, url: string, h: Handlers) { this.name = name; this.url = url; this.h = h; }

  start(): this { this.connect(); return this; }

  stop(): void {
    this.stopped = true;
    if (this.hb) clearInterval(this.hb);
    if (this.watchdog) clearInterval(this.watchdog);
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  send(o: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(typeof o === 'string' ? o : JSON.stringify(o));
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch (e) { log.warn(`[${this.name}] connect failed: ${(e as Error).message}`); return this.schedule(); }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.ok = true; this.retry = 0; this.lastMsg = Date.now();
      log.info(`[${this.name}] connected`);
      this.h.open?.(this);
      if (this.h.ping) this.hb = setInterval(() => { const m = this.h.ping!(); if (m) this.send(m); }, this.h.pingMs ?? 20_000);
      // reconnect if a socket goes silent for 90 s (half-open TCP)
      this.watchdog = setInterval(() => { if (Date.now() - this.lastMsg > 90_000) { log.warn(`[${this.name}] silent, reconnecting`); try { ws.close(); } catch { /* */ } } }, 30_000);
    };
    ws.onmessage = (e) => {
      this.lastMsg = Date.now();
      const raw = typeof e.data === 'string' ? e.data : Buffer.from(e.data as ArrayBuffer).toString('utf8');
      if (raw === 'pong') return;
      let d: unknown;
      try { d = JSON.parse(raw); } catch { return; }
      try { this.h.msg(d); } catch (err) { log.warn(`[${this.name}] handler error: ${(err as Error).message}`); }
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.hb) clearInterval(this.hb);
      if (this.watchdog) clearInterval(this.watchdog);
      this.hb = this.watchdog = null;
      if (this.ok) log.warn(`[${this.name}] disconnected`);
      this.ok = false;
      this.h.close?.();
      this.schedule();
    };
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    setTimeout(() => this.connect(), delay);
  }
}

export async function getJSON<T = any>(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal, headers: { 'User-Agent': 'FlowScope/1.0', ...(init?.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json() as T;
  } finally { clearTimeout(t); }
}

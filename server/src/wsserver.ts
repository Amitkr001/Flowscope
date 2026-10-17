/**
 * Minimal RFC 6455 WebSocket server (text frames, ping/pong, close, fragmentation).
 * Dependency-free so the server runs with plain `node`. Server→client messages are unmasked;
 * client→server frames must be masked (browsers always do).
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_IN = 1 << 20;            // 1 MB inbound frame limit
const MAX_BUFFERED = 16 << 20;     // drop clients that can't keep up

export class WsConn {
  private buf = Buffer.alloc(0);
  private frags: Buffer[] = [];
  private alive = true;
  private timer: ReturnType<typeof setInterval>;
  closed = false;
  onMessage: (s: string) => void = () => {};
  onClose: () => void = () => {};

  private sock: Duplex;
  constructor(sock: Duplex) {
    this.sock = sock;
    sock.on('data', (c: Buffer) => this.feed(c));
    sock.on('close', () => this.finish());
    sock.on('error', () => this.finish());
    this.timer = setInterval(() => {
      if (!this.alive) return this.close();
      this.alive = false;
      this.raw(0x9, Buffer.alloc(0));
    }, 30_000);
  }

  send(s: string): void {
    if (this.closed) return;
    if ((this.sock as any).writableLength > MAX_BUFFERED) return this.close(1008);
    this.raw(0x1, Buffer.from(s));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const b = Buffer.alloc(2); b.writeUInt16BE(code);
    try { this.raw(0x8, b); this.sock.end(); } catch { /* ignore */ }
    this.finish();
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    try { this.sock.destroy(); } catch { /* ignore */ }
    this.onClose();
  }

  private raw(op: number, payload: Buffer) {
    const n = payload.length;
    let h: Buffer;
    if (n < 126) { h = Buffer.alloc(2); h[1] = n; }
    else if (n < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    h[0] = 0x80 | op;
    this.sock.write(Buffer.concat([h, payload]));
  }

  feed(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_IN) return this.close(1009);
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const m = b.subarray(off, off + 4); const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3];
        payload = out;
      }
      this.buf = b.subarray(need);
      this.alive = true;
      if (op === 0x8) return this.close();
      if (op === 0x9) { this.raw(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frags.push(Buffer.from(payload));
        if (fin) { const msg = Buffer.concat(this.frags).toString('utf8'); this.frags = []; try { this.onMessage(msg); } catch { /* ignore */ } }
      }
    }
  }
}

export function acceptUpgrade(req: IncomingMessage, sock: Duplex, head: Buffer): WsConn | null {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return null; }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  (sock as any).setNoDelay?.(true);
  const c = new WsConn(sock);
  if (head?.length) c.feed(head);
  return c;
}

/**
 * Users + per-user documents (layouts, drawings, scripts, settings).
 * MongoDB when MONGO_URL is set, otherwise a JSON file in DATA_DIR (default ./data).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { mongo } from './mongo.ts';

export interface User { id: string; email: string; name: string; hash: string; created: number }

export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });
const FILE = join(DATA_DIR, 'db.json');

interface FileDb { users: User[]; docs: Record<string, unknown> }
let fileDb: FileDb = { users: [], docs: {} };
if (existsSync(FILE)) { try { fileDb = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* start fresh */ } }
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const save = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; const tmp = FILE + '.tmp'; writeFileSync(tmp, JSON.stringify(fileDb)); renameSync(tmp, FILE); }, 300);
};

const MAX_DOC_BYTES = 2_000_000;

export const docs = {
  async findUser(email: string): Promise<User | null> {
    const db = await mongo();
    if (db) return db.collection('users').findOne({ email }, { projection: { _id: 0 } });
    return fileDb.users.find(u => u.email === email) ?? null;
  },
  async userById(id: string): Promise<User | null> {
    const db = await mongo();
    if (db) return db.collection('users').findOne({ id }, { projection: { _id: 0 } });
    return fileDb.users.find(u => u.id === id) ?? null;
  },
  async createUser(u: User): Promise<void> {
    const db = await mongo();
    if (db) { await db.collection('users').insertOne({ ...u }); return; }
    fileDb.users.push(u); save();
  },
  async get(uid: string, kind: string): Promise<unknown> {
    const db = await mongo();
    if (db) return (await db.collection('docs').findOne({ uid, kind }))?.data ?? null;
    return fileDb.docs[`${uid}:${kind}`] ?? null;
  },
  async put(uid: string, kind: string, data: unknown): Promise<void> {
    if (JSON.stringify(data).length > MAX_DOC_BYTES) throw new Error('document too large');
    const db = await mongo();
    if (db) { await db.collection('docs').updateOne({ uid, kind }, { $set: { data, at: new Date() } }, { upsert: true }); return; }
    fileDb.docs[`${uid}:${kind}`] = data; save();
  },
};

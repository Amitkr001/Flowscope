/** Optional MongoDB connection. Set MONGO_URL to enable persistence; otherwise the app runs in-memory + JSON file. */
import { log } from '../log.ts';

let dbPromise: Promise<any | null> | null = null;

export function mongo(): Promise<any | null> {
  if (dbPromise) return dbPromise;
  const url = process.env.MONGO_URL;
  if (!url) return (dbPromise = Promise.resolve(null));
  dbPromise = (async () => {
    try {
      const name = 'mongodb';
      const mod: any = await import(name);
      const client = new mod.MongoClient(url, { maxPoolSize: 10 });
      await client.connect();
      const db = client.db(process.env.MONGO_DB || 'flowscope');
      const days = Number(process.env.RETAIN_DAYS) || 14;
      await db.collection('ticks').createIndex({ sym: 1, t0: 1 });
      await db.collection('ticks').createIndex({ at: 1 }, { expireAfterSeconds: days * 86400 });
      await db.collection('heat').createIndex({ sym: 1, t0: 1 });
      await db.collection('heat').createIndex({ at: 1 }, { expireAfterSeconds: Math.min(days, 3) * 86400 });
      await db.collection('users').createIndex({ email: 1 }, { unique: true });
      await db.collection('docs').createIndex({ uid: 1, kind: 1 }, { unique: true });
      log.info(`MongoDB connected (retain ticks ${days} days)`);
      return db;
    } catch (e) {
      log.error(`MongoDB unavailable (${(e as Error).message}) — falling back to memory/JSON storage`);
      return null;
    }
  })();
  return dbPromise;
}

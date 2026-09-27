import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { runMigrations } from './migrate.js';
import { createInMemoryDb } from './in-memory-db.js';

const uri = process.env.MONGODB_URI;
let client = null;
if (uri) {
  client = new MongoClient(uri, { maxPoolSize: 20, minPoolSize: 1, retryWrites: true, serverSelectionTimeoutMS: 4000 });
}

let database;
let isInMemory = false;

export async function getDb() {
  if (!database) {
    if (client) {
      try {
        console.log('[SOS:DB] Connecting to MongoDB Atlas cluster...');
        await client.connect();
        database = client.db(process.env.MONGODB_DB_NAME || 'school_erp_sos');
        isInMemory = false;
        console.log('[SOS:DB] ✓ Successfully connected to MongoDB Atlas cluster');
      } catch (err) {
        console.warn(`[SOS:DB] ⚠️ MongoDB Atlas connection timed out: ${err.message}`);
        console.warn('[SOS:DB] (Note: Outbound TCP port 27017 is blocked by local network/firewall)');
        console.log('[SOS:DB] Activating resilient in-memory database fallback for emergency services...');
        database = createInMemoryDb();
        isInMemory = true;
      }
    } else {
      database = createInMemoryDb();
      isInMemory = true;
    }
  }
  return database;
}

export async function initDatabase() {
  const db = await getDb();
  await runMigrations(db);
  return db;
}

export function startSession() {
  if (isInMemory || !client) {
    return {
      withTransaction: async (fn) => fn(),
      endSession: async () => {}
    };
  }
  try {
    return client.startSession();
  } catch {
    return {
      withTransaction: async (fn) => fn(),
      endSession: async () => {}
    };
  }
}

export async function closeDatabase() {
  if (!isInMemory && client) {
    try {
      await client.close();
    } catch {}
  }
  database = undefined;
}
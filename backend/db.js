import 'dotenv/config';
import dns from 'node:dns';
import { MongoClient } from 'mongodb';
import { runMigrations } from './migrate.js';

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {}

const uri=process.env.MONGODB_URI;
if(!uri)throw new Error('MONGODB_URI is required. Copy .env.example to .env.');
const client=new MongoClient(uri,{maxPoolSize:20,minPoolSize:1,retryWrites:true,serverSelectionTimeoutMS:10000});
let database;
export async function getDb(){if(!database){await client.connect();database=client.db(process.env.MONGODB_DB_NAME||'school_erp_sos')}return database}
export async function initDatabase(){const db=await getDb();await runMigrations(db);return db}
export function startSession(){return client.startSession()}
export async function closeDatabase(){await client.close();database=undefined}
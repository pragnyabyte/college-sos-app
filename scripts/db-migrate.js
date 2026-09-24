import 'dotenv/config';
import dns from 'node:dns';
import { MongoClient, BSON } from 'mongodb';

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {}

const { EJSON } = BSON;
import { readFile, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { backupDatabase } from './db-backup.js';
const sourceUri=process.env.MONGODB_SOURCE_URI||process.env.MONGODB_URI,targetUri=process.env.MONGODB_TARGET_URI,sourceDb=process.env.MONGODB_SOURCE_DB||process.env.MONGODB_DB_NAME||'school_erp_sos',targetDb=process.env.MONGODB_TARGET_DB||sourceDb;
if(!sourceUri||!targetUri)throw new Error('Set MONGODB_SOURCE_URI (or MONGODB_URI) and MONGODB_TARGET_URI');if(sourceUri===targetUri&&sourceDb===targetDb)throw new Error('Source and target databases must be different');
const backup=await backupDatabase({uri:sourceUri,dbName:sourceDb,outputDir:process.env.BACKUP_DIR}),manifest=EJSON.parse(await readFile(join(backup.directory,'manifest.json'),'utf8')),targetClient=new MongoClient(targetUri);await targetClient.connect();try{const db=targetClient.db(targetDb);for(const [name,info] of Object.entries(manifest.collections)){const operations=[];for await(const line of createInterface({input:createReadStream(join(backup.directory,info.file)),crlfDelay:Infinity})){if(!line.trim())continue;const doc=EJSON.parse(line);operations.push({replaceOne:{filter:{_id:doc._id},replacement:doc,upsert:true}});if(operations.length===500){await db.collection(name).bulkWrite(operations,{ordered:false});operations.length=0}}if(operations.length)await db.collection(name).bulkWrite(operations,{ordered:false});for(const index of info.indexes){if(index.name==='_id_')continue;const {key,name:indexName,unique,sparse,partialFilterExpression,expireAfterSeconds}=index;await db.collection(name).createIndex(key,{name:indexName,...(unique&&{unique}),...(sparse&&{sparse}),...(partialFilterExpression&&{partialFilterExpression}),...(expireAfterSeconds!=null&&{expireAfterSeconds})})}console.log(`Migrated ${info.count} documents: ${name}`)}console.log(`Migration complete. Pre-migration backup: ${backup.directory}`)}finally{await targetClient.close()}
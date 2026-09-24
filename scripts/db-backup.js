import 'dotenv/config';
import dns from 'node:dns';
import { MongoClient, BSON } from 'mongodb';

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {}

const { EJSON } = BSON;
import { mkdir, writeFile, createWriteStream } from 'node:fs';
import { mkdir as mkdirAsync } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
export async function backupDatabase({uri,dbName,outputDir}){if(!uri)throw new Error('A MongoDB source URI is required');const client=new MongoClient(uri);await client.connect();try{const db=client.db(dbName),stamp=new Date().toISOString().replace(/[:.]/g,'-'),dir=resolve(outputDir||'backups',`${dbName}-${stamp}`);await mkdirAsync(dir,{recursive:true});const collections=(await db.listCollections({}, {nameOnly:true}).toArray()).map(x=>x.name);const metadata={format:'sos-mongodb-ejson-v1',database:dbName,createdAt:new Date().toISOString(),collections:{}};for(const name of collections){const indexes=await db.collection(name).listIndexes().toArray(),file=`${name}.jsonl`,stream=createWriteStream(join(dir,file),{encoding:'utf8'});let count=0;for await(const doc of db.collection(name).find({})){if(!stream.write(EJSON.stringify(doc)+'\n'))await once(stream,'drain');count++}stream.end();await once(stream,'finish');metadata.collections[name]={file,count,indexes:indexes.map(({v,ns,...index})=>index)}}await new Promise((ok,fail)=>writeFile(join(dir,'manifest.json'),EJSON.stringify(metadata,null,2),e=>e?fail(e):ok()));return{directory:dir,metadata}}finally{await client.close()}}
if(fileURLToPath(import.meta.url)===resolve(process.argv[1])){const result=await backupDatabase({uri:process.env.MONGODB_SOURCE_URI||process.env.MONGODB_URI,dbName:process.env.MONGODB_SOURCE_DB||process.env.MONGODB_DB_NAME||'school_erp_sos',outputDir:process.env.BACKUP_DIR});console.log(`Backup completed: ${result.directory}`)}

import * as core from './migrations/001-sos-core.js';
import * as activeIncident from './migrations/002-one-active-sos.js';
import * as cleanCategories from './migrations/003-remove-category-emojis.js';
const migrations=[core,activeIncident,cleanCategories];
export async function runMigrations(db){const applied=db.collection('schema_migrations');await applied.createIndex({id:1},{unique:true});for(const migration of migrations){if(await applied.findOne({id:migration.id}))continue;await migration.up(db);await applied.insertOne({id:migration.id,applied_at:new Date().toISOString()})}}
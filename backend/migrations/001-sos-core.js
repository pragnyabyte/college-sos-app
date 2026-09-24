import { categories } from '../domain.js';
export const id='001_sos_core';
export async function up(db){
 await Promise.all([
  db.collection('incidents').createIndex({id:1},{unique:true,name:'incident_id_unique'}),
  db.collection('incidents').createIndex({student_id:1,idempotency_key:1},{unique:true,name:'student_idempotency_unique'}),
  db.collection('incidents').createIndex({student_id:1,status:1,created_at:-1},{name:'student_history'}),
  db.collection('incidents').createIndex({assigned_departments:1,status:1,created_at:-1},{name:'department_active'}),
  db.collection('incidents').createIndex({priority:1,created_at:-1},{name:'priority_created'}),
  db.collection('timeline').createIndex({incident_id:1,timestamp:1},{name:'incident_timeline'}),
  db.collection('audit').createIndex({incident_id:1,timestamp:1},{name:'incident_audit'}),
  db.collection('notifications').createIndex({user_id:1,acknowledged:1,created_at:-1},{name:'user_notifications'}),
  db.collection('notifications').createIndex({department_id:1,acknowledged:1,created_at:-1},{name:'department_notifications'})
 ]);
 const departments=[['DEPT_MEDICAL','Medical Department'],['DEPT_SECURITY','Security Department'],['DEPT_FIRE','Fire / Safety Department'],['DEPT_WELFARE','Student Welfare Department'],['DEPT_ELECTRICAL','Electrical / Maintenance Department'],['DEPT_MAINTENANCE','Maintenance / Infrastructure Department'],['DEPT_ADMIN','Emergency Administration']];
 await db.collection('departments').bulkWrite(departments.map(([id,name])=>({updateOne:{filter:{id},update:{$setOnInsert:{id,name,active:true}},upsert:true}})));
 await db.collection('categories').bulkWrite(categories.map(c=>({updateOne:{filter:{id:c.id},update:{$set:{...c,updated_at:new Date().toISOString()}},upsert:true}})));
}
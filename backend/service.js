import { ObjectId } from 'mongodb';
import { getDb, startSession } from './db.js';
import { categories, canTransition, validateLocation } from './domain.js';
import { isAdmin } from './auth.js';
const terminal=['RESOLVED','CANCELLED','REJECTED','DUPLICATE'];
const httpError=(message,status,extra={})=>Object.assign(new Error(message),{status,...extra});
async function hydrate(i,user){
  if(!i)return i;
  const db=await getDb(),location={...i.location};
  const isResp = user && (user.id === 'RESP-1111' || String(user.role || '').toUpperCase() === 'RESPONDER');
  const canSeeGps = user && (
    isAdmin(user) ||
    isResp ||
    user.id === i.student_id ||
    (user.role !== 'STUDENT' && (!user.departmentId || user.departmentId === 'DEPT_ADMIN' || user.departmentId === 'ALL' || (i.assigned_departments && i.assigned_departments.includes(user.departmentId))))
  );
  if(!canSeeGps){
    delete location.latitude;
    delete location.longitude;
    delete location.accuracy;
  }
  const timeline=await db.collection('timeline').find({incident_id:i.id},{projection:{_id:0,incident_id:0}}).sort({timestamp:1}).toArray();
  const {_id,...incident}=i;
  return{
    ...incident,
    _id:String(_id||''),
    restricted:!!i.restricted,
    location,
    assignedDepartments:i.assigned_departments,
    timeline
  };
}
function assertAccess(i,u){
  const role = String(u?.role || '').toUpperCase();
  if (role === 'STUDENT' && i.student_id !== u.id) throw httpError('Forbidden', 403);
  if (u?.id === 'RESP-1111' || role === 'RESPONDER') return; // Permanent emergency responder has access to handle incidents
  if (['DEPARTMENT_HEAD'].includes(role)){
    if (u.departmentId && u.departmentId !== 'ALL' && u.departmentId !== 'DEPT_ADMIN' && !i.assigned_departments.includes(u.departmentId)) throw httpError('Not assigned to your department', 403);
  }
  if (i.restricted && role === 'RESPONDER' && !['DEPT_WELFARE','DEPT_SECURITY'].includes(u.departmentId || '')) throw httpError('Restricted incident', 403);
}
const timeline=(db,id,status,u,note,now,session)=>db.collection('timeline').insertOne({incident_id:id,status,actorId:u.id,actorRole:u.role,note,timestamp:now},{session});
const audit=(db,id,u,action,oldValue,newValue,ip,session)=>db.collection('audit').insertOne({incident_id:id,actor_id:u.id,actor_role:u.role,action,old_value:oldValue,new_value:newValue,ip,timestamp:new Date().toISOString()},{session});
const notify=(db,id,userId,departmentId,priority,message,session)=>db.collection('notifications').insertOne({user_id:userId,department_id:departmentId,incident_id:id,type:'SOS',priority,message,acknowledged:false,created_at:new Date().toISOString()},{session});
export async function createIncident(body,u,ip=''){
  if(u.role!=='STUDENT')throw httpError('Only students can create an SOS',403);
  const category=categories.find(c=>c.id===body.categoryId) || categories.find(c=>c.id==='other') || categories[0];
  if(!category)throw httpError('Invalid emergency category',400);
  const description=String(body.description||'').trim();
  if(description.length>1000)throw httpError('Description is too long',400);
  const location=validateLocation(body.location||{}),key=String(body.idempotencyKey||'');
  if(!/^[\w-]{16,100}$/.test(key))throw httpError('Valid idempotency key required',400);
  const db=await getDb(),incidents=db.collection('incidents');
  const existing=await incidents.findOne({student_id:u.id,idempotency_key:key});
  if(existing)return hydrate(existing,u);
  const active=await incidents.findOne({student_id:u.id,status:{$nin:terminal}});
  if(active)throw httpError(`You already have an active SOS (${active.id})`,409,{incidentId:active.id});
  const session=startSession();
  let created;
  try{
    await session.withTransaction(async()=>{
      const counter=await db.collection('counters').findOneAndUpdate({_id:'sos_incident'},{$inc:{seq:1}}, {upsert:true,returnDocument:'after',session});
      const id=`SOS-${String(counter.seq).padStart(5,'0')}`,now=new Date().toISOString();
      created={
        id,
        category_id:category.id,
        student_id:u.id,
        student_name:u.name,
        description,
        location,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        gps_accuracy: location.accuracy,
        location_status: location.locationStatus,
        locationStatus: location.locationStatus,
        gps_timestamp: location.gpsTimestamp,
        gpsTimestamp: location.gpsTimestamp,
        building: location.building,
        floor: location.floor,
        room: location.room,
        area: location.area,
        priority:category.priority,
        status:'DEPARTMENT_NOTIFIED',
        primary_department_id:category.primaryDepartmentId,
        assigned_departments:category.departmentIds,
        restricted:category.restricted,
        active_key:u.id,
        accepted_by:null,
        accepted_by_name:null,
        accepted_at:null,
        responding_at:null,
        arrived_at:null,
        resolved_at:null,
        cancelled_at:null,
        resolution_type:null,
        resolution_note:null,
        idempotency_key:key,
        created_at:now,
        updated_at:now
      };
      await incidents.insertOne(created,{session});
      await timeline(db,id,'SOS_SENT',u,null,now,session);
      await timeline(db,id,'DEPARTMENT_NOTIFIED',{id:'SYSTEM',role:'SUPER_ADMIN'},null,now,session);
      await audit(db,id,u,'SOS_CREATED',null,{categoryId:category.id,priority:category.priority},ip,session);
      const locLabel = [location.building, location.floor, location.room].filter(Boolean).join(', ')
        || (location.latitude != null ? `GPS (${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)})` : 'Campus Location');
      for(const d of category.departmentIds)
        await notify(db,id,null,d,category.priority,`New ${category.name} at ${locLabel}`,session);
    });
  }catch(e){
    if(e.code===11000){
      const duplicate=await incidents.findOne({student_id:u.id,idempotency_key:key});
      if(duplicate)return hydrate(duplicate,u);
      const current=await incidents.findOne({student_id:u.id,status:{$nin:terminal}});
      if(current)throw httpError(`You already have an active SOS (${current.id})`,409,{incidentId:current.id});
    }
    throw e;
  }finally{
    await session.endSession();
  }
  return hydrate(created,u);
}
export async function getIncident(id,u){
  const db=await getDb(),incidents=db.collection('incidents');
  let filter={id:String(id)};
  if(ObjectId.isValid(id)){filter={$or:[{_id:new ObjectId(id)},{id:String(id)}]};}
  const i=await incidents.findOne(filter);
  if(!i)throw httpError('Incident not found',404);
  assertAccess(i,u);
  return hydrate(i,u);
}
export async function listIncidents(u,query={}){const filter={};const isResp = u?.id === 'RESP-1111' || String(u?.role || '').toUpperCase() === 'RESPONDER';if(u.role==='STUDENT')filter.student_id=u.id;else if(!isResp && ['DEPARTMENT_HEAD'].includes(u.role)){if(u.departmentId&&u.departmentId!=='ALL'&&u.departmentId!=='DEPT_ADMIN')filter.assigned_departments=u.departmentId}if(query.status)filter.status=query.status;if(query.priority)filter.priority=query.priority;if(query.search){const escaped=String(query.search).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');filter.$or=['id','student_id','student_name'].map(k=>({[k]:{$regex:escaped,$options:'i'}}))}const docs=await(await getDb()).collection('incidents').find(filter).sort({created_at:-1}).limit(100).toArray();return Promise.all(docs.map(i=>hydrate(i,u)))}
export async function changeStatus(id,to,body,u,ip=''){const db=await getDb(),incidents=db.collection('incidents'),i=await incidents.findOne({id});if(!i)throw httpError('Incident not found',404);assertAccess(i,u);const uRole=String(u?.role||'').toUpperCase();if(uRole==='STUDENT'){if(to!=='CANCELLED'||!['SOS_SENT','DEPARTMENT_NOTIFIED'].includes(i.status))throw httpError('Students cannot perform this action',403);if(!String(body.reason||'').trim())throw httpError('Cancellation reason is required',400)}else if(u?.id!=='RESP-1111'&&!['RESPONDER','DEPARTMENT_HEAD','INSTITUTE_ADMIN','SUPER_ADMIN','ADMIN'].includes(uRole))throw httpError('Forbidden',403);if(!canTransition(i.status,to))throw httpError(`Cannot transition ${i.status} to ${to}`,409);if(to==='ACCEPTED'&&i.accepted_by&&i.accepted_by!==u.id)throw httpError('Already accepted by another responder',409);if(to==='RESOLVED'&&(!String(body.note||'').trim()||!['RESOLVED','REFERRED','FALSE_ALARM','DUPLICATE','OTHER'].includes(body.resolutionType)))throw httpError('Resolution type and note are required',400);const now=new Date().toISOString(),set={status:to,updated_at:now},timestampFields={ACCEPTED:'accepted_at',RESPONDING:'responding_at',ARRIVED:'arrived_at',RESOLVED:'resolved_at',CANCELLED:'cancelled_at'};if(timestampFields[to])set[timestampFields[to]]=now;if(to==='ACCEPTED'){set.accepted_by=u.id;set.accepted_by_name=u.name}if(to==='RESOLVED'){set.resolution_type=body.resolutionType;set.resolution_note=String(body.note).trim()}const update={$set:set};if(terminal.includes(to))update.$unset={active_key:''};const result=await incidents.findOneAndUpdate({id,status:i.status},update,{returnDocument:'after'});if(!result)throw httpError('Incident changed by another responder',409);const note=String(body.note||body.reason||'').trim()||null;await Promise.all([timeline(db,id,to,u,note,now),audit(db,id,u,`SOS_${to}`,{status:i.status},{status:to},ip),notify(db,id,i.student_id,null,i.priority,`Your SOS ${id} is now ${to.replaceAll('_',' ').toLowerCase()}.`)]);return hydrate(result,u)}
export async function stats(){const db=await getDb(),c=db.collection('incidents'),today=new Date();today.setUTCHours(0,0,0,0);const [active,critical,responding,resolvedToday,accepted]=await Promise.all([c.countDocuments({status:{$nin:terminal}}),c.countDocuments({priority:'CRITICAL',status:{$nin:['RESOLVED','CANCELLED']}}),c.countDocuments({status:'RESPONDING'}),c.countDocuments({status:'RESOLVED',resolved_at:{$gte:today.toISOString()}}),c.find({accepted_at:{$ne:null}},{projection:{created_at:1,accepted_at:1}}).toArray()]);const avg=accepted.length?accepted.reduce((n,x)=>n+(new Date(x.accepted_at)-new Date(x.created_at))/1000,0)/accepted.length:0;return{active,critical,responding,resolvedToday,averageAcceptSeconds:Math.round(avg)}}
export async function exportCsv(u){if(!isAdmin(u)&&u.role!=='DEPARTMENT_HEAD')throw httpError('Admin only',403);const data=await(await getDb()).collection('incidents').find({}, {projection:{_id:0,id:1,category_id:1,student_id:1,priority:1,status:1,primary_department_id:1,created_at:1,resolved_at:1}}).sort({created_at:-1}).toArray();const keys=['id','category_id','student_id','priority','status','primary_department_id','created_at','resolved_at'];return['id,category,student,priority,status,department,createdAt,resolvedAt',...data.map(r=>keys.map(k=>`"${String(r[k]??'').replaceAll('"','""')}"`).join(','))].join('\n')}
export async function deleteIncident(id, u, ip = '') {
  if (!id) throw httpError('Incident identifier is required', 400);
  const db = await getDb(), incidents = db.collection('incidents');
  let filter = { id: String(id) };
  if (ObjectId.isValid(id)) {
    filter = { $or: [{ _id: new ObjectId(id) }, { id: String(id) }] };
  }
  const i = await incidents.findOne(filter);
  if (!i) throw httpError(`Incident not found`, 404);
  assertAccess(i, u);
  const uRole = String(u?.role || '').toUpperCase();
  if (u?.id !== 'RESP-1111' && !['RESPONDER', 'INSTITUTE_ADMIN', 'SUPER_ADMIN', 'ADMIN'].includes(uRole)) {
    throw httpError('Forbidden: Only emergency responders can delete incidents', 403);
  }
  // Permanently delete using the actual MongoDB document _id
  const deleteResult = await incidents.deleteOne({ _id: i._id });
  if (deleteResult.deletedCount === 0) {
    throw httpError('Failed to delete incident from database', 500);
  }
  console.log(`[SOS:MongoDB] Permanently deleted document _id: ${i._id} (ID: ${i.id}) from collection 'incidents'`);
  await db.collection('timeline').deleteMany({ incident_id: i.id });
  await audit(db, i.id, u, 'SOS_DELETED', { id: i.id, _id: String(i._id), status: i.status }, null, ip);
  return { success: true, id: i.id, _id: String(i._id) };
}

export async function updateIncidentLocation(id, locBody, u, ip = '') {
  if (!id) throw httpError('Incident identifier is required', 400);
  const db = await getDb(), incidents = db.collection('incidents');
  let filter = { id: String(id) };
  if (ObjectId.isValid(id)) filter = { $or: [{ _id: new ObjectId(id) }, { id: String(id) }] };
  const i = await incidents.findOne(filter);
  if (!i) throw httpError('Incident not found', 404);
  assertAccess(i, u);
  if (terminal.includes(i.status)) throw httpError('Cannot update location for a closed incident', 400);

  const location = validateLocation(locBody || {});
  const now = new Date().toISOString();
  const update = {
    $set: {
      location,
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy,
      gps_accuracy: location.accuracy,
      location_status: location.locationStatus,
      locationStatus: location.locationStatus,
      gps_timestamp: location.gpsTimestamp,
      gpsTimestamp: location.gpsTimestamp,
      building: location.building,
      floor: location.floor,
      room: location.room,
      area: location.area,
      updated_at: now
    }
  };
  const result = await incidents.findOneAndUpdate(filter, update, { returnDocument: 'after' });
  const locNote = [location.building, location.floor, location.room].filter(Boolean).join(', ')
    || (location.latitude != null ? `GPS: ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)} (±${Math.round(location.accuracy || 0)}m)` : 'Location updated');
  await timeline(db, i.id, 'LOCATION_UPDATED', u, `Location updated: ${locNote}`, now);
  await audit(db, i.id, u, 'LOCATION_UPDATED', i.location, location, ip);
  return hydrate(result, u);
}

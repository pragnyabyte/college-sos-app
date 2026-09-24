export const id='002_one_active_sos_per_student';
export async function up(db){
 const incidents=db.collection('incidents');
 await incidents.updateMany({status:{$in:['RESOLVED','CANCELLED','REJECTED','DUPLICATE']}},{$unset:{active_key:''}});
 const active=await incidents.find({status:{$nin:['RESOLVED','CANCELLED','REJECTED','DUPLICATE']}}).sort({created_at:1}).toArray(),seen=new Set();
 for(const incident of active){if(seen.has(incident.student_id)){await incidents.updateOne({_id:incident._id},{$set:{status:'DUPLICATE',updated_at:new Date().toISOString()},$unset:{active_key:''}})}else{seen.add(incident.student_id);await incidents.updateOne({_id:incident._id},{$set:{active_key:incident.student_id}})}}
 await incidents.createIndex({active_key:1},{unique:true,sparse:true,name:'one_active_sos_per_student'});
}
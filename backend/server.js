import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { authenticate, createSessionUser, issueToken, isAdmin } from './auth.js';
import { categories } from './domain.js';
import { initDatabase } from './db.js';
import { changeStatus, createIncident, exportCsv, getIncident, listIncidents, stats } from './service.js';

const port=Number(process.env.PORT||4000), limits=new Map();
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer'});res.end(JSON.stringify(data))};
const body=async req=>{let raw='';for await(const c of req){raw+=c;if(raw.length>30_000)throw Object.assign(new Error('Payload too large'),{status:413})}try{return raw?JSON.parse(raw):{}}catch{throw Object.assign(new Error('Invalid JSON'),{status:400})}};
const rate=req=>{const key=req.socket.remoteAddress||'unknown',now=Date.now(),v=limits.get(key)||{n:0,t:now};if(now-v.t>60_000){v.n=0;v.t=now}if(++v.n>80)throw Object.assign(new Error('Too many requests'),{status:429});limits.set(key,v)};
const eventPayload=(event,incident)=>({event,id:incident.id,status:incident.status,priority:incident.priority,categoryId:incident.category_id,studentId:incident.student_id,studentName:incident.student_name,assignedDepartments:incident.assignedDepartments,location:{building:incident.location.building,floor:incident.location.floor,room:incident.location.room},message:event==='sos.created'?`New ${incident.priority} SOS: ${incident.id}`:`SOS ${incident.id} is now ${incident.status.replaceAll('_',' ').toLowerCase()}`,timestamp:new Date().toISOString()});

const server=createServer(async(req,res)=>{try{rate(req);const url=new URL(req.url||'/','http://local'),path=url.pathname;
 if(path==='/api/health')return json(res,200,{status:'ok',websocket:'/ws',time:new Date().toISOString()});
 if((path==='/api/auth/login'||path==='/api/auth/demo')&&req.method==='POST'){
  const b=await body(req);
  const u=createSessionUser({name:b.name||b.userId||'User',regdNo:b.regdNo||b.userId||b.id||'REG-001',role:b.role||'STUDENT',departmentId:b.departmentId});
  return json(res,200,{token:issueToken(u),user:u});
 }
 if(path==='/api/auth/users')return json(res,200,[]);
 if(path==='/api/categories')return json(res,200,categories);
 if(path.startsWith('/api/')){const u=authenticate(req);
  if(path==='/api/sos'&&req.method==='POST'){const result=await createIncident(await body(req),u,req.socket.remoteAddress);broadcast(eventPayload('sos.created',result));return json(res,201,result)}
  if((path==='/api/sos/my'||path==='/api/sos/active'||path==='/api/sos/admin')&&req.method==='GET'){if(path.endsWith('/admin')&&!isAdmin(u)&&u.role!=='DEPARTMENT_HEAD')return json(res,403,{error:'Admin only'});return json(res,200,await listIncidents(u,Object.fromEntries(url.searchParams)))}
  if(path==='/api/sos/stats'&&req.method==='GET'){if(!isAdmin(u)&&u.role!=='DEPARTMENT_HEAD')return json(res,403,{error:'Admin only'});return json(res,200,await stats())}
  if(path==='/api/sos/export.csv'&&req.method==='GET'){const csv=await exportCsv(u);res.writeHead(200,{'content-type':'text/csv','content-disposition':'attachment; filename="sos-incidents.csv"'});return res.end(csv)}
  const match=path.match(/^\/api\/sos\/([^/]+)(?:\/(accept|respond|arrive|resolve|cancel))?$/);if(match){const [,id,action]=match;if(req.method==='GET'&&!action)return json(res,200,await getIncident(id,u));if(req.method==='POST'&&action){const map={accept:'ACCEPTED',respond:'RESPONDING',arrive:'ARRIVED',resolve:'RESOLVED',cancel:'CANCELLED'},result=await changeStatus(id,map[action],await body(req),u,req.socket.remoteAddress);broadcast(eventPayload(`sos.${action}`,result));return json(res,200,result)}}
  return json(res,404,{error:'API route not found'});
 }
 const dist=join(process.cwd(),'dist'),requested=path==='/'?'index.html':normalize(path).replace(/^(\.\.[/\\])+/,'').replace(/^[/\\]+/,''),file=join(dist,requested),target=existsSync(file)?file:join(dist,'index.html');if(existsSync(target)){const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};res.writeHead(200,{'content-type':mime[extname(target)]||'application/octet-stream'});return res.end(readFileSync(target))}return json(res,404,{error:'Not found'});
 }catch(e){json(res,e.status||500,{error:e.status?e.message:'Internal server error',incidentId:e.incidentId})}});

const wss=new WebSocketServer({noServer:true,handleProtocols:protocols=>protocols.has('sos')?'sos':false});
function allowed(user,event){
 if(!user)return false;
 if(isAdmin(user))return true;
 if(user.role==='STUDENT')return event.studentId===user.id;
 if(['RESPONDER','DEPARTMENT_HEAD','TEACHER'].includes(user.role)){
  if(!user.departmentId||user.departmentId==='DEPT_ADMIN'||user.departmentId==='ALL')return true;
  return event.assignedDepartments&&event.assignedDepartments.includes(user.departmentId);
 }
 return false;
}
function broadcast(event){const encoded=JSON.stringify(event);for(const ws of wss.clients)if(ws.readyState===WebSocket.OPEN&&allowed(ws.user,event))ws.send(encoded)}
server.on('upgrade',(req,socket,head)=>{try{const url=new URL(req.url||'/','http://local');if(url.pathname!=='/ws')throw new Error('Unknown WebSocket route');const protocols=String(req.headers['sec-websocket-protocol']||'').split(',').map(x=>x.trim()),token=protocols[1];if(!token)throw new Error('Authentication required');req.headers.authorization=`Bearer ${token}`;const user=authenticate(req);wss.handleUpgrade(req,socket,head,ws=>{ws.user=user;ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);ws.send(JSON.stringify({event:'connection.ready',message:'Live SOS notifications connected',timestamp:new Date().toISOString()}));wss.emit('connection',ws,req)})}catch{socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy()}});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(ws.isAlive===false){ws.terminate();continue}ws.isAlive=false;ws.ping()}},30000);heartbeat.unref();
await initDatabase();
server.listen(port,()=>console.log(`SOS server listening on http://localhost:${port} with WebSocket notifications at /ws`));
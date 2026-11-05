// One-instance native bridge acceptance: general checkpoints, bounded inputs and acknowledged captures.
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {createServer} from './server.mjs';
import {nativeCommand} from './movie.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
if(execFileSync('powershell.exe',['-NoProfile','-Command',"@(Get-Process -Name 'blastem*' -ErrorAction SilentlyContinue).Count"],{encoding:'utf8',windowsHide:true}).trim()!=='0')throw Error('Close the existing BlastEm instance first');
const dir=path.resolve('rea/test-output/bridge-'+Date.now());await mkdir(dir,{recursive:true});
const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const command=line=>nativeCommand(port,line),server=createServer(dir,{movie:{command}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const stream=await server.listenStream(0),root=`http://127.0.0.1:${server.address().port}`;
const child=spawn(path.resolve('blastem-raster.exe'),['-g',path.resolve(process.argv[2]||'rea/test-output/inspection-test.bin')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BLASTEM_REA_DIR:dir,BLASTEM_REA_CONTROL_PORT:String(port),BLASTEM_REA_STREAM_PORT:String(stream.port),BLASTEM_REA_BROWSER_ONLY:'1',BLASTEM_REA_CAPTURE_EVERY:'1'}});
let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
const get=async route=>{const r=await fetch(root+route);if(!r.ok)throw Error(await r.text());return r.json();};
const post=async(route,body)=>{const r=await fetch(root+route,{method:'POST',headers:{Origin:root,'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await r.json();if(!r.ok)throw Object.assign(Error(JSON.stringify(data)),{status:r.status});return data;};
async function wait(work,ms=15000){const end=Date.now()+ms;while(Date.now()<end){try{const value=await work();if(value)return value;}catch{}await sleep(30);}throw Error('Timed out: '+log.slice(-1600));}
const capture=async()=>{const result=await post('/api/control',{action:'pause_capture',owner:'native-test'}),s=await get('/api/snapshot?snapshot='+result.capture.capture);assert.equal(s.id.split('-').at(-1),String(result.state.capture_sequence));assert.equal(s.frame,result.state.capture_frame);return s;};
const hashes=s=>Object.fromEntries(['ram','zram','vram','cram','vsram','regs','rgb','raster_rgba','raster_samples','raster_flags'].filter(f=>s[f]).map(f=>[f,createHash('sha256').update(s[f]).digest('hex')]));
try{
  await wait(async()=>{const s=await get('/api/session');return s.machine.protocol===2&&s.evidence.frame>5;});
  const initial=await capture();console.log('Acknowledged capture',initial.frame,initial.id);
  await post('/api/control',{action:'checkpoint_save',name:'Repeatable experiment'});const checkpoint=(await get('/api/checkpoints'))[0];assert.ok(checkpoint.id);
  const results=[];
  for(let i=0;i<2;i++){
    if(i)await post('/api/control',{action:'checkpoint_restore',id:checkpoint.id});
    await post('/api/control',{action:'run',frames:45,p1:0x120,p2:0});
    await wait(async()=>{const s=await command('status');return s.paused&&s.experiment_remaining===0&&s.experiment_completed===45;});
    const s=await capture();results.push({frame:s.frame,cpu:s.cpu_cycles,vdp:s.vdp_cycles,hashes:hashes(s)});
  }
  assert.deepEqual(results[0],results[1],'Restored experiments must reproduce all captured render/evidence/memory buffers and cycles');console.log('Checkpoint experiment matched twice',results[0].frame);
  const frame=(await command('status')).machine_frame;await post('/api/control',{action:'step'});await wait(async()=>{const s=await command('status');return s.paused&&s.machine_frame===frame+1;});
  const movie=await post('/api/movie',{action:'record',title:'Read-only guard test'});await sleep(200);await post('/api/movie',{action:'pause'});
  await assert.rejects(()=>post('/api/control',{action:'checkpoint_save',name:'Must reject'}),e=>e.status===409);
  await post('/api/movie',{action:'stop'});await post('/api/movie',{action:'replay',id:movie.id});await post('/api/movie',{action:'pause'});
  await assert.rejects(()=>post('/api/control',{action:'run',frames:2,p1:2,p2:0}),e=>e.status===409);
  await post('/api/movie',{action:'stop'});
  const stoppedFrame=(await command('status')).machine_frame;await post('/api/control',{action:'step'});await wait(async()=>{const s=await command('status');return s.paused&&s.machine_frame===stoppedFrame+1;});
  const s=await capture(),note=await post('/api/comments',{snapshot:s.id,title:'General session evidence',markdown:'A captured observation outside a movie.'});assert.equal(note.movie,null);assert.equal(note.capture,s.id);
  const saved=await get('/api/snapshot?snapshot='+s.id);assert.equal(saved.ram,s.ram);
  await writeFile(path.join(dir,'result.json'),JSON.stringify({passed:true,checkpoint,results,note},null,2));console.log('PASS',dir);
}finally{if(child.exitCode===null){child.kill();await once(child,'exit');}await new Promise(r=>server.close(r));await writeFile(path.join(dir,'native.log'),log);}

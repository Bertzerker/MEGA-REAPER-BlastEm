// Integration proof with ONE native child, no pre-existing emulator allowed.
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from './server.mjs';
import {nativeCommand,crc32} from './movie.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const existing=execFileSync('powershell.exe',['-NoProfile','-Command',"@(Get-Process -Name 'blastem*' -ErrorAction SilentlyContinue).Count"],{encoding:'utf8',windowsHide:true}).trim();
if(existing!=='0')throw Error('Close the existing BlastEm instance before running this test');
const dir=path.resolve('rea/test-output/movie-'+Date.now());await mkdir(dir,{recursive:true});
const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const frames=new Map(),differences=[];
const duration=Number(process.env.REA_MOVIE_TEST_MS||700),loops=Number(process.env.REA_MOVIE_TEST_LOOPS||1);
const digest=s=>Object.fromEntries(['ram','vram','cram','vsram','regs','rgb','zram'].map(field=>[field,createHash('sha256').update(s[field]).digest('hex')]));
const command=line=>nativeCommand(port,line),server=createServer(dir,{movie:{command},onCapture:s=>{
  if(s.movie?.mode==='recording')frames.set(s.movie.frame,{cpu_cycles:s.cpu_cycles,vdp_cycles:s.vdp_cycles,hashes:digest(s)});
  if(s.movie?.mode==='playback'){
    const recorded=frames.get(s.movie.frame);if(!recorded)return;
    const compare={frame:s.movie.frame,cpu:s.cpu_cycles-recorded.cpu_cycles,vdp:s.vdp_cycles-recorded.vdp_cycles};
    const hashes=digest(s);for(const field of Object.keys(hashes))if(hashes[field]!==recorded.hashes[field])compare[field]='mismatch';
    if(Object.keys(compare).length>3||compare.cpu||compare.vdp)differences.push(compare);
  }
}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const stream=await server.listenStream(0),root=`http://127.0.0.1:${server.address().port}`;
const child=spawn(path.resolve('blastem-raster.exe'),['-g',path.resolve(process.argv[2]||'rea/test-output/inspection-test.bin')],{windowsHide:true,env:{...process.env,BLASTEM_REA_DIR:dir,BLASTEM_REA_CONTROL_PORT:String(port),BLASTEM_REA_STREAM_PORT:String(stream.port),BLASTEM_REA_BROWSER_ONLY:'1',BLASTEM_REA_CAPTURE_EVERY:'1'},stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
const post=async body=>{const r=await fetch(root+'/api/movie',{method:'POST',headers:{Origin:root,'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
async function wait(test,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){try{const result=await test();if(result)return result;}catch{}await sleep(35);}throw Error('Timed out waiting for native movie: '+log.slice(-1800));}
try{
  await wait(async()=>{const s=await command('status');return s;});
  await wait(async()=>{const r=await fetch(root+'/api/snapshot');return r.ok&&(await r.json()).frame>5;});
  const start=await post({action:'record',title:'Native deterministic replay test'});console.log('Recording',start);
  await post({action:'pad',port:1,button:8,down:true});await sleep(150);await post({action:'pad',port:1,button:8,down:false});
  const until=Date.now()+duration;let button=0;
  while(Date.now()<until){const b=[4,5,8,1][button++%4];await post({action:'pad',port:1,button:b,down:true});await sleep(Math.min(200,Math.max(0,until-Date.now())));await post({action:'pad',port:1,button:b,down:false});await sleep(50);}
  await post({action:'pause'});const paused=await command('status');await sleep(100);assert.equal((await command('status')).frame,paused.frame);
  const before=await (await fetch(root+'/api/snapshot')).json();
  assert.equal(before.movie.id,start.id);
  const response=await fetch(root+'/api/comments',{method:'POST',headers:{Origin:root,'Content-Type':'application/json'},body:JSON.stringify({snapshot:before.id,title:'Recorded frame',markdown:'```json\n{"test":true}\n```\n\n```mermaid\nflowchart LR\nInput --> VDP\n```'})});
  assert.equal(response.status,201,await response.clone().text());const note=await response.json();
  await post({action:'step'});await wait(async()=>(await command('status')).frame===paused.frame+1);assert.equal((await command('status')).paused,true);
  await post({action:'speed',speed:50});await post({action:'play'});await sleep(250);await post({action:'stop'});
  const length=(await (await fetch(root+'/api/movies')).json())[0].length;assert.ok(length>20);console.log('Recorded frames',length);
  await post({action:'speed',speed:100});let ended;
  for(let loop=0;loop<loops;loop++){
  await post({action:'replay',id:start.id});
  ended=await wait(async()=>{const s=await command('status');return s.mode==='ended'?s:null;},Math.max(20000,duration*2));
  console.log('Replay differences',differences.slice(0,20));await writeFile(path.join(dir,'differences.json'),JSON.stringify(differences,null,2));
  if(ended.desync){const frame=ended.frame;await writeFile(path.join(dir,'recorded-mismatch.json'),JSON.stringify(frames.get(frame),(key,value)=>ArrayBuffer.isView(value)?Buffer.from(value).toString('hex'):value));}
  assert.equal(ended.desync,false,JSON.stringify(ended));assert.equal(ended.frame,length-1);assert.equal(ended.paused,true);console.log('Replay verified',ended);
  }
  const zip=await fetch(root+`/api/movies/${start.id}/export`);assert.equal(zip.status,200);await writeFile(path.join(dir,'investigation.zip'),Buffer.from(await zip.arrayBuffer()));
  const inputsPath=path.join(dir,'movies',start.id,'inputs.rmt'),statePath=path.join(dir,'movies',start.id,'start.state');
  const originalInputs=await readFile(inputsPath),originalState=await readFile(statePath);
  try{
    const wrongRom=Buffer.from(originalInputs);wrongRom[8]^=1;await writeFile(inputsPath,wrongRom);
    await assert.rejects(()=>command('replay '+start.id),/exact recorded ROM/);
    const wrongConfig=Buffer.from(originalState);wrongConfig[0]^=1;
    const changedHeader=Buffer.from(originalInputs);changedHeader.writeUInt32LE(crc32(wrongConfig),52);
    await writeFile(statePath,wrongConfig);await writeFile(inputsPath,changedHeader);
    await assert.rejects(()=>command('replay '+start.id),/configuration differs/);
  }finally{await writeFile(inputsPath,originalInputs);await writeFile(statePath,originalState);}
  const evidence=await readFile(path.join(dir,'comments',note.id,'note.json'));assert.equal(JSON.parse(evidence).capture,before.id);
  assert.equal(differences.length,0,'Every captured render, memory space and cycle counter must match');
  await writeFile(path.join(dir,'result.json'),JSON.stringify({passed:true,length,loops,ended,note,root},null,2));console.log('PASS',dir);
}finally{
  if(child.exitCode===null){child.kill();await once(child,'exit');}
  await new Promise(r=>server.close(r));await writeFile(path.join(dir,'native.log'),log);
}

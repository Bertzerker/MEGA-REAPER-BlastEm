import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gunzipSync,inflateSync} from 'node:zlib';
import {MovieStore,png,crc32} from '../movie.mjs';
import {createServer} from '../server.mjs';
const fixture=id=>({schema:1,id:'capture-123',frame:127,width:1,height:1,mode5:true,interlace:false,
  movie:{id,frame:12,mode:'recording'},raster:{valid:true,complete:true,layers:['sprites','a','b','window','source']},raster_rgba:new Uint8Array(20),raster_samples:new Uint8Array(4),raster_flags:new Uint8Array(1),regs:new Uint8Array(24),vram:new Uint8Array(65536),cram:new Uint8Array(128),vsram:new Uint8Array(80),ram:Uint8Array.of(12,34),zram:new Uint8Array(8192),rgb:Uint8Array.of(11,22,33)});
test('lossless PNG encoder writes checksummed RGBA rows',()=>{
  const bytes=png(2,1,Uint8Array.of(1,2,3,255,4,5,6,255));let pos=8,rows;
  while(pos<bytes.length){const n=bytes.readUInt32BE(pos),type=bytes.subarray(pos+4,pos+8),data=bytes.subarray(pos+8,pos+8+n);assert.equal(crc32(Buffer.concat([type,data])),bytes.readUInt32BE(pos+8+n));if(type.toString()==='IDAT')rows=inflateSync(data);pos+=n+12;}
  assert.deepEqual([...rows],[0,1,2,3,255,4,5,6,255]);
});
test('movie library and frame notes survive restart with exact evidence and portable exports',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'rea-movie-'));let commands=[];
  const command=async line=>{commands.push(line);if(line.startsWith('record ')){const id=line.slice(7),header=Buffer.alloc(64);header.write('RMTAS001');await writeFile(path.join(dir,'movies',id,'inputs.rmt'),header);await writeFile(path.join(dir,'movies',id,'start.state'),Buffer.from('checkpoint'));return {id,mode:'recording'};}return {mode:'idle'};};
  try{
    const store=new MovieStore(dir,{command}),movie=await store.control({action:'record',title:'Investigation'}),s=fixture(movie.id);
    const note=await store.annotate(s,{title:'Sprite source',markdown:'Observed **change**.\n\n```json\n{"address":"0xFF0000"}\n```\n\n```mermaid\nflowchart LR\n A --> B\n```\n'});
    s.ram[0]=99;
    const saved=JSON.parse(gunzipSync(await store.artifact(note.id,'snapshot.json.gz')));assert.equal(saved.ram,'0c22');assert.equal(saved.movie.frame,12);
    const restarted=new MovieStore(dir,{command});assert.equal((await restarted.movies())[0].title,'Investigation');assert.equal((await restarted.comments())[0].capture,'capture-123');
    await assert.rejects(()=>restarted.updateNote(note.id,{title:'Bad JSON',markdown:'```json\n{bad}\n```'}));
    await assert.rejects(()=>restarted.updateNote(note.id,{title:'Bad JSON',markdown:'~~~json\n{bad}\n~~~'}));
    await restarted.updateNote(note.id,{title:'Edited',markdown:'Corrected observation'});
    assert.match((await restarted.artifact(note.id,'note.md')).toString(),/Corrected observation/);
    await assert.rejects(()=>store.control({action:'replay',id:'../outside'}),/Invalid ID/);
    await assert.rejects(()=>store.artifact(note.id,'../../secret'),/Unknown evidence/);
    const exported=await restarted.exportMovie(movie.id);assert.equal(exported.readUInt32LE(),0x04034b50);assert.ok(exported.includes(Buffer.from('inputs.json')));assert.ok(exported.includes(Buffer.from('snapshot.json.gz')));
    await store.control({action:'speed',speed:50});assert.ok(commands.includes('speed 50'));
    await assert.rejects(()=>store.control({action:'speed',speed:-1}),/Invalid movie/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('movie API rejects cross-origin writes and binds notes to the requested capture',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'rea-movie-api-')),server=createServer(dir,{movie:{command:async()=>({mode:'idle',paused:true})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const root=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(root+'/api/movie')).status,200);
    const body=JSON.stringify({action:'pause'});
    assert.equal((await fetch(root+'/api/movie',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://foreign.example'},body})).status,403);
    assert.equal((await fetch(root+'/api/movie',{method:'POST',headers:{'Content-Type':'application/json',Origin:root},body})).status,200);
    const response=await fetch(root+'/api/comments',{method:'POST',headers:{'Content-Type':'application/json',Origin:root},body:JSON.stringify({snapshot:'expired',title:'Frame',markdown:''})});assert.equal(response.status,409);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

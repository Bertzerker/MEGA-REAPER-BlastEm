import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {MovieStore} from '../movie.mjs';
import {SessionBridge,FrameWatch,compatible,contextOf} from '../bridge.mjs';
import {NoteDraft} from '../public/note-model.mjs';
import {createServer} from '../server.mjs';
import {pack,unpack} from '../protocol.mjs';
import {AtlasPresenter} from '../public/presenter.mjs';
class Storage {
  constructor(){this.map=new Map();}get length(){return this.map.size;}key(i){return [...this.map.keys()][i];}getItem(k){return this.map.get(k)||null;}setItem(k,v){this.map.set(k,v);}removeItem(k){this.map.delete(k);}
}
const note={id:'note',title:'Original',markdown:'Observation',classification:'observed',revision:1};
test('editor recovers drafts, isolates tabs, rebases conflicts and retains typing during saves',async()=>{
  const storage=new Storage(),one=new NoteDraft(storage,'project','one').open(note);one.set({markdown:'Unsaved investigation'});
  const reload=new NoteDraft(storage,'project','one').open(note);assert.equal(reload.fields.markdown,'Unsaved investigation');assert.equal(reload.recovered,true);
  const two=new NoteDraft(storage,'project','two').open(note);two.set({markdown:'Independent second tab'});assert.equal(reload.read(reload.key()).fields.markdown,'Unsaved investigation');
  assert.equal(two.foreign()[0].fields.markdown,'Unsaved investigation');
  const latest={...note,revision:2,markdown:'Server update'};
  await assert.rejects(()=>reload.save(async()=>{throw Object.assign(Error('Conflict'),{latest});}));assert.equal(reload.fields.markdown,'Unsaved investigation');assert.equal(reload.revision,1);
  reload.rebase();assert.equal(reload.revision,2);assert.equal(reload.fields.markdown,'Unsaved investigation');
  let resolve;const pending=reload.save(()=>new Promise(r=>resolve=r));reload.set({markdown:'Typed while saving'});resolve({...latest,revision:3,markdown:'Unsaved investigation'});await pending;
  assert.equal(reload.fields.markdown,'Typed while saving');assert.equal(reload.dirty,true);assert.equal(reload.read(reload.key()).revision,3);
  reload.discard();assert.equal(reload.dirty,false);assert.equal(reload.fields.markdown,'Unsaved investigation');assert.equal(two.fields.markdown,'Independent second tab');
});
function fixture(frame=1){const count=16*8;return {schema:1,id:`111-222-${frame}`,frame,width:16,height:8,active_height:8,mode5:true,interlace:false,movie:{id:'12345678-1234-4234-8234-123456789abc',mode:'recording',frame,rom_sha1:'rom-a',build_sha1:'build-a'},raster:{valid:true,complete:true,width:16,height:8,layers:['sprites','a','b','window','source']},regs:new Uint8Array(24),vram:new Uint8Array(65536),cram:new Uint8Array(128),vsram:new Uint8Array(80),ram:new Uint8Array(65536),zram:new Uint8Array(8192),rgb:new Uint8Array(count*3).fill(frame),raster_rgba:new Uint8Array(count*20),raster_samples:new Uint8Array(count*4),raster_flags:new Uint8Array(count)};}
test('note revisions serialize concurrent saves and preserve immutable archived evidence',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'rea-revisions-')),store=new MovieStore(dir),other=new MovieStore(dir);
  try{
    const original=await store.annotate(fixture(),{title:'Original',markdown:'Text'});assert.equal(original.revision,1);
    const before=await store.artifact(original.id,'snapshot.json.gz');
    const results=await Promise.allSettled([store.updateNote(original.id,{revision:1,title:'First tab',markdown:'A'}),other.updateNote(original.id,{revision:1,title:'Second tab',markdown:'B'})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const saved=JSON.parse(await store.artifact(original.id,'note.json'));assert.equal(saved.revision,2);
    await assert.rejects(()=>store.updateNote(original.id,{revision:1,title:'Stale',markdown:'Do not overwrite'}),e=>e.code==='revision_conflict'&&e.latest.revision===2);
    await assert.rejects(()=>store.updateNote(original.id,{title:'Missing revision',markdown:'No'}),e=>e.status===428);
    assert.deepEqual(await store.artifact(original.id,'snapshot.json.gz'),before);
    const snapshot=await other.savedSnapshot(original.id);assert.equal(snapshot.id,'111-222-1');assert.equal(snapshot.rgb[0],1);
    const damaged=Buffer.from(before);damaged[20]^=1;await writeFile(path.join(dir,'comments',original.id,'snapshot.json.gz'),damaged);await assert.rejects(()=>other.savedSnapshot(original.id),/integrity/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('pinned selection survives history eviction; saved review works after restart without a producer',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'rea-context-'));let server=createServer(dir),producer;
  const listen=async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;};
  let root=await listen();const source=await server.listenStream(0);producer=net.connect(source.port,'127.0.0.1');await once(producer,'connect');
  const post=(url,body)=>fetch(root+url,{method:'POST',headers:{Origin:root,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const publish=async s=>{const bytes=pack(s),size=Buffer.alloc(4);size.writeUInt32LE(bytes.length);producer.write(Buffer.concat([size,bytes]));for(let i=0;i<100;i++){const r=await fetch(root+'/api/snapshot');if(r.ok&&(await r.json()).id===s.id)return;await new Promise(r=>setTimeout(r,5));}throw Error('Capture not ingested');};
  try{
    const first=fixture();first.ram[0]=17;await publish(first);assert.equal((await post('/api/evidence/pin',{capture:first.id,owner:'browser-one',purpose:'view'})).status,200);
    for(let i=2;i<=22;i++)await publish(fixture(i));
    assert.equal((await (await fetch(root+'/api/snapshot?snapshot='+first.id)).json()).ram.slice(0,2),'11');
    const noteResponse=await post('/api/comments',{snapshot:first.id,title:'Original selected pixel',markdown:''}),note=await noteResponse.json();assert.equal(note.capture,first.id);
    const foreign=fixture(23);foreign.movie.rom_sha1='rom-b';await publish(foreign);
    const conflict=await fetch(root+`/api/diff?from=${first.id}&snapshot=${foreign.id}&length=1`);assert.equal(conflict.status,409);
    producer.destroy();await new Promise(r=>server.close(r));server=createServer(dir);root=await listen();
    const saved=await fetch(root+'/api/evidence?note='+note.id);assert.equal(saved.status,200);const image=unpack(await saved.arrayBuffer());assert.equal(image.id,first.id);assert.equal(image.ram[0],17);assert.equal(image.archive.note,note.id);
    const pixel=await (await fetch(root+`/api/pixel?snapshot=${first.id}&view=composite&x=0&y=0`)).json();assert.deepEqual(pixel.rgb,[1,1,1]);
    assert.equal((await post('/api/evidence/pin',{capture:'expired',owner:'browser-one'})).status,409);
    const state=await (await fetch(root+'/api/session')).json();assert.equal(state.connection.producer,'disconnected');assert.equal(state.capabilities.pause.available,false);assert.doesNotMatch(state.connection.reason,/updated launcher/i);
  }finally{producer?.destroy();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('capabilities distinguish unsupported hardware, renderer and movie read-only rules',async()=>{
  const movies={command:async()=>({protocol:2,mode:'idle',paused:true,movie_supported:false,movie_reason:'Unsupported controller'})};
  const bridge=new SessionBridge('.',movies),state=await bridge.describe({producer:true,latest:{...fixture(),raster:{valid:false}}});
  assert.equal(state.capabilities.record.supported,false);assert.equal(state.capabilities.checkpoint.available,false);assert.match(state.capabilities.record.reason,/controller/);assert.match(state.capabilities.renderer.reason,/capture/);
  movies.command=async()=>({protocol:2,mode:'playback',paused:true,movie_supported:true});const replay=await bridge.describe({producer:true,latest:fixture()});assert.equal(replay.capabilities.browser_input.available,false);assert.equal(replay.capabilities.pause.available,true);assert.equal(replay.capabilities.checkpoint.available,false);
});
test('input pagination reports both controllers, next-frame convention and checksum without rewriting the log',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'rea-inputs-')),id='12345678-1234-4234-8234-123456789abc';
  try{
    const store=new MovieStore(dir,{command:async line=>{const {mkdir}=await import('node:fs/promises');await mkdir(path.join(dir,'movies',id),{recursive:true});return {id};}});
    const {mkdir}=await import('node:fs/promises');await mkdir(path.join(dir,'movies',id),{recursive:true});
    const bytes=Buffer.alloc(56+16);bytes.write('RMTAS001');bytes.writeUInt16LE(1<<5,56);bytes.writeUInt16LE(1<<8,58);bytes.writeUInt32LE(0x12345678,60);bytes.writeUInt16LE(1<<4,64);
    const file=path.join(dir,'movies',id,'inputs.rmt');await writeFile(file,bytes);
    const page=await store.inputRows(id,0,1);assert.equal(page.total,2);assert.equal(page.rows[0].next_frame,1);assert.deepEqual(page.rows[0].buttons1,['a']);assert.deepEqual(page.rows[0].buttons2,['start']);assert.equal(page.rows[0].checksum,'12345678');assert.match(page.convention,/after capture/);
    assert.equal((await store.inputRows(id,2,60)).rows.length,0);await assert.rejects(()=>store.inputRows(id,0,257));assert.deepEqual(await readFile(file),bytes);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('frame watches have bounded ranges, explicit stop timing and ROM/session guards',()=>{
  const watch=new FrameWatch();assert.throws(()=>watch.start({length:1025}));watch.start({frames:2,length:1});const a=fixture(),b=fixture(2);b.ram[0]=5;watch.ingest(a);watch.ingest(b);assert.equal(watch.status().active,false);assert.equal(watch.status().events[0].capture,b.id);assert.equal(watch.status().events[0].changes[0].after,5);
  watch.start({frames:1000,length:1});for(let i=0;i<502&&watch.status().active;i++){const s=fixture(i+1);s.ram[0]=i%2;watch.ingest(s);}assert.equal(watch.status().truncated,true);assert.equal(watch.status().events.length,500);
  watch.start({frames:10});watch.ingest(a);const c=fixture(3);c.id='999-888-3';watch.ingest(c);assert.match(watch.status().reason,/session/);assert.equal(compatible(contextOf(a),contextOf(c)),false);
});
test('focus changes crop the original texture without extra uploads',()=>{
  let uploads=0;const noop=()=>{},gl=new Proxy({createShader:()=>({}),createProgram:()=>({}),getShaderParameter:()=>true,getProgramParameter:()=>true,createBuffer:()=>({}),createTexture:()=>({}),getUniformLocation:()=>({}),getAttribLocation:()=>0,texImage2D:()=>uploads++,texSubImage2D:()=>uploads++},{get:(target,key)=>key in target?target[key]:typeof key==='string'&&key===key.toUpperCase()?1:noop});
  const canvas={width:1,height:1,getContext:()=>gl},presenter=new AtlasPresenter(canvas),s=fixture();s.atlas={width:48,height:64,panels:[{view:'composite',x:0,y:24,width:16,height:8},{view:'sprites',x:16,y:24,width:16,height:8}]};s.atlasPixels=new Uint8Array(48*64*4);
  presenter.draw(s,false,'all');presenter.draw(s,false,'sprites');presenter.draw(s,false,'composite');assert.equal(uploads,1);assert.equal(canvas.width,16);assert.equal(presenter.region.x,0);
  presenter.draw({...s,id:'next',atlasPixels:s.atlasPixels.slice()});assert.equal(uploads,2);
});

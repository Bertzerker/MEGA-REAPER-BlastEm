import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
import {once} from 'node:events';
import {mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pack,unpack,FrameReader} from '../protocol.mjs';
import {AtlasRenderer} from '../atlas.mjs';
import {createServer} from '../server.mjs';
import {palette,planePixel,spritePixel,sprites,tilePixel} from '../public/decoder.mjs';
test('standalone REA starts through a directory alias', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-alias-'));
  const alias = path.join(root, 'launcher path Ω');
  const source = fileURLToPath(new URL('../', import.meta.url));
  let child, timer;
  try {
    await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    child = spawn(process.execPath, [path.join(alias, 'server.mjs')], {
      env: {...process.env, PORT: '0', BLASTEM_REA_STREAM_PORT: '0', BLASTEM_REA_DIR: path.join(root, 'session')},
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => {
        stdout += bytes;
        if (stdout.includes('REA: http://127.0.0.1:')) resolve();
      });
      child.stderr.on('data', bytes => { stderr += bytes; });
      child.once('error', reject);
      child.once('exit', code => reject(Error(`Server exited before startup (${code}). ${stderr}`)));
      timer = setTimeout(() => reject(Error('Alias server startup timed out.')), 5000);
    });
  } finally {
    clearTimeout(timer);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    await rm(alias, {force: true});
    await rm(root, {recursive: true, force: true});
  }
});
function fixture(){
  const s={schema:1,id:'stream-test-1',frame:1,width:16,height:8,active_height:8,mode5:true,interlace:false,
    regs:new Uint8Array(24),vram:new Uint8Array(65536),cram:new Uint8Array(128),vsram:new Uint8Array(80),ram:new Uint8Array(65536),zram:new Uint8Array(8192),rgb:new Uint8Array(16*8*3)};
  s.regs[2]=0x30;s.regs[4]=7;s.regs[5]=0x6c;s.regs[3]=0x2c;s.cram[3]=14;s.vram.fill(0x11,32,64);
  for(const a of [0xc000,0xe000,0xb000])for(let i=0;i<1024;i++){s.vram[a+i*2]=0;s.vram[a+i*2+1]=1;}
  s.vram[0xd801]=128;s.vram[0xd805]=1;s.vram[0xd807]=128;
  for(let i=0;i<s.rgb.length;i+=3)s.rgb[i+1]=255;
  s.ram.set([0x12,0x34,0x56,0x78]);return s;
}
test('native packet framing handles fragmentation, coalescing and size limits',()=>{
  const s=fixture(),packet=pack(s),prefix=Buffer.alloc(4);prefix.writeUInt32LE(packet.length);
  const input=Buffer.concat([prefix,packet,prefix,packet]),frames=[],reader=new FrameReader(p=>frames.push(unpack(p)));
  for(let i=0;i<input.length;i+=137)reader.push(input.subarray(i,i+137));
  assert.equal(frames.length,2);assert.deepEqual(frames[0].ram,s.ram);assert.deepEqual(frames[1].rgb,s.rgb);
  const bad=Buffer.alloc(4);bad.writeUInt32LE(2**30);assert.throws(()=>new FrameReader(()=>{}).push(bad),/size/);
});
test('one atlas retains all six reference images and panel coordinate mapping',()=>{
  const s=fixture(),combined=new AtlasRenderer().render(s),roundtrip=unpack(pack(combined)),list=sprites(s);
  assert.equal(roundtrip.atlas.panels.length,6);
  const {width}=roundtrip.atlas,rgba=roundtrip.atlasPixels;
  for(const panel of roundtrip.atlas.panels){
    for(let y=0;y<panel.height;y++)for(let x=0;x<panel.width;x++){
      let expected;
      if(panel.view==='composite')expected=[...s.rgb.slice((y*s.width+x)*3,(y*s.width+x)*3+3),255];
      else {
        const p=panel.view==='tiles'?tilePixel(s,(y>>3)*64+(x>>3),x,y):panel.view==='sprites'?spritePixel(s,list,x,y):planePixel(s,panel.view,x,y);
        expected=p.value?palette(s,p.palette*16+p.value):[0,0,0,0];
      }
      const offset=((panel.y+y)*width+panel.x+x)*4;
      assert.deepEqual(Array.from(rgba.subarray(offset,offset+4)),expected);
    }
  }
});
test('TCP capture becomes one WebSocket atlas; JSON/API snapshots remain pinned',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'rea-stream-')),server=createServer(dir);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=await server.listenStream(0),root=`http://127.0.0.1:${server.address().port}`;
  const ws=new WebSocket(root.replace('http:','ws:')+'/stream',{origin:root});
  await once(ws,'open');
  assert.equal(ws.extensions,'');
  const client=net.connect(address.port,'127.0.0.1');await once(client,'connect');
  function send(s){const data=pack(s),length=Buffer.alloc(4);length.writeUInt32LE(data.length);client.write(Buffer.concat([length,data]));}
  try{
    const received=once(ws,'message'),s=fixture();send(s);const [message]=await received;
    const image=unpack(message);assert.equal(image.id,s.id);assert.equal(image.atlas.panels.length,6);
    const capture=await (await fetch(root+'/api/snapshot')).json();assert.equal(capture.ram.slice(0,8),'12345678');
    for(let i=2;i<=20;i++){const next=once(ws,'message');send({...s,id:`stream-test-${i}`,frame:i});await next;}
    const memory=await (await fetch(root+`/api/memory?snapshot=${s.id}&length=4`)).json();
    assert.deepEqual(memory.bytes,[18,52,86,120]);
    const metrics=await (await fetch(root+'/api/metrics')).json();assert.equal(metrics.ingested,20);
    assert.equal(metrics.native_gaps,0);assert.ok(metrics.received_bytes>0);assert.ok(metrics.pipeline_p95_ms>=0);
    const afterGap=once(ws,'message');send({...s,id:'stream-test-22',frame:22});await afterGap;
    assert.equal((await (await fetch(root+'/api/metrics')).json()).native_gaps,1);
    const rawClient=new WebSocket(root.replace('http:','ws:')+'/stream',{origin:root,perMessageDeflate:false});
    const rawMessage=once(rawClient,'message');
    try{
      await once(rawClient,'open');assert.equal(rawClient.extensions,'');
      const [packet]=await rawMessage,rawImage=unpack(packet);
      assert.equal(rawImage.id,'stream-test-22');assert.deepEqual(rawImage.rgb,s.rgb);
    }finally{rawClient.terminate();}
  }finally{client.destroy();ws.terminate();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

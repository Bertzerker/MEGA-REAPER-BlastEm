import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from '../server.mjs';
import {unpack} from '../public/transport.mjs';
test('snapshot API pins data, diffs memory, bounds reads and expires history',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'rea-'));
  const server=createServer(dir);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  const request=async p=>{const r=await fetch(root+p);return {status:r.status,body:await r.json()};};
  const raw={schema:1,id:'first',frame:1,mode5:true,interlace:false,regs:'00'.repeat(24),vram:'00'.repeat(65536),cram:'00'.repeat(128),vsram:'00'.repeat(80),ram:'12345678',zram:'00'.repeat(8192),rgb:'112233',width:1,height:1};
  const publish=()=>writeFile(path.join(dir,'snapshot.json'),JSON.stringify(raw));
  try {
    assert.equal((await request('/api/snapshot')).status,503);
    await publish();assert.equal((await request('/api/snapshot')).body.id,'first');
    const live=await fetch(root+'/api/live'),tag=live.headers.get('etag');
    const binary=unpack(await live.arrayBuffer());
    assert.equal(binary.id,'first');assert.deepEqual(Array.from(binary.ram),[0x12,0x34,0x56,0x78]);
    assert.deepEqual(Array.from(binary.rgb),[17,34,51]);
    assert.equal((await fetch(root+'/api/live',{headers:{'If-None-Match':tag}})).status,304);
    raw.id='second';raw.ram='12349978';await publish();
    const updated=await fetch(root+'/api/live',{headers:{'If-None-Match':tag}});
    assert.equal(updated.status,200);assert.equal(unpack(await updated.arrayBuffer()).id,'second');
    assert.deepEqual((await request('/api/memory?space=ram&snapshot=first&length=4')).body.bytes,[0x12,0x34,0x56,0x78]);
    assert.deepEqual((await request('/api/diff?space=ram&from=first&length=4')).body.changes,[{offset:2,before:0x56,after:0x99}]);
    assert.equal((await request('/api/memory?space=ram&start=-1')).status,400);
    assert.equal((await request('/api/memory?space=ram&length=4097')).status,400);
    assert.equal((await request('/api/memory?space=io')).status,400);
    assert.equal((await request('/api/snapshot?snapshot=missing')).status,404);
    assert.deepEqual((await request('/api/pixel?view=composite&x=0&y=0')).body.rgb,[17,34,51]);
    for(let n=0;n<16;n++){raw.id='next'+n;await publish();await request('/api/snapshot');}
    assert.equal((await request('/api/history')).body.length,16);
    assert.equal((await request('/api/snapshot?snapshot=first')).status,404);
    assert.equal((await fetch(root+'/api/snapshot',{method:'POST'})).status,405);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

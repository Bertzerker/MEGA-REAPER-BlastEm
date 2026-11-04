import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AtlasEncoder,decodeAtlas} from '../public/rle.mjs';
import {pack,unpack} from '../protocol.mjs';

test('pixel runs preserve arbitrary RGBA words, transparency and literal/run boundaries',()=>{
  const encoder=new AtlasEncoder();let seed=12345;
  for(let n=1;n<2000;n+=37){
    const words=new Uint32Array(n);
    for(let i=0;i<n;i++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      words[i]=i&&seed%4?words[i-1]:seed;
    }
    const bytes=new Uint8Array(words.buffer),encoded=encoder.encode(bytes);
    if(encoded){assert.ok(encoded.length<bytes.length);assert.deepEqual(decodeAtlas(encoded,bytes.length),bytes);}
    else assert.deepEqual(bytes,new Uint8Array(words.buffer));
  }
  for(const values of [[0,0,0],[1,2,3,3,3,4,5],[1,1,1,2,3,3,3,4],[0xffffffff,0xffffffff,0xffffffff]]){
    const bytes=new Uint8Array(new Uint32Array(values).buffer),encoded=encoder.encode(bytes);
    if(encoded)assert.deepEqual(decodeAtlas(encoded,bytes.length),bytes);
  }
});
test('high entropy uses raw fallback and packet copies remain immutable when encoder scratch is reused',()=>{
  const encoder=new AtlasEncoder(),random=new Uint32Array(1024);for(let i=0;i<random.length;i++)random[i]=i;
  assert.equal(encoder.encode(new Uint8Array(random.buffer)),null);
  const fields=Object.fromEntries(['regs','vram','cram','vsram','ram','zram','rgb'].map(k=>[k,new Uint8Array(4)]));
  const s={...fields,atlasPixels:new Uint8Array(new Uint32Array(1024).fill(0xff00ff00).buffer)};
  const packet=pack(s,{atlasEncoder:encoder});
  encoder.encode(new Uint8Array(new Uint32Array(1024).fill(0x11223344).buffer));
  assert.deepEqual(unpack(packet).atlasPixels,s.atlasPixels);
  s.atlasPixels=new Uint8Array(random.buffer);assert.deepEqual(unpack(pack(s,{atlasEncoder:encoder})).atlasPixels,s.atlasPixels);
});
test('malformed pixel runs reject overflow, truncation, zero counts and incomplete images',()=>{
  const bytes=values=>new Uint8Array(new Uint32Array(values).buffer);
  for(const input of [[0],[0x80000001],[0x80000010,1],[2,1],[0x80000001,1]])assert.throws(()=>decodeAtlas(bytes(input),8));
  assert.throws(()=>decodeAtlas(new Uint8Array(3),8));
  assert.throws(()=>decodeAtlas(bytes([0x80000001,1]),32*1024*1024));
});

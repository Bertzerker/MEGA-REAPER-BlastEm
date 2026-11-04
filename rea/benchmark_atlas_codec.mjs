import {WebSocket} from 'ws';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {AtlasEncoder,decodeAtlas} from './public/rle.mjs';
import {unpack} from './protocol.mjs';
const root=process.argv[2]||'http://127.0.0.1:8765';
const ws=new WebSocket(root.replace('http:','ws:')+'/stream',{origin:root});
const message=once(ws,'message');await once(ws,'open');const [packet]=await message;ws.terminate();
const image=unpack(packet),pixels=Uint8Array.from(image.atlasPixels),encoder=new AtlasEncoder();
for(let i=0;i<10;i++)encoder.encode(pixels);
const started=performance.now();let encoded;
for(let i=0;i<100;i++)encoded=encoder.encode(pixels);
const encodeMs=(performance.now()-started)/100;
let decodeMs=0;
if(encoded){
  assert.deepEqual(decodeAtlas(encoded,pixels.byteLength),pixels);
  const start=performance.now();for(let i=0;i<100;i++)decodeAtlas(encoded,pixels.byteLength);decodeMs=(performance.now()-start)/100;
}
console.log(JSON.stringify({raw:image.atlasPixels.byteLength,encoded:encoded?.byteLength||image.atlasPixels.byteLength,encode_ms:encodeMs,decode_ms:decodeMs},null,2));

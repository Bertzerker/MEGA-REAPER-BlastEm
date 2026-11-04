// Integration assertions for the original diagnostic ROM, not synthetic decoder data.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {decode,sprites,planePixel,inspect} from './public/decoder.mjs';
const raw=JSON.parse(await readFile(process.argv[2]||'rea/test-output/capture/snapshot.json','utf8'));
const s=decode(raw);
assert.equal(s.schema,1);assert.equal(s.mode5,true);assert.equal(s.interlace,false);
assert.equal(s.rgb.length,s.width*s.height*3);
assert.equal(s.vram.length,65536);assert.equal(s.ram.length,65536);
assert.deepEqual(Array.from(s.ram.slice(16,20)),[0x52,0x45,0x41,0x31]);
assert.equal(planePixel(s,'b',0,0).tile,1);
assert.equal(planePixel(s,'a',96,72).tile,2);
assert.equal(sprites(s)[0].x,80);assert.equal(sprites(s)[0].y,60);
function color(x,y){return inspect(s,'composite',x+s.border_left,y+s.border_top).rgb;}
assert.deepEqual(color(10,10),[255,0,0]);
assert.deepEqual(color(96,72),[0,255,0]);
assert.deepEqual(color(80,60),[0,0,255]);
if(s.raster?.valid){
  assert.equal(s.raster.complete,true);
  const layers={1:1,2:3,3:2,4:0},count=s.width*s.height;let checked=0;
  for(let offset=0;offset<count;offset++){
    const flags=s.raster_flags[offset],layer=layers[flags&7];
    if(layer===undefined||flags&128)continue;
    const start=(layer*count+offset)*4;
    assert.equal(s.raster_rgba[start+3],255);
    assert.deepEqual(s.raster_rgba.subarray(start,start+3),s.rgb.subarray(offset*3,offset*3+3),`selected source at pixel ${offset}`);
    checked++;
  }
  assert.ok(checked>s.width*s.height/2);
  console.log(`PASS: ${checked} captured winning-source pixels equal composite RGB.`);
}
console.log(`PASS: actual emulator capture ${s.id}, frame ${s.frame}, ${s.width}x${s.height}; RGB layers/sprite and RAM bus order verified.`);

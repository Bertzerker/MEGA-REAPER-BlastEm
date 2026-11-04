// Integration assertions against the raster diagnostic's actual VDP execution.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {decode,inspect,word,sprites,spritePixel} from './public/decoder.mjs';
const s=decode(JSON.parse(await readFile(process.argv[2]||'rea/test-output/raster-split-capture.json','utf8')));
assert.equal(s.raster.valid,true);assert.equal(s.raster.complete,true);
const pixel=(view,x,y)=>inspect(s,view,x+s.border_left,y+s.border_top);
const top=pixel('b',16,40),middle=pixel('b',24,160),bottom=pixel('b',24,208);
assert.equal(top.sample&15,1);assert.ok(top.rgba[0]>0&&top.rgba[1]===0);
assert.equal(middle.sample&15,1);assert.ok(middle.rgba[1]>0&&middle.rgba[0]===0);
assert.equal(word(s.cram,2),14,'end-of-frame CRAM is red, while captured middle remains green');
let rowRed=0,rowGreen=0;
for(let x=0;x<256;x++){
  const p=pixel('b',x,112);if((p.sample&63)!==1)continue;
  if(p.rgba[0]>0&&p.rgba[1]===0)rowRed++;
  if(p.rgba[0]===0&&p.rgba[1]>0)rowGreen++;
}
assert.ok(rowRed>0&&rowGreen>0,'the same palette index changes color within one scanline');
assert.ok(s.raster_flags.some(flag=>flag&128),'active CRAM write must be classified as an output artifact');
assert.equal(bottom.sample&15,0);assert.equal(bottom.rgba[3],0);
assert.equal(s.vram[32],0x11,'tile 1 restored after scanout; bottom capture must remain transparent');
assert.notEqual(pixel('b',16,40).sample&15,pixel('b',16,160).sample&15,'mid-frame scroll must survive');
assert.equal(pixel('window',280,40).rgba[3],255);assert.equal(pixel('window',280,160).rgba[3],0);
assert.equal(pixel('window',20,40).rgba[3],0);assert.equal(pixel('window',20,160).rgba[3],255);
assert.equal(s.regs[17],0x90,'Window was restored after scanout');
assert.equal(pixel('a',280,40).rgba[3],0);
assert.equal(pixel('sprites',0,64).rgba[3],255);
assert.equal(pixel('sprites',240,64).rgba[3],0,'21st sprite must be dropped by the VDP');
assert.notEqual(spritePixel(s,sprites(s),240,64).value,0,'end-of-frame SAT reconstruction would wrongly draw it');
assert.equal(pixel('sprites',80,100).sprite_control,'highlight');
assert.equal(pixel('sprites',100,120).sprite_control,'shadow');
assert.equal(pixel('sprites',80,100).rgba[3],0);
const layers={1:1,2:3,3:2,4:0},count=s.width*s.height;let checked=0;
for(let offset=0;offset<count;offset++){
  const flags=s.raster_flags[offset],layer=layers[flags&7];
  if(layer===undefined||flags&128)continue;
  const start=(layer*count+offset)*4;
  assert.equal(s.raster_rgba[start+3],255);
  assert.deepEqual(Array.from(s.raster_rgba.subarray(start,start+3)),Array.from(s.rgb.subarray(offset*3,offset*3+3)),`selected source vs composite at pixel ${offset}`);
  checked++;
}
console.log(`PASS: ${s.id}; ${checked} selected-source pixels match actual output. Mid-frame CRAM, scroll, tile writes, Window changes, sprite overflow and S/H operators preserved despite restored end-of-frame memory.`);

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {palette,tilePixel,planePixel,sprites,spritePixel,inspect} from '../public/decoder.mjs';
function fixture(){return {id:'test',mode5:true,interlace:false,regs:new Uint8Array(24),vram:new Uint8Array(65536),cram:new Uint8Array(128),vsram:new Uint8Array(80)};}
const setword=(s,a,v)=>{s.vram[a]=v>>8;s.vram[a+1]=v&255;};
test('palette converts hardware BGR to RGB',()=>{const s=fixture();s.cram[3]=14;assert.deepEqual(palette(s,1),[255,0,0,255]);s.cram[4]=14;assert.deepEqual(palette(s,2),[0,0,255,255]);});
test('tile nibbles, flips and provenance',()=>{const s=fixture();s.vram[32]=0x12;assert.equal(tilePixel(s,1,0,0).value,1);assert.equal(tilePixel(s,1,1,0).value,2);assert.equal(tilePixel(s,0x801,7,0).value,1);assert.equal(tilePixel(s,0x1001,0,7).address,32);});
test('plane scroll, wrapping and name table address',()=>{const s=fixture();s.regs[2]=0x30;s.regs[13]=0x3f;setword(s,0xFC00,8);setword(s,0xC000+31*2,2);s.vram[64]=0x10;const p=planePixel(s,'a',0,0);assert.equal(p.tile,2);assert.equal(p.entry,0xC03E);assert.equal(p.value,1);});
test('SAT linked order, dimensions, column-major tiles and loop guard',()=>{const s=fixture();s.regs[5]=0x6c;setword(s,0xd800,128);s.vram[0xd802]=5;s.vram[0xd803]=1;setword(s,0xd804,3);setword(s,0xd806,128);setword(s,0xd808,128);s.vram[0xd80b]=1;const list=sprites(s);assert.equal(list.length,2);assert.equal(list[0].width,16);assert.equal(list[0].height,16);s.vram[5*32]=0x30;const p=spritePixel(s,list,8,0);assert.equal(p.value,3);assert.equal(p.tile,5);assert.equal(p.sprite,0);});
test('rejects unsupported reconstruction without mislabeling captured pixels',()=>{const s=fixture();s.interlace=true;assert.throws(()=>inspect(s,'a',0,0),/non-interlaced/);s.width=1;s.height=1;s.rgb=new Uint8Array([1,2,3]);assert.deepEqual(inspect(s,'composite',0,0).rgb,[1,2,3]);assert.throws(()=>inspect(s,'composite',1,0),/Outside/);});

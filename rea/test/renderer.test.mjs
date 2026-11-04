import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tilePixel,planePixel,spritePixel,sprites,palette,decode} from '../public/decoder.mjs';
import {prepare,draw,dimensions} from '../public/renderer.mjs';
export function fixture(h40=true) {
  let seed=17;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
  const s={id:'render-test',mode5:true,interlace:false,width:347,height:240,active_height:32,
    regs:new Uint8Array(24),vram:Uint8Array.from({length:65536},random),
    cram:Uint8Array.from({length:128},random),vsram:Uint8Array.from({length:80},random),
    rgb:Uint8Array.from({length:347*240*3},random)};
  s.regs.set([4,0x44,0x30,0x2c,7,0x6c]);s.regs[12]=h40?1:0;s.regs[13]=0x3f;s.regs[16]=0x11;s.regs[11]=7;
  const set=(a,n)=>{s.vram[a]=n>>8;s.vram[a+1]=n&255;};
  for(let i=0;i<80;i++){
    const a=0xd800+i*8;
    set(a,128+(i%10)*4);s.vram[a+2]=15;s.vram[a+3]=i===79?0:i+1;
    set(a+4,(i*19)|((i%4)<<13)|((i%2)<<11)|((i%3===0?1:0)<<12));set(a+6,128+(i%16)*18);
  }
  return s;
}
export function reference(s,view) {
  const [w,h]=dimensions(s,view),out=new Uint8ClampedArray(w*h*4),list=sprites(s);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*4;
    if(view==='composite'){out.set([...s.rgb.slice((y*w+x)*3,(y*w+x)*3+3),255],i);continue;}
    const p=view==='tiles'?tilePixel(s,(y>>3)*64+(x>>3),x,y):view==='sprites'?spritePixel(s,list,x,y):planePixel(s,view,x,y);
    out.set(p.value?palette(s,p.palette*16+p.value):[0,0,0,0],i);
  }
  return out;
}
for(const h40 of [true,false])test(`packed renderer matches reference pixels (H${h40?40:32}, scroll/flip/overlap)`,()=>{
  const s=fixture(h40),prepared=prepare(s);
  for(const view of ['composite','sprites','a','b','window','tiles']){
    const [w,h]=dimensions(s,view),pixels=draw(prepared,view,new Uint32Array(w*h));
    assert.deepEqual(new Uint8ClampedArray(pixels.buffer),reference(s,view),view);
  }
});
test('fast hex decoder retains exact bytes',()=>{
  const raw={};for(const key of ['regs','vram','cram','vsram','ram','zram','rgb'])raw[key]='0123456789abcdefABCDEF';
  for(const bytes of Object.values(decode(raw)))assert.deepEqual(Array.from(bytes),[1,35,69,103,137,171,205,239,171,205,239]);
});

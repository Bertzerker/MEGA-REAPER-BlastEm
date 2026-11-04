import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AtlasRenderer} from '../atlas.mjs';
import {pack,unpack,jsonSnapshot} from '../protocol.mjs';
import {decode,inspect} from '../public/decoder.mjs';
function fixture(){
  const s={schema:1,id:'raster-test',frame:1,width:2,height:2,mode5:true,interlace:false,nominal_hz:59.922743,
    regs:new Uint8Array(24),vram:new Uint8Array(65536),cram:new Uint8Array(128),vsram:new Uint8Array(80),ram:new Uint8Array(65536),zram:new Uint8Array(8192),rgb:new Uint8Array(12),
    raster:{valid:true,complete:true,width:2,height:2,layers:['sprites','a','b','window','source']},
    raster_rgba:new Uint8Array(80),raster_samples:new Uint8Array(16),raster_flags:new Uint8Array(4).fill(1)};
  for(let i=0;i<4;i++){
    s.rgb[i*3]=255;s.raster_rgba.set([255,0,0,255],(4+i)*4);
    s.raster_rgba.set([0,0,255,255],(8+i)*4);s.raster_rgba.set([0,208,255,255],(16+i)*4);
    s.raster_samples[4+i]=1;s.raster_samples[8+i]=3;
  }
  return s;
}
test('atlas blits captured pixels despite contradictory end-of-frame VRAM/CRAM',()=>{
  const s=fixture(),renderer=new AtlasRenderer();
  const before=renderer.render(s);assert.deepEqual(inspect(before,'a',0,0).rgba,[255,0,0,255]);
  s.vram.fill(255);s.cram.fill(255);
  const after=renderer.render(s);assert.deepEqual(inspect(after,'a',0,0).rgba,[255,0,0,255]);
  assert.equal(after.atlas.panels[5].view,'source');assert.ok(after.atlas.panels.every(p=>p.captured));
  const raw=decode(jsonSnapshot(s));assert.deepEqual(raw.raster_rgba,s.raster_rgba);
});
test('WebSocket omits duplicate raster RGBA but preserves exact atlas hit-testing',()=>{
  const original=fixture(),image=new AtlasRenderer().render(original),s=unpack(pack(image,{omitRasterRGBA:true}));
  assert.equal(s.raster_rgba,undefined);assert.deepEqual(s.raster_samples,original.raster_samples);
  assert.equal(s.nominal_hz,original.nominal_hz);
  const a=inspect(s,'a',1,1);assert.deepEqual(a.rgba,[255,0,0,255]);assert.equal(a.sample,1);assert.equal(a.winner,'a');assert.equal(a.captured,true);
  assert.deepEqual(inspect(s,'source',0,0).rgba,[0,208,255,255]);
  assert.equal(a.tile,undefined,'never infer captured pattern addresses from end-of-frame maps');
});
test('unsupported and missing samples are explicit, never reconstructed fallbacks',()=>{
  const s=fixture();s.raster.valid=false;s.vram.fill(255);
  const image=new AtlasRenderer().render(s);
  assert.ok(image.atlas.panels.slice(1).every(p=>!p.supported));
  assert.throws(()=>inspect(image,'a',0,0),/unavailable/);
  s.raster.valid=true;s.raster.complete=false;s.raster_rgba[(16+1)*4+3]=0;
  assert.equal(inspect(s,'a',1,0).captured,false);
});

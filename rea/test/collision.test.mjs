import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collisionFor,elementalMaster} from '../public/collision.mjs';

function stageOne(frame=9) {
  const ram = Buffer.alloc(0x10000);
  const regs = new Uint8Array(24);
  regs[12]=1;
  const hit = frame===10;
  for (const [address,value] of [
    [0xa026,236],[0xa020,250],[0xf1cc,hit?390:389],
    [0xf2f8,hit?3:4],[0xf2fa,4],[0xa008,hit?1:0],
    [0xa800,0x0db3],[0xa802,22],[0xa81c,24],[0xa81e,24],
    [0xa826,hit?251:253],[0xa820,hit?269:268],
  ]) ram.writeUInt16BE(value,address);
  return {id:`stage-one-${frame}`,frame:2059+frame,ram,regs,mode5:true,interlace:false,
    width:347,height:240,border_left:13,border_top:9,active_height:224,raster:{valid:true},
    movie:{id:'elemental-contact',frame,mode:'playback',rom_sha1:elementalMaster.word_swapped_sha1}};
}

test('Elemental Master profile reproduces the replayed near miss and contact',()=>{
  const before=collisionFor(stageOne()),after=collisionFor(stageOne(10));
  assert.equal(before.available,true);
  assert.deepEqual([before.player.x,before.player.y,before.player.width,before.player.height],[244,258,8,16]);
  assert.deepEqual(before.viewport,{x:13,y:9,width:320,height:224});
  assert.deepEqual(before.origin,{x:-115,y:-119});
  assert.deepEqual([before.movie.frame,before.health,before.objects[0].overlaps],[9,4,false]);
  assert.deepEqual([after.movie.frame,after.health,after.immunity,after.objects[0].overlaps],[10,3,1,true]);
  assert.equal(after.objects[0].address,0xffa800);
  assert.equal(after.objects[0].evidence,'replay-verified geometry');
});

test('contact is strict at each edge, uses signed words and respects the slot flag',()=>{
  const s=stageOne();
  for (const [x,y] of [[252,268],[220,268],[251,274],[251,234]]) {
    s.ram.writeInt16BE(x,0xa826);
    s.ram.writeInt16BE(y,0xa820);
    assert.equal(collisionFor(s).objects[0].overlaps,false);
  }
  s.ram.writeInt16BE(-1,0xa826);
  assert.equal(collisionFor(s).objects[0].x,-1);
  s.ram.writeUInt16BE(0x8000,0xa800);
  assert.deepEqual(collisionFor(s).objects,[]);
  s.ram.writeUInt16BE(0x80,0xa800);
  s.ram.writeUInt16BE(11,0xa802);
  assert.equal(collisionFor(s).objects[0].kind,'pickup');
  assert.equal(collisionFor(s).objects[0].evidence,'code-derived operands');
});

test('profile matches only the two known ROM byte orders and requires a gameplay capture',()=>{
  const s=stageOne();
  assert.equal(collisionFor({...s,movie:{rom_sha1:'other'}}).supported,false);
  assert.equal(collisionFor({...s,movie:{rom_sha1:elementalMaster.rom_sha1}}).available,true);
  assert.equal(collisionFor({...s,interlace:true}).available,false);
  assert.equal(collisionFor({...s,raster:{valid:false}}).available,false);
  s.ram.writeUInt16BE(1,0xf37a);
  assert.equal(collisionFor(s).available,false);
});

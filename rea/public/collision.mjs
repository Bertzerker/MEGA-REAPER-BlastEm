// GPL-3.0-or-later. Elemental Master (USA) 68000 contact routine at $001D60.
export const elementalMaster = Object.freeze({
  id:'elemental-master-usa-contact',
  name:'Elemental Master (USA)',
  rom_sha1:'fd47e4f8c2d6cc82860ae281faad50e3dee2d033',
  // The native bridge can hash the in-core, little-endian word layout.
  word_swapped_sha1:'0f1983d5470a7a5d451d34c4eb8f871f983dcce9',
  routine:'$001D60',
  verification:'Stage 1 player contact against a 24×24 type-22 object, movie frames 9–10.',
});

const signed16 = n => (n << 16) >> 16;
const word = (ram, offset) => (ram[offset] << 8) | ram[offset+1];
const matches = hash => typeof hash==='string' &&
  [elementalMaster.rom_sha1,elementalMaster.word_swapped_sha1].includes(hash.toLowerCase());

export function collisionSupport(s, rom = s?.movie?.rom_sha1) {
  if (!matches(rom)) return {supported:false,available:false,reason:'The collision profile requires the exact Elemental Master (USA) ROM.'};
  if (!s) return {supported:true,available:false,reason:'Waiting for a completed capture.'};
  if (!matches(s.movie?.rom_sha1) || !s.raster?.valid || !s.mode5 || s.interlace ||
      !(s.regs?.[12]&1) || s.active_height !== 224 || s.ram?.length !== 0x10000 ||
      !Number.isInteger(s.border_left) || !Number.isInteger(s.border_top) ||
      s.border_left<0 || s.border_top<0 || !(s.width>=s.border_left+320 && s.height>=s.border_top+224)) {
    return {supported:true,available:false,reason:'This profile requires a direct, non-interlaced H40 capture and full work RAM.'};
  }
  const ram = s.ram;
  const x = word(ram,0xa026), y = word(ram,0xa020);
  const hp = signed16(word(ram,0xf2f8)), capacity = word(ram,0xf2fa);
  if (x<128 || x>=448 || y<128 || y>=352 || capacity<4 || capacity>7 ||
      hp<0 || hp>capacity || word(ram,0xf37a)) {
    return {supported:true,available:false,reason:'Waiting for an active gameplay capture.'};
  }
  return {supported:true,available:true,reason:''};
}

// The left/top comparisons subtract the object extent in a 16-bit register.
function overlaps(p, o) {
  return signed16(p.x+p.width)>o.x && signed16(p.x-o.width)<o.x &&
    signed16(p.y+p.height)>o.y && signed16(p.y-o.height)<o.y;
}

export function collisionFor(s) {
  const support = collisionSupport(s);
  const result = {schema:1,snapshot:s?.id??null,frame:s?.frame??null,
    movie:s?.movie?.id?{id:s.movie.id,frame:s.movie.frame,mode:s.movie.mode}:null,
    profile:support.supported?elementalMaster:null,...support};
  if (!support.available) return result;

  const ram = s.ram;
  const stage = word(ram,0xf2e2);
  const player = {kind:'player',address:0xffa000,x:signed16(word(ram,0xa026)+8),
    y:signed16(word(ram,0xa020)+8),width:8,height:16,evidence:'replay-verified geometry'};
  const objects = [];
  for (let slot=0;slot<40;slot++) {
    const offset = 0xa700+slot*0x80;
    const flags = word(ram,offset);
    if (!(flags&0x80)) continue;
    const type = word(ram,offset+2);
    const object = {kind:type===11?'pickup':'contact',slot,address:0xff0000+offset,type,flags,
      x:signed16(word(ram,offset+0x26)),y:signed16(word(ram,offset+0x20)),
      width:signed16(word(ram,offset+0x1c)),height:signed16(word(ram,offset+0x1e))};
    object.overlaps = overlaps(player,object);
    object.evidence = stage===0 && type===22 && object.width===24 && object.height===24
      ? 'replay-verified geometry' : 'code-derived operands';
    objects.push(object);
  }
  return {...result,stage,tick:(word(ram,0xf1ca)*0x10000)+word(ram,0xf1cc),
    health:signed16(word(ram,0xf2f8)),capacity:word(ram,0xf2fa),
    shield:signed16(word(ram,0xa004)),immunity:word(ram,0xa008),
    sampling:'completed-frame RAM',
    origin:{x:s.border_left-128,y:s.border_top-128},
    viewport:{x:s.border_left,y:s.border_top,width:320,height:s.active_height},
    player,objects};
}

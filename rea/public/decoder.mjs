// Genesis Mode 5 snapshot decoding. GPL-3.0-or-later.
const hexValues = new Uint8Array(128);
for(let i=0;i<10;i++) hexValues[48+i]=i;
for(let i=0;i<6;i++) hexValues[65+i]=hexValues[97+i]=10+i;
export function unhex(s) {
  const out=new Uint8Array(s.length >> 1);
  for(let i=0,j=0;i<out.length;i++,j+=2) out[i]=(hexValues[s.charCodeAt(j)]<<4)|hexValues[s.charCodeAt(j+1)];
  return out;
}
export const word = (b, a) => (b[a & 65535] << 8) | b[(a + 1) & 65535];
export function decode(raw) {
  const s = {...raw};
  for (const k of ['regs','vram','cram','vsram','ram','zram','rgb']) s[k] = unhex(raw[k]);
  for (const k of ['raster_rgba','raster_samples','raster_flags','catalog_runs'])if(typeof raw[k]==='string')s[k]=unhex(raw[k]);
  return s;
}
export function palette(s, index) {
  const w = word(s.cram, (index & 63) * 2);
  return [Math.round(((w >> 1) & 7) * 255 / 7), Math.round(((w >> 5) & 7) * 255 / 7), Math.round(((w >> 9) & 7) * 255 / 7), 255];
}
export function tilePixel(s, attr, x, y) {
  x = (attr & 0x800) ? 7 - (x & 7) : x & 7;
  y = (attr & 0x1000) ? 7 - (y & 7) : y & 7;
  const address = ((attr & 2047) * 32 + y * 4 + (x >> 1)) & 65535;
  const value = (s.vram[address] >> (x & 1 ? 0 : 4)) & 15;
  return {address, value, palette: (attr >> 13) & 3, tile: attr & 2047, priority: !!(attr & 0x8000)};
}
export function planePixel(s, plane, x, y, scrolled = true) {
  const r = s.regs, p = plane === 'b' ? 1 : 0;
  const dims = [32,64,32,128];
  let cols = dims[r[16] & 3], rows = dims[(r[16] >> 4) & 3];
  let base = p ? (r[4] & 7) << 13 : (r[2] & 0x38) << 10;
  if (plane === 'window') {
    cols = r[12] & 1 ? 64 : 32; rows = 32;
    base = (r[3] & (r[12] & 1 ? 0x3c : 0x3e)) << 10;
  } else if (scrolled) {
    const mask = [0,7,0xf8,0xff][r[11] & 3];
    const hs = word(s.vram, ((r[13] & 63) << 10) + (y & mask) * 4 + p * 2) & 1023;
    const vsindex = r[11] & 4 ? (x >> 4) * 2 + p : p;
    const vs = word(s.vsram, vsindex * 2) & 1023;
    x -= hs; y += vs;
  }
  x = ((x % (cols * 8)) + cols * 8) % (cols * 8);
  y = ((y % (rows * 8)) + rows * 8) % (rows * 8);
  const entry = (base + ((y >> 3) * cols + (x >> 3)) * 2) & 65535;
  const attr = word(s.vram, entry);
  return {...tilePixel(s, attr, x, y), entry, attr, plane};
}
export function sprites(s) {
  const base = (s.regs[5] & (s.regs[12] & 1 ? 0x7e : 0x7f)) << 9;
  const result = [], visited = new Set();
  let i = 0;
  const limit = s.regs[12] & 1 ? 80 : 64;
  while (i < limit && !visited.has(i)) {
    visited.add(i);
    const a = base + i * 8, size = s.vram[a + 2], attr = word(s.vram, a + 4);
    result.push({index:i, entry:a, x:(word(s.vram,a+6)&511)-128, y:(word(s.vram,a)&511)-128,
      width:(((size >> 2)&3)+1)*8, height:((size&3)+1)*8,
      tile:attr&2047, palette:(attr>>13)&3, priority:!!(attr&0x8000), hflip:!!(attr&0x800), vflip:!!(attr&0x1000)});
    i = s.vram[a + 3] & 127;
    if (!i) break;
  }
  return result;
}
export function spritePixel(s, list, x, y) {
  for (const sp of list) {
    let sx = x - sp.x, sy = y - sp.y;
    if (sx < 0 || sy < 0 || sx >= sp.width || sy >= sp.height) continue;
    if (sp.hflip) sx = sp.width - 1 - sx;
    if (sp.vflip) sy = sp.height - 1 - sy;
    const tile = (sp.tile + (sx >> 3) * (sp.height >> 3) + (sy >> 3)) & 2047;
    const px = tilePixel(s, tile | (sp.palette << 13), sx, sy);
    if (px.value) return {...px, sprite:sp.index, entry:sp.entry, priority:sp.priority};
  }
  return {value:0, palette:0};
}
export function inspect(s, view, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) throw Error('Invalid coordinates');
  if (view === 'composite') {
    if (x >= s.width || y >= s.height) throw Error('Outside captured image');
    return {snapshot:s.id, x,y,rgb:Array.from(s.rgb.slice((y*s.width+x)*3,(y*s.width+x)*3+3)),
      evidence:'captured output; per-pixel hardware provenance is not recorded'};
  }
  if(s.raster&&view!=='tiles'){
    if(!s.raster.valid)throw Error('Raster capture unavailable for this frame/mode');
    if(x>=s.width||y>=s.height)throw Error('Outside captured raster');
    const layer=s.raster.layers.indexOf(view),offset=y*s.width+x,count=s.width*s.height;
    if(layer<0)throw Error('Unknown captured layer');
    let rgba;
    if(s.raster_rgba)rgba=Array.from(s.raster_rgba.subarray((layer*count+offset)*4,(layer*count+offset)*4+4));
    else {
      const panel=s.atlas?.panels.find(p=>p.view===view);
      if(!panel||!s.atlasPixels)throw Error('Captured color unavailable');
      const start=((panel.y+y)*s.atlas.width+panel.x+x)*4;rgba=Array.from(s.atlasPixels.subarray(start,start+4));
    }
    const flags=s.raster_flags[offset],sample=layer<4?s.raster_samples[layer*count+offset]:undefined;
    const sourcePanel=s.atlas?.panels.find(p=>p.view==='source');
    const captured=s.raster_rgba?!!s.raster_rgba[(4*count+offset)*4+3]:!!(sourcePanel&&s.atlasPixels[((sourcePanel.y+y)*s.atlas.width+sourcePanel.x+x)*4+3]);
    return {snapshot:s.id,view,x,y,captured,rgba,sample,palette:sample===undefined?undefined:(sample>>4)&3,
      color_index:sample===undefined?undefined:sample&15,priority:sample===undefined?!!(flags&8):!!(sample&64),
      winner:['backdrop','a','window','b','sprites'][flags&7],intensity:flags&32?'highlight':flags&16?'shadow':'normal',
      output_blank:!!(flags&64),cram_output_artifact:!!(flags&128),
      sprite_control:layer===0&&rgba[3]===0&&(sample&62)===62?((sample&63)===62?'highlight':'shadow'):undefined,
      evidence:captured?'captured compositor input / DAC-slot color; no end-of-frame tile-address inference':'no output-slot sample recorded for this coordinate'};
  }
  if (!s.mode5 || s.interlace) throw Error('Decoder supports non-interlaced Mode 5 only');
  if (x >= 512 || y >= 512) throw Error('Outside diagnostic view');
  let px;
  if (view === 'tiles') px = tilePixel(s, (y >> 3) * 64 + (x >> 3), x,y);
  else if (view === 'sprites') px = spritePixel(s,sprites(s),x,y);
  else if (['a','b','window'].includes(view)) px = planePixel(s,view,x,y);
  else throw Error('Unknown view');
  return {snapshot:s.id,x,y,...px,evidence:'reconstructed from captured VRAM; not raster history'};
}

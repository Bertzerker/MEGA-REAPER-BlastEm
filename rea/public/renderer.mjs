// Packed-pixel renderer: no temporary objects in pixel loops. GPL-3.0-or-later.
import {palette,word,sprites} from './decoder.mjs';
const littleEndian=new Uint8Array(new Uint32Array([1]).buffer)[0]===1;
const pack=(r,g,b,a=255)=>littleEndian?((a<<24)|(b<<16)|(g<<8)|r)>>>0:((r<<24)|(g<<16)|(b<<8)|a)>>>0;
export function prepare(s) {
  const colors=new Uint32Array(64),pixels=new Uint8Array(131072);
  for(let i=0;i<64;i++)colors[i]=pack(...palette(s,i));
  for(let i=0;i<65536;i++){pixels[i*2]=s.vram[i]>>4;pixels[i*2+1]=s.vram[i]&15;}
  return {s,colors,pixels,list:sprites(s)};
}
export function dimensions(s,view){
  return [view==='composite'?s.width:view==='tiles'?512:(s.regs[12]&1?320:256),
    view==='composite'?s.height:view==='tiles'?256:Math.min(240,s.active_height)];
}
export function draw(prepared,view,out) {
  const {s,colors,pixels,list}=prepared,[width,height]=dimensions(s,view),r=s.regs;
  if(out.length!==width*height)throw Error('Wrong render buffer size');
  out.fill(0);
  if(view==='composite') {
    for(let i=0,j=0;i<out.length;i++,j+=3)out[i]=pack(s.rgb[j],s.rgb[j+1],s.rgb[j+2]);
  }else if(view==='tiles'){
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const tile=(y>>3)*64+(x>>3),v=pixels[tile*64+(y&7)*8+(x&7)];
      if(v)out[y*width+x]=colors[v];
    }
  }else if(view==='sprites'){
    // Earlier SAT entries win nontransparent overlap. Draw back to front,
    // touching sprite rectangles only, rather than scanning all sprites per pixel.
    for(let i=list.length-1;i>=0;i--){
      const sp=list[i];
      for(let y=Math.max(0,sp.y);y<Math.min(height,sp.y+sp.height);y++){
        const sy=sp.vflip?sp.height-1-(y-sp.y):y-sp.y;
        for(let x=Math.max(0,sp.x);x<Math.min(width,sp.x+sp.width);x++){
          const sx=sp.hflip?sp.width-1-(x-sp.x):x-sp.x;
          const tile=(sp.tile+(sx>>3)*(sp.height>>3)+(sy>>3))&2047;
          const v=pixels[tile*64+(sy&7)*8+(sx&7)];
          if(v)out[y*width+x]=colors[sp.palette*16+v];
        }
      }
    }
  }else if(['a','b','window'].includes(view)){
    const p=view==='b'?1:0,window=view==='window',dims=[32,64,32,128];
    const cols=window?(r[12]&1?64:32):dims[r[16]&3],rows=window?32:dims[(r[16]>>4)&3];
    const base=window?(r[3]&(r[12]&1?0x3c:0x3e))<<10:p?(r[4]&7)<<13:(r[2]&0x38)<<10;
    const xmask=cols*8-1,ymask=rows*8-1,hmask=[0,7,0xf8,0xff][r[11]&3];
    for(let y=0;y<height;y++){
      const hs=window?0:word(s.vram,((r[13]&63)<<10)+(y&hmask)*4+p*2)&1023;
      for(let x=0;x<width;x++){
        const vs=window?0:word(s.vsram,((r[11]&4?(x>>4)*2:0)+p)*2)&1023;
        const sx=(x-hs)&xmask,sy=(y+vs)&ymask;
        const attr=word(s.vram,base+((sy>>3)*cols+(sx>>3))*2);
        const tx=attr&0x800?7-(sx&7):sx&7,ty=attr&0x1000?7-(sy&7):sy&7;
        const v=pixels[(attr&2047)*64+ty*8+tx];
        if(v)out[y*width+x]=colors[((attr>>13)&3)*16+v];
      }
    }
  }else throw Error('Unknown view');
  return out;
}

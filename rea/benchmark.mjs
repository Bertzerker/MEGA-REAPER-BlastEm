// Compare CPU rendering only; this is not an end-to-end FPS measurement.
import {readFile} from 'node:fs/promises';
import {decode,palette,planePixel,tilePixel,spritePixel,sprites} from './public/decoder.mjs';
import {prepare,draw,dimensions} from './public/renderer.mjs';
const s=decode(JSON.parse(await readFile(process.argv[2]||'rea/test-output/capture/snapshot.json','utf8')));
const views=['composite','sprites','a','b','window','tiles'];
const buffers=Object.fromEntries(views.map(v=>{const [w,h]=dimensions(s,v);return [v,new Uint32Array(w*h)];}));
function old(){
  const list=sprites(s);
  for(const view of views){
    const [w,h]=dimensions(s,view),out=new Uint8ClampedArray(w*h*4);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      if(view==='composite'){out.set([...s.rgb.slice((y*w+x)*3,(y*w+x)*3+3),255],i);continue;}
      const p=view==='tiles'?tilePixel(s,(y>>3)*64+(x>>3),x,y):view==='sprites'?spritePixel(s,list,x,y):planePixel(s,view,x,y);
      out.set(p.value?palette(s,p.palette*16+p.value):[0,0,0,0],i);
    }
  }
}
function fast(){const p=prepare(s);for(const view of views)draw(p,view,buffers[view]);}
function median(fn){for(let i=0;i<3;i++)fn();const times=[];for(let i=0;i<15;i++){const start=performance.now();fn();times.push(performance.now()-start);}return times.sort((a,b)=>a-b)[7];}
const before=median(old),after=median(fast);
console.log(JSON.stringify({snapshot:s.id,views:views.length,before_ms:before,after_ms:after,speedup:before/after,scope:'CPU pixel generation only; excludes capture, network, DOM and canvas upload'},null,2));

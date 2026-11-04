import {prepare,draw,dimensions} from './public/renderer.mjs';
export const views=['composite','sprites','a','b','window','tiles'];
export class AtlasRenderer {
  render(s){
    const captured=!!s.raster,activeViews=captured?['composite',...s.raster.layers]:views;
    const sizes=activeViews.map(view=>captured?[s.width,s.height]:dimensions(s,view));
    const columns=[0,1,2].map(c=>Math.max(sizes[c][0],sizes[c+3][0]));
    const rows=[0,1].map(r=>Math.max(...sizes.slice(r*3,r*3+3).map(d=>d[1]))+24);
    const width=columns.reduce((a,b)=>a+b),height=rows[0]+rows[1];
    if(this.width!==width||this.height!==height){this.width=width;this.height=height;this.pixels=new Uint32Array(width*height);this.scratch={};}
    this.pixels.fill(0);
    const panels=[],prepared=captured?null:prepare(s),supported=captured?s.raster.valid:s.mode5&&!s.interlace;
    const bytes=new Uint8Array(this.pixels.buffer);
    const started=performance.now();
    for(let i=0;i<activeViews.length;i++){
      const view=activeViews[i],[w,h]=sizes[i],x=columns.slice(0,i%3).reduce((a,b)=>a+b,0),y=(i<3?0:rows[0])+24;
      panels.push({view,x,y,width:w,height:h,supported:view==='composite'||supported,captured,partial:captured&&!s.raster.complete});
      if(view!=='composite'&&!supported)continue;
      if(captured){
        if(view==='composite'){
          for(let row=0;row<h;row++)for(let col=0;col<w;col++){
            const src=(row*w+col)*3,dst=((y+row)*width+x+col)*4;
            bytes[dst]=s.rgb[src];bytes[dst+1]=s.rgb[src+1];bytes[dst+2]=s.rgb[src+2];bytes[dst+3]=255;
          }
        }else{
          const start=s.raster.layers.indexOf(view)*w*h*4;
          for(let row=0;row<h;row++)bytes.set(s.raster_rgba.subarray(start+row*w*4,start+(row+1)*w*4),((y+row)*width+x)*4);
        }
        continue;
      }
      if(this.scratch[view]?.length!==w*h)this.scratch[view]=new Uint32Array(w*h);
      const image=draw(prepared,view,this.scratch[view]);
      for(let row=0;row<h;row++)this.pixels.set(image.subarray(row*w,(row+1)*w),(y+row)*width+x);
    }
    return {...s,atlas:{width,height,panels,render_ms:performance.now()-started},atlasPixels:new Uint8Array(this.pixels.buffer)};
  }
}

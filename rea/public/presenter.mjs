// One GPU texture containing all six views, presented with one textured quad.
import {sprites} from './decoder.mjs';
export class AtlasPresenter {
  constructor(canvas){
    this.canvas=canvas;
    const gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
    this.gl=gl;
    if(!gl){this.ctx=canvas.getContext('2d');this.method='Canvas 2D atlas';return;}
    this.method='WebGL atlas';
    const program=(vertex,fragment)=>{
      const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
      const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));return p;
    };
    this.program=program('attribute vec2 p; varying vec2 uv; uniform vec4 region; void main(){uv=region.xy+vec2((p.x+1.0)*0.5,(1.0-p.y)*0.5)*region.zw;gl_Position=vec4(p,0,1);}',
      'precision highp float; varying vec2 uv; uniform sampler2D atlas; uniform vec2 size; void main(){vec4 c=texture2D(atlas,uv);float k=mod(floor(uv.x*size.x/8.0)+floor(uv.y*size.y/8.0),2.0);vec3 bg=mix(vec3(0.133,0.173,0.22),vec3(0.161,0.208,0.267),k);gl_FragColor=vec4(mix(bg,c.rgb,c.a),1.0);}');
    this.lines=program('attribute vec2 p;void main(){gl_Position=vec4(p,0,1);}','precision mediump float;void main(){gl_FragColor=vec4(1.0,0.81,0.35,1.0);}');
    this.sizeUniform=gl.getUniformLocation(this.program,'size');
    this.regionUniform=gl.getUniformLocation(this.program,'region');this.textureUploads=0;
    this.positionAttributes=new Map([this.program,this.lines].map(p=>[p,gl.getAttribLocation(p,'p')]));
    this.quad=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.quad);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    this.lineBuffer=gl.createBuffer();this.texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.texture);
    for(const key of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,key,gl.NEAREST);
    for(const key of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,key,gl.CLAMP_TO_EDGE);
  }
  draw(s,bounds=false,view='all'){
    const {width,height}=s.atlas,c=this.canvas;
    const crop=s.atlas.panels.find(p=>p.view===view)||{x:0,y:0,width,height};this.region=crop;
    const changed=c.width!==crop.width||c.height!==crop.height;
    if(changed){c.width=crop.width;c.height=crop.height;}
    const newCapture=this.uploadedId!==s.id||this.uploadedPixels!==s.atlasPixels;
    if(!this.gl){
      this.surface??=document.createElement('canvas');
      if(newCapture){this.surface.width=width;this.surface.height=height;this.surface.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(s.atlasPixels.buffer,s.atlasPixels.byteOffset,s.atlasPixels.byteLength),width,height),0,0);}
      this.ctx.clearRect(0,0,c.width,c.height);this.ctx.imageSmoothingEnabled=false;this.ctx.drawImage(this.surface,crop.x,crop.y,crop.width,crop.height,0,0,c.width,c.height);
      if(bounds){this.ctx.strokeStyle='#ffcf5b';for(const [x,y,w,h] of this.rectangles(s))this.ctx.strokeRect(x-crop.x,y-crop.y,w,h);}
      this.uploadedId=s.id;this.uploadedPixels=s.atlasPixels;
      return;
    }
    const gl=this.gl;
    gl.viewport(0,0,c.width,c.height);gl.useProgram(this.program);gl.bindTexture(gl.TEXTURE_2D,this.texture);
    if(newCapture){
      if(this.textureWidth!==width||this.textureHeight!==height){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,s.atlasPixels);this.textureWidth=width;this.textureHeight=height;}
      else gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,s.atlasPixels);
      this.textureUploads++;this.uploadedId=s.id;this.uploadedPixels=s.atlasPixels;
    }
    gl.uniform2f(this.sizeUniform,width,height);
    gl.uniform4f(this.regionUniform,crop.x/width,crop.y/height,crop.width/width,crop.height/height);
    this.bind(this.program,this.quad);gl.drawArrays(gl.TRIANGLES,0,6);
    if(bounds){
      const coords=[];
      for(const [x,y,w,h] of this.rectangles(s)){
        const l=2*(x-crop.x)/crop.width-1,r=2*(x+w-crop.x)/crop.width-1,t=1-2*(y-crop.y)/crop.height,b=1-2*(y+h-crop.y)/crop.height;
        coords.push(l,t,r,t,r,t,r,b,r,b,l,b,l,b,l,t);
      }
      if(coords.length){gl.useProgram(this.lines);this.bind(this.lines,this.lineBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(coords),gl.DYNAMIC_DRAW);gl.drawArrays(gl.LINES,0,coords.length/2);}
    }
  }
  bind(program,buffer){const gl=this.gl,index=this.positionAttributes.get(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(index);gl.vertexAttribPointer(index,2,gl.FLOAT,false,0,0);}
  rectangles(s){
    if(!s.mode5||s.interlace)return [];
    const rects=[];
    for(const panel of s.atlas.panels.filter(p=>['composite','sprites'].includes(p.view))){
      const ox=panel.view==='composite'?s.border_left:0,oy=panel.view==='composite'?s.border_top:0;
      for(const sp of sprites(s)){
        const x=Math.max(0,sp.x+ox),y=Math.max(0,sp.y+oy),r=Math.min(panel.width,sp.x+ox+sp.width),b=Math.min(panel.height,sp.y+oy+sp.height);
        if(r>x&&b>y)rects.push([panel.x+x,panel.y+y,r-x,b-y]);
      }
    }
    return rects;
  }
}

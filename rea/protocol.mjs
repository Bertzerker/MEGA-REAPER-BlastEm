import {fields,extraFields,unpack} from './public/transport.mjs';
export {unpack};
export function pack(s,{omitRasterRGBA=false,atlasEncoder}={}){
  const metadata={...s},parts=fields.map(key=>{const b=s[key];delete metadata[key];return Buffer.from(b.buffer,b.byteOffset,b.byteLength);});
  delete metadata.atlasPixels;
  const extra=[];
  for(const key of extraFields){
    delete metadata[key];const bytes=s[key];
    if(bytes&&!(omitRasterRGBA&&key==='raster_rgba')){extra.push({name:key,length:bytes.byteLength});parts.push(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength));}
  }
  const encoded=s.atlasPixels&&atlasEncoder?.encode(s.atlasPixels);
  const pixels=encoded||s.atlasPixels;
  const atlas=pixels?Buffer.from(pixels.buffer,pixels.byteOffset,pixels.byteLength):null;
  const header=Buffer.from(JSON.stringify({metadata,lengths:parts.slice(0,fields.length).map(b=>b.length),extra,atlasLength:atlas?.length||0,
    ...(encoded?{atlasEncoding:'rgba-rle-v1',atlasDecodedLength:s.atlasPixels.byteLength}:{})}));
  const prefix=Buffer.alloc(4);prefix.writeUInt32LE(header.length);
  return Buffer.concat([prefix,header,...parts,...(atlas?[atlas]:[])]);
}
export function jsonSnapshot(s){
  const raw={...s};delete raw.atlasPixels;delete raw.atlas;
  for(const key of [...fields,...extraFields])if(s[key])raw[key]=Buffer.from(s[key].buffer,s[key].byteOffset,s[key].byteLength).toString('hex');
  return raw;
}
export class FrameReader {
  constructor(onFrame,max=8*1024*1024){this.onFrame=onFrame;this.max=max;this.prefix=Buffer.alloc(4);this.prefixUsed=0;this.body=null;this.used=0;}
  push(chunk){
    let pos=0;
    while(pos<chunk.length){
      if(!this.body){
        const n=Math.min(4-this.prefixUsed,chunk.length-pos);chunk.copy(this.prefix,this.prefixUsed,pos,pos+n);pos+=n;this.prefixUsed+=n;
        if(this.prefixUsed<4)continue;
        const length=this.prefix.readUInt32LE();if(length<4||length>this.max)throw Error('Invalid native packet size');
        this.body=Buffer.allocUnsafe(length);this.used=0;this.prefixUsed=0;
      }
      const n=Math.min(this.body.length-this.used,chunk.length-pos);chunk.copy(this.body,this.used,pos,pos+n);pos+=n;this.used+=n;
      if(this.used===this.body.length){const body=this.body;this.body=null;this.onFrame(body);}
    }
  }
}

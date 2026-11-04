// Binary live-view transport. The JSON snapshot API remains available for AI clients.
import {decodeAtlas} from './rle.mjs';
export const fields=['regs','vram','cram','vsram','ram','zram','rgb'];
export const extraFields=['raster_rgba','raster_samples','raster_flags'];
export function unpack(buffer) {
  const bytes=ArrayBuffer.isView(buffer)?new Uint8Array(buffer.buffer,buffer.byteOffset,buffer.byteLength):new Uint8Array(buffer);
  const headerLength=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);
  if(headerLength>65536||headerLength+4>bytes.length)throw Error('Invalid live header');
  const header=JSON.parse(new TextDecoder().decode(bytes.subarray(4,4+headerLength)));
  const result={...header.metadata};
  let offset=4+headerLength;
  for(let i=0;i<fields.length;i++) {
    const length=header.lengths[i];
    result[fields[i]]=new Uint8Array(bytes.buffer,bytes.byteOffset+offset,length);
    offset+=length;
  }
  const seen=new Set();
  for(const extra of header.extra||[]){
    if(!extraFields.includes(extra.name)||seen.has(extra.name)||!Number.isInteger(extra.length)||extra.length<0)throw Error('Invalid raster buffer');
    seen.add(extra.name);result[extra.name]=new Uint8Array(bytes.buffer,bytes.byteOffset+offset,extra.length);offset+=extra.length;
  }
  if(header.atlasLength){
    const atlas=new Uint8Array(bytes.buffer,bytes.byteOffset+offset,header.atlasLength);offset+=header.atlasLength;
    if(header.atlasEncoding&&header.atlasEncoding!=='rgba-rle-v1')throw Error('Unknown atlas encoding');
    result.atlasPixels=header.atlasEncoding?decodeAtlas(atlas,header.atlasDecodedLength):atlas;
  }
  if(offset!==bytes.byteLength)throw Error('Invalid live capture length');
  return result;
}

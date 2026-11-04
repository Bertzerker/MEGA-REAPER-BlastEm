// Lossless RGBA word runs. A high-bit header repeats the next RGBA word;
// otherwise the header counts literal words. Headers are little endian.
const littleEndian=new Uint8Array(new Uint32Array([1]).buffer)[0]===1;
export class AtlasEncoder {
  encode(bytes){
    if(!littleEndian||bytes.byteOffset%4||bytes.byteLength%4)return null;
    const words=new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4),n=words.length;
    if(!this.words||this.words.length<n+2)this.words=new Uint32Array(n+2);
    const out=this.words;let i=0,p=0,literal=-1,count=0;
    while(i<n){
      const color=words[i];let end=i+1;
      while(end<n&&words[end]===color)end++;
      const run=end-i;
      if(run>=3){
        if(count){out[literal]=count;count=0;}
        out[p++]=0x80000000|run;out[p++]=color;
      }else{
        if(!count)literal=p++;
        for(;i<end;i++){out[p++]=color;count++;}
      }
      i=end;
    }
    if(count)out[literal]=count;
    // Do not expand high-entropy images. The caller sends the raw atlas then.
    return p*4<bytes.byteLength?new Uint8Array(out.buffer,0,p*4):null;
  }
}
export function decodeAtlas(bytes,length){
  if(!Number.isInteger(length)||length<4||length>16*1024*1024||length%4||bytes.length%4)throw Error('Invalid atlas RLE size');
  const out=new Uint8Array(length),words=new Uint32Array(out.buffer),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let i=0,p=0;
  while(i<bytes.length){
    const header=view.getUint32(i,true);i+=4;
    const count=header&0x7fffffff;
    if(!count||p+count>words.length)throw Error('Invalid atlas RLE run');
    if(header&0x80000000){
      if(i+4>bytes.length)throw Error('Truncated atlas RLE color');
      const color=view.getUint32(i,true);i+=4;
      if(littleEndian)words.fill(color,p,p+count);
      else {const target=new DataView(out.buffer);for(let j=p;j<p+count;j++)target.setUint32(j*4,color,true);}
    }else{
      if(i+count*4>bytes.length)throw Error('Truncated atlas RLE literals');
      out.set(bytes.subarray(i,i+count*4),p*4);i+=count*4;
    }
    p+=count;
  }
  if(p!==words.length)throw Error('Incomplete atlas RLE image');
  return out;
}

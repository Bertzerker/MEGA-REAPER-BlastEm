// Read-only live-capture cadence measurement; excludes browser presentation.
import {unpack} from './public/transport.mjs';
const url=(process.argv[2]||'http://127.0.0.1:8877')+'/api/live';
let etag='',count=0,first,last,bytes=0;
const started=performance.now();
while(performance.now()-started<3000){
  const res=await fetch(url,{headers:etag?{'If-None-Match':etag}:{}});
  if(res.status===200){
    etag=res.headers.get('etag');const buffer=await res.arrayBuffer(),s=unpack(buffer);
    first??=s.frame;last=s.frame;count++;bytes+=buffer.byteLength;
  }else if(res.status!==304)throw Error(await res.text());
  await new Promise(resolve=>setTimeout(resolve,5));
}
const seconds=(performance.now()-started)/1000;
console.log(JSON.stringify({seconds,captures:count,captures_per_second:count/seconds,first_frame:first,last_frame:last,bytes_received:bytes,scope:'capture + HTTP; excludes browser rendering'},null,2));

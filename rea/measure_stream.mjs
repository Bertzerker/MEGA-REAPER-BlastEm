import {writeFile} from 'node:fs/promises';
const base=process.argv[2]||'http://127.0.0.1:8890',seconds=Number(process.argv[3]||60),samples=[];
const warmup=Number(process.argv.find(a=>a.startsWith('--warmup='))?.split('=')[1]||5);
if(warmup>0){console.log(`Warming up ${warmup}s`);await new Promise(resolve=>setTimeout(resolve,warmup*1000));}
const start=performance.now();
while(performance.now()-start<seconds*1000){
  const response=await fetch(base+'/api/metrics');if(!response.ok)throw Error(await response.text());
  samples.push({time:performance.now(),...(await response.json())});
  if(samples.length%10===0)console.log(`Measured ${samples.length}s`);
  await new Promise(resolve=>setTimeout(resolve,1000));
}
const first=samples[0],last=samples.at(-1),duration=(last.time-first.time)/1000;
const clients=samples.map(s=>s.clients.find(c=>!c.frozen&&Number.isFinite(c.presented))).filter(Boolean),c0=clients[0],c1=clients.at(-1);
const valid=samples.every((s,i)=>!i||s.ingested>=samples[i-1].ingested)
  &&clients.every((c,i)=>!i||(c.presented>=clients[i-1].presented&&c.capture?.slice(0,c.capture.lastIndexOf('-'))===clients[i-1].capture?.slice(0,clients[i-1].capture.lastIndexOf('-'))));
const result={valid_run:valid,seconds:duration,source_hz:(last.ingested-first.ingested)/duration,
  core_frame_hz:(last.frame-first.frame)/duration,
  presented_hz:c0&&c1?(c1.presented-c0.presented)/((c1.received-c0.received)/1000):null,
  min_reported_hz:Math.min(...clients.map(c=>c.unique_hz)),max_reported_hz:Math.max(...clients.map(c=>c.unique_hz)),
  max_p95_ms:Math.max(...clients.map(c=>c.p95_ms)),max_upload_ms:Math.max(...clients.map(c=>c.upload_ms)),
  client_skips:last.client_skips-first.client_skips,
  native_gaps:last.native_gaps-first.native_gaps,
  native_mbytes_per_second:(last.received_bytes-first.received_bytes)/duration/1e6,
  max_pipeline_p95_ms:Math.max(...samples.map(s=>s.pipeline_p95_ms||0)),
  underruns:c0&&c1?c1.underruns-c0.underruns:null,dropped:c0&&c1?c1.dropped-c0.dropped:null,
  duplicates:c0&&c1?c1.duplicates-c0.duplicates:null,nominal_hz:c1?.source_hz,method:c1?.method};
console.log(JSON.stringify(result,null,2));
if(process.argv[4])await writeFile(process.argv[4],JSON.stringify({result,samples},null,2));
if(process.argv.includes('--assert60')){
  // NTSC is 59.9227 Hz; assert real unique frames, steady five-second windows,
  // frame-time p95 and delivery integrity rather than rounding the HUD to 60.
  const pass=valid&&duration>=10&&result.source_hz>=59.7&&result.presented_hz>=59.7&&result.min_reported_hz>=59.5
    &&result.max_p95_ms<=18&&result.client_skips===0&&result.native_gaps===0&&result.underruns===0&&result.dropped===0;
  console.log(pass?'PASS: sustained NTSC 60-fps delivery':valid?'FAIL: sustained NTSC 60-fps delivery':'INVALID: server, emulator or browser restarted during measurement');
  if(!pass)process.exitCode=1;
}

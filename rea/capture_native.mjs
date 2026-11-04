// Isolated native integration harness: no existing server/game is touched.
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from './server.mjs';
const rom=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
await mkdir(path.dirname(output),{recursive:true});
const server=createServer(path.dirname(output));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const source=await server.listenStream(0),url=`http://127.0.0.1:${server.address().port}/api/snapshot`;
const child=spawn(path.resolve('blastem-raster.exe'),['-g',rom],{windowsHide:true,stdio:'ignore',env:{...process.env,BLASTEM_REA_STREAM_PORT:String(source.port),BLASTEM_REA_CAPTURE_EVERY:'1',BLASTEM_REA_BROWSER_ONLY:process.argv.includes('--browser-only')?'1':'0'}});
let failure;child.on('error',error=>failure=error);
try{
  const deadline=Date.now()+15000;let capture;
  while(Date.now()<deadline){
    if(failure)throw failure;
    const res=await fetch(url,{signal:AbortSignal.timeout(2000)});
    if(res.ok){const s=await res.json();if(s.frame>3&&s.raster?.valid&&s.raster.complete){capture=s;break;}}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!capture)throw Error('No complete raster capture within 15 seconds');
  await writeFile(output,JSON.stringify(capture));
  console.log(`Captured ${capture.width}x${capture.height}, frame ${capture.frame}, ${capture.id}`);
}finally{
  if(child.pid&&child.exitCode===null&&child.signalCode===null){
    await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
  }
  await new Promise(resolve=>server.close(resolve));
}

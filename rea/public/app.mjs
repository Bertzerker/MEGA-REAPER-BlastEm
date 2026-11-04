import {inspect} from './decoder.mjs';
import {unpack} from './transport.mjs';
import {AtlasPresenter} from './presenter.mjs';
import {FramePacer} from './cadence.mjs';
import {prepare,draw} from './renderer.mjs';
const $=id=>document.getElementById(id),hex=(n,len=2)=>n.toString(16).toUpperCase().padStart(len,'0');
const names={composite:'Composite · captured',sprites:'Sprites · captured input',a:'Plane A · captured input',b:'Plane B · captured input',window:'Window · captured input',source:'Source / priority · captured',tiles:'VRAM tiles · snapshot preview'};
const article=document.createElement('article');article.className='atlas';
const canvas=document.createElement('canvas');canvas.id='atlas';canvas.setAttribute('aria-label','All six synchronized Genesis views');canvas.width=1179;canvas.height=544;
const labels=document.createElement('div');labels.className='atlas-labels';article.append(canvas,labels);$('views').append(article);
const presenter=new AtlasPresenter(canvas);
let current,previous,comparison,selectedPixel,frozen=false,refreshHz=60,socket,layoutSignature;
const pacer=new FramePacer();
let queue=[],buffered=false,lastInfo=0,lastStatus=0,uploadMs=0,presented=0,underruns=0,dropped=0,duplicates=0,sourceHz=60,lastReceivedId;
const times=[],rafTimes=[];
function updateLabels(s){
  const signature=JSON.stringify(s.atlas.panels);if(signature===layoutSignature)return;layoutSignature=signature;
  labels.replaceChildren(...s.atlas.panels.map(panel=>{
    const label=document.createElement('span');label.textContent=(panel.captured?names[panel.view]:names[panel.view]?.replace('captured input','reconstructed'))+(panel.supported?'':' · unavailable')+(panel.partial?' · partial':'');
    label.style.left=`${panel.x/s.atlas.width*100}%`;label.style.top=`${(panel.y-24)/s.atlas.height*100}%`;return label;
  }));
  $('capture-note').textContent=s.raster?'Isolated panels are actual pre-priority VDP inputs, colored at their output slots with the scene’s captured intensity. Window replaces A where selected. Sprite control operators remain transparent. SAT bounds and the optional VRAM tile preview are separate snapshot diagnostics.':'Legacy capture: isolated panels are reconstructed. Start the raster build for direct VDP capture.';
  $('source-legend').hidden=!s.raster;
}
function show(s){
  const start=performance.now();presenter.draw(s,$('bounds').checked);uploadMs=performance.now()-start;updateLabels(s);
}
function info(){
  if(!current)return;
  renderMemory();renderSelection();
  renderTiles();
  $('registers').textContent=`Inspection capture ${current.id}\nFrame ${current.frame} · VDP cycles ${current.vdp_cycles}\nCPU cycles ${current.cpu_cycles}\nSprite overlap flag: ${current.sprite_collision_flag}\n\n`+Array.from(current.regs,(v,i)=>`R${hex(i)} ${hex(v)}`).join('   ');
}
function renderTiles(){
  if(!current||!$('tile-details').open)return;
  const out=new Uint32Array(512*256);draw(prepare(current),'tiles',out);
  $('tile-snapshot').getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.buffer),512,256),0,0);
  $('tile-id').textContent=`Memory snapshot ${current.id} · palette 0 · not a raster layer`;
}
$('tile-details').ontoggle=renderTiles;
function renderSelection(){
  if(!current||!selectedPixel)return;const {view,x,y}=selectedPixel;
  try{$('selection').textContent=JSON.stringify(inspect(current,view,x,y),null,2);}catch(error){$('selection').textContent=error.message;}
}
function renderMemory(){
  if(!current)return;
  const space=$('space').value,data=current[space],base=space==='ram'?0xff0000:0,offset=parseInt($('offset').value,16);
  $('memory-snapshot').textContent=`capture ${current.id}`;
  if(!Number.isInteger(offset)||offset<0||offset>=data.length){$('memory').textContent='Offset outside this address space';return;}
  const prior=(comparison||previous)?.[space],fragment=document.createDocumentFragment();
  for(let a=offset;a<Math.min(data.length,offset+256);a+=16){
    fragment.append(`${hex(base+a,6)}  `);
    for(let i=a;i<Math.min(a+16,data.length);i++){
      const text=hex(data[i])+' ';
      if(prior&&prior[i]!==data[i]){const mark=document.createElement('mark');mark.textContent=text;fragment.append(mark);}else fragment.append(text);
    }
    fragment.append('\n');
  }
  $('memory').replaceChildren(fragment);
}
canvas.addEventListener('click',event=>{
  if(!current)return;const rect=canvas.getBoundingClientRect(),x=(event.clientX-rect.left)*canvas.width/rect.width,y=(event.clientY-rect.top)*canvas.height/rect.height;
  const panel=current.atlas.panels.find(p=>x>=p.x&&y>=p.y&&x<p.x+p.width&&y<p.y+p.height);
  if(panel){selectedPixel={view:panel.view,x:Math.floor(x-panel.x),y:Math.floor(y-panel.y)};renderSelection();}
});
function pause(value){
  frozen=value;queue=[];buffered=false;pacer.reset();times.length=0;
  $('freeze').textContent=frozen?'Resume inspection':'Freeze inspection';
  if(frozen&&current)info();
  if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'pause',paused:frozen}));
}
const channel=new BroadcastChannel('blastem-rea-inspection');
channel.onmessage=({data})=>{if(data.type==='freeze'){pause(data.frozen);if(data.capture){current=data.capture;show(current);info();}}};
$('freeze').onclick=()=>{pause(!frozen);channel.postMessage({type:'freeze',frozen,capture:current});};
$('refresh').onchange=()=>{refreshHz=Number($('refresh').value);queue=[];buffered=false;pacer.reset();times.length=0;};
$('bounds').onchange=()=>{if(current)show(current);};
$('space').onchange=()=>{$('offset').value='0000';renderMemory();};$('offset').oninput=renderMemory;
$('pin').onclick=()=>{comparison=comparison?null:current;$('pin').textContent=comparison?'Clear comparison':'Compare from here';renderMemory();};
$('export').onclick=()=>{
  if(!current)return;const raw={...current};delete raw.atlasPixels;delete raw.atlas;
  for(const key of ['regs','vram','cram','vsram','ram','zram','rgb','raster_samples','raster_flags'])if(raw[key])raw[key]=Array.from(raw[key],v=>hex(v).toLowerCase()).join('');
  if(current.raster?.valid&&current.atlasPixels){
    const {width,height}=current,count=width*height,rgba=new Uint8Array(count*20);
    for(let layer=0;layer<5;layer++){
      const panel=current.atlas.panels.find(p=>p.view===current.raster.layers[layer]);
      for(let y=0;y<height;y++){const start=((panel.y+y)*current.atlas.width+panel.x)*4;rgba.set(current.atlasPixels.subarray(start,start+width*4),(layer*count+y*width)*4);}
    }
    raw.raster_rgba=Array.from(rgba,v=>hex(v).toLowerCase()).join('');
  }
  const url=URL.createObjectURL(new Blob([JSON.stringify(raw)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`rea-${current.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
function connect(){
  socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/stream`);socket.binaryType='arraybuffer';
  socket.onopen=()=>{queue=[];buffered=false;pacer.reset();socket.send(JSON.stringify({type:'pause',paused:frozen}));};
  socket.onmessage=event=>{
    if(frozen)return;
    try{
      const next=unpack(event.data);if(!next.atlasPixels)throw Error('Atlas is missing');
      if(next.id===lastReceivedId||next.id===current?.id){duplicates++;return;}
      lastReceivedId=next.id;sourceHz=next.nominal_hz||60;
      queue.push(next);if(queue.length>10){queue.shift();dropped++;}
    }
    catch(error){$('status').textContent=error.message;socket.close();}
  };
  socket.onclose=()=>{$('status').textContent='Stream disconnected. Restart the server and emulator with the updated launcher.';setTimeout(connect,1000);};
  socket.onerror=()=>{};
}
const rate=list=>list.length>1?(list.length-1)*1000/(list.at(-1)-list[0]):0;
function animate(now){
  rafTimes.push(now);while(rafTimes[0]<now-5000)rafTimes.shift();
  if(!frozen&&pacer.tick(now,sourceHz,refreshHz)){
    if(!buffered&&queue.length>=6)buffered=true;
    if(buffered){
      if(queue.length){
        const next=queue.shift();previous=current;current=next;show(current);times.push(now);presented++;
        if(now-lastInfo>=100){info();lastInfo=now;}
      }else underruns++;
    }
  }
  while(times.length&&times[0]<now-5000)times.shift();
  if(now-lastStatus>=1000){
    const intervals=times.slice(1).map((t,i)=>t-times[i]).sort((a,b)=>a-b),fps=rate(times);
    const metrics={type:'metrics',presented,unique_hz:fps,raf_hz:rate(rafTimes),source_hz:sourceHz,upload_ms:uploadMs,p95_ms:intervals[Math.floor(intervals.length*.95)]||0,underruns,dropped,duplicates,frozen,frame:current?.frame,method:presenter.method,queue:queue.length,capture:current?.id};
    if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(metrics));
    if(current)$('status').textContent=frozen?`Frozen capture ${current.id}`:`${fps.toFixed(1)} unique updates/s · ${uploadMs.toFixed(1)} ms upload · ${presenter.method}`;
    lastStatus=now;
  }
  requestAnimationFrame(animate);
}
connect();requestAnimationFrame(animate);

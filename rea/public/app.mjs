import {inspect} from './decoder.mjs';
import {unpack} from './transport.mjs';
import {AtlasPresenter} from './presenter.mjs';
import {FramePacer} from './cadence.mjs';
import {prepare,draw} from './renderer.mjs';
import {movieUI,api} from './movie-ui.mjs';
import {catalogUI} from './catalog-ui.mjs';
const $=id=>document.getElementById(id),hex=(n,len=2)=>n.toString(16).toUpperCase().padStart(len,'0');
const names={composite:'Composite · Captured output',sprites:'Sprites · Captured input',a:'Plane A · Captured input',b:'Plane B · Captured input',window:'Window · Captured input',source:'Source / priority · Captured evidence'};
const owner=crypto.randomUUID(),article=document.createElement('article'),canvas=document.createElement('canvas'),labels=document.createElement('div');
article.className='atlas';canvas.id='atlas';canvas.tabIndex=0;canvas.width=1;canvas.height=1;canvas.setAttribute('aria-label','Captured VDP atlas. Use the coordinate controls to inspect a pixel with the keyboard.');
labels.className='atlas-labels';article.append(canvas,labels);$('views').append(article);
const presenter=new AtlasPresenter(canvas),pacer=new FramePacer();
let current,previous,comparison,selectedPixel,evidenceMode='none',evidenceValid=false,selectionRequest=0,refreshHz=60,socket,layoutSignature,session,viewerConnected=false;
let queue=[],buffered=false,lastInfo=0,lastStatus=0,uploadMs=0,presented=0,underruns=0,dropped=0,duplicates=0,sourceHz=60,lastReceivedId,lastMovieSignature,lastMovieFrame;
const times=[],rafTimes=[],held=()=>['frozen','saved','invalid'].includes(evidenceMode);
const context=s=>s?.evidence_context||{},compatible=(a,b)=>!!a&&!!b&&['rom','build','session'].every(k=>context(a)[k]===context(b)[k]);
const message=text=>$('evidence-message').textContent=text;
function tabGroup(attribute){
  const buttons=[...document.querySelectorAll(`[${attribute}]`)];
  const activate=button=>{for(const b of buttons){const active=b===button;b.setAttribute('aria-selected',String(active));$(b.getAttribute(attribute)).hidden=!active;}};
  for(const button of buttons){button.onclick=()=>activate(button);button.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const i=buttons.indexOf(button),next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;activate(buttons[next]);buttons[next].focus();};}
  return id=>activate(buttons.find(b=>b.getAttribute(attribute)===id));
}
const drawer=tabGroup('data-drawer'),inspector=tabGroup('data-inspector');
const narrow=matchMedia('(max-width:599px)');let userFocus=false;
if(narrow.matches)$('view-select').value='composite';
narrow.addEventListener('change',()=>{if(!userFocus){$('view-select').value=narrow.matches?'composite':'all';if(current)show(current);}});
new ResizeObserver(()=>document.documentElement.style.setProperty('--toolbar-height',$('machine-status').closest('.sticky-controls').getBoundingClientRect().height+'px')).observe(document.querySelector('.sticky-controls'));
function evidenceStatus(){
  $('evidence-status').textContent=current?`Evidence: ${evidenceMode.toUpperCase()}${session?.evidence.stale&&evidenceMode==='live'?' · STALE':''}${evidenceValid?'':' · pin not confirmed'} · frame ${current.frame} · ${current.id}`:'Evidence: none';
  $('return-live').hidden=!held();$('freeze').textContent=held()?'Resume inspection':'Freeze inspection';
  for(const id of ['freeze','comment-add','export','inspect-pixel','pin']){$(id).disabled=!current||(held()&&!evidenceValid&&['comment-add','export'].includes(id));$(id).title=!current?'Wait for a captured frame or inspect saved evidence.':held()&&!evidenceValid?'Re-select a pixel to confirm evidence retention, or return to live.':'';}
}
function suspend(mode){evidenceMode=mode;queue=[];buffered=false;pacer.reset();times.length=0;socket?.readyState===WebSocket.OPEN&&socket.send(JSON.stringify({type:'pause',paused:held()}));evidenceStatus();}
async function pinRaw(s,purpose='view'){
  if(!s)throw Error('No captured frame is displayed.');
  return api('/api/evidence/pin',{owner,purpose,capture:s.id});
}
async function pinDisplayed(){
  const s=current;if(!s)throw Error('Wait for a native capture or inspect a saved frame.');
  $('follow-pixel').checked=false;
  suspend(s.archive?'saved':'frozen');evidenceValid=false;evidenceStatus();
  try{await pinRaw(s);if(current===s){evidenceValid=true;evidenceStatus();}return s;}
  catch(e){if(current===s){evidenceMode='invalid';evidenceValid=false;message(e.message);evidenceStatus();}throw e;}
}
async function pinCatalogCapture(id){
  if(current?.id===id)return pinDisplayed();
  await pinRaw({id});
  const response=await fetch('/api/evidence?capture='+encodeURIComponent(id));
  if(!response.ok)throw Error((await response.json()).error);
  const s=unpack(await response.arrayBuffer());
  if(s.id!==id)throw Error('The returned capture does not match the catalog observation.');
  selectedPixel=null;
  $('selection').textContent='No pixel selected in this catalog capture.';
  $('follow-pixel').checked=false;
  suspend('frozen');
  setCurrent(s,'frozen');
  evidenceValid=true;
  evidenceStatus();
  return s;
}
function updateLabels(s){
  const signature=JSON.stringify(s.atlas.panels);if(signature===layoutSignature)return;layoutSignature=signature;
  labels.replaceChildren(...s.atlas.panels.map(panel=>{const label=document.createElement('span');label.textContent=(names[panel.view]||panel.view)+(panel.supported?'':' · Unavailable')+(panel.partial?' · partial':'');label.style.left=`${panel.x/s.atlas.width*100}%`;label.style.top=`${(panel.y-24)/s.atlas.height*100}%`;return label;}));
  $('capture-note').textContent=s.raster?'Isolated views preserve actual VDP inputs and output-slot palette/intensity. Window replaces A where selected; sprite control operators remain transparent. Focus crops the same atlas texture.':'Legacy capture: isolated views are memory reconstructions, not direct raster evidence.';
  $('source-legend').hidden=!s.raster;
}
function show(s){
  const focus=$('view-select').value,start=performance.now();presenter.draw(s,$('bounds').checked,focus);uploadMs=performance.now()-start;
  article.classList.toggle('focused',focus!=='all');article.classList.toggle('fixed-scale',$('zoom').value!=='fit');
  canvas.style.width=$('zoom').value==='fit'?'100%':`${canvas.width*Number($('zoom').value)}px`;
  $('empty-state').hidden=true;$('views').hidden=false;updateLabels(s);evidenceStatus();
}
function setCurrent(s,mode=evidenceMode){previous=compatible(current,s)?current:null;current=s;evidenceMode=mode;evidenceValid=mode==='live';show(s);info();}
function info(){
  if(!current)return;renderMemory();renderSelection();renderTiles();
  $('registers').textContent=`${evidenceMode.toUpperCase()} capture ${current.id}\nFrame ${current.frame} · VDP cycles ${current.vdp_cycles}\nCPU cycles ${current.cpu_cycles}\nSprite overlap flag: ${current.sprite_collision_flag}\n\n`+Array.from(current.regs,(v,i)=>`R${hex(i)} ${hex(v)}`).join('\n');
}
function renderTiles(){if(!current||!$('tile-details').open)return;const out=new Uint32Array(512*256);draw(prepare(current),'tiles',out);$('tile-snapshot').getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.buffer),512,256),0,0);$('tile-id').textContent=`Memory diagnostic · capture ${current.id} · palette 0`;} $('tile-details').ontoggle=renderTiles;
function renderSelection(){
  if(!current||!selectedPixel)return;
  if(!$('follow-pixel').checked&&(!evidenceValid||selectedPixel.capture!==current.id)){$('selection').textContent='Evidence retention is not confirmed. Re-select a pixel or return to live.';return;}
  try{const result=inspect(current,selectedPixel.view,selectedPixel.x,selectedPixel.y);$('selection').textContent=`${$('follow-pixel').checked?'FOLLOW LIVE PIXEL':'PINNED EVIDENCE'} · ${current.id}\n`+JSON.stringify(result,null,2);}catch(e){$('selection').textContent=e.message;}
}
function renderMemory(){
  if(!current)return;const space=$('space').value,data=current[space],base=space==='ram'?0xff0000:0,offset=parseInt($('offset').value,16);
  $('memory-snapshot').textContent=`Current: frame ${current.frame} · ${current.id} · ROM ${context(current).rom||'unknown'} · session ${context(current).session||'unknown'}`;
  const validBaseline=!comparison||compatible(comparison,current);
  $('baseline-status').textContent=comparison?`Baseline: frame ${comparison.frame} · ${comparison.id}${validBaseline?'':' · INCOMPATIBLE ROM/session: comparison disabled'}`:'Baseline: previous compatible display; set an explicit baseline to retain it.';
  if(!Number.isInteger(offset)||offset<0||offset>=data.length){$('memory').textContent='Offset outside this address space';return;}
  const prior=(validBaseline?comparison||previous:null)?.[space],fragment=document.createDocumentFragment();
  for(let a=offset;a<Math.min(data.length,offset+256);a+=16){fragment.append(`${hex(base+a,6)}  `);for(let i=a;i<Math.min(a+16,data.length);i++){const text=hex(data[i])+' ';if(prior&&prior[i]!==data[i]){const mark=document.createElement('mark');mark.textContent=text;fragment.append(mark);}else fragment.append(text);}fragment.append('\n');}
  $('memory').replaceChildren(fragment);
}
async function selectPixel(view,x,y){
  if(!current)return;const s=current,request=++selectionRequest;selectedPixel={view,x,y,capture:s.id};$('pixel-view').value=view;$('pixel-x').value=x;$('pixel-y').value=y;inspector('selection-panel');
  if($('follow-pixel').checked){renderSelection();return;}
  $('selection').textContent='Retaining the displayed render and memory…';
  try{await pinDisplayed();if(request!==selectionRequest||current!==s)return;message('');renderSelection();}
  catch(e){if(request===selectionRequest)$('selection').textContent=e.message;}
}
canvas.addEventListener('click',e=>{if(!current)return;const r=canvas.getBoundingClientRect(),crop=presenter.region,x=crop.x+(e.clientX-r.left)*crop.width/r.width,y=crop.y+(e.clientY-r.top)*crop.height/r.height,p=current.atlas.panels.find(p=>x>=p.x&&y>=p.y&&x<p.x+p.width&&y<p.y+p.height);if(p)selectPixel(p.view,Math.floor(x-p.x),Math.floor(y-p.y));});
$('inspect-pixel').onclick=()=>selectPixel($('pixel-view').value,Number($('pixel-x').value),Number($('pixel-y').value));
$('follow-pixel').onchange=()=>{if($('follow-pixel').checked){const selection=selectedPixel;returnLive().then(()=>{selectedPixel=selection;renderSelection();});}else if(selectedPixel)selectPixel(selectedPixel.view,selectedPixel.x,selectedPixel.y);};
canvas.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('inspect-pixel').click();}};
async function returnLive(){
  const request=++selectionRequest;selectedPixel=null;$('selection').textContent='No pixel selected.';message('');suspend('live');evidenceValid=false;
  api('/api/evidence/release',{owner,purpose:'view'}).catch(()=>{});
  try{const response=await fetch('/api/evidence');if(!response.ok)throw Error((await response.json()).error);const s=unpack(await response.arrayBuffer());if(request===selectionRequest)setCurrent(s,'live');}
  catch(e){if(request!==selectionRequest)return;current=null;evidenceMode='none';$('views').hidden=true;$('empty-state').hidden=false;message(e.message);evidenceStatus();}
}
async function openSaved(note){
  const request=++selectionRequest;$('follow-pixel').checked=false;selectedPixel=null;$('selection').textContent='No pixel selected in this saved capture.';suspend('saved');evidenceValid=false;message('Loading and verifying saved evidence…');
  try{const response=await fetch('/api/evidence?note='+encodeURIComponent(note.id));if(!response.ok)throw Error((await response.json()).error);const s=unpack(await response.arrayBuffer());if(request!==selectionRequest)return;setCurrent(s,'saved');await pinDisplayed();message('Saved evidence review. The live machine was not restored or seeked.');}
  catch(e){if(request!==selectionRequest)return;evidenceMode='invalid';message(e.message);evidenceStatus();throw e;}
}
$('return-live').onclick=returnLive;$('freeze').onclick=()=>held()?returnLive():pinDisplayed().catch(e=>message(e.message));
$('view-select').onchange=()=>{userFocus=true;if(current)show(current);};$('zoom').onchange=$('bounds').onchange=()=>{if(current)show(current);};
$('refresh').onchange=()=>{refreshHz=Number($('refresh').value);queue=[];buffered=false;pacer.reset();times.length=0;};
$('space').onchange=()=>{$('offset').value='0000';renderMemory();};$('offset').oninput=renderMemory;
$('pin').onclick=async()=>{
  if(comparison){comparison=null;api('/api/evidence/release',{owner,purpose:'baseline'}).catch(()=>{});$('pin').textContent='Set comparison baseline';renderMemory();return;}
  const s=current;try{await pinRaw(s,'baseline');comparison=s;$('pin').textContent='Clear comparison baseline';renderMemory();}catch(e){message('Baseline not retained: '+e.message);}
};
$('export').onclick=async()=>{try{const s=await pinDisplayed(),response=await fetch('/api/snapshot?snapshot='+encodeURIComponent(s.id));if(!response.ok)throw Error((await response.json()).error);const url=URL.createObjectURL(new Blob([await response.text()],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`rea-${s.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){message(e.message);}};
function onSession(next){
  session=next;$('rom-name').textContent=next.identity.name;$('machine-status').textContent=`Machine: ${next.machine.state} · live frame ${next.machine.machine_frame??next.machine.frame??'unknown'}`;
  const controlLabel=({'ready':'ready','control_disconnected':'disconnected','control_not_configured':'not configured'})[next.connection.control]||'unavailable';
  $('status').textContent=`Viewer ${viewerConnected?'connected':'reconnecting'} · Producer ${next.connection.producer} · Control ${controlLabel}${next.connection.capture_age_ms===null?'':` · last capture ${(next.connection.capture_age_ms/1000).toFixed(1)}s ago`}`;
  if(!current)$('empty-detail').textContent=next.connection.producer==='connected'?'The emulator is connected. Waiting for a valid completed VDP capture.':'No native producer is connected. Start MEGA REAPER with a local ROM, or open a saved comment below.';
  if(next.evidence.stale&&current&&!held())message('Native producer disconnected. The last displayed capture is stale; machine state is shown separately.');
  if(current&&!held()&&next.machine.paused&&Number.isInteger(next.machine.generation)&&current.movie?.generation!==next.machine.generation){message('The machine timeline changed. The previous completed capture is held; step the machine and return to live to inspect its next render.');pinDisplayed().catch(e=>message(e.message));}
  evidenceStatus();
  if(next.machine.paused&&queue.length&&!held()){setCurrent(queue.at(-1),'live');queue=[];buffered=false;pacer.reset();}
}
const ui=movieUI({capture:()=>current,pinDisplayed,openSaved,owner,drawer,onSession,onCaptured:async id=>{const r=await fetch('/api/evidence?capture='+encodeURIComponent(id));if(!r.ok)throw Error((await r.json()).error);setCurrent(unpack(await r.arrayBuffer()),'frozen');await pinDisplayed();}});
catalogUI({capture:()=>current,pixel:()=>selectedPixel,pinDisplayed,drawer,owner,
  attach:(id,attachment)=>ui.commentCatalog(()=>pinCatalogCapture(id),attachment)});
function connect(){
  socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/stream`);socket.binaryType='arraybuffer';
  socket.onopen=()=>{viewerConnected=true;queue=[];buffered=false;pacer.reset();socket.send(JSON.stringify({type:'pause',paused:held()}));if(held()&&current)pinRaw(current).then(()=>{evidenceValid=true;evidenceMode=current.archive?'saved':'frozen';evidenceStatus();}).catch(e=>{evidenceValid=false;evidenceMode='invalid';message(e.message);evidenceStatus();});};
  socket.onmessage=e=>{if(held())return;try{const next=unpack(e.data);if(!next.atlasPixels)throw Error('Atlas missing');if(next.id===lastReceivedId||next.id===current?.id){duplicates++;return;}lastReceivedId=next.id;sourceHz=(next.nominal_hz||60)*(next.movie?.speed||100)/100;const signature=`${next.evidence_context?.session}:${next.movie?.id}:${next.movie?.mode}`;if(signature!==lastMovieSignature||next.movie?.frame<lastMovieFrame){queue=[];buffered=false;pacer.reset();}lastMovieSignature=signature;lastMovieFrame=next.movie?.frame;queue.push(next);if(queue.length>10){queue.shift();dropped++;}}catch(e){message(e.message);socket.close();}};
  socket.onclose=()=>{viewerConnected=false;if(held()){evidenceValid=false;evidenceMode='invalid';message('Viewer connection lost. Held evidence must be retained again before adding a comment.');evidenceStatus();}setTimeout(connect,1000);};socket.onerror=()=>{};
}
const rate=list=>list.length>1?(list.length-1)*1000/(list.at(-1)-list[0]):0;
function animate(now){
  rafTimes.push(now);while(rafTimes[0]<now-5000)rafTimes.shift();
  if(!held()&&pacer.tick(now,sourceHz,refreshHz)){
    if(!buffered&&queue.length>=(session?.machine.paused?1:6))buffered=true;
    if(buffered){if(queue.length){const s=queue.shift();previous=compatible(current,s)?current:null;current=s;evidenceMode='live';evidenceValid=true;show(s);times.push(now);presented++;if(now-lastInfo>=100){info();lastInfo=now;}}else if(!session?.machine.paused)underruns++;}
  }
  while(times.length&&times[0]<now-5000)times.shift();
  if(now-lastStatus>=1000){const intervals=times.slice(1).map((t,i)=>t-times[i]).sort((a,b)=>a-b),metrics={type:'metrics',presented,unique_hz:rate(times),raf_hz:rate(rafTimes),source_hz:sourceHz,upload_ms:uploadMs,p95_ms:intervals[Math.floor(intervals.length*.95)]||0,underruns,dropped,duplicates,frozen:held(),evidence:evidenceMode,frame:current?.frame,method:presenter.method,queue:queue.length,capture:current?.id,texture_uploads:presenter.textureUploads};if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(metrics));$('performance').textContent=JSON.stringify(metrics,null,2);lastStatus=now;}
  requestAnimationFrame(animate);
}
setInterval(()=>{if(held()&&current&&evidenceValid)pinRaw(current).catch(e=>{evidenceValid=false;evidenceMode='invalid';message(e.message);evidenceStatus();});if(comparison)pinRaw(comparison,'baseline').catch(e=>{message('Comparison baseline expired: '+e.message);comparison=null;renderMemory();});},30000);
evidenceStatus();connect();requestAnimationFrame(animate);

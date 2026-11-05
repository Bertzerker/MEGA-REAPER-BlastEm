import {NoteDraft} from './note-model.mjs';
const $=id=>document.getElementById(id);
export async function api(url,body){
  const response=await fetch(url,{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),keepalive:body.action==='pad'&&!body.down}),signal:AbortSignal.timeout(12000)}),data=await response.json();
  if(!response.ok)throw Object.assign(Error(data.error),{status:response.status,code:data.code,latest:data.latest});return data;
}
export function movieUI({capture,pinDisplayed,openSaved,owner,drawer,onSession,onCaptured}){
  let session,state={},model,preview,notes=[],pending=null,pendingSwitch,commandSequence=0,foreignDraft;
  let writer;try{writer=sessionStorage.getItem('rea-editor-writer');if(!writer){writer=crypto.randomUUID();sessionStorage.setItem('rea-editor-writer',writer);}}catch{writer=owner;}
  const error=e=>$('movie-message').textContent=e.message;
  function enable(id,cap,extra=true){const node=$(id);node.disabled=!cap?.available||!extra||(!!pending&&id!=='movie-pause');node.title=!extra?'Unavailable in the current state':cap?.reason||'';}
  function display(next){
    session=next;state=next.machine;onSession(next);
    if(!model)model=new NoteDraft(localStorage,next.workspace_id,writer);
    const c=next.capabilities;
    $('movie-state').textContent=`${state.mode||'No movie'} · movie frame ${state.frame??0} / ${state.length??0}${state.desync?' · DESYNC: '+state.error:''}`;
    for(const [id,key] of Object.entries({'movie-play':'play','movie-pause':'pause','movie-step':'step','movie-speed':'speed','movie-record':'record','movie-replay':'replay','checkpoint-save':'checkpoint','checkpoint-restore':'checkpoint','experiment-run':'experiment','watch-start':'frame_watch','movie-pad-enabled':'browser_input','pause-capture':'pause_capture'}))enable(id,c[key],id!=='checkpoint-restore'||!!$('checkpoint-list').value);
    $('movie-stop').disabled=!state.available||state.mode==='idle'||!!pending;
    $('movie-export').disabled=state.mode==='recording'||!$('movie-list').value;
    if(document.activeElement!==$('movie-speed'))$('movie-speed').value=String(state.speed||100);
    $('checkpoint-reason').textContent=c.checkpoint.reason||'Compatible disk checkpoints. Saving pauses and normalizes the starting state.';
    $('experiment-reason').textContent=state.experiment_remaining?`Running · ${state.experiment_completed}/${state.experiment_total} frames completed; Pause can interrupt.`:c.experiment.reason||'Ready · stops at a completed video-frame boundary.';
    $('trace-reason').textContent=c.instruction_trace.reason+' '+c.collision_adapter.reason;
    $('input-mode').textContent=next.input?.mode==='browser-only'?'Input: browser-only display':next.input?.mode==='native-window'?'Input: optional native window + browser controller':'Input mode not reported; browser controller is opt-in';
    if(!c.browser_input.available&&pressed.size)release();
  }
  async function command(action,extra={},movie=false){
    if(pending&&action!=='pause')return;
    const sequence=++commandSequence;pending=action;$('movie-message').textContent=`${action.replaceAll('_',' ')} pending…`;if(session)display(session);
    try{
      const result=await api(movie?'/api/movie':'/api/control',{action,...extra});
      if(sequence!==commandSequence)return;
      if(action==='pause_capture'){await onCaptured(result.capture.capture);await commentDisplayed(capture());}
      if(['record','stop','replay','checkpoint_save','checkpoint_restore'].includes(action))await library(action==='record'?result.id:undefined);
      $('movie-message').textContent=`${action.replaceAll('_',' ')} completed.`;
    }catch(e){error(e);if(e.code==='command_timeout'||e.name==='TimeoutError')$('movie-message').textContent+=' Command outcome is unknown; the state is being rechecked. No action was retried.';}
    finally{if(sequence===commandSequence){pending=null;await poll();}}
  }
  function statusDraft(){
    if(!model?.base)return;
    $('comment-save-status').textContent=model.error||`${model.recovered?'Recovered draft · ':''}${model.dirty?'Unsaved · recovered locally':'Saved'} · base revision ${model.revision}`;
    foreignDraft=model.foreign()[0];$('comment-recover').hidden=!foreignDraft;
    $('comment-conflict').hidden=!model.latest;
    if(model.latest)$('comment-server-version').textContent=`Revision ${model.latest.revision||0}\n${model.latest.title}\n\n${model.latest.markdown}`;
  }
  function fields(){if(!model?.base)return;$('comment-title').value=model.fields.title;$('comment-text').value=model.fields.markdown;$('comment-classification').value=model.fields.classification;statusDraft();}
  function guard(work){
    if(model?.dirty){pendingSwitch=work;$('note-guard').hidden=false;drawer('comments-drawer');$('guard-stay').focus();return;}
    return work();
  }
  async function continueSwitch(policy){
    try{if(policy==='save'){await save();if(model.dirty)throw Error('New edits were entered while saving. Save them or keep the local draft before switching.');}if(policy==='discard')model.discard();if(policy==='keep')model.persist();const work=pendingSwitch;pendingSwitch=null;$('note-guard').hidden=true;await work?.();}catch(e){error(e);}
  }
  $('guard-save').onclick=()=>continueSwitch('save');$('guard-keep').onclick=()=>continueSwitch('keep');$('guard-discard').onclick=()=>continueSwitch('discard');$('guard-stay').onclick=()=>{pendingSwitch=null;$('note-guard').hidden=true;};
  async function library(preferred){
    const selected=preferred??$('movie-list').value,list=await api('/api/movies'),empty=document.createElement('option');empty.value='';empty.textContent='All movies / session notes';
    $('movie-list').replaceChildren(empty,...list.map(movie=>{const o=document.createElement('option');o.value=movie.id;o.textContent=`${movie.title} · ${movie.length} rows`;return o;}));
    if(list.some(m=>m.id===selected))$('movie-list').value=selected;
    librarySelection=$('movie-list').value;
    notes=await api('/api/comments');renderNotes();
    const previous=$('checkpoint-list').value,checkpoints=await api('/api/checkpoints');
    $('checkpoint-list').replaceChildren(...checkpoints.map(cp=>{const o=document.createElement('option');o.value=cp.id;o.textContent=`${cp.name} · frame ${cp.frame}`;return o;}));
    if(checkpoints.some(cp=>cp.id===previous))$('checkpoint-list').value=previous;
    if(session)display(session);
  }
  function renderNotes(){
    const list=notes.filter(n=>!$('movie-list').value||n.movie===$('movie-list').value);
    $('comment-list').replaceChildren(...list.map(note=>{const button=document.createElement('button'),draft=model?.read(model.key(note.id));button.textContent=`${note.movie_frame===null?'Frame '+note.emulator_frame:'Movie frame '+note.movie_frame} · ${note.title||'Untitled'} · r${note.revision||0}${draft?' · local draft':''}`;button.onclick=()=>guard(()=>edit(note));return button;}));
  }
  function edit(note,{recover=true}={}){
    model.open(note,{recover});drawer('comments-drawer');$('comment-editor').hidden=false;fields();
    $('comment-capture').textContent=`${note.movie?'Movie '+note.movie+' · movie frame '+note.movie_frame:'Session observation'} · emulator frame ${note.emulator_frame} · capture ${note.capture}`
      +(note.catalog?` · ${note.catalog.label} · catalog revision ${note.catalog.revision}`:'');
    $('comment-render').src=`/api/comments/${note.id}/render.png`;
    const files=['note.md','note.json','atlas.png','snapshot.json.gz'];
    if(note.catalog)files.push('catalog.json','isolation.png','export');
    $('comment-files').replaceChildren(...files.map(file=>{const a=document.createElement('a');a.href=`/api/comments/${note.id}/${file}`;a.textContent=file==='export'?'Comment evidence ZIP':file;a.download=file==='export'?'comment.zip':file;return a;}));$('comment-preview').replaceChildren();
  }
  async function save(){
    if(!model?.base)return;
    $('comment-save').disabled=true;
    try{await model.save((id,body)=>api('/api/comments/'+id,body));await library();statusDraft();$('movie-message').textContent=`Comment saved at revision ${model.revision}.`;return true;}
    finally{$('comment-save').disabled=false;statusDraft();}
  }
  async function commentDisplayed(pinned,catalog){
    const s=pinned||await pinDisplayed();if(!s)throw Error('No captured frame is displayed');
    const note=await api('/api/comments',{snapshot:s.id,title:'Frame '+s.frame,markdown:'',catalog});
    await library(note.movie||'');edit(note);$('comment-title').focus();
  }
  $('movie-record').onclick=()=>guard(()=>command('record',{title:$('movie-title').value},true));
  $('movie-play').onclick=()=>state.mode==='ended'?command('replay',{id:state.id},true):command('play');$('movie-pause').onclick=()=>command('pause');$('movie-step').onclick=()=>command('step');$('movie-stop').onclick=()=>command('stop',{},true);
  $('movie-speed').onchange=()=>command('speed',{speed:Number($('movie-speed').value)});
  $('movie-replay').onclick=()=>{if($('movie-list').value)guard(()=>command('replay',{id:$('movie-list').value},true));};
  let librarySelection='';
  $('movie-list').onchange=()=>{const desired=$('movie-list').value;$('movie-list').value=librarySelection;guard(()=>{librarySelection=desired;$('movie-list').value=desired;renderNotes();$('comment-editor').hidden=true;if(session)display(session);});};
  $('movie-export').onclick=()=>{if($('movie-list').value)guard(()=>{location.href=`/api/movies/${$('movie-list').value}/export`;});};
  $('comment-add').onclick=()=>guard(()=>commentDisplayed().catch(error));
  $('pause-capture').onclick=()=>guard(()=>command('pause_capture',{owner}));
  $('comment-save').onclick=()=>save().catch(error);
  for(const id of ['comment-title','comment-text','comment-classification'])$(id).addEventListener('input',()=>{if(!model?.base)return;model.set({title:$('comment-title').value,markdown:$('comment-text').value,classification:$('comment-classification').value});statusDraft();});
  $('comment-discard').onclick=()=>{model?.discard();fields();};
  $('comment-recover').onclick=()=>guard(()=>{model.restore(foreignDraft.key);fields();});
  $('comment-use-server').onclick=()=>{const latest=model.latest;if(latest)guard(()=>{model.discard();edit(latest,{recover:false});});};
  $('comment-rebase').onclick=()=>{try{model.rebase();statusDraft();}catch(e){error(e);}};
  $('comment-inspect').onclick=()=>{
    const note=model?.base;
    if(note)openSaved(note).then(()=>{if(note.catalog)drawer('catalog-drawer');}).catch(error);
  };
  $('comment-preview-button').onclick=async()=>{try{preview??=(await import('/vendor/notes.js')).preview;await preview($('comment-preview'),$('comment-text').value);}catch(e){error(e);}};
  function insert(text){const editor=$('comment-text');editor.setRangeText(text,editor.selectionStart,editor.selectionEnd,'end');editor.dispatchEvent(new Event('input'));editor.focus();}
  $('comment-json').onclick=()=>insert('\n```json\n{\n  "address": "0xFF0000",\n  "observation": ""\n}\n```\n');
  $('comment-mermaid').onclick=()=>insert('\n```mermaid\nflowchart LR\n  Input --> GameLogic\n  GameLogic --> RAM\n  RAM --> VDP\n```\n');
  async function inputRows(delta=0){try{const id=$('movie-list').value;if(!id)throw Error('Select a movie to read its input rows.');const start=Math.max(0,Number($('input-row-start').value)+delta);$('input-row-start').value=start;const data=await api(`/api/movies/${id}/inputs?start=${start}&length=60`);$('input-convention').textContent=data.convention+` · ${data.total} persisted rows`;$('input-rows').textContent=data.rows.map(r=>`${String(r.frame).padStart(7)} → ${String(r.next_frame).padStart(7)}  P1 ${r.p1.toString(16).padStart(4,'0')} [${r.buttons1.join(',')}]  P2 ${r.p2.toString(16).padStart(4,'0')} [${r.buttons2.join(',')}]  CRC ${r.checksum}`).join('\n')||'No rows in this range.';}catch(e){error(e);}}
  $('input-rows-refresh').onclick=()=>inputRows();$('input-rows-prev').onclick=()=>inputRows(-60);$('input-rows-next').onclick=()=>inputRows(60);
  $('checkpoint-save').onclick=()=>command('checkpoint_save',{name:$('checkpoint-name').value});$('checkpoint-restore').onclick=()=>{if($('checkpoint-list').value)command('checkpoint_restore',{id:$('checkpoint-list').value});};
  $('experiment-run').onclick=()=>command('run',{frames:Number($('experiment-frames').value),p1:parseInt($('experiment-p1').value,16),p2:parseInt($('experiment-p2').value,16)});
  async function watch(body){try{const data=await api('/api/watch',body);$('watch-result').textContent=JSON.stringify(data,null,2);}catch(e){error(e);}}
  $('watch-start').onclick=()=>watch({action:'start',space:$('watch-space').value,start:parseInt($('watch-offset').value,16),length:Number($('watch-length').value),frames:Number($('watch-frames').value)});$('watch-stop').onclick=()=>watch({action:'stop'});
  const buttons={ArrowUp:1,ArrowDown:2,ArrowLeft:3,ArrowRight:4,a:5,s:6,d:7,Enter:8,q:9,w:10,e:11,f:12},pressed=new Map();
  const interactive=target=>!!target.closest('input,textarea,select,button,a,summary,[contenteditable=true],[role=textbox]');
  function pad(button,down,port=Number($('movie-pad-port').value)){api('/api/control',{action:'pad',port,button,down}).catch(e=>{if(down)error(e);});}
  function release(){for(const [button,port] of pressed)pad(button,false,port);pressed.clear();}
  window.addEventListener('blur',release);document.addEventListener('visibilitychange',()=>{if(document.hidden)release();});document.addEventListener('focusin',e=>{if(interactive(e.target))release();});$('movie-pad-enabled').onchange=release;$('movie-pad-port').onchange=release;
  window.addEventListener('keydown',e=>{if(!$('movie-pad-enabled').checked||!session?.capabilities.browser_input.available||pending||interactive(e.target)||e.ctrlKey||e.metaKey||e.altKey)return;const button=buttons[e.key.length===1?e.key.toLowerCase():e.key];if(!button)return;e.preventDefault();if(!pressed.has(button)){pressed.set(button,Number($('movie-pad-port').value));pad(button,true);}});
  window.addEventListener('keyup',e=>{const button=buttons[e.key.length===1?e.key.toLowerCase():e.key],port=pressed.get(button);if(pressed.delete(button)){e.preventDefault();pad(button,false,port);}});
  window.addEventListener('beforeunload',e=>{if(model?.dirty){model.persist();if(model.error){e.preventDefault();e.returnValue='';}}release();});
  let polling=false;
  async function poll(){
    if(polling)return;polling=true;
    try{display(await api('/api/session'));if(!$('execution-drawer').hidden)await watch();}
    catch(e){
      error(e);
      if(session)display({...session,connection:{...session.connection,producer:'unknown',control:'unavailable',reason:'REA server disconnected; machine state is unknown.'},machine:{...state,state:'unknown',available:false},evidence:{...session.evidence,stale:true},capabilities:Object.fromEntries(Object.entries(session.capabilities).map(([name,cap])=>[name,{...cap,available:false,reason:'REA server disconnected; reconnect before using this action.'}]))});
    }finally{polling=false;}
  }
  poll().then(()=>library()).catch(error);setInterval(poll,750);
  return {state:()=>state,commentCatalog:(prepare,attachment)=>guard(async()=>{
    try{await commentDisplayed(await prepare(),attachment);}catch(e){drawer('comments-drawer');error(e);}
  })};
}

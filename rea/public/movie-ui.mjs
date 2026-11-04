const $=id=>document.getElementById(id);
export function movieUI({capture,freeze,onState}){
  let state={},editing,preview,notes=[],busy=false;
  async function request(url,body){
    const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await response.json();
    if(!response.ok)throw Error(data.error);return data;
  }
  function error(e){$('movie-message').textContent=e.message;}
  function display(next){
    state=next;onState(state);
    $('movie-state').textContent=state.available===false?state.error:`${state.mode||'idle'} · ${state.paused?'paused':'playing'} · next movie frame ${state.frame??0} / ${state.length??0} · ${state.speed||100}%${state.desync?' · DESYNC: '+state.error:''}`;
    for(const id of ['movie-record','movie-play','movie-pause','movie-step','movie-stop','movie-replay','movie-speed'])$(id).disabled=state.available===false;
    $('movie-record').disabled||=state.mode==='recording';
    $('movie-export').disabled=state.mode==='recording'||!$('movie-list').value;
    $('movie-speed').value=String(state.speed||100);
  }
  async function control(action,extra={}){
    if(busy)return;busy=true;$('movie-message').textContent='';
    try{
      if(['play','step','replay','record'].includes(action))freeze(false);
      display({available:true,...await request('/api/movie',{action,...extra})});
      if(['record','stop','replay'].includes(action))await library();
    }catch(e){error(e);}finally{busy=false;}
  }
  async function library(){
    const selected=$('movie-list').value,list=await request('/api/movies');
    $('movie-list').replaceChildren(...list.map(movie=>{const o=document.createElement('option');o.value=movie.id;o.textContent=`${movie.title} · ${movie.length} frames`;return o;}));
    if(list.some(m=>m.id===state.id))$('movie-list').value=state.id;else if(list.some(m=>m.id===selected))$('movie-list').value=selected;
    $('movie-export').disabled=state.mode==='recording'||!$('movie-list').value;
    notes=await request('/api/comments');renderNotes();
  }
  function renderNotes(){
    const list=notes.filter(n=>!$('movie-list').value||n.movie===$('movie-list').value);
    $('comment-list').replaceChildren(...list.map(note=>{const button=document.createElement('button');button.textContent=`Frame ${note.movie_frame} · ${note.title||'Untitled note'}`;button.onclick=()=>edit(note);return button;}));
  }
  function edit(note){
    editing=note;$('comment-editor').hidden=false;$('comment-title').value=note.title;$('comment-text').value=note.markdown;
    $('comment-capture').textContent=`Movie frame ${note.movie_frame} · emulator frame ${note.emulator_frame} · capture ${note.capture}`;
    $('comment-render').src=`/api/comments/${note.id}/render.png`;
    $('comment-files').replaceChildren(...['note.md','note.json','atlas.png','snapshot.json.gz'].map(file=>{const a=document.createElement('a');a.href=`/api/comments/${note.id}/${file}`;a.textContent=file;a.download=file;return a;}));
    $('comment-preview').replaceChildren();
  }
  $('movie-record').onclick=()=>control('record',{title:$('movie-title').value});
  $('movie-play').onclick=()=>state.mode==='ended'?control('replay',{id:state.id}):control('play');$('movie-pause').onclick=()=>control('pause');$('movie-step').onclick=()=>control('step');$('movie-stop').onclick=()=>control('stop');
  $('movie-speed').onchange=()=>control('speed',{speed:Number($('movie-speed').value)});
  $('movie-replay').onclick=()=>{if($('movie-list').value)control('replay',{id:$('movie-list').value});};
  $('movie-list').onchange=()=>{renderNotes();$('movie-export').disabled=state.mode==='recording'||!$('movie-list').value;};
  $('movie-export').onclick=()=>{if($('movie-list').value)location.href=`/api/movies/${$('movie-list').value}/export`;};
  $('comment-add').onclick=async()=>{
    try{
      const s=capture();if(!s)throw Error('Wait for a captured movie frame');
      freeze(true);
      const note=await request('/api/comments',{snapshot:s.id,title:'Frame '+s.movie?.frame,markdown:''});
      editing=note;await library();edit(note);$('comment-title').focus();
    }catch(e){error(e);}
  };
  $('comment-save').onclick=async()=>{
    try{
      if(!editing)return;
      editing=await request('/api/comments/'+editing.id,{title:$('comment-title').value,markdown:$('comment-text').value});
      await library();$('movie-message').textContent='Comment and evidence saved locally.';
    }catch(e){error(e);}
  };
  $('comment-preview-button').onclick=async()=>{
    try{preview??=(await import('/vendor/notes.js')).preview;await preview($('comment-preview'),$('comment-text').value);}catch(e){error(e);}
  };
  $('comment-json').onclick=()=>insert('\n```json\n{\n  "address": "0xFF0000",\n  "observation": ""\n}\n```\n');
  $('comment-mermaid').onclick=()=>insert('\n```mermaid\nflowchart LR\n  Input --> GameLogic\n  GameLogic --> RAM\n  RAM --> VDP\n```\n');
  function insert(text){const editor=$('comment-text');editor.setRangeText(text,editor.selectionStart,editor.selectionEnd,'end');editor.focus();}
  // Native-window pads and these browser pads share the same frame latch.
  const buttons={ArrowUp:1,ArrowDown:2,ArrowLeft:3,ArrowRight:4,a:5,s:6,d:7,Enter:8,q:9,w:10,e:11,f:12},pressed=new Map();
  function pad(button,down,port=Number($('movie-pad-port').value)){request('/api/movie',{action:'pad',port,button,down}).catch(error);}
  const release=()=>{for(const [button,port] of pressed)pad(button,false,port);pressed.clear();};
  window.addEventListener('blur',release);$('movie-pad-enabled').onchange=release;$('movie-pad-port').onchange=release;
  window.addEventListener('keydown',event=>{
    if(!$('movie-pad-enabled').checked||/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)||event.ctrlKey||event.metaKey||event.altKey)return;
    const button=buttons[event.key];if(!button)return;event.preventDefault();if(!pressed.has(button)){pressed.set(button,Number($('movie-pad-port').value));pad(button,true);}
  });
  window.addEventListener('keyup',event=>{const button=buttons[event.key],port=pressed.get(button);if(pressed.delete(button)){event.preventDefault();pad(button,false,port);}});
  let polling=false;
  async function poll(){if(polling||busy)return;polling=true;try{display(await request('/api/movie'));}catch(e){error(e);}finally{polling=false;}}
  library().catch(error);poll();setInterval(poll,750);
  return {state:()=>state};
}

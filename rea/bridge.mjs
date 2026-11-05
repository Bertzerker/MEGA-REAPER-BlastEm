// GPL-3.0-or-later. Versioned REA adapter; machine and evidence state are independent.
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {collisionSupport} from './public/collision.mjs';
export function contextOf(s,fallback='legacy'){
  if(s.evidence_context)return s.evidence_context;
  const source=s.id?.match(/^(\d+-\d+)-\d+$/)?.[1]||fallback;
  return {session:source+':'+(s.movie?.rom_generation||0),rom:s.movie?.rom_sha1||null,build:s.movie?.build_sha1||null};
}
export function compatible(a,b){return !!a&&!!b&&a.session===b.session&&a.rom===b.rom&&a.build===b.build;}
const validId=id=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id||''))throw Error('Invalid checkpoint ID');return id;};
const capability=(supported,available,reason='',extra={})=>({supported,available:!!(supported&&available),reason,...extra});
export class SessionBridge {
  constructor(dir,movies){this.dir=dir;this.movies=movies;this.workspace=createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0,24);}
  async describe({producer,latest,metrics}={}){
    let native;
    try{native={available:true,...await this.movies.command('describe')};}
    catch(e){
      if(e.code==='native_rejected'||/Unknown.*command/i.test(e.message))native={...await this.movies.status(),protocol:1};
      else native={available:false,code:e.code||'control_disconnected',error:e.message};
    }
    const ready=!!native.available,v2=native.protocol>=2,idle=ready&&native.mode==='idle'&&!native.experiment_remaining,readOnly=['playback','ended'].includes(native.mode);
    const connectionReason=ready?'':native.code==='control_not_configured'?'This server has no native control port. Open a complete REA launcher session.':!producer?'No emulator control connection. Start an emulator with the REA launcher.':'Frames are arriving, but native control is disconnected. Check the launcher/control connection.';
    const movieSupported=ready?(v2?native.movie_supported!==false:true):false;
    const movieReason=ready?(native.movie_reason||'') :connectionReason;
    const idleReason=!ready?connectionReason:!v2?'This native build supports movie transport only. General checkpoints and experiments require bridge protocol 2.':native.experiment_remaining?'Pause the running experiment before changing its starting state.':!idle?'Stop the active movie before changing experiment state.':!movieSupported?movieReason:'';
    const captureAge=metrics?.last_received?Date.now()-metrics.last_received:null;
    const captureMatches=!latest||!ready||!v2||(latest.movie?.rom_generation===native.rom_generation&&(!native.rom_sha1||latest.movie?.rom_sha1===native.rom_sha1));
    const collision=collisionSupport(captureMatches?latest:null,native.rom_sha1||latest?.movie?.rom_sha1);
    return {schema:1,adapter:'genesis-blastem',workspace_id:this.workspace,identity:{name:native.rom_name||'Genesis / Mega Drive',rom:native.rom_sha1||latest?.movie?.rom_sha1||null,build:native.build_sha1||null,session:latest?contextOf(latest,this.workspace).session:null},
      connection:{viewer:'http',producer:producer?'connected':'disconnected',control:ready?'ready':native.code||'disconnected',reason:connectionReason,capture_age_ms:captureAge},
      machine:{state:ready?(native.paused?'paused':'running'):'unknown',frame:native.machine_frame??latest?.frame??null,...native},
      input:{mode:process.env.BLASTEM_REA_BROWSER_ONLY==='1'?'browser-only':process.env.BLASTEM_REA_BROWSER_ONLY==='0'?'native-window':'not_reported'},
      evidence:{available:!!latest&&captureMatches,capture:latest?.id||null,frame:latest?.frame??null,valid:!!latest&&captureMatches,stale:!!latest&&(!producer||!captureMatches),context:latest?contextOf(latest,this.workspace):null},
      capabilities:{
        play:capability(true,ready&&!native.desync,connectionReason||native.error),pause:capability(true,ready,connectionReason),step:capability(true,ready&&native.mode!=='ended'&&!native.desync,connectionReason||(native.mode==='ended'?'Restart or stop the ended movie first.':native.error)),
        pause_capture:capability(v2,ready&&!!producer&&v2&&!!latest&&captureMatches&&(!native.paused||latest.movie?.generation===native.generation),connectionReason||(!v2?'The native bridge needs protocol 2 for acknowledged capture.':!producer?'A completed native capture stream is required.':!latest?'Wait for the first completed capture.':native.paused&&latest.movie?.generation!==native.generation?'Step the restored machine to produce a current completed frame.':'')),
        speed:capability(true,ready,connectionReason,{values:[25,50,100,200,400]}),
        record:capability(movieSupported,ready&&native.mode!=='recording'&&movieSupported,movieReason||(native.mode==='recording'?'A movie is already recording.':'')),
        replay:capability(movieSupported,ready&&native.mode!=='recording'&&movieSupported,movieReason||(native.mode==='recording'?'Stop recording before replaying.':'')),
        browser_input:capability(true,ready&&!readOnly&&!native.experiment_remaining,connectionReason||(readOnly?'Recorded input is authoritative during replay.':native.experiment_remaining?'The bounded experiment owns both controllers.':''),{ports:[1,2]}),
        checkpoint:capability(v2&&movieSupported,idle&&v2&&movieSupported,idleReason,{persistence:'disk',compatibility:'exact ROM, executable and configuration'}),
        experiment:capability(v2&&movieSupported,idle&&v2&&movieSupported,idleReason,{min_frames:1,max_frames:3600,stop_granularity:'completed video-frame boundary'}),
        renderer:capability(!!latest?.raster?.valid&&captureMatches,!!latest?.raster?.valid&&captureMatches,!captureMatches?'No completed capture belongs to the current native ROM/session.':latest?latest.raster?.valid?'':'This capture mode has no supported direct VDP layer capture.':'Waiting for the first native capture.',{coverage:latest?.raster?.complete?'complete':latest?'partial':'unknown'}),
        saved_evidence:capability(true,true),frame_watch:capability(true,!!producer&&!!latest,producer?'Wait for a valid capture.':'Frame watches require an active native producer.',{max_frames:3600,max_events:500,granularity:'copied memory at completed capture boundaries'}),
        instruction_trace:capability(false,false,'Instruction tracing remains a native debugger workflow; frame watches do not trace CPU instructions.'),
        collision_adapter:{...collision,reason:collision.reason||'The Elemental Master contact profile uses completed-frame RAM.'},
        timeline:capability(false,false,'Rerecording, branches and arbitrary seek require the separate determinism design in SPEC.md.')},metrics};
  }
  async control(body){
    const action=body.action;
    if(['play','pause','step','speed','pad'].includes(action))return this.movies.control(body);
    return this.movies.exclusive(async()=>{
      if(action==='checkpoint_save'){
        const id=randomUUID(),name=String(body.name||'Checkpoint').slice(0,120),created=new Date().toISOString();
        await mkdir(path.join(this.dir,'checkpoints',id),{recursive:true});
        const state=await this.movies.command('cp_save '+id);
        const meta={schema:1,id,name,created,rom:state.rom_sha1,build:state.build_sha1,configuration:state.configuration_sha1,frame:state.machine_frame};
        await writeFile(path.join(this.dir,'checkpoints',id,'checkpoint.json'),JSON.stringify(meta,null,2));return state;
      }
      if(action==='checkpoint_restore')return this.movies.command('cp_restore '+validId(body.id));
      if(action==='run'){
        if(!Number.isInteger(body.frames)||body.frames<1||body.frames>3600||![body.p1??0,body.p2??0].every(n=>Number.isInteger(n)&&n>=0&&n<=8190&&(n&1)===0))throw Error('Experiment requires 1–3600 frames and valid 12-button masks');
        return this.movies.command(`run ${body.frames} ${body.p1||0} ${body.p2||0}`);
      }
      if(action==='pause_capture')return this.movies.command('capture');
      throw Error('Unsupported bridge action');
    });
  }
  async checkpoints(){
    const root=path.join(this.dir,'checkpoints');await mkdir(root,{recursive:true});const result=[];
    for(const id of await readdir(root))try{validId(id);result.push(JSON.parse(await readFile(path.join(root,id,'checkpoint.json'),'utf8')));}catch{}
    return result.sort((a,b)=>b.created.localeCompare(a.created));
  }
}
export class FrameWatch {
  start({space='ram',start=0,length=16,frames=120}){
    if(!['ram','zram','vram','cram','vsram','regs'].includes(space)||!Number.isInteger(start)||start<0||!Number.isInteger(length)||length<1||length>1024||!Number.isInteger(frames)||frames<1||frames>3600)throw Error('Watch needs a valid memory domain/range (1–1024 bytes) and 1–3600 captures');
    this.config={space,start,length,frames};this.events=[];this.previous=null;this.seen=0;this.active=true;this.reason='';this.truncated=false;return this.status();
  }
  stop(reason='Stopped by user'){this.active=false;this.reason=reason;return this.status();}
  ingest(s){
    if(!this.active)return;
    const c=this.config,data=s[c.space],context=contextOf(s);
    if(!data||c.start+c.length>data.length){this.stop('Range is outside this capture domain');return;}
    if(this.previous&&!compatible(this.context,context)){this.stop('ROM or native session changed');return;}
    const bytes=data.slice(c.start,c.start+c.length),changes=[];
    if(this.previous)for(let i=0;i<bytes.length;i++)if(bytes[i]!==this.previous[i])changes.push({offset:c.start+i,before:this.previous[i],after:bytes[i]});
    if(changes.length){this.events.push({capture:s.id,frame:s.frame,changes});if(this.events.length>=500){this.truncated=true;this.stop('Event limit reached');}}
    this.previous=bytes;this.context=context;this.seen++;
    if(this.seen>=c.frames)this.stop('Capture limit reached');
  }
  status(){return {schema:1,active:!!this.active,config:this.config||null,captures:this.seen||0,events:this.events||[],truncated:!!this.truncated,reason:this.reason||'',granularity:'completed captures; delivery gaps are not CPU instruction traces'};}
}

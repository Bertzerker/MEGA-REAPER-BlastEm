// Local movie controls and durable investigation evidence. GPL-3.0-or-later.
import net from 'node:net';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,rename,stat,open,rmdir} from 'node:fs/promises';
import {gzipSync,deflateSync,gunzipSync} from 'node:zlib';
import {jsonSnapshot} from './protocol.mjs';
import {decode} from './public/decoder.mjs';
import {AtlasRenderer} from './atlas.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const checkId=id=>{if(!uuid.test(id||''))throw Error('Invalid ID');return id;};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function nativeCommand(port,line){
  return new Promise((resolve,reject)=>{
    if(!Number.isInteger(port)||port<1||port>65535)return reject(Object.assign(Error('No native control port is configured for this server.'),{code:'control_not_configured',status:503}));
    const socket=net.connect({host:'127.0.0.1',port});let data='';
    socket.setTimeout(5000,()=>socket.destroy(Object.assign(Error('Native command timed out; its outcome is unknown. Recheck machine state before issuing another action.'),{code:'command_timeout',status:504})));
    socket.on('connect',()=>socket.write(line+'\n'));
    socket.on('error',e=>reject(e.code==='command_timeout'?e:Object.assign(Error('The native control connection is unavailable. Start or reconnect the emulator using the REA launcher.'),{code:'control_disconnected',status:503})));
    socket.on('end',()=>{if(!data.includes('\n'))reject(Error('Emulator closed control connection'));});
    socket.on('data',chunk=>{
      data+=chunk;if(data.length>4096){socket.destroy(Error('Oversized emulator response'));return;}
      if(data.includes('\n')){
        socket.end();try{const result=JSON.parse(data.split('\n')[0]);if(!result.ok)throw Object.assign(Error(result.error),{code:'native_rejected',status:409});resolve(result.state);}catch(e){reject(e);}
      }
    });
  });
}
// Small PNG encoder: lossless RGBA, no browser screenshot scaling/overlays.
let crcTable;
export function crc32(data){
  crcTable??=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  let crc=0xffffffff;for(const b of data)crc=crcTable[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;
}
export function png(width,height,rgba){
  const chunk=(name,bytes)=>{const type=Buffer.from(name),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(bytes.length);sum.writeUInt32BE(crc32(Buffer.concat([type,bytes])));return Buffer.concat([size,type,bytes,sum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const rows=Buffer.alloc(height*(width*4+1));
  for(let y=0;y<height;y++)Buffer.from(rgba.buffer,rgba.byteOffset+y*width*4,width*4).copy(rows,y*(width*4+1)+1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
export function zip(files){
  const local=[],central=[];let offset=0;
  for(const [name,data] of files){
    const label=Buffer.from(name),crc=crc32(data),entry=Buffer.alloc(30),index=Buffer.alloc(46);
    entry.writeUInt32LE(0x04034b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(0x800,6);entry.writeUInt32LE(crc,14);entry.writeUInt32LE(data.length,18);entry.writeUInt32LE(data.length,22);entry.writeUInt16LE(label.length,26);
    index.writeUInt32LE(0x02014b50);index.writeUInt16LE(20,4);index.writeUInt16LE(20,6);index.writeUInt16LE(0x800,8);index.writeUInt32LE(crc,16);index.writeUInt32LE(data.length,20);index.writeUInt32LE(data.length,24);index.writeUInt16LE(label.length,28);index.writeUInt32LE(offset,42);
    local.push(entry,label,data);central.push(index,label);offset+=entry.length+label.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
async function atomic(file,value){const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,value);await rename(temp,file);}
export class MovieStore {
  constructor(dir,{port,command}={}){this.dir=dir;this.command=command||((line)=>nativeCommand(port,line));this.tail=Promise.resolve();}
  // Serialize control mutations: changing movies must not race a second tab.
  exclusive(work){const result=this.tail.then(work);this.tail=result.catch(()=>{});return result;}
  async status(){try{return {available:true,...await this.command('status')};}catch(e){return {available:false,error:e.message,code:e.code||'control_disconnected'};}}
  async movies(){
    const root=path.join(this.dir,'movies');await mkdir(root,{recursive:true});
    const movies=[];
    for(const id of await readdir(root))if(uuid.test(id))try{
      const meta=JSON.parse(await readFile(path.join(root,id,'movie.json'),'utf8'));
      const info=await stat(path.join(root,id,'inputs.rmt'));movies.push({...meta,length:Math.max(0,Math.floor((info.size-56)/8))});
    }catch{}
    return movies.sort((a,b)=>b.created.localeCompare(a.created));
  }
  control(body){return this.exclusive(async()=>{
    const {action}=body;
    if(action==='record'){
      const id=randomUUID(),title=String(body.title||'REA investigation').slice(0,200),created=new Date().toISOString();
      const folder=path.join(this.dir,'movies',id);await mkdir(folder,{recursive:true});
      const state=await this.command('record '+id);
      await atomic(path.join(folder,'movie.json'),JSON.stringify({schema:1,id,title,created,start:'checkpoint',input:'frame-latched two-player Genesis pads',format:'RMTAS001'},null,2));
      return state;
    }
    if(action==='replay')return this.command('replay '+checkId(body.id));
    if(['play','pause','step','stop'].includes(action))return this.command(action);
    if(action==='speed'&&[25,50,100,200,400].includes(body.speed))return this.command('speed '+body.speed);
    if(action==='pad'&&[1,2].includes(body.port)&&Number.isInteger(body.button)&&body.button>=1&&body.button<=12&&typeof body.down==='boolean')return this.command(`pad ${body.port} ${body.button} ${Number(body.down)}`);
    throw Error('Invalid movie action');
  });}
  async comments(){
    const root=path.join(this.dir,'comments');await mkdir(root,{recursive:true});const notes=[];
    for(const id of await readdir(root))if(uuid.test(id))try{notes.push(JSON.parse(await readFile(path.join(root,id,'note.json'),'utf8')));}catch{}
    return notes.sort((a,b)=>b.created.localeCompare(a.created));
  }
  async annotate(snapshot,{title='',markdown='',classification='observed'}={},attachment){
    if(!snapshot)throw Object.assign(Error('Capture expired. Resume inspection and capture a new comment.'),{status:409});
    const s=typeof snapshot.ram==='string'?decode(snapshot):snapshot;
    const movie=s.movie?.id&&s.movie.mode!=='idle'?checkId(s.movie.id):null;
    const id=randomUUID(),folder=path.join(this.dir,'comments',id);await mkdir(folder,{recursive:true});
    const image=new AtlasRenderer().render(s),rgba=new Uint8Array(s.width*s.height*4);
    for(let i=0;i<s.width*s.height;i++){rgba.set(s.rgb.subarray(i*3,i*3+3),i*4);rgba[i*4+3]=255;}
    const snapshotBytes=gzipSync(Buffer.from(JSON.stringify(jsonSnapshot(s))));
    const atlasBytes=png(image.atlas.width,image.atlas.height,image.atlasPixels),renderBytes=png(s.width,s.height,rgba);
    await Promise.all([writeFile(path.join(folder,'snapshot.json.gz'),snapshotBytes),writeFile(path.join(folder,'atlas.png'),atlasBytes),writeFile(path.join(folder,'render.png'),renderBytes)]);
    const note={schema:2,id,movie,movie_frame:movie?s.movie.frame:null,emulator_frame:s.frame,capture:s.id,context:s.evidence_context||null,created:new Date().toISOString(),width:s.width,height:s.height,
      evidence:{snapshot:{file:'snapshot.json.gz',sha256:hash(snapshotBytes)},atlas:{file:'atlas.png',sha256:hash(atlasBytes)},render:{file:'render.png',sha256:hash(renderBytes)}}};
    if(attachment){
      let row=null;
      if(movie){
        try{row=(await this.inputRows(movie,s.movie.frame,1)).rows[0]||null;}
        catch(error){if(error.code!=='ENOENT')throw error;}
      }
      const content={...attachment.content,snapshot_sha256:note.evidence.snapshot.sha256,
        movie:movie?{id:movie,format:'RMTAS001',frame:s.movie.frame,input_row:s.movie.frame,
          input_checksum:row?.checksum??null,recorded_pad_masks:row?[row.p1,row.p2]:null}:null};
      const bytes=Buffer.from(JSON.stringify(content,null,2));
      await Promise.all([writeFile(path.join(folder,'catalog.json'),bytes),writeFile(path.join(folder,'isolation.png'),attachment.image)]);
      note.evidence.catalog={file:'catalog.json',sha256:hash(bytes)};
      note.evidence.isolation={file:'isolation.png',sha256:hash(attachment.image)};
      const entry=content.catalog;
      note.catalog={id:entry.id,revision:entry.revision,label:entry.label,kind:entry.kind,
        instance:content.observation.instance,evidence:content.observation.evidence};
    }
    return this.saveNote(folder,note,{title,markdown,classification});
  }
  async saveNote(folder,note,body){
    if(typeof body.markdown!=='string'||body.markdown.length>65536||typeof body.title!=='string'||body.title.length>200)throw Error('Note exceeds title/text limit');
    const blocks=[...body.markdown.matchAll(/^(`{3,}|~{3,})json[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/gmi)];for(const block of blocks)JSON.parse(block[2]);
    const classification=body.classification||note.classification||'observed';
    if(!['observed','hypothesis'].includes(classification))throw Error('Unknown finding classification');
    const result={...note,revision:(note.revision||0)+1,classification,title:body.title,markdown:body.markdown,updated:new Date().toISOString()};
    const catalog=note.catalog?'[Captured catalog definition and observation](catalog.json)\n\n![Captured isolation](isolation.png)\n\n':'';
    const doc=`# ${body.title.replace(/[\r\n]/g,' ')}\n\nMovie: ${note.movie} · movie frame: ${note.movie_frame} · emulator frame: ${note.emulator_frame}\n\nCapture: ${note.capture}\n\n![Captured render](render.png)\n\n![Six-view atlas](atlas.png)\n\n[Render and memory snapshot](snapshot.json.gz)\n\n${catalog}${body.markdown}\n`;
    await atomic(path.join(folder,'note.md'),doc);await atomic(path.join(folder,'note.json'),JSON.stringify(result,null,2));return result;
  }
  async updateNote(id,body){
    const folder=path.join(this.dir,'comments',checkId(id)),lock=path.join(folder,'.write-lock');
    if(!Number.isInteger(body.revision)||body.revision<0)throw Object.assign(Error('Read the current note revision before saving.'),{status:428,code:'revision_required'});
    try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')throw Object.assign(Error('This note is being saved by another client. Your draft is unchanged.'),{status:409,code:'note_busy'});throw e;}
    try{
      const note=JSON.parse(await readFile(path.join(folder,'note.json'),'utf8'));
      if(body.revision!==(note.revision||0))throw Object.assign(Error('Another tab saved this note. Review the newer version before saving your draft.'),{status:409,code:'revision_conflict',latest:note});
      return await this.saveNote(folder,note,body);
    }finally{await rmdir(lock);}
  }
  async savedSnapshot(id){
    const note=JSON.parse((await this.artifact(id,'note.json')).toString()),bytes=await this.artifact(id,'snapshot.json.gz');
    if(hash(bytes)!==note.evidence.snapshot.sha256)throw Object.assign(Error('Saved evidence failed its SHA-256 integrity check.'),{status:422});
    const raw=JSON.parse(gunzipSync(bytes,{maxOutputLength:32*1024*1024}));
    if(raw.id!==note.capture||raw.frame!==note.emulator_frame)throw Error('Saved note and capture identities differ');
    if(note.catalog){
      const [catalog]=await Promise.all([this.artifact(id,'catalog.json'),this.artifact(id,'isolation.png')]);
      const evidence=JSON.parse(catalog.toString());
      if(evidence.observation.capture!==note.capture||evidence.snapshot_sha256!==note.evidence.snapshot.sha256
          || evidence.catalog.id!==note.catalog.id||evidence.catalog.revision!==note.catalog.revision
          || hash(JSON.stringify(evidence.catalog))!==evidence.definition_sha256){
        throw Object.assign(Error('Catalog attachment does not match the saved capture and definition.'),{status:422});
      }
    }
    return {...decode(raw),archive:{note:id,title:note.title,catalog:note.catalog},evidence_context:note.context||raw.evidence_context};
  }
  async inputRows(id,start=0,length=60){
    checkId(id);if(!Number.isInteger(start)||start<0||!Number.isInteger(length)||length<1||length>256)throw Error('Input rows require start >= 0 and length 1–256');
    const file=await open(path.join(this.dir,'movies',id,'inputs.rmt'),'r');
    try{
      const info=await file.stat(),header=Buffer.alloc(56);await file.read(header,0,56,0);
      if(header.subarray(0,8).toString()!=='RMTAS001'||info.size<56)throw Error('Invalid movie input log');
      const total=Math.floor((info.size-56)/8),count=Math.min(length,Math.max(0,total-start)),data=Buffer.alloc(count*8);
      await file.read(data,0,data.length,56+start*8);
      const names=['up','down','left','right','a','b','c','start','x','y','z','mode'],buttons=mask=>names.filter((_,i)=>mask&(1<<(i+1)));
      return {schema:1,movie:id,start,total,convention:'Row N checks capture N; pad masks apply after capture N, for frame N+1.',rows:Array.from({length:count},(_,i)=>({frame:start+i,next_frame:start+i+1,p1:data.readUInt16LE(i*8),p2:data.readUInt16LE(i*8+2),buttons1:buttons(data.readUInt16LE(i*8)),buttons2:buttons(data.readUInt16LE(i*8+2)),checksum:data.readUInt32LE(i*8+4).toString(16).padStart(8,'0')}))};
    }finally{await file.close();}
  }
  async artifact(id,file){
    checkId(id);if(!['note.json','note.md','atlas.png','render.png','snapshot.json.gz','catalog.json','isolation.png'].includes(file))throw Error('Unknown evidence file');
    const bytes=await readFile(path.join(this.dir,'comments',id,file));
    if(file==='catalog.json'||file==='isolation.png'){
      const note=JSON.parse(await this.artifact(id,'note.json'));
      const descriptor=note.evidence[file==='catalog.json'?'catalog':'isolation'];
      if(descriptor?.file!==file||descriptor.sha256!==hash(bytes)){
        throw Object.assign(Error('Catalog attachment failed its SHA-256 integrity check.'),{status:422});
      }
    }
    return bytes;
  }
  async noteFiles(note,prefix=''){
    const names=['note.json','note.md','atlas.png','render.png','snapshot.json.gz'];
    if(note.catalog)names.push('catalog.json','isolation.png');
    return Promise.all(names.map(async file=>[prefix+file,await this.artifact(note.id,file)]));
  }
  async exportNote(id){
    const note=JSON.parse(await this.artifact(id,'note.json'));
    if(note.id!==id)throw Error('Saved note identity differs');
    return zip(await this.noteFiles(note));
  }
  async exportMovie(id){
    checkId(id);const status=await this.status();
    if(status.id===id&&status.mode==='recording')throw Error('Stop recording before exporting the movie');
    const folder=path.join(this.dir,'movies',id),files=[];
    for(const name of ['movie.json','inputs.rmt','start.state'])files.push([name,await readFile(path.join(folder,name))]);
    for(const note of await this.comments())if(note.movie===id)files.push(...await this.noteFiles(note,`comments/${note.id}/`));
    const header=files.find(([name])=>name==='inputs.rmt')[1];
    if(header.length<56||(header.length-56)%8||header.subarray(0,8).toString()!=='RMTAS001')throw Error('Invalid movie input log');
    files.push(['inputs.json',Buffer.from(JSON.stringify({schema:1,format:'RMTAS001',rom_sha1:header.subarray(8,28).toString('hex'),emulator_sha1:header.subarray(28,48).toString('hex'),
      frames:Array.from({length:Math.floor((header.length-56)/8)},(_,i)=>({frame:i,p1:header.readUInt16LE(56+i*8),p2:header.readUInt16LE(58+i*8),evidence_crc32:header.readUInt32LE(60+i*8)}))},null,2))]);
    files.push(['README.txt',Buffer.from('MEGA REAPER investigation movie\nRestore movie.json, inputs.rmt and start.state into rea/session/movies/'+id+'/ to replay with the exact recorded ROM and emulator executable. No ROM is included.\nInput masks apply at the boundary AFTER the indicated capture. Frame zero can contain a partial pre-checkpoint render. Each later frame checks render plus RAM/VRAM/CRAM; mismatches pause playback.\nNotes include lossless PNGs and a gzip-compressed render/memory JSON snapshot. Markdown supports fenced json and mermaid blocks.\n')]);
    return zip(files);
  }
}

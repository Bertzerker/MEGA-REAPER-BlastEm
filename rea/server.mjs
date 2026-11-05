// Local snapshot API, movie controls and bounded atlas stream. GPL-3.0-or-later.
import http from 'node:http';
import net from 'node:net';
import {WebSocketServer,WebSocket} from 'ws';
import {readFile, mkdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {decode, inspect, sprites} from './public/decoder.mjs';
import {fields} from './public/transport.mjs';
import {pack,unpack,jsonSnapshot,FrameReader} from './protocol.mjs';
import {AtlasRenderer} from './atlas.mjs';
import {AtlasEncoder} from './public/rle.mjs';
import {MovieStore} from './movie.mjs';
import {SessionBridge,FrameWatch,contextOf,compatible} from './bridge.mjs';
import {CatalogStore,catalogRom,pickCatalog,observeCatalog,catalogAttachment,validateCatalogCapture} from './catalog.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
export function createServer(dir,options={}) {
  const movies=new MovieStore(dir,{port:Number(process.env.BLASTEM_REA_CONTROL_PORT),...options.movie});
  const catalogs=new CatalogStore(dir);
  const bridge=new SessionBridge(dir,movies),watch=new FrameWatch(),leases=new Map(),captureWaiters=new Set();
  const history = new Map();
  const pinned = new Map();
  let cached, stamp, loading, live;
  let streamed,producer,streamListener,producerTicket=0;
  // Fixed-cost pixel runs avoid general-purpose compression worker backlogs
  // on dense scenes. Incompressible atlases use the raw packet format.
  const atlas=new AtlasRenderer(),atlasEncoder=new AtlasEncoder(),wss=new WebSocketServer({noServer:true,maxPayload:16384,perMessageDeflate:false});
  const counters={ingested:0,atlases:0,client_skips:0,native_gaps:0,received_bytes:0,pipeline_max_ms:0,clients:[]};
  const pipelineTimes=[];
  let previousProducer,previousFrame;
  const decoded=s=>typeof s.ram==='string'?decode(s):s;
  const rawJSON=s=>typeof s.ram==='string'?s:jsonSnapshot(s);
  function retained(id){
    for(const [key,item] of leases)if(item.expires<Date.now())leases.delete(key);
    return history.get(id)||pinned.get(id)||Array.from(leases.values()).find(item=>item.raw.id===id)?.raw;
  }
  function pin(raw,owner,purpose='view'){
    if(!/^[a-zA-Z0-9-]{1,64}$/.test(owner||'')||!['view','baseline','catalog'].includes(purpose))throw Error('Invalid evidence lease owner/purpose');
    if(!raw)throw Object.assign(Error('Capture expired or unknown. Resume live inspection to select another frame.'),{status:409,code:'capture_expired'});
    const key=owner+':'+purpose;retained(raw.id);
    if(leases.size>=16&&!leases.has(key))throw Object.assign(Error('Evidence retention is full. Release an unused pinned view.'),{status:429});
    leases.set(key,{raw,expires:Date.now()+120000});return {capture:raw.id,frame:raw.frame,context:contextOf(raw,bridge.workspace),lease:key,expires:Date.now()+120000};
  }
  const binary=(res,raw)=>{const s=decoded(raw),image=new AtlasRenderer().render(s),bytes=pack(image,{omitRasterRGBA:true,omitCatalog:true,atlasEncoder:new AtlasEncoder()});res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);};
  function catalogCapture(id) {
    const raw = typeof id === 'string' && retained(id);
    if (!raw) throw Object.assign(Error('The catalog capture expired. Pin the displayed frame or pick a new match.'), {status: 409});
    return decoded(raw);
  }
  async function pausedCapture(state){
    const sequence=state.capture_sequence;
    if(!sequence)throw Object.assign(Error('The native bridge has no acknowledged completed capture yet.'),{status:503,code:'capture_unavailable'});
    const source=producerTicket;
    const match=s=>s.capture_source===source&&s.id.endsWith('-'+sequence)&&(!state.rom_sha1||s.movie?.rom_sha1===state.rom_sha1);
    const validate=s=>{if(Number.isInteger(state.generation)&&s.movie?.generation!==state.generation)throw Object.assign(Error('The machine was restored after this completed capture. Step a frame before capturing the current timeline.'),{status:409,code:'capture_generation_changed'});return s;};
    const current=Array.from(history.values()).find(match);if(current)return validate(current);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{captureWaiters.delete(waiter);reject(Object.assign(Error('The emulator paused, but its acknowledged capture did not arrive. The command was not retried.'),{status:504,code:'capture_timeout'}));},4000);
      const waiter=s=>{if(match(s)){clearTimeout(timer);captureWaiters.delete(waiter);try{resolve(validate(s));}catch(e){reject(e);}}};captureWaiters.add(waiter);
    });
  }
  function ingest(packet,ticket=producerTicket){
    const started=performance.now();
    const s=unpack(packet);
    s.capture_source=ticket;
    s.evidence_context=contextOf(s,bridge.workspace);
    options.onCapture?.(s);
    if(s.schema!==1||!Number.isInteger(s.width)||s.width<1||s.width>347||!Number.isInteger(s.height)||s.height<1||s.height>512
      ||s.regs.length!==24||s.vram.length!==65536||s.cram.length!==128||s.ram.length!==65536||s.zram.length!==8192
      ||![80,128].includes(s.vsram.length)||s.rgb.length!==s.width*s.height*3)throw Error('Invalid native snapshot');
    if(s.raster&&(s.raster.width!==s.width||s.raster.height!==s.height||JSON.stringify(s.raster.layers)!==JSON.stringify(['sprites','a','b','window','source'])))throw Error('Invalid raster layout');
    if(s.raster?.valid&&(s.raster_rgba?.length!==s.width*s.height*20||s.raster_samples?.length!==s.width*s.height*4||s.raster_flags?.length!==s.width*s.height))throw Error('Invalid captured raster lengths');
    validateCatalogCapture(s);
    const producerId=s.id.slice(0,s.id.lastIndexOf('-'));
    if(producerId===previousProducer&&s.frame>previousFrame)counters.native_gaps+=s.frame-previousFrame-1;
    previousProducer=producerId;previousFrame=s.frame;counters.received_bytes+=packet.byteLength;
    streamed=s;live=packet;history.set(s.id,s);if(history.size>16)history.delete(history.keys().next().value);
    watch.ingest(s);for(const waiter of captureWaiters)waiter(s);
    counters.ingested++;counters.frame=s.frame;counters.last_received=Date.now();
    counters.catalog_bytes=s.catalog_runs?.length||0;
    counters.catalog_dropped_samples=s.catalog?.dropped_samples||0;
    if(Array.from(wss.clients).some(c=>!c.paused)){
      const image=atlas.render(s),combined=pack(image,{omitRasterRGBA:true,omitCatalog:true,atlasEncoder});counters.atlases++;counters.atlas_render_ms=image.atlas.render_ms;counters.last_packet_bytes=combined.byteLength;
      for(const client of wss.clients){
        if(client.readyState!==WebSocket.OPEN||client.paused)continue;
        sendAtlas(client,combined);
      }
    }
    const elapsed=performance.now()-started;
    counters.pipeline_max_ms=Math.max(counters.pipeline_max_ms,elapsed);
    pipelineTimes.push(elapsed);if(pipelineTimes.length>300)pipelineTimes.shift();
  }
  function sendAtlas(client,packet){
    // Count completed messages rather than comparing byte sizes: headers vary
    // slightly, and an audio-paced producer can deliver several frames in a
    // burst. At most six complete frames may be compressing/writing, covering
    // a short worker scheduling pause without dropping a real capture.
    if((client.pendingFrames||0)>=6){counters.client_skips++;return;}
    client.pendingFrames=(client.pendingFrames||0)+1;
    client.send(packet,{binary:true,compress:false},()=>{client.pendingFrames--;});
  }
  async function load() {
    if(streamed)return streamed;
    if(loading)return loading;
    loading=refresh();
    try{return await loading;}finally{loading=null;}
  }
  async function refresh() {
    let raw;
    let nextStamp;
    try {
      const file=path.join(dir,'snapshot.json'), info=await stat(file,{bigint:true});
      nextStamp=`${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.size}`;
      if(cached && stamp===nextStamp)return cached;
      raw = JSON.parse(await readFile(file,'utf8'));
    }
    catch { throw Object.assign(Error('Waiting for emulator snapshot'),{status:503}); }
    if (raw.schema !== 1 || typeof raw.id !== 'string') throw Error('Unsupported snapshot');
    if (!history.has(raw.id)) {
      history.set(raw.id, raw);
      if (history.size > 16) history.delete(history.keys().next().value);
    }
    cached=raw;stamp=nextStamp;live=null;
    return raw;
  }
  const server=http.createServer(async (req,res) => {
    const send = (status,data) => {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try {
      // Prevent arbitrary Host headers/DNS rebinding. Server binds loopback only.
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return send(403,{error:'Use 127.0.0.1'});
      const u = new URL(req.url,'http://127.0.0.1');
      if(req.method==='POST'){
        if(!['/api/movie','/api/comments','/api/control','/api/evidence/pin','/api/evidence/release','/api/watch','/api/catalog','/api/catalog/pick','/api/catalog/observe'].includes(u.pathname)&&!/^\/api\/comments\/[^/]+$/.test(u.pathname))return send(405,{error:'Read-only endpoint'});
        if(req.headers.origin!==`http://${req.headers.host}`||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return send(403,{error:'Same-origin JSON request required'});
        let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>131072)throw Object.assign(Error('Request too large'),{status:413});}
        const body=JSON.parse(text),notePath=u.pathname.match(/^\/api\/comments\/([^/]+)$/);
        if(u.pathname==='/api/evidence/pin')return send(200,pin(retained(body.capture),body.owner,body.purpose));
        if(u.pathname==='/api/evidence/release'){if(!/^[a-zA-Z0-9-]{1,64}$/.test(body.owner||''))throw Error('Invalid lease owner');for(const key of leases.keys())if(key.startsWith(body.owner+':')&&(!body.purpose||key.endsWith(':'+body.purpose)))leases.delete(key);return send(200,{released:true});}
        if(u.pathname==='/api/watch')return send(200,body.action==='stop'?watch.stop():watch.start(body));
        if(u.pathname==='/api/catalog')return send(200,await catalogs.write(catalogCapture(body.capture),body));
        if(u.pathname==='/api/catalog/pick')return send(200,pickCatalog(catalogCapture(body.capture),body.selection));
        if(u.pathname==='/api/catalog/observe'){
          const s=catalogCapture(body.capture),entry=await catalogs.entry(s,body.entry,body.revision);
          const {result,image}=observeCatalog(s,entry,{instance:body.instance,follow:body.follow,point:body.point});
          if(body.owner && image)pin(s,body.owner,'catalog');
          return send(200,{...result,image:image?.toString('base64')||null});
        }
        if(u.pathname==='/api/control'){
          const state=await bridge.control(body);
          if(body.action==='pause_capture'){
            const raw=await pausedCapture(state),lease=pin(raw,body.owner,'view');return send(200,{state,capture:lease});
          }
          return send(200,{state});
        }
        if(u.pathname==='/api/movie')return send(200,await movies.control(body));
        if(u.pathname==='/api/comments'){
          const raw=retained(body.snapshot);
          let attachment;
          if(body.catalog){
            const s=catalogCapture(body.snapshot);
            const entry=await catalogs.entry(s,body.catalog.entry,body.catalog.revision);
            attachment=catalogAttachment(s,entry,body.catalog.instance);
          }
          return send(201,await movies.annotate(raw,body,attachment));
        }
        if(notePath)return send(200,await movies.updateNote(notePath[1],body));
        return send(405,{error:'Unknown write endpoint'});
      }
      if(req.method!=='GET')return send(405,{error:'Method not allowed'});
      if(u.pathname==='/api/session')return send(200,await bridge.describe({producer:!!producer,latest:streamed||cached,metrics:counters}));
      if(u.pathname==='/api/checkpoints')return send(200,await bridge.checkpoints());
      if(u.pathname==='/api/watch')return send(200,watch.status());
      if(u.pathname==='/api/catalog')return send(200,await catalogs.read(catalogRom(catalogCapture(u.searchParams.get('capture')))));
      if(u.pathname==='/api/evidence'){
        const note=u.searchParams.get('note');let raw;
        if(note){raw=await movies.savedSnapshot(note);raw.evidence_context=contextOf(raw,bridge.workspace);pinned.set(raw.id,raw);if(pinned.size>16)pinned.delete(pinned.keys().next().value);}
        else raw=u.searchParams.has('capture')?retained(u.searchParams.get('capture')):await load();
        if(!raw)return send(404,{error:'Capture expired or unknown'});return binary(res,raw);
      }
      const inputRows=u.pathname.match(/^\/api\/movies\/([^/]+)\/inputs$/);
      if(inputRows)return send(200,await movies.inputRows(inputRows[1],Number(u.searchParams.get('start')||0),Number(u.searchParams.get('length')||60)));
      if(u.pathname==='/api/movie')return send(200,await movies.status());
      if(u.pathname==='/api/movies')return send(200,await movies.movies());
      if(u.pathname==='/api/comments')return send(200,await movies.comments());
      const artifact=u.pathname.match(/^\/api\/comments\/([^/]+)\/([^/]+)$/),movieExport=u.pathname.match(/^\/api\/movies\/([^/]+)\/export$/);
      if(artifact||movieExport){
        const file=artifact?.[2]==='export'?'comment.zip':artifact?.[2]||'movie.zip';
        const bytes=movieExport?await movies.exportMovie(movieExport[1]):file==='comment.zip'?await movies.exportNote(artifact[1]):await movies.artifact(artifact[1],file);
        res.writeHead(200,{'Content-Type':file.endsWith('.png')?'image/png':file.endsWith('.gz')?'application/gzip':file.endsWith('.zip')?'application/zip':file.endsWith('.json')?'application/json':'text/markdown; charset=utf-8',
          'Cache-Control':'no-store','Content-Disposition':`${file.endsWith('.png')?'inline':'attachment'}; filename="${file}"`,'X-Content-Type-Options':'nosniff'});return res.end(bytes);
      }
      if (u.pathname.startsWith('/api/')) {
        if(u.pathname==='/api/metrics'){
          const sorted=[...pipelineTimes].sort((a,b)=>a-b);
          return send(200,{...counters,pipeline_p95_ms:sorted[Math.floor(sorted.length*.95)]||0,clients:Array.from(wss.clients,c=>({...c.metrics,pending_frames:c.pendingFrames||0,transport:'rgba-rle/raw'}))});
        }
        const requested=u.searchParams.get('snapshot');
        const latest = requested?retained(requested):await load();
        if(!latest)return send(404,{error:'Snapshot expired or unknown'});
        if(u.pathname === '/api/live') {
          const etag=`"${latest.id}"`;
          if(req.headers['if-none-match']===etag){res.writeHead(304,{'ETag':etag,'Cache-Control':'no-cache'});return res.end();}
          if(!live){
            const metadata={...latest},parts=[];
            for(const field of fields){parts.push(Buffer.from(metadata[field],'hex'));delete metadata[field];}
            const header=Buffer.from(JSON.stringify({metadata,lengths:parts.map(p=>p.length)}));
            const size=Buffer.alloc(4);size.writeUInt32LE(header.length);
            live=Buffer.concat([size,header,...parts]);
          }
          res.writeHead(200,{'Content-Type':'application/octet-stream','ETag':etag,'Cache-Control':'no-cache','Content-Length':live.length});
          return res.end(live);
        }
        if (u.pathname === '/api/history') return send(200,Array.from(history.values(),s=>({id:s.id,frame:s.frame})));
        const id = u.searchParams.get('snapshot');
        const raw = id ? retained(id) : latest;
        if (!raw) return send(404,{error:'Snapshot expired or unknown'});
        if (u.pathname === '/api/snapshot') {
          pinned.delete(raw.id);pinned.set(raw.id,raw);if(pinned.size>16)pinned.delete(pinned.keys().next().value);
          return send(200,rawJSON(raw));
        }
        const s = decoded(raw);
        if (u.pathname === '/api/sprites') {
          if (!s.mode5 || s.interlace) throw Error('Decoder supports non-interlaced Mode 5 only');
          return send(200,{snapshot:s.id,sprites:sprites(s),evidence:'SAT reconstruction; no gameplay objects'});
        }
        if (u.pathname === '/api/pixel') return send(200,inspect(s,u.searchParams.get('view'),Number(u.searchParams.get('x')),Number(u.searchParams.get('y'))));
        if (['/api/memory','/api/diff'].includes(u.pathname)) {
          const space = u.searchParams.get('space') || 'ram';
          if (!['ram','zram','vram','cram','vsram','regs'].includes(space)) throw Error('Unknown address space');
          const start = Number(u.searchParams.get('start') || 0), length = Number(u.searchParams.get('length') || 256);
          if (!Number.isInteger(start)||!Number.isInteger(length)||start<0||length<1||length>4096||start+length>s[space].length) throw Error('Invalid range (maximum 4096 bytes)');
          if (u.pathname === '/api/memory') return send(200,{snapshot:s.id,space,start,base:space==='ram'?0xff0000:0,bytes:Array.from(s[space].slice(start,start+length))});
          const prior = retained(u.searchParams.get('from'));
          if (!prior) return send(404,{error:'Comparison snapshot expired or unknown'});
          if(!compatible(contextOf(prior,bridge.workspace),contextOf(raw,bridge.workspace)))return send(409,{error:'Comparison belongs to a different ROM or native session.',code:'incompatible_evidence'});
          const b = decoded(prior)[space], changes=[];
          for (let i=start;i<start+length;i++) if (b[i]!==s[space][i]) changes.push({offset:i,before:b[i],after:s[space][i]});
          return send(200,{from:prior.id,to:s.id,space,changes});
        }
        return send(404,{error:'Unknown endpoint'});
      }
      const files = {'/':'index.html','/app.mjs':'app.mjs','/decoder.mjs':'decoder.mjs','/renderer.mjs':'renderer.mjs','/transport.mjs':'transport.mjs','/presenter.mjs':'presenter.mjs','/cadence.mjs':'cadence.mjs','/rle.mjs':'rle.mjs','/style.css':'style.css','/movie-ui.mjs':'movie-ui.mjs','/note-model.mjs':'note-model.mjs','/catalog-ui.mjs':'catalog-ui.mjs'};
      const file = files[u.pathname]||(/^\/vendor\/[a-zA-Z0-9_.-]+\.(?:js|mjs)$/.test(u.pathname)?u.pathname.slice(1):null);
      if (!file) return send(404,{error:'Not found'});
      res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript',
        'Cache-Control':'no-store','Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://${req.headers.host}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`});
      res.end(await readFile(path.join(here,'public',file)));
    } catch(e) { send(e.status || (e.code==='ENOENT'?404:400),{error:e.message,code:e.code,latest:e.latest}); }
  });
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/stream'||!/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')||req.headers.origin!==`http://${req.headers.host}`){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      ws.on('error',()=>{});
      ws.on('message',message=>{try{const m=JSON.parse(message);if(m.type==='metrics')ws.metrics={...m,received:Date.now()};if(m.type==='pause')ws.paused=!!m.paused;}catch{}});
      if(streamed)sendAtlas(ws,pack(atlas.render(streamed),{omitRasterRGBA:true,omitCatalog:true,atlasEncoder}));
    });
  });
  server.listenStream=port=>new Promise((resolve,reject)=>{
    streamListener=net.createServer(socket=>{
      if(producer){socket.destroy();return;}
      producer=socket;socket.setNoDelay(true);
      const ticket=++producerTicket,reader=new FrameReader(packet=>ingest(packet,ticket));
      socket.on('data',chunk=>{try{reader.push(chunk);}catch(error){console.error('REA stream:',error.message);socket.destroy();}});
      socket.on('error',()=>{});socket.on('close',()=>{if(producer===socket){producer=null;if(watch.active)watch.stop('Native producer disconnected');}});
    });
    streamListener.once('error',reject);streamListener.listen(port,'127.0.0.1',()=>resolve(streamListener.address()));
  });
  // Close upgraded sockets before awaiting HTTP close; an open viewer must not
  // keep an owned session alive during shutdown.
  let closing=false;
  const close=server.close.bind(server);
  server.close=(...args)=>{
    if(!closing){closing=true;for(const ws of wss.clients)ws.terminate();wss.close();producer?.destroy();streamListener?.close();}
    return close(...args);
  };
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.env.BLASTEM_REA_DIR || process.argv[2] || path.join(here,'session'));
  await mkdir(dir,{recursive:true});
  const port = Number(process.env.PORT || 8765);
  const server=createServer(dir),streamPort=Number(process.env.BLASTEM_REA_STREAM_PORT||port+1);
  await server.listenStream(streamPort);
  server.listen(port,'127.0.0.1',()=>console.log(`REA: http://127.0.0.1:${port}\nNative binary stream: 127.0.0.1:${streamPort}\nCapture directory (legacy fallback): ${dir}`));
}

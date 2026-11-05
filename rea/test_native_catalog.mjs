// Original-ROM acceptance. Each phase owns one hidden native process and cleans it up.
import assert from 'node:assert/strict';
import {execFile, execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {promisify} from 'node:util';
import {inflateSync} from 'node:zlib';
import WebSocket from 'ws';
import {createServer} from './server.mjs';
import {catalogRom, observeCatalog, pickCatalog, sha256, timelineOf} from './catalog.mjs';
import {nativeCommand} from './movie.mjs';
import {unpack} from './protocol.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const folder = await mkdtemp(path.resolve('rea/test-output/catalog-acceptance-'));
const h40 = path.resolve('rea/test-output/catalog-test.bin');
const h32 = path.resolve('rea/test-output/catalog-test-h32.bin');
const visual = ['ram', 'zram', 'vram', 'cram', 'vsram', 'regs', 'rgb', 'raster_rgba', 'raster_samples', 'raster_flags'];
const spriteAddress = 'sat:55296,55304';
const invoke = promisify(execFile);

async function wait(predicate, timeout = 12000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const result = await predicate();
    if (result) return result;
    await sleep(10);
  }
  throw Error('Timed out waiting for catalog fixture.');
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function json(root, route, body, status = 200) {
  const response = await fetch(root + route, body === undefined ? {} : {
    method: 'POST', headers: {Origin: root, 'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result).slice(0, 1000));
  return result;
}

async function native(rom, enabled, work) {
  const existing = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "@(Get-Process -Name 'blastem*' -ErrorAction SilentlyContinue).Count"],
  {encoding: 'utf8', windowsHide: true}).trim();
  assert.equal(existing, '0', 'A BlastEm instance is already running.');
  const reservation = net.createServer(), reservationURL = await listen(reservation);
  const port = Number(new URL(reservationURL).port);
  await new Promise(resolve => reservation.close(resolve));
  const command = line => nativeCommand(port, line);
  let latest, visitor, log = '';
  const server = createServer(folder, {movie: {command}, onCapture: s => {
    latest = s;
    visitor?.(s);
  }});
  const root = await listen(server), stream = await server.listenStream(0);
  const child = spawn(path.resolve('blastem-raster.exe'), ['-g', rom], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, BLASTEM_REA_DIR: folder, BLASTEM_REA_CONTROL_PORT: String(port),
      BLASTEM_REA_STREAM_PORT: String(stream.port), BLASTEM_REA_BROWSER_ONLY: '1',
      BLASTEM_REA_CAPTURE_EVERY: '1', BLASTEM_REA_CATALOG: enabled ? '1' : '0'},
  });
  child.stdout.on('data', bytes => { log += bytes; });
  child.stderr.on('data', bytes => { log += bytes; });
  const post = (route, body, status = 200) => json(root, route, body, status);
  const pin = capture => post('/api/evidence/pin', {capture, owner: 'catalog-fixture'});
  try {
    await wait(() => latest?.frame > 6 && latest.raster?.complete);
    return await work({
      root, command, post, pin, pid: child.pid, get latest() { return latest; },
      visit: callback => { visitor = callback; },
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
    await new Promise(resolve => server.close(resolve));
    await writeFile(path.join(folder, `native-${path.basename(rom)}-${enabled}.log`), log);
  }
}

function profile(kind, pieces) {
  return {id: 'test', revision: 1, label: 'Original fixture', kind, selectors: [{pieces}]};
}
function rule(layer, first, last = first, palette = 0) { return {layer, first, last, palette}; }
const chains = profile('sprite', [rule('sprites', 2, 3), rule('sprites', 2)]);
const bTiles = profile('tile', [rule('b', 1, 1, null)]);

function countPixels(image, width, height) {
  let alpha = 0;
  // The production PNG encoder uses one unfiltered IDAT.
  assert.equal(image.subarray(37, 41).toString(), 'IDAT');
  const rows = inflateSync(image.subarray(41, 41 + image.readUInt32BE(33)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (rows[y * (width * 4 + 1) + 4 + x * 4]) alpha++;
  }
  return alpha;
}

function anchor(result, id) {
  const item = result.instances.find(instance => instance.id === id);
  assert.ok(item, `Expected ${id} among ${result.instances.map(i => i.id)}`);
  return {capture: result.capture, id, timeline: result.timeline, frame: result.frame,
    locator: item.locator, x: item.x, y: item.y};
}

function exact(s) {
  return {
    cpu: s.cpu_cycles, vdp: s.vdp_cycles,
    ...Object.fromEntries(visual.map(field => [field, sha256(s[field])])),
  };
}

function verifyRuns(s) {
  const size = s.width * s.height, seen = new Uint8Array(size * 4);
  const bytes = Buffer.from(s.catalog_runs);
  for (let offset = 0; offset < bytes.length; offset += 12) {
    const x = bytes.readUInt16LE(offset), y = bytes.readUInt16LE(offset + 2) - s.catalog.row_origin;
    if (y < 0 || y >= s.height) continue;
    const end = Math.min(s.width, x + bytes[offset + 4]), layer = bytes[offset + 5];
    const attr = bytes.readUInt16LE(offset + 6);
    for (let i = x; i < end; i++) {
      const index = size * layer + y * s.width + i, sample = s.raster_samples[index];
      assert.ok(sample & 15, 'Attributed pixels are admitted nonzero samples.');
      assert.equal(sample & 0x70, (attr >> 9) & 0x70, 'Captured attribute supplies palette and priority.');
      assert.equal(seen[index], 0, 'A stable-mode layer has one attribution per output sample.');
      seen[index] = 1;
    }
  }
  for (let i = 0; i < seen.length; i++) assert.equal(seen[i], Number(Boolean(s.raster_samples[i] & 15)));
}

async function measure(session, activeEntry) {
  let frames = 0, first;
  const socket = new WebSocket(session.root.replace('http', 'ws') + '/stream', {origin: session.root});
  socket.on('message', bytes => { frames++; first ??= bytes; });
  await once(socket, 'open');
  const proc = async () => {
    const script = `$p=Get-Process -Id ${session.pid}; @($p.TotalProcessorTime.TotalMilliseconds,$p.WorkingSet64) -join '|'`;
    const {stdout} = await invoke('powershell.exe', ['-NoProfile', '-Command', script], {windowsHide: true});
    return stdout.trim().split('|').map(Number);
  };
  const metrics = async () => {
    const snapshot = await json(session.root, '/api/metrics');
    return {...snapshot, delivered: frames};
  };
  let observations = 0, pending = false, worstObservation = 0, observeError;
  const timer = activeEntry && setInterval(async () => {
    if (pending) return;
    pending = true;
    const started = performance.now();
    try {
      await session.post('/api/catalog/observe', {capture: session.latest.id, entry: activeEntry.id, revision: activeEntry.revision});
      observations++;
      worstObservation = Math.max(worstObservation, performance.now() - started);
    } catch (error) { observeError = error; }
    finally { pending = false; }
  }, 125);
  try {
    await sleep(650);
    const [start, resources] = await Promise.all([metrics(), proc()]);
    await sleep(5000);
    const [end, finalResources] = await Promise.all([metrics(), proc()]);
    if (observeError) throw observeError;
    assert.ok(first);
    assert.equal(unpack(first).catalog_runs, undefined, 'Normal atlas clients must not receive provenance buffers.');
    return {
      seconds: (end.last_received - start.last_received) / 1000, captures: end.ingested - start.ingested,
      delivered: end.delivered - start.delivered, native_gaps: end.native_gaps - start.native_gaps,
      viewer_skips: end.client_skips - start.client_skips, catalog_bytes: end.catalog_bytes,
      catalog_dropped_samples: end.catalog_dropped_samples, server_pipeline_p95_ms: end.pipeline_p95_ms,
      native_cpu_ms_per_capture: (finalResources[0] - resources[0]) / (end.ingested - start.ingested),
      native_working_set_bytes: finalResources[1], observations, worst_observation_ms: worstObservation,
    };
  } finally { clearInterval(timer); socket.close(); }
}

const recorded = new Map();
const replayed = new Map();
let movie, entry, note, originalLog, oldRom, observed, onMetrics, offMetrics;
await native(h40, true, async session => {
  const {root, post, pin, command} = session;
  await post('/api/control', {action: 'pause_capture', owner: 'catalog-fixture'});
  const first = session.latest;
  assert.equal(first.catalog.status, 'complete');
  assert.equal(first.catalog.mode, 2);
  verifyRuns(first);
  oldRom = catalogRom(first);
  const firstGroups = observeCatalog(first, chains);
  let start = firstGroups.result.instances.find(item => item.id === spriteAddress);
  async function step() {
    const prior = session.latest.id;
    await post('/api/control', {action: 'step'});
    return wait(() => session.latest.id !== prior && session.latest);
  }
  for (let i = 0; i < 14 && !start; i++) {
    await step();
    start = observeCatalog(session.latest, chains).result.instances.find(item => item.id === spriteAddress);
  }
  assert.ok(start, 'The first linked sprite must become visible.');
  const seedFrame = session.latest;
  const seedSelection = {view: 'sprites', x: start.bounds.left, y: start.bounds.top, count: 2};
  const seed = pickCatalog(seedFrame, seedSelection);
  assert.deepEqual(seed.selector.seed.samples.map(sample => [sample.slot, sample.link]), [[0, 1], [1, 2]]);
  await pin(seedFrame.id);
  let saved = await post('/api/catalog', {action: 'create', revision: 0, capture: seedFrame.id,
    selection: seedSelection, label: 'Original linked animation'});
  entry = saved.entry;
  assert.equal(saved.catalog.revision, 1);
  await post('/api/catalog', {action: 'edit', revision: 0, capture: seedFrame.id, entry: entry.id}, 409);

  const firstPattern = seed.selector.pieces[0].first;
  for (let i = 0; i < 12; i++) {
    const next = await step(), sample = observeCatalog(next, chains).result.instances.find(item => item.id === spriteAddress);
    if (!sample || sample.samples[0].tile === firstPattern) continue;
    await pin(next.id);
    saved = await post('/api/catalog', {action: 'append', revision: 1, capture: next.id, entry: entry.id,
      selection: {view: 'sprites', x: sample.bounds.left, y: sample.bounds.top, count: 2}});
    entry = saved.entry;
    break;
  }
  assert.equal(entry.selectors.length, 2);
  const a = session.latest, all = observeCatalog(a, entry);
  assert.equal(all.result.count, 2);
  assert.equal(countPixels(all.image, a.width, a.height), 256);
  const only = observeCatalog(a, entry, {instance: spriteAddress});
  assert.equal(countPixels(only.image, a.width, a.height), 128);
  const tiles = observeCatalog(a, bTiles);
  assert.ok(tiles.result.count > 500);
  assert.ok(tiles.result.instances.some(item => item.samples[0].address !== tiles.result.instances[0].samples[0].address));
  const distantTile = observeCatalog(a, bTiles, {point: {x: 32, y: 180}}).result.instance;
  assert.ok(distantTile.bounds.top > 170);
  assert.ok(!tiles.result.instances.some(item => item.id === distantTile.id), 'Image selection reaches beyond the bounded dropdown.');
  const window = pickCatalog(a, {view: 'window', x: 280, y: 25});
  assert.equal(window.selector.seed.samples[0].layer, 'window');
  assert.equal(window.selector.pieces[0].first, 2);
  await pin(a.id);
  saved = await post('/api/catalog', {action: 'create', revision: 2, capture: a.id, label: 'Repeating backdrop',
    selection: {view: 'b', x: 30, y: 25, palette: false}});
  assert.equal(saved.entry.kind, 'tile');
  assert.equal(saved.entry.selectors[0].pieces[0].palette, null);

  let followStart = all.result;
  for (let i = 0; i < 14 && !followStart.instances.some(item => item.id === spriteAddress && item.bounds.left <= 88); i++) {
    followStart = observeCatalog(await step(), entry).result;
  }
  assert.ok(followStart.instances.some(item => item.id === spriteAddress && item.bounds.left <= 88));
  let previous = anchor(followStart, spriteAddress);
  const tileStart = observeCatalog(session.latest, bTiles).result;
  const tileAnchor = anchor(tileStart, tileStart.instances.find(item => item.bounds.top > 18).id);
  let motion = false, loss = false, slotReuse = false;
  let tileFollow = false;
  const palettes = new Set();
  for (let i = 0; i < 14; i++) {
    const s = await step();
    const tile = pickCatalog(s, {view: 'b', x: 14, y: 10});
    palettes.add(tile.selector.seed.samples[0].palette);
    if (s.frame - tileAnchor.frame <= 12) {
      const trackedTile = observeCatalog(s, bTiles, {follow: tileAnchor}).result;
      if (trackedTile.state === 'following') tileFollow = trackedTile.instance.locator === tileAnchor.locator;
    }
    const next = observeCatalog(s, entry, {follow: previous}).result;
    if (next.state === 'following') {
      assert.equal(next.selected, spriteAddress);
      if (next.instance.x !== previous.x) motion = true;
      previous = anchor(next, next.selected);
    } else {
      assert.equal(next.state, 'missing');
      loss = true;
      if (next.instances.some(item => item.id === spriteAddress && item.x > 170)) slotReuse = true;
      if (slotReuse && palettes.size > 1) break;
    }
  }
  assert.ok(motion && loss && slotReuse && tileFollow && palettes.size === 2,
    JSON.stringify({motion, loss, slotReuse, tileFollow, palettes: [...palettes]}));
  const generationBefore = session.latest.catalog.generation;
  await post('/api/control', {action: 'checkpoint_save', name: 'Catalog continuity checkpoint'});
  const [checkpoint] = await json(root, '/api/checkpoints');
  await step();
  await post('/api/control', {action: 'checkpoint_restore', id: checkpoint.id});
  const afterRestore = await step();
  assert.ok(afterRestore.catalog.generation > generationBefore);
  assert.notEqual(timelineOf(afterRestore), previous.timeline);

  // Record, replay with tracking enabled, and attach a pinned replay observation.
  session.visit(s => {
    if (s.movie?.mode === 'recording') recorded.set(s.movie.frame, {exact: exact(s), runs: sha256(s.catalog_runs || '')});
  });
  movie = await post('/api/movie', {action: 'record', title: 'Original catalog verification'});
  await wait(() => recorded.size >= 46);
  await post('/api/movie', {action: 'stop'});
  const inputFile = path.join(folder, 'movies', movie.id, 'inputs.rmt');
  originalLog = await readFile(inputFile);
  session.visit(s => {
    if (s.movie?.mode === 'playback') replayed.set(s.movie.frame, {exact: exact(s), runs: sha256(s.catalog_runs || '')});
  });
  await post('/api/movie', {action: 'speed', speed: 50});
  await post('/api/movie', {action: 'replay', id: movie.id});
  let replayCapture = await wait(() => {
    const s = session.latest;
    return s.movie.mode === 'playback' && s.movie.frame > 3 && s.catalog.status === 'complete'
      && observeCatalog(s, entry).result.instances.some(item => item.id === spriteAddress && item.bounds.left <= 90) && s;
  });
  assert.equal(observeCatalog(replayCapture, entry, {follow: previous}).result.state, 'lost');
  let playbackAnchor = anchor(observeCatalog(replayCapture, entry).result, spriteAddress);
  for (let i = 0; i < 3; i++) {
    replayCapture = await wait(() => session.latest.id !== playbackAnchor.capture && session.latest);
    const tracking = observeCatalog(replayCapture, entry, {follow: playbackAnchor}).result;
    assert.equal(tracking.state, 'following');
    assert.equal(tracking.selected, spriteAddress);
    playbackAnchor = anchor(tracking, tracking.selected);
  }
  await pin(replayCapture.id);
  observed = await post('/api/catalog/observe', {capture: replayCapture.id, entry: entry.id,
    revision: entry.revision, instance: spriteAddress});
  await wait(() => session.latest.movie.frame > replayCapture.movie.frame + 18);
  note = await post('/api/comments', {snapshot: replayCapture.id, title: 'Pinned playback observation', markdown: 'Evidence.',
    catalog: {entry: entry.id, revision: entry.revision, instance: spriteAddress}}, 201);
  assert.equal(note.capture, replayCapture.id);
  assert.equal(note.movie_frame, replayCapture.movie.frame);
  assert.equal(note.catalog.label, entry.label);
  const edited = await post('/api/catalog', {action: 'edit', revision: 3, capture: replayCapture.id, entry: entry.id,
    label: 'Renamed later', notes: 'Persistent investigator note.', selectors: entry.selectors});
  const ended = await wait(async () => {
    const state = await command('status');
    return state.mode === 'ended' && state;
  });
  assert.equal(ended.desync, false);
  let compared = 0;
  for (const [frame, value] of replayed) {
    if (frame < 2 || !recorded.has(frame)) continue;
    assert.deepEqual(value, recorded.get(frame), `Enabled replay mismatch at ${frame}`);
    compared++;
  }
  assert.ok(compared > 25);
  assert.deepEqual(await readFile(inputFile), originalLog);
  await post('/api/movie', {action: 'stop'});
  await post('/api/movie', {action: 'speed', speed: 100});
  await post('/api/movie', {action: 'play'});
  session.visit(null);
  onMetrics = await measure(session, edited.entry);
  console.log('PASS H40 animation, links, repeated tile, palette, follow, movie and attachment', {compared, onMetrics});
});

await native(h40, false, async session => {
  const {post, pin, command} = session;
  await pin(session.latest.id);
  const book = await json(session.root, '/api/catalog?capture=' + session.latest.id);
  assert.ok(book.entries.some(item => item.label === 'Renamed later' && item.selectors.length === 2));
  assert.ok(book.entries.some(item => item.label === 'Repeating backdrop'));
  assert.equal(session.latest.catalog.status, 'disabled');
  const off = new Map();
  session.visit(s => {
    if (s.movie?.mode === 'playback') off.set(s.movie.frame, exact(s));
  });
  await post('/api/movie', {action: 'replay', id: movie.id});
  const ended = await wait(async () => {
    const state = await command('status');
    return state.mode === 'ended' && state;
  });
  assert.equal(ended.desync, false);
  let compared = 0;
  for (const [frame, value] of off) {
    if (frame < 2 || !recorded.has(frame)) continue;
    assert.deepEqual(value, recorded.get(frame).exact, `Tracking on/off mismatch at ${frame}`);
    compared++;
  }
  assert.ok(compared > 25);
  assert.deepEqual(await readFile(path.join(folder, 'movies', movie.id, 'inputs.rmt')), originalLog);
  await post('/api/movie', {action: 'stop'});
  await post('/api/movie', {action: 'play'});
  session.visit(null);
  offMetrics = await measure(session);
  console.log('PASS H40 tracking on/off equivalence and catalog restart', {compared, offMetrics});
});

await native(h32, true, async session => {
  const s = session.latest;
  assert.equal(s.width, 283);
  assert.equal(s.catalog.mode, 1);
  assert.equal(s.catalog.status, 'complete');
  verifyRuns(s);
  assert.notEqual(catalogRom(s).digest, oldRom.digest);
  await session.pin(s.id);
  assert.equal((await json(session.root, '/api/catalog?capture=' + s.id)).entries.length, 0);
  await session.post('/api/catalog/observe', {capture: s.id, entry: entry.id, revision: entry.revision}, 409);
  const window = pickCatalog(s, {view: 'window', x: 245, y: 25});
  assert.equal(window.selector.pieces[0].first, 2);
  assert.ok(observeCatalog(s, chains).result.count >= 1);
  console.log('PASS H32 Window and sprite attribution; wrong ROM isolated');
});

const archive = createServer(folder);
const root = await listen(archive);
try {
  async function bytes(route) {
    const response = await fetch(root + route);
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  }
  const saved = unpack(await bytes('/api/evidence?note=' + note.id));
  assert.equal(saved.archive.catalog.label, entry.label);
  assert.equal(saved.id, observed.capture);
  assert.equal(saved.movie.frame, note.movie_frame);
  const catalog = await bytes(`/api/comments/${note.id}/catalog.json`);
  assert.equal(sha256(catalog), note.evidence.catalog.sha256);
  const decoded = JSON.parse(catalog);
  assert.equal(decoded.movie.input_row, note.movie_frame);
  assert.ok(/^[0-9a-f]{8}$/.test(decoded.movie.input_checksum));
  assert.equal(decoded.observation.instance.id, spriteAddress);
  const png = await bytes(`/api/comments/${note.id}/isolation.png`);
  assert.deepEqual(png, Buffer.from(observed.image, 'base64'));
  assert.equal(sha256(png), note.evidence.isolation.sha256);
  const zip = await bytes(`/api/movies/${movie.id}/export`);
  assert.ok(zip.includes(Buffer.from(`comments/${note.id}/catalog.json`)));
  assert.ok(zip.includes(catalog) && zip.includes(png) && zip.includes(originalLog));
  const commentZip = await bytes(`/api/comments/${note.id}/export`);
  assert.ok(commentZip.includes(catalog) && commentZip.includes(png));
  console.log('PASS saved review and both verified exports after restart');
} finally { await new Promise(resolve => archive.close(resolve)); }

await writeFile(path.join(folder, 'result.json'), JSON.stringify({note, onMetrics, offMetrics}, null, 2));
console.log('PASS', folder);

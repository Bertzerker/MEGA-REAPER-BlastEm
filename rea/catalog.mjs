// ROM-scoped declarative selectors and actual VDP sample isolation. GPL-3.0-or-later.
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, rename, rm, rmdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {sprites} from './public/decoder.mjs';
import {png} from './movie.mjs';

const layers = ['sprites', 'a', 'b', 'window'];
const names = ['Sprite', 'Plane A', 'Plane B', 'Window'];
const digest = /^[a-f0-9]{40}$/;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const maxBytes = 256 * 1024;
const maxRuns = 32768;
const maxInstances = 256;
const within = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const failure = (message, status = 400) => Object.assign(Error(message), {status});
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function catalogRom(snapshot) {
  const rom = snapshot?.movie?.rom_sha1;
  if (typeof rom !== 'string' || !digest.test(rom)) {
    throw failure('This capture has no native ROM digest. Open a capture from the Genesis bridge.', 409);
  }
  if (snapshot.catalog?.single_cartridge !== true) {
    throw failure('Catalog identity requires an updated bridge and a single Genesis cartridge.', 409);
  }
  return {algorithm: 'sha1', digest: rom, system: 'genesis', selector_format: 'vdp-mode5-8x8-v1'};
}

function cleanText(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw failure(`${label} must be ${required ? '1–' : 'at most '}${max} characters.`);
  }
  return value.trim();
}

function cleanSelectors(value, kind) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw failure('An entry needs 1–16 selector alternatives.');
  }
  return value.map(group => {
    if (!Array.isArray(group?.pieces) || group.pieces.length < 1
        || group.pieces.length > (kind === 'sprite' ? 4 : 1)) {
      throw failure('Each sprite alternative takes 1–4 linked pieces; tile alternatives take one.');
    }
    return {pieces: group.pieces.map(piece => {
      if (!piece || !layers.includes(piece.layer) || (piece.layer === 'sprites') !== (kind === 'sprite')
          || !within(piece.first, 0, 2047) || !within(piece.last, piece.first, 2047)
          || !(piece.palette === null || within(piece.palette, 0, 3))) {
        throw failure('Use a compatible layer, pattern range 0–2047 and palette 0–3 or null.');
      }
      return {layer: piece.layer, first: piece.first, last: piece.last, palette: piece.palette};
    })};
  });
}

export class CatalogStore {
  constructor(dir) { this.root = path.join(dir, 'catalogs'); }

  file(rom) {
    if (rom?.algorithm !== 'sha1' || !digest.test(rom.digest || '')) throw failure('Invalid catalog ROM identity.');
    return path.join(this.root, rom.digest + '.json');
  }

  async read(rom) {
    let file;
    try {
      file = await open(this.file(rom), 'r');
      if ((await file.stat()).size > maxBytes) throw failure('Catalog exceeds its file limit.');
      const book = JSON.parse(await file.readFile('utf8'));
      if (book.schema !== 1 || book.rom?.digest !== rom.digest || book.rom?.algorithm !== rom.algorithm
          || book.rom?.system !== rom.system || book.rom?.selector_format !== rom.selector_format
          || !within(book.revision, 0, Number.MAX_SAFE_INTEGER)
          || !Array.isArray(book.entries) || book.entries.length > maxInstances) {
        throw failure('Catalog identity or schema is incompatible.');
      }
      for (const entry of book.entries) {
        if (!idPattern.test(entry.id) || !within(entry.revision, 1, Number.MAX_SAFE_INTEGER)
            || !['sprite', 'tile'].includes(entry.kind)) throw failure('Invalid catalog entry.');
        cleanText(entry.label, 120, 'Label', true);
        cleanText(entry.notes, 2000, 'Notes');
        cleanSelectors(entry.selectors, entry.kind);
      }
      return book;
    } catch (error) {
      if (error.code === 'ENOENT') return {schema: 1, rom, revision: 0, entries: []};
      throw error;
    } finally { await file?.close(); }
  }

  async entry(snapshot, id, revision) {
    const book = await this.read(catalogRom(snapshot));
    const entry = book.entries.find(item => item.id === id);
    if (!entry || entry.revision !== revision) {
      throw failure('This catalog revision has changed. Reload the catalog and select the entry again.', 409);
    }
    return entry;
  }

  async write(snapshot, body) {
    const rom = catalogRom(snapshot), file = this.file(rom), lock = file + '.lock';
    await mkdir(this.root, {recursive: true});
    try { await mkdir(lock); }
    catch (error) {
      if (error.code === 'EEXIST') throw failure('Another editor is saving this catalog. Reload before retrying.', 409);
      throw error;
    }
    let temp;
    try {
      const book = await this.read(rom);
      if (body.revision !== book.revision) throw failure('The catalog changed. Reload before saving; your text is still in the editor.', 409);
      const index = book.entries.findIndex(item => item.id === body.entry);
      const prior = book.entries[index];
      let entry = prior;
      if (body.action === 'create') {
        if (book.entries.length === maxInstances) throw failure('Catalog has reached its entry limit.');
        const seed = pickCatalog(snapshot, body.selection);
        entry = {
          id: randomUUID(), kind: seed.kind, revision: 1,
          label: cleanText(body.label, 120, 'Label', true), notes: cleanText(body.notes ?? '', 2000, 'Notes'),
          selectors: [seed.selector],
        };
        book.entries.push(entry);
      } else {
        if (!prior) throw failure('Catalog entry does not exist.', 404);
        if (body.action === 'delete') book.entries.splice(index, 1);
        else {
          entry = {...prior, revision: prior.revision + 1};
          if (body.action === 'append') {
            const seed = pickCatalog(snapshot, body.selection);
            if (seed.kind !== prior.kind || prior.selectors.length >= 16) throw failure('Selection kind or selector limit does not match this entry.');
            if (prior.selectors.some(group => equalPieces(group, seed.selector))) throw failure('This selector is already in the entry.');
            entry.selectors = [...prior.selectors, seed.selector];
          } else if (body.action === 'edit') {
            entry.label = cleanText(body.label, 120, 'Label', true);
            entry.notes = cleanText(body.notes ?? '', 2000, 'Notes');
            entry.selectors = cleanSelectors(body.selectors, entry.kind).map(group =>
              prior.selectors.find(old => equalPieces(old, group)) || group);
          } else throw failure('Unknown catalog action.');
          book.entries[index] = entry;
        }
      }
      book.revision++;
      const data = JSON.stringify(book, null, 2);
      if (Buffer.byteLength(data) > maxBytes) throw failure('Catalog exceeds its file limit.');
      temp = file + '.' + randomUUID() + '.tmp';
      await writeFile(temp, data, {flag: 'wx'});
      await rename(temp, file);
      return {catalog: book, entry: body.action === 'delete' ? null : entry};
    } finally {
      if (temp) await rm(temp, {force: true});
      await rmdir(lock);
    }
  }
}

function equalPieces(a, b) { return JSON.stringify(a.pieces) === JSON.stringify(b.pieces); }

export function validateCatalogCapture(s) {
  if (s.catalog_runs === undefined) return;
  if (s.catalog?.version !== 1 || !['complete', 'partial'].includes(s.catalog.status)
      || !within(s.catalog.row_origin, 0, 511) || !within(s.catalog.dropped_samples, 0, 4 * 347 * 512)
      || s.catalog_runs.length % 12 || s.catalog_runs.length > maxRuns * 12) {
    throw failure('Invalid VDP catalog buffer.');
  }
}

function supported(s) {
  return s.raster?.valid && !s.interlace && s.catalog_runs && s.raster_rgba
    && ['complete', 'partial'].includes(s.catalog?.status);
}

function* runs(s) {
  const data = s.catalog_runs;
  for (let i = 0; i < data.length; i += 12) {
    const x = data[i] | data[i + 1] << 8;
    const y = (data[i + 2] | data[i + 3] << 8) - s.catalog.row_origin;
    const length = Math.min(data[i + 4], s.width - x), layer = data[i + 5];
    if (length <= 0 || y < 0 || y >= s.height || layer >= layers.length) continue;
    const attr = data[i + 6] | data[i + 7] << 8, address = data[i + 8] | data[i + 9] << 8;
    const slot = data[i + 10], link = data[i + 11];
    yield {x, y, length, layer, attr, address, slot, link, tile: attr & 2047, palette: attr >> 13 & 3};
  }
}

function descriptor(run) {
  return {
    layer: layers[run.layer], tile: run.tile, palette: run.palette, address: run.address,
    pattern_address: run.tile * 32, priority: Boolean(run.attr & 0x8000),
    flip_x: Boolean(run.attr & 0x800), flip_y: Boolean(run.attr & 0x1000),
    ...(run.layer === 0 ? {slot: run.slot, link: run.link} : {}),
  };
}

function makeSelector(samples, palette, s, evidence, coordinates) {
  return {
    pieces: samples.map(sample => ({
      layer: sample.layer, first: sample.tile, last: sample.tile, palette: palette ? sample.palette : null,
    })),
    seed: {capture: s.id, frame: s.frame, evidence, coordinates, samples},
  };
}

export function pickCatalog(s, selection) {
  catalogRom(s);
  const {view, x, y, palette = true, count = 1} = selection || {};
  if (!within(count, 1, 4) || typeof palette !== 'boolean') throw failure('Choose 1–4 pieces and a palette matching mode.');
  if (view === 'tiles' || view === 'sat') {
    if (!s.mode5 || s.interlace) throw failure('Memory picks require non-interlaced Mode 5.', 409);
    let sample;
    if (view === 'tiles') {
      const {tile, layer} = selection;
      if (!within(tile, 0, 2047) || !layers.slice(1).includes(layer)) throw failure('Choose a VRAM tile and A, B or Window.');
      sample = {layer, tile, palette: 0, pattern_address: tile * 32};
    } else {
      const sprite = sprites(s).find(item => item.index === selection.slot);
      if (!sprite) throw failure('This SAT slot is absent from the copied link chain.', 404);
      sample = {layer: 'sprites', tile: sprite.tile, palette: sprite.palette, address: sprite.entry, slot: sprite.index, link: s.vram[sprite.entry + 3] & 127};
    }
    return {
      kind: view === 'sat' ? 'sprite' : 'tile',
      selector: makeSelector([sample], view === 'sat' && palette, s, 'memory-diagnostic', {view}),
    };
  }
  if (!within(x, 0, s.width - 1) || !within(y, 0, s.height - 1)) throw failure('Choose a pixel inside the captured image.');
  if (!supported(s)) throw failure('Native sample identity is unavailable. Use a labeled VRAM/SAT memory pick.', 409);
  let layer = layers.indexOf(view);
  if (view === 'composite' || view === 'source') {
    const flag = s.raster_flags[y * s.width + x];
    if (flag & 0xC0) throw failure('This output pixel is an artifact or blanking; select a captured input.');
    layer = [-1, 1, 3, 2, 0][flag & 7] ?? -1;
  }
  if (layer < 0) throw failure('No sprite or tile owns this pixel. Try an isolated input.');
  let hit;
  for (const run of runs(s)) {
    if (run.layer === layer && run.y === y && run.x <= x && x < run.x + run.length) hit = run;
  }
  if (!hit) throw failure('This pixel has no attributed sample in the capture.', 404);
  const picked = [descriptor(hit)];
  if (layer === 0 && count > 1) {
    const slots = spriteSlots(s);
    if (slots.get(spriteKey(s, hit.address, hit.slot))?.links.size !== 1) throw failure('The selected slot changes link during this capture.');
    const seen = new Set([hit.slot]);
    for (let i = 1; i < count; i++) {
      if (!hit.link || seen.has(hit.link)) throw failure('The captured SAT link terminates or loops before the selected piece count.');
      const piece = slots.get(linkKey(s, hit));
      if (!piece || piece.links.size !== 1) throw failure('A linked piece is missing or changes link during this capture.');
      hit = piece.runs[0];
      picked.push(descriptor(hit));
      seen.add(hit.slot);
    }
  }
  return {
    kind: layer === 0 ? 'sprite' : 'tile',
    selector: makeSelector(picked, palette, s, evidenceClass(s), {view, x, y}),
  };
}

const evidenceClass = s => s.catalog.status === 'complete' ? 'vdp-input-samples' : 'partial-vdp-input-samples';
const matches = (run, rule) => layers[run.layer] === rule.layer && run.tile >= rule.first && run.tile <= rule.last
  && (rule.palette === null || run.palette === rule.palette);

function spriteKey(s, address, slot) {
  return s.catalog.mode === 1 && slot >= 64 ? `${address}@${slot}` : String(address);
}

function linkKey(s, run) {
  // H32 masks the attribute fetch address. SAT scan identity and link still
  // come from the actual scan slot, which can differ from the fetch slot.
  const mask = s.catalog.mode === 1 ? 63 : 127;
  const base = run.address - (run.slot & mask) * 8;
  return spriteKey(s, base + (run.link & mask) * 8, run.link);
}

function spriteSlots(s) {
  const slots = new Map();
  for (const run of runs(s)) {
    if (run.layer !== 0) continue;
    const key = spriteKey(s, run.address, run.slot);
    let slot = slots.get(key);
    if (!slot) {
      slot = {runs: [], links: new Set(), left: Infinity, right: -1, top: Infinity, bottom: -1};
      slots.set(key, slot);
    }
    slot.runs.push(run);
    slot.links.add(run.link);
    slot.left = Math.min(slot.left, run.x);
    slot.right = Math.max(slot.right, run.x + run.length - 1);
    slot.top = Math.min(slot.top, run.y);
    slot.bottom = Math.max(slot.bottom, run.y);
  }
  return slots;
}

function spriteMatches(s, entry) {
  const slots = spriteSlots(s), groups = new Map();
  for (const [startKey, start] of slots) {
    for (const {pieces} of entry.selectors) {
      const chain = [], seen = new Set();
      let slot = start, currentKey = startKey, ambiguous = false;
      for (const rule of pieces) {
        if (!slot || seen.has(currentKey) || !slot.runs.some(run => matches(run, rule))) break;
        seen.add(currentKey);
        chain.push(...slot.runs);
        ambiguous ||= slot.links.size > 1 || slot.right - slot.left >= 32 || slot.bottom - slot.top >= 32;
        const first = slot.runs[0], link = first.link;
        currentKey = linkKey(s, first);
        slot = link && slot.links.size === 1 ? slots.get(currentKey) : null;
      }
      if (seen.size === pieces.length) {
        const key = 'sat:' + [...seen].join(',');
        groups.set(key, {key, locator: key, runs: chain, ambiguous});
      }
    }
  }
  return groups;
}

function tileMatches(s, entry) {
  const groups = new Map();
  for (const run of runs(s)) {
    if (run.layer === 0 || !entry.selectors.some(group => matches(run, group.pieces[0]))) continue;
    // The native run carries the screen X phase and pre-flip tile row. A
    // repeated name-table address can therefore have multiple screen origins.
    const x = run.x - ((run.x - run.slot) & 7), y = run.y - run.link;
    const locator = layers[run.layer] + ':' + run.address, key = locator + ':' + x + ':' + y;
    let group = groups.get(key);
    if (!group) {
      group = {key, locator, runs: []};
      groups.set(key, group);
    }
    group.runs.push(run);
  }
  return groups;
}

function describe(group) {
  const bounds = {left: Infinity, top: Infinity, right: -1, bottom: -1}, samples = new Map();
  for (const run of group.runs) {
    bounds.left = Math.min(bounds.left, run.x);
    bounds.right = Math.max(bounds.right, run.x + run.length - 1);
    bounds.top = Math.min(bounds.top, run.y);
    bounds.bottom = Math.max(bounds.bottom, run.y);
    const key = [run.layer, run.address, run.attr, run.slot, run.link].join(':');
    if (samples.size < 24 && !samples.has(key)) samples.set(key, descriptor(run));
  }
  return {
    id: group.key, locator: group.locator, bounds, ambiguous: Boolean(group.ambiguous),
    x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2,
    samples: [...samples.values()],
  };
}

export function timelineOf(s) {
  const m = s.movie || {};
  return [s.evidence_context?.session, s.capture_source, m.rom_sha1, m.build_sha1,
    m.configuration_sha1, m.generation, m.id, m.mode, s.width, s.height, s.catalog?.mode, s.catalog?.generation].join(':');
}

function followCandidate(instances, s, anchor, partial, kind) {
  if (partial) return {state: 'unsupported', reason: 'Partial VDP coverage. Re-pick in a complete capture.'};
  if (anchor.timeline !== timelineOf(s) || !within(anchor.frame, 0, s.frame) || s.frame - anchor.frame > 12
      || typeof anchor.locator !== 'string' || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
    return {state: 'lost', reason: 'The timeline or capture gap changed. Re-pick an instance.'};
  }
  if (anchor.capture === s.id && instances.some(candidate => candidate.id === anchor.id && !candidate.ambiguous)) {
    return {state: 'following', selected: anchor.id};
  }
  const distance = Math.min(24, 2 + 4 * (s.frame - anchor.frame));
  const nearby = instances.filter(candidate => Math.hypot(candidate.x - anchor.x, candidate.y - anchor.y) <= distance);
  const same = nearby.filter(candidate => candidate.locator === anchor.locator);
  if (same.length > 1 || (same.length === 1 && (same[0].ambiguous || (kind === 'sprite' && nearby.length > 1)))) {
    return {state: 'ambiguous', reason: 'Several matches are within the motion gate. Re-pick an instance.'};
  }
  if (!same.length) return {state: 'missing', reason: 'The chosen locator is absent, occluded or outside the motion gate. Re-pick to resume.'};
  return {state: 'following', selected: same[0].id};
}

// Mode 5 ties put A or Window over B. Sprite slots already resolved their
// hardware order in the native line buffer.
function drawRank(run) {
  return 1 + ((run.attr & 0x8000) ? 4 : 0) + (run.layer === 2 ? 0 : 1);
}

function pickMatch(s, groups, point) {
  const {x, y} = point;
  if (!within(x, 0, s.width - 1) || !within(y, 0, s.height - 1)) throw failure('Choose an isolation pixel inside the image.');
  const pixel = y * s.width + x, count = s.width * s.height;
  let winner, rank = 0, ambiguous = false;
  for (const group of groups.values()) {
    for (const run of group.runs) {
      if (run.y !== y || x < run.x || x >= run.x + run.length || !s.raster_rgba[(run.layer * count + pixel) * 4 + 3]) continue;
      const score = drawRank(run);
      if (score > rank) {
        winner = group.key;
        rank = score;
        ambiguous = false;
      } else if (score === rank && winner !== group.key) ambiguous = true;
    }
  }
  if (ambiguous) throw failure('Several catalog groups share this sample. Choose an instance from the list.', 409);
  if (!winner) throw failure('Choose a colored sample in the isolated image.', 404);
  return winner;
}

function isolation(s, groups) {
  const count = s.width * s.height, rgba = new Uint8Array(count * 4), priority = new Uint8Array(count);
  for (const group of groups) {
    for (const run of group.runs) {
      let pos = run.y * s.width + run.x;
      let from = (run.layer * count + pos) * 4;
      const rank = drawRank(run);
      for (let end = pos + run.length; pos < end; pos++, from += 4) {
        if (!s.raster_rgba[from + 3] || rank < priority[pos]) continue;
        priority[pos] = rank;
        rgba.set(s.raster_rgba.subarray(from, from + 4), pos * 4);
      }
    }
  }
  return png(s.width, s.height, rgba);
}

export function observeCatalog(s, entry, {instance, follow, point} = {}) {
  const result = {
    capture: s.id, frame: s.frame, timeline: timelineOf(s), width: s.width, height: s.height,
    entry: {id: entry.id, revision: entry.revision, label: entry.label}, instances: [], count: 0, selected: null,
  };
  if (!supported(s)) {
    return {result: {...result, state: 'unsupported', reason: 'Native attribution requires catalog capture and non-interlaced Mode 5 with stable H32/H40 geometry.'}};
  }
  const groups = entry.kind === 'sprite' ? spriteMatches(s, entry) : tileMatches(s, entry);
  if (point) instance = pickMatch(s, groups, point);
  const instances = [...groups.values()].map(describe);
  const partial = s.catalog.status !== 'complete';
  Object.assign(result, {
    state: 'all', evidence: evidenceClass(s), partial, dropped_samples: s.catalog.dropped_samples,
    count: instances.length, instances: instances.slice(0, maxInstances),
    reason: partial ? 'Partial VDP coverage. Missing samples cannot establish absence.' : '',
  });
  if (instance != null) {
    const selected = instances.find(candidate => candidate.id === instance);
    if (!selected) throw failure('This instance does not belong to the selected capture and entry.', 409);
    result.selected = selected.id;
    result.state = 'selected';
  } else if (follow) {
    Object.assign(result, followCandidate(instances, s, follow, partial, entry.kind));
  }
  result.instance = instances.find(candidate => candidate.id === result.selected) || null;
  if (result.instance && !result.instances.includes(result.instance)) {
    result.instances[maxInstances - 1] = result.instance;
  }
  const displayed = result.selected ? [groups.get(result.selected)] : result.state === 'all' ? [...groups.values()] : [];
  return {result, image: displayed.length ? isolation(s, displayed) : null};
}

export function catalogAttachment(s, entry, instance) {
  const {result, image} = observeCatalog(s, entry, {instance});
  if (!image) throw failure('Select an observed match to attach to a comment.', 409);
  const {instances, ...observation} = result;
  const content = {
    schema: 1, rom: catalogRom(s), build_sha1: s.movie?.build_sha1 || null,
    configuration_sha1: s.movie?.configuration_sha1 || null,
    catalog: entry, definition_sha256: sha256(JSON.stringify(entry)),
    observation: {...observation, instances: result.instance ? [result.instance] : instances},
  };
  return {content, image};
}

import {api} from './movie-ui.mjs';

const $ = id => document.getElementById(id);
const hex = n => '$' + n.toString(16).toUpperCase().padStart(4, '0');
const option = (label, value) => new Option(label, value);

export function catalogUI({capture, pixel, pinDisplayed, drawer, attach, owner}) {
  let book, entry, seed, result, anchor, blockedFollow = false, editorDirty = false;
  let loadedRom, renderedArchive, lastObserved, pending = false, editing = false, serial = 0;
  let readyImage;
  const status = text => { $('catalog-status').textContent = text; };
  const mode = () => entry ? `${entry.label} · ${entry.kind} · revision ${entry.revision}` : 'Choose an entry or add a picked sample.';

  function setButtons() {
    const available = result?.count > 0 && result.state !== 'unsupported';
    $('catalog-all').disabled = !entry;
    $('catalog-instance').disabled = !available;
    $('catalog-follow').disabled = !available || result.partial || !$('catalog-instance').value;
    $('catalog-attach').disabled = !result?.image || readyImage !== result;
    $('catalog-create').disabled = !seed || editing || !$('catalog-new-label').value.trim();
    $('catalog-append').disabled = !seed || editing || entry?.kind !== seed.kind || editorDirty;
    $('catalog-save').disabled = !entry || editing || !editorDirty;
  }

  function showSeed() {
    const data = seed?.selector?.seed;
    $('catalog-seed').textContent = data
      ? `${data.evidence} · frame ${data.frame} · ${data.capture}\n` + data.samples.map(sample => {
        const locator = sample.slot == null ? sample.layer : `SAT slot ${sample.slot} → ${sample.link ?? '?'}`;
        return `${locator} · pattern ${sample.tile} at ${hex(sample.pattern_address)} · palette ${sample.palette}`
          + (sample.address == null ? '' : ` · table ${hex(sample.address)}`);
      }).join('\n') : 'No evidence selected.';
    setButtons();
  }

  function listEntries() {
    const query = $('catalog-search').value.trim().toLowerCase(), kind = $('catalog-kind').value;
    const entries = book?.entries.filter(item => (!kind || item.kind === kind)
      && (!query || (item.label + ' ' + item.notes).toLowerCase().includes(query))) || [];
    if (entry && !entries.some(item => item.id === entry.id)) entries.unshift(entry);
    $('catalog-entry').replaceChildren(option('Choose an entry', ''), ...entries.map(item => option(`${item.label} · ${item.kind}`, item.id)));
    $('catalog-entry').value = entry?.id || '';
  }

  function resetObservation() {
    serial++;
    anchor = result = lastObserved = null;
    readyImage = null;
    blockedFollow = false;
    $('catalog-instance').replaceChildren(option('Choose a captured instance', ''));
    $('catalog-isolation').hidden = true;
    $('catalog-observation').textContent = mode();
    setButtons();
  }

  function choose(id) {
    entry = book?.entries.find(item => item.id === id);
    editorDirty = false;
    $('catalog-editor').hidden = !entry;
    $('catalog-label').value = entry?.label || '';
    $('catalog-notes').value = entry?.notes || '';
    $('catalog-selectors').value = entry ? JSON.stringify(entry.selectors.map(({pieces}) => ({pieces})), null, 2) : '';
    resetObservation();
    listEntries();
  }

  async function loadBook(s, force = false) {
    const rom = s?.movie?.rom_sha1 || null;
    if (!rom || !/^[a-f0-9]{40}$/.test(rom)) {
      if (loadedRom || book) {
        loadedRom = book = seed = null;
        choose('');
        showSeed();
      }
      status('Waiting for a capture with a native ROM digest.');
      return false;
    }
    if (s.catalog?.single_cartridge !== true) {
      if (book) {
        loadedRom = book = seed = null;
        choose('');
        showSeed();
      }
      status('Catalog identity requires an updated bridge and a single Genesis cartridge.');
      return false;
    }
    if (!force && book && loadedRom === rom) return true;
    const changed = loadedRom !== rom;
    const selected = changed ? '' : entry?.id;
    if (changed) {
      seed = null;
      book = null;
      choose('');
      showSeed();
    }
    const next = await api('/api/catalog?capture=' + encodeURIComponent(s.id));
    if (capture()?.movie?.rom_sha1 !== rom) return false;
    book = next;
    loadedRom = rom;
    choose(selected);
    status(`ROM SHA-1 ${rom} · catalog revision ${book.revision} · ${book.entries.length} entries`);
    return true;
  }

  async function pick(selection) {
    if (editing) return;
    drawer('catalog-drawer');
    $('catalog-seed-panel').open = true;
    try {
      editing = true;
      const s = await pinDisplayed();
      if (!await loadBook(s)) return;
      const request = {...selection, count: Number($('catalog-pieces').value), palette: $('catalog-palette').checked};
      const picked = await api('/api/catalog/pick', {capture: s.id, selection: request});
      if (capture()?.id !== s.id) return;
      seed = {...picked, capture: s.id, request};
      status(`Selected ${picked.kind} evidence from frame ${s.frame}.`);
    } catch (error) {
      seed = null;
      status(error.message);
    } finally {
      editing = false;
      showSeed();
    }
  }

  function pickPixel() {
    const selection = pixel(), current = capture();
    if (!selection || selection.capture !== current?.id) {
      status('Select a pixel in the displayed capture first.');
      return;
    }
    return pick({view: selection.view, x: selection.x, y: selection.y});
  }

  async function save(action) {
    if (editing || !book) return;
    editing = true;
    setButtons();
    try {
      const body = {action, capture: action === 'edit' ? capture()?.id : seed?.capture,
        revision: book.revision, entry: entry?.id};
      if (action === 'edit') {
        body.label = $('catalog-label').value;
        body.notes = $('catalog-notes').value;
        body.selectors = JSON.parse($('catalog-selectors').value);
      } else {
        body.selection = seed.request;
        if (action === 'create') body.label = $('catalog-new-label').value;
      }
      const saved = await api('/api/catalog', body);
      if (capture()?.movie?.rom_sha1 !== saved.catalog.rom.digest) return;
      book = saved.catalog;
      choose(saved.entry.id);
      if (action === 'create') $('catalog-new-label').value = '';
      status(`Saved ${saved.entry.label} · entry revision ${saved.entry.revision} · catalog revision ${book.revision}`);
    } catch (error) {
      status(error.message);
    } finally {
      editing = false;
      setButtons();
    }
  }

  function show(observation) {
    const selected = observation.selected || $('catalog-instance').value;
    if (document.activeElement !== $('catalog-instance')) {
      $('catalog-instance').replaceChildren(option('Choose a captured instance', ''), ...observation.instances.map(item =>
        option(`${item.locator} · (${item.x.toFixed(1)}, ${item.y.toFixed(1)})`, item.id)));
      if (observation.instances.some(item => item.id === selected)) $('catalog-instance').value = selected;
    }
    const image = $('catalog-isolation');
    readyImage = null;
    image.hidden = !observation.image;
    if (observation.image) {
      const source = 'data:image/png;base64,' + observation.image;
      image.src = source;
      image.decode().then(() => {
        if (image.src === source && result === observation) readyImage = observation;
        setButtons();
      }).catch(() => {});
    }
    $('catalog-observation').textContent = `${observation.state.toUpperCase()} · frame ${observation.frame} · ${observation.capture}`
      + ` · ${observation.count} matches`
      + (observation.count > observation.instances.length ? ` · ${observation.instances.length} listed` : '')
      + (observation.evidence ? ` · ${observation.evidence}` : '') + (observation.reason ? ` · ${observation.reason}` : '')
      + (observation.dropped_samples ? ` · ${observation.dropped_samples} samples dropped` : '')
      + (observation.instance ? ` · bounds ${Object.values(observation.instance.bounds).join(', ')}` : '');
    setButtons();
  }

  function setAnchor(instance, observation) {
    anchor = {capture: observation.capture, id: instance.id, timeline: observation.timeline,
      frame: observation.frame, locator: instance.locator, x: instance.x, y: instance.y};
  }

  function startFollow(picked, observation = result) {
    if (!picked || observation.partial) return;
    if (picked.ambiguous) {
      status('This slot changes identity within the capture. Pick a different instance or frame.');
      return;
    }
    setAnchor(picked, observation);
    blockedFollow = false;
    serial++;
    lastObserved = null;
    status(`Following ${picked.locator} from frame ${observation.frame}.`);
    tick();
  }

  async function tick() {
    const s = capture();
    $('catalog-pick-pixel').disabled = !s || !!s.archive?.catalog || pixel()?.capture !== s.id;
    if (!s || $('catalog-drawer').hidden || document.hidden || pending || editing) return;
    const archived = s.archive?.catalog;
    $('catalog-archive').hidden = !archived;
    $('catalog-live').hidden = Boolean(archived);
    if (archived) {
      if (renderedArchive !== s.archive.note) {
        renderedArchive = s.archive.note;
        resetObservation();
        const root = '/api/comments/' + s.archive.note;
        $('catalog-archive-summary').textContent = `${archived.label} · revision ${archived.revision} · ${archived.evidence} · frame ${s.frame} · ${s.id}`;
        $('catalog-archive-image').src = root + '/isolation.png';
        $('catalog-archive-definition').href = root + '/catalog.json';
      }
      status('Reviewing the catalog revision attached to this saved capture.');
      return;
    }
    if (renderedArchive) {
      renderedArchive = null;
      status(book ? `ROM SHA-1 ${loadedRom} · catalog revision ${book.revision} · ${book.entries.length} entries`
        : 'Loading the live ROM catalog.');
    }
    pending = true;
    try {
      if (!await loadBook(s) || !entry || blockedFollow || lastObserved === s.id) return;
      const request = serial;
      const next = await api('/api/catalog/observe', {capture: s.id, entry: entry.id, revision: entry.revision, follow: anchor, owner});
      if (request !== serial || capture()?.archive || capture()?.movie?.rom_sha1 !== loadedRom) return;
      lastObserved = s.id;
      result = next;
      if (anchor) {
        if (next.state === 'following') setAnchor(next.instance, next);
        else {
          anchor = null;
          blockedFollow = true;
        }
      }
      show(next);
    } catch (error) {
      if (capture()?.id === s.id || /revision|catalog changed/i.test(error.message)) status(error.message);
      lastObserved = s.id;
    } finally { pending = false; }
  }

  $('catalog-pick-pixel').onclick = pickPixel;
  $('catalog-repick').onclick = pickPixel;
  $('catalog-pick-tile').onclick = () => pick({view: 'tiles', tile: Number($('catalog-tile').value), layer: $('catalog-layer').value});
  $('catalog-pick-sat').onclick = () => pick({view: 'sat', slot: Number($('catalog-slot').value)});
  $('catalog-search').oninput = $('catalog-kind').onchange = listEntries;
  $('catalog-entry').onchange = () => {
    if (editorDirty) {
      $('catalog-entry').value = entry.id;
      status('Save your edits or use Reload catalog to discard them before switching entries.');
      return;
    }
    choose($('catalog-entry').value);
    tick();
  };
  $('catalog-reload').onclick = async () => {
    if (pending || editing) return;
    try {
      editing = true;
      await loadBook(capture(), true);
    } catch (error) { status(error.message); }
    finally { editing = false; tick(); }
  };
  for (const id of ['catalog-label', 'catalog-notes', 'catalog-selectors']) {
    $(id).oninput = () => { editorDirty = true; setButtons(); };
  }
  $('catalog-new-label').oninput = setButtons;
  $('catalog-create').onclick = () => save('create');
  $('catalog-append').onclick = () => save('append');
  $('catalog-save').onclick = () => save('edit');
  $('catalog-all').onclick = () => { resetObservation(); tick(); };
  $('catalog-instance').onchange = setButtons;
  $('catalog-follow').onclick = () => startFollow(result?.instances.find(item => item.id === $('catalog-instance').value));
  $('catalog-isolation').onclick = async event => {
    if (!result?.image || readyImage !== result || result.selected || result.partial) return;
    const observed = result, request = serial;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) * observed.width / rect.width);
    const y = Math.floor((event.clientY - rect.top) * observed.height / rect.height);
    try {
      const selected = await api('/api/catalog/observe', {capture: observed.capture, entry: observed.entry.id,
        revision: observed.entry.revision, point: {x, y}});
      if (request === serial) startFollow(selected.instance, selected);
    } catch (error) { status(error.message); }
  };
  $('catalog-attach').onclick = () => {
    if (!result?.image || readyImage !== result) return;
    attach(result.capture, {entry: result.entry.id, revision: result.entry.revision, instance: result.selected});
  };
  setInterval(tick, 125);
}

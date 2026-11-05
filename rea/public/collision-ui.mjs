// GPL-3.0-or-later.
import {collisionFor,collisionSupport} from './collision.mjs';

const svg = tag => document.createElementNS('http://www.w3.org/2000/svg',tag);
const hex = n => '$'+n.toString(16).toUpperCase().padStart(6,'0');
const kinds = ['player','contact','pickup','overlap'];

export function collisionUI({article,refresh}) {
  const overlay = svg('svg'), field = svg('svg');
  overlay.classList.add('collision-overlay');
  overlay.setAttribute('aria-hidden','true');
  overlay.setAttribute('hidden','');
  overlay.append(field);
  const paths = Object.fromEntries(kinds.map(kind=>{
    const path = svg('path');
    path.classList.add('collision-'+kind);
    field.append(path);
    return [kind,path];
  }));
  article.append(overlay);
  const toggle = document.getElementById('collision-overlay');
  const filter = document.getElementById('collision-filter');
  const status = document.getElementById('collision-status');
  const detail = document.getElementById('collision-evidence');
  toggle.onchange = filter.onchange = refresh;
  let cachedCapture, cachedResult;
  function report(s) {
    if (s!==cachedCapture || !cachedResult) {
      cachedCapture=s;
      cachedResult=collisionFor(s);
    }
    return cachedResult;
  }
  const selected = data => [data.player,...data.objects].filter(box=>filter.value==='all'||box.kind===filter.value);
  function draw(s,focus,crop) {
    const panel = s.atlas.panels.find(p=>p.view==='composite');
    const support = collisionSupport(s);
    toggle.disabled = !support.supported;
    const visible = toggle.checked && support.available && panel && (focus==='all'||focus==='composite');
    overlay.toggleAttribute('hidden',!visible);
    if (!visible) return;
    const data = report(s), {viewport,origin} = data;
    overlay.setAttribute('viewBox',`0 0 ${crop.width} ${crop.height}`);
    overlay.setAttribute('preserveAspectRatio','none');
    field.setAttribute('x',panel.x+viewport.x-crop.x);
    field.setAttribute('y',panel.y+viewport.y-crop.y);
    field.setAttribute('width',viewport.width);
    field.setAttribute('height',viewport.height);
    const commands = {player:'',contact:'',pickup:'',overlap:''};
    for (const box of selected(data)) {
      if (box.width<=0 || box.height<=0) continue;
      const x=box.x+origin.x-viewport.x, y=box.y+origin.y-viewport.y;
      if (x+box.width<=0||y+box.height<=0||x>=viewport.width||y>=viewport.height) continue;
      const kind=box.overlaps?'overlap':box.kind;
      commands[kind]+=`M${x} ${y}h${box.width}v${box.height}h-${box.width}Z`;
    }
    for (const kind of kinds) paths[kind].setAttribute('d',commands[kind]);
  }
  function describe(s) {
    const data = report(s);
    const frame = data.snapshot
      ? ` · capture ${data.snapshot} · frame ${data.frame}${data.movie?` · movie ${data.movie.frame}`:''}` : '';
    status.textContent = (data.available
      ? `${data.profile.name} · Stage ${data.stage+1} · tick ${data.tick} · HP ${data.health}/${data.capacity} · shield ${data.shield} · immunity ${data.immunity}`
      : data.reason)+frame;
    detail.textContent = data.available ? selected(data).map(box=>{
      const name = box.kind==='player'?'Player':`${box.kind==='pickup'?'Pickup':'Contact'} type ${box.type}`;
      return `${name}  ${hex(box.address)}  (${box.x-128}, ${box.y-128})  ${box.width}×${box.height}${box.overlaps?'  OVERLAP':''}  · ${box.evidence}`;
    }).join('\n') : '';
  }
  return {draw,describe};
}

'use strict';

// Sync model: each shot type (sports.json) defines named markers, one of which is the
// sync marker. The shared timeline position `g` is measured in seconds from the sync
// marker, so clip i shows local time syncTime(i) + g. Selecting a clip detaches it so it
// can be stepped on its own to mark its frames. The other markers don't affect sync;
// they're highlighted so differences in timing between clips are visible.

const RATES = [0.1, 0.25, 0.5, 1, 2];
const ASPECT_PRESETS = ['9:16', '1:2', '2:3', '3:4', '4:5', '1:1'];
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 10;
const START_LATENCY = 0.05; // seconds between play() and frames actually advancing
const MARKER_HOLD_MS = 350; // keep a marker highlight up long enough to see at full speed
const RESERVED_KEYS = new Set([' ', 'f', 'z', 'l', 'o', 'a', 's', '?', '[', ']', ...'0123456789']);
const ALIGN_POINTS = [
  { id: 'head', label: 'H', prompt: 'click the top of the head' },
  { id: 'feet', label: 'F', prompt: 'click the ground between the feet' },
];
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = sel => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const state = {
  sport: '',
  sportDef: null,
  markers: [],   // [{ id, label, key, color, hint }]
  syncOn: '',    // id of the marker clips are aligned on
  clips: [],
  aspect: '9:16',
  rate: 0.25,
  loop: true,
  g: 0,
  gMin: 0,
  gMax: 0,
  playing: null, // null | 'sync' | 'solo'
  selected: -1,  // clip being adjusted on its own, -1 = all synced
  overlay: { on: false, base: '', top: '', opacity: 0.5 }, // base/top are clip names
  picking: null, // { c, step } while clicking a clip's alignment points
  panelW: 0,
  panelH: 0,
};

let savedClips = {};
let clock = null;
let saveTimer = 0;
let toastTimer = 0;
const stats = { jumps: {} };

const stage = $('#stage');
const lanes = $('#lanes');
const gtrack = $('#gtrack');

// ---------------------------------------------------------------- helpers

const selectedClip = () => state.clips[state.selected];
const displayName = name => name.replace(/\.[^.]+$/, '');
const signed = d => `${d >= 0 ? '+' : '−'}${Math.abs(d)}`;
const signedSec = s => `${s < 0 ? '−' : '+'}${Math.abs(s).toFixed(3)}s`;
const keyLabel = m => m.key.toUpperCase();
const abbrev = m => m.label[0].toUpperCase();
const lower = m => m.label.toLowerCase();

const syncMarker = () => state.markers.find(m => m.id === state.syncOn);
const otherMarkers = () => state.markers.filter(m => m.id !== state.syncOn);
const isSet = (c, id) => c.markers[id] != null;
const syncIdx = c => c.markers[state.syncOn] ?? 0;
const syncTime = c => c.frames[syncIdx(c)];
const markerOffset = (c, id) => c.frames[c.markers[id]] - syncTime(c); // seconds from the sync marker

function readLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function frameAt(c, t) {
  const f = c.frames;
  t += 1e-6;
  if (t <= f[0]) return 0;
  let lo = 0;
  let hi = c.n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Seek to the middle of a frame so rounding never lands on its neighbour.
function frameMid(c, idx) {
  const t = c.frames[idx] + c.durs[idx] / 2;
  return Number.isFinite(c.el.duration) ? Math.min(t, c.el.duration - 0.001) : t;
}

// Clip with the highest frame rate; global frame steps follow its frames.
function refClip() {
  return state.clips.reduce((best, c) => (c.fd < best.fd ? c : best));
}

function snapG(g) {
  const ref = refClip();
  const lt = syncTime(ref) + g;
  if (lt < 0 || lt >= ref.duration) return g;
  return ref.frames[frameAt(ref, lt)] - syncTime(ref);
}

function computeRange() {
  state.gMin = Math.min(...state.clips.map(c => -syncTime(c)));
  state.gMax = Math.max(...state.clips.map(c => c.frames[c.n - 1] - syncTime(c)));
  if (state.gMax <= state.gMin) state.gMax = state.gMin + 0.001;
  state.g = clamp(state.g, state.gMin, state.gMax);
}

// ---------------------------------------------------------------- loading

// Resolves once the video can play without stalling. Some browsers never fire
// canplaythrough for a paused video, so fall back after a few seconds of being decodable.
function whenPlayable(video, name) {
  return new Promise((resolve, reject) => {
    let fallback = 0;
    const done = () => { clearTimeout(fallback); resolve(); };
    video.addEventListener('canplaythrough', done, { once: true });
    video.addEventListener('loadeddata', () => { fallback = setTimeout(done, 3000); }, { once: true });
    video.addEventListener('error', () => reject(new Error(`${name}: this browser can't play it`)), { once: true });
  });
}

async function loadClip({ name, url }) {
  // Load the whole file into memory once: the frame table is parsed from it and the
  // video plays from it, so playback never waits on the network.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText}`);
  const blob = await res.blob();

  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.disablePictureInPicture = true;
  const ready = whenPlayable(video, name);
  video.src = URL.createObjectURL(blob);

  let table = null;
  try {
    table = parseFrameTable(await blob.arrayBuffer());
  } catch (err) {
    console.warn(`${name}: couldn't read frame table, assuming 30 fps`, err);
  }
  await ready;
  if (!table) table = uniformFrameTable(video.duration, 30);

  const n = table.frames.length;
  const sortedDurs = Array.from(table.durs).sort((a, b) => a - b);
  const fd = sortedDurs[sortedDurs.length >> 1];
  const saved = savedClips[name] || {};
  const savedMarkers = saved.markers || {};

  const c = {
    name,
    el: video,
    frames: table.frames,
    durs: table.durs,
    duration: table.duration,
    n,
    fd,
    fps: 1 / fd,
    markers: Object.fromEntries(state.markers.map(m => [
      m.id,
      Number.isInteger(savedMarkers[m.id]) ? clamp(savedMarkers[m.id], 0, n - 1) : null,
    ])),
    flashUntil: {}, // marker id → time its highlight stays on until, during playback
    lastIdx: -1,
    zoom: saved.zoom || 1,
    panX: saved.panX || 0,
    panY: saved.panY || 0,
    flip: !!saved.flip,
    // Two body points in normalised video coordinates ([0..1, 0..1] of the source frame),
    // used to scale and place this clip onto another in overlay mode.
    align: Object.fromEntries(ALIGN_POINTS
      .filter(pt => Array.isArray(saved.align?.[pt.id]) && saved.align[pt.id].length === 2)
      .map(pt => [pt.id, saved.align[pt.id]])),
    view: { tx: 0, ty: 0, z: 1, f: 1 }, // transform currently applied to the video, in px
    hidden: false,  // not shown (overlay mode with other clips stacked)
    shownIdx: -1,   // frame known to be on screen
    targetIdx: 0,   // frame we want on screen
    pendingIdx: -1, // frame an in-flight seek will land on
    localIdx: 0,    // position while adjusted on its own
    hardSeekAt: 0,
    out: false,
  };
  video.addEventListener('seeked', () => onSeeked(c));
  return c;
}

// Browsers differ slightly in where a trimmed clip's timeline starts. Show one frame,
// read back the timestamp the browser reports for it, and shift the table to match.
async function calibrate(c) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype) || c.n < 3) return;
  const k = c.n >> 1;
  const mediaTime = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 1500);
    c.el.requestVideoFrameCallback((now, meta) => { clearTimeout(timer); resolve(meta.mediaTime); });
    c.el.currentTime = frameMid(c, k);
  });
  if (mediaTime == null) return;
  let j = k;
  for (let i = Math.max(0, k - 2); i <= Math.min(c.n - 1, k + 2); i++) {
    if (Math.abs(c.frames[i] - mediaTime) < Math.abs(c.frames[j] - mediaTime)) j = i;
  }
  const offset = mediaTime - c.frames[j];
  if (Math.abs(offset) < 1e-4 || Math.abs(offset) > c.fd) return;
  for (let i = 0; i < c.n; i++) c.frames[i] += offset;
  c.duration += offset;
  console.info(`${c.name}: shifted frame table by ${(offset * 1000).toFixed(1)} ms to match the browser`);
}

function setupMarkers(def) {
  const used = new Set();
  state.markers = (def.markers || []).map(m => {
    let key = (m.key || m.label[0]).toLowerCase();
    if (RESERVED_KEYS.has(key) || used.has(key)) {
      console.warn(`sports.json: key "${key}" for ${m.label} is already taken; leaving it unbound`);
      key = '';
    }
    used.add(key);
    return { ...m, key };
  });
}

async function init() {
  buildStaticControls();

  let sports;
  try {
    const res = await fetch('/api/sports');
    if (!res.ok) throw new Error(await res.text());
    sports = await res.json();
  } catch (err) {
    $('#empty').textContent = `Couldn't load shot types: ${err.message}`;
    return;
  }
  const ids = Object.keys(sports);
  const wanted = new URLSearchParams(location.search).get('sport') || readLocal('sport');
  state.sport = ids.includes(wanted) ? wanted : ids[0];
  state.sportDef = sports[state.sport];
  if (!state.sportDef) {
    $('#empty').textContent = 'No shot types defined in sports.json';
    return;
  }
  writeLocal('sport', state.sport);
  setupMarkers(state.sportDef);
  if (!state.markers.length) {
    $('#empty').textContent = `${state.sportDef.label} has no markers in sports.json`;
    return;
  }
  buildSportSelect(sports);

  const q = `sport=${encodeURIComponent(state.sport)}`;
  let list = [];
  let cfg = {};
  try {
    [list, cfg] = await Promise.all([
      fetch(`/api/clips?${q}`).then(r => r.json()),
      fetch(`/api/config?${q}`).then(r => r.json()).catch(() => ({})),
    ]);
  } catch (err) {
    $('#empty').textContent = `Couldn't reach the server: ${err.message}`;
    return;
  }
  savedClips = cfg.clips || {};
  if (cfg.aspect) state.aspect = cfg.aspect;
  if (RATES.includes(cfg.rate)) state.rate = cfg.rate;
  if (typeof cfg.loop === 'boolean') state.loop = cfg.loop;
  if (cfg.overlay) Object.assign(state.overlay, cfg.overlay);
  const known = id => state.markers.some(m => m.id === id);
  state.syncOn = known(cfg.syncOn) ? cfg.syncOn : known(state.sportDef.syncOn) ? state.sportDef.syncOn : state.markers[0].id;

  buildSyncSelect();
  buildHelp();
  updateMarkerButtons();
  updateChrome();

  if (!list.length) {
    $('#empty').textContent = `No clips yet. Put videos in data/${state.sport}/ and reload.`;
    return;
  }
  const results = await Promise.allSettled(list.map(loadClip));
  state.clips = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const failed = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (failed.length) toast(failed.join(' · '), 6000);
  if (!state.clips.length) {
    $('#empty').textContent = 'None of the clips could be played.';
    return;
  }

  buildPanels();
  buildLanes();
  buildAspectOptions();
  buildOverlayControls();
  await Promise.all(state.clips.map(calibrate));
  computeRange();
  state.g = clamp(0, state.gMin, state.gMax);
  applyOverlayLayout();
  renderSynced(true);
  updateChrome();
  if (state.clips.every(c => !isSet(c, state.syncOn))) {
    const sm = syncMarker();
    toast(`Click a clip, step to its ${lower(sm)} frame with ← →, press ${keyLabel(sm)}. Press ? for all shortcuts.`, 7000);
  }
}

// ---------------------------------------------------------------- building the UI

function buildSportSelect(sports) {
  const sel = $('#sport');
  for (const [id, def] of Object.entries(sports)) sel.append(new Option(def.label, id));
  sel.value = state.sport;
  sel.addEventListener('change', () => {
    writeLocal('sport', sel.value);
    location.search = `?sport=${encodeURIComponent(sel.value)}`;
  });
}

function buildSyncSelect() {
  const sel = $('#sync-on');
  sel.replaceChildren(...state.markers.map(m => new Option(m.label, m.id)));
  sel.value = state.syncOn;
  sel.addEventListener('change', () => { setSyncOn(sel.value); sel.blur(); });
}

function buildHelp() {
  const sm = syncMarker();
  const others = otherMarkers();
  const rows = [
    ['Space', 'Play / pause'],
    ['← / →', 'Step one frame (hold Shift for 10)'],
    ['Home / End', 'Go to start / end'],
    ['Enter or 0', `Go to the ${lower(sm)} frame`],
    ['↑ / ↓', 'Faster / slower'],
    ['L', 'Toggle loop'],
    ['1 – 9', 'Select a clip to adjust on its own'],
    ...state.markers.filter(m => m.key).map(m => [
      keyLabel(m),
      m.id === state.syncOn
        ? `Set the selected clip's ${lower(m)} frame (clips sync on this)`
        : `Set or clear the selected clip's ${lower(m)} frame`,
    ]),
    ...(others.length ? [['[ / ]', `Jump to the previous / next ${others.map(lower).join(' or ')} frame`]] : []),
    ['F', 'Mirror the selected clip'],
    ['Z', "Reset the selected clip's zoom and pan"],
    ['O', 'Overlay two clips on top of each other'],
    ['S', 'Swap the base and overlaid clip'],
    ['A', "Set the selected clip's alignment points: click the head, then the ground between the feet"],
    ['Esc', 'Cancel alignment / leave the selected clip and resync all'],
  ];
  $('#help-keys').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));

  const describe = m => `${m.label} (${keyLabel(m) || 'no key'})${m.hint ? `: ${m.hint.charAt(0).toLowerCase()}${m.hint.slice(1)}` : ''}`;
  $('#help-hint').textContent =
    `Markers: ${state.markers.map(describe).join('. ')}. ` +
    `Select a clip, step to each marker's frame and press its key. Repeat for each clip, then press Esc and Enter: ` +
    `every clip lines up on its ${lower(sm)} frame. Clips light up in a marker's colour on that frame, and the ` +
    `timeline shows each marker's time relative to ${lower(sm)}.`;
}

function updateMarkerButtons() {
  const sm = syncMarker();
  const others = otherMarkers();
  const goSync = $('#btn-sync');
  goSync.textContent = `Go to ${lower(sm)}`;
  goSync.title = `Jump to the ${lower(sm)} frame (Enter or 0)`;
  goSync.style.setProperty('--mk', sm.color);

  const next = $('#btn-next-marker');
  next.hidden = !others.length;
  next.textContent = others.length === 1 ? `Next ${lower(others[0])}` : 'Next marker';
  if (others.length === 1) next.style.setProperty('--mk', others[0].color);
  else next.style.removeProperty('--mk');

  const zero = $('#tl-zero');
  zero.style.setProperty('--mk', sm.color);
  zero.firstElementChild.textContent = abbrev(sm);
}

function buildPanels() {
  stage.replaceChildren();
  state.clips.forEach((c, i) => {
    const panel = el('div', 'panel');

    const name = el('div', 'chip chip-name');
    name.append(el('span', 'key', String(i + 1)), displayName(c.name), el('span', 'dim', `${Math.round(c.fps)} fps`));
    name.title = c.name;

    const info = el('div', 'chip chip-info');

    const badges = el('div', 'badges');
    const badgeFor = {};
    for (const m of state.markers) {
      const b = el('div', 'badge', m.label);
      b.style.setProperty('--mk', m.color);
      b.hidden = true;
      badges.append(b);
      badgeFor[m.id] = b;
    }

    const tools = el('div', 'tools');
    for (const m of state.markers) {
      const keyHint = m.key ? ` (${keyLabel(m)})` : '';
      const b = toolButton(`Set ${lower(m)}`, `${m.hint || `Mark this frame as ${lower(m)}`}${keyHint}`, () => { select(i); setMarker(m); }, 'marker');
      b.style.setProperty('--mk', m.color);
      tools.append(b);
    }
    tools.append(
      toolButton('Align points', 'For overlay: click the top of the head, then the ground between the feet (A)', () => { select(i); startPicking(); }),
      toolButton('Flip', 'Mirror horizontally (F)', () => toggleFlip(c)),
      toolButton('Reset view', 'Reset zoom and pan (double-click, Z)', () => resetView(c)),
    );

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('align-layer');
    svg.setAttribute('hidden', '');
    const line = document.createElementNS(SVG_NS, 'line');
    svg.append(line);
    const marks = {};
    for (const pt of ALIGN_POINTS) {
      const g = document.createElementNS(SVG_NS, 'g');
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('r', '6');
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('dx', '10');
      text.setAttribute('dy', '4');
      text.textContent = pt.label;
      g.append(dot, text);
      svg.append(g);
      marks[pt.id] = g;
    }

    panel.append(c.el, svg, name, info, badges, tools);
    stage.append(panel);
    c.ui = { panel, info, badges: badgeFor, align: { svg, line, marks } };
    attachPanelInput(c, i);
  });
}

function toolButton(label, title, onClick, className) {
  const b = el('button', className, label);
  b.title = title;
  b.addEventListener('pointerdown', e => e.stopPropagation());
  b.addEventListener('mousedown', e => e.preventDefault());
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}

function buildLanes() {
  lanes.replaceChildren();
  state.clips.forEach((c, i) => {
    const row = el('div', 'tl-row');
    const label = el('div', 'tl-label', `${i + 1}  ${displayName(c.name)}`);
    label.title = 'Select this clip';
    label.addEventListener('click', () => select(state.selected === i ? -1 : i));
    const track = el('div', 'tl-track');
    const bar = el('div', 'lane-bar');
    const head = el('div', 'lane-head');
    track.append(bar);
    const ticks = {};
    for (const m of state.markers) {
      const tick = el('div', 'lane-tick');
      tick.style.setProperty('--mk', m.color);
      tick.append(el('span', 'lane-tick-label'));
      tick.hidden = true;
      track.append(tick);
      ticks[m.id] = tick;
    }
    track.append(head);
    row.append(label, track);
    lanes.append(row);
    c.ui.lane = { row, bar, head, ticks };

    scrubber(track, x => {
      if (state.selected !== i) select(i);
      const t = clamp(gFromX(x) + syncTime(c), 0, c.duration);
      setLocal(c, frameAt(c, t));
    });
  });

  scrubber(gtrack, x => {
    if (state.selected !== -1) select(-1);
    if (state.playing) pause();
    state.g = snapG(gFromX(x));
    renderSynced();
  });
}

function scrubber(node, onPos) {
  node.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    node.setPointerCapture(e.pointerId);
    if (state.playing) pause();
    onPos(e.clientX);
    const move = ev => onPos(ev.clientX);
    const up = () => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  });
}

function gFromX(clientX) {
  const r = gtrack.getBoundingClientRect();
  return state.gMin + clamp((clientX - r.left) / r.width, 0, 1) * (state.gMax - state.gMin);
}

function buildStaticControls() {
  const rateSel = $('#rate');
  for (const r of RATES) rateSel.append(new Option(`${r}×`, String(r)));
  rateSel.addEventListener('change', () => { setRate(Number(rateSel.value)); rateSel.blur(); });

  const loop = $('#loop');
  loop.addEventListener('change', () => { state.loop = loop.checked; loop.blur(); saveConfig(); });

  const aspectSel = $('#aspect');
  const custom = $('#aspect-custom');
  aspectSel.addEventListener('change', () => {
    if (aspectSel.value === 'custom') {
      custom.hidden = false;
      custom.value = state.aspect;
      custom.focus();
      custom.select();
    } else {
      setAspect(aspectSel.value);
      aspectSel.blur();
    }
  });
  custom.addEventListener('keydown', e => {
    if (e.key === 'Enter') { setAspect(custom.value); custom.blur(); }
    if (e.key === 'Escape') { custom.blur(); syncAspectUI(); }
    e.stopPropagation();
  });
  custom.addEventListener('change', () => setAspect(custom.value));

  const bind = (id, fn) => {
    const b = $(id);
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', fn);
  };
  bind('#btn-play', togglePlay);
  bind('#btn-prev', () => step(-1));
  bind('#btn-next', () => step(1));
  bind('#btn-start', () => goToEdge(-1));
  bind('#btn-end', () => goToEdge(1));
  bind('#btn-sync', goToSync);
  bind('#btn-next-marker', () => goToMarker(1));
  bind('#help-btn', () => $('#help').showModal());
  bind('#ov-toggle', () => setOverlay(!state.overlay.on));
  bind('#ov-swap', swapOverlay);

  stage.addEventListener('pointerdown', e => { if (e.target === stage) select(-1); });
  new ResizeObserver(layout).observe(stage);
}

// ---------------------------------------------------------------- aspect + layout

function parseAspect(v) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(v || '');
  if (!m || !Number(m[1]) || !Number(m[2])) return null;
  return Number(m[1]) / Number(m[2]);
}

function buildAspectOptions() {
  const sel = $('#aspect');
  sel.replaceChildren();
  const presets = el('optgroup');
  presets.label = 'Presets';
  for (const a of ASPECT_PRESETS) presets.append(new Option(a, a));
  const match = el('optgroup');
  match.label = 'Match a clip';
  for (const c of state.clips) {
    if (c.el.videoWidth) match.append(new Option(`${displayName(c.name)} (${c.el.videoWidth}×${c.el.videoHeight})`, `${c.el.videoWidth}:${c.el.videoHeight}`));
  }
  sel.append(presets, match, new Option('Custom…', 'custom'));
  syncAspectUI();
}

function syncAspectUI() {
  const sel = $('#aspect');
  const custom = $('#aspect-custom');
  const known = [...sel.options].some(o => o.value === state.aspect);
  sel.value = known ? state.aspect : 'custom';
  custom.hidden = known;
  if (!known) custom.value = state.aspect;
}

function setAspect(v) {
  if (!parseAspect(v)) {
    toast('Aspect ratio should look like 9:16');
    syncAspectUI();
    return;
  }
  state.aspect = v.trim();
  syncAspectUI();
  layout();
  saveConfig();
}

function layout() {
  if (!state.clips.length) return;
  const n = overlayPair() ? 1 : state.clips.length;
  const ratio = parseAspect(state.aspect) || 9 / 16;
  const cs = getComputedStyle(stage);
  const gap = parseFloat(cs.columnGap) || 12;
  const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - gap * (n - 1);
  const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const w = Math.max(40, Math.min(availH * ratio, availW / n));
  state.panelW = Math.floor(w);
  state.panelH = Math.floor(w / ratio);
  stage.style.setProperty('--pw', `${state.panelW}px`);
  stage.style.setProperty('--ph', `${state.panelH}px`);
  state.clips.forEach(applyView);
}

// ---------------------------------------------------------------- zoom / pan

// Where a normalised video point sits relative to the panel centre before the view
// transform, given object-fit: contain.
function fittedSize(c) {
  const vw = c.el.videoWidth || state.panelW;
  const vh = c.el.videoHeight || state.panelH;
  const s = Math.min(state.panelW / vw, state.panelH / vh);
  return [vw * s, vh * s];
}

function fitted(c, [u, v]) {
  const [dw, dh] = fittedSize(c);
  return [(u - 0.5) * dw, (v - 0.5) * dh];
}

// Video point → panel pixel, through a view transform (translate · scale · scaleX(flip)).
function toPanel(c, view, pt) {
  const [rx, ry] = fitted(c, pt);
  return [state.panelW / 2 + view.tx + view.z * view.f * rx, state.panelH / 2 + view.ty + view.z * ry];
}

function fromPanel(c, x, y) {
  const { tx, ty, z, f } = c.view;
  const [dw, dh] = fittedSize(c);
  return [(x - state.panelW / 2 - tx) / (z * f) / dw + 0.5, (y - state.panelH / 2 - ty) / z / dh + 0.5];
}

const ownView = c => ({ tx: c.panX * state.panelW, ty: c.panY * state.panelH, z: c.zoom, f: c.flip ? -1 : 1 });
const hasAlign = c => ALIGN_POINTS.every(pt => c.align[pt.id]);

// Transform that puts `top`'s feet on `base`'s feet and scales it to the same
// head-to-feet length. No rotation, so a lean in one clip stays visible.
function alignedView(base, top) {
  if (!hasAlign(base) || !hasAlign(top)) return null;
  const bv = ownView(base);
  const [hx, hy] = toPanel(base, bv, base.align.head);
  const [fx, fy] = toPanel(base, bv, base.align.feet);
  const f = top.flip ? -1 : 1;
  const [qhx, qhy] = fitted(top, top.align.head);
  const [qfx, qfy] = fitted(top, top.align.feet);
  const len = Math.hypot(qhx - qfx, qhy - qfy);
  if (len < 1) return null;
  const z = Math.hypot(hx - fx, hy - fy) / len;
  return { tx: fx - state.panelW / 2 - z * f * qfx, ty: fy - state.panelH / 2 - z * qfy, z, f };
}

function applyView(c) {
  const ov = overlayPair();
  const view = (ov && c === ov.top && alignedView(ov.base, ov.top)) || ownView(c);
  c.view = view;
  c.el.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.z}) scaleX(${view.f})`;
  drawAlign(c);
  if (ov && c === ov.base) applyView(ov.top); // the aligned top clip follows the base
}

function drawAlign(c) {
  const { svg, line, marks } = c.ui.align;
  const picking = state.picking?.c === c;
  const pts = picking ? state.picking.points : c.align;
  const show = picking || (state.clips[state.selected] === c && Object.keys(pts).length > 0);
  svg.toggleAttribute('hidden', !show);
  if (!show) return;
  const pos = {};
  for (const pt of ALIGN_POINTS) {
    const g = marks[pt.id];
    g.toggleAttribute('hidden', !pts[pt.id]);
    if (!pts[pt.id]) continue;
    pos[pt.id] = toPanel(c, c.view, pts[pt.id]);
    g.setAttribute('transform', `translate(${pos[pt.id][0]} ${pos[pt.id][1]})`);
  }
  line.toggleAttribute('hidden', !(pos.head && pos.feet));
  if (pos.head && pos.feet) {
    line.setAttribute('x1', pos.head[0]);
    line.setAttribute('y1', pos.head[1]);
    line.setAttribute('x2', pos.feet[0]);
    line.setAttribute('y2', pos.feet[1]);
  }
}

// In overlay mode, once the top clip is aligned, dragging and zooming it moves the base
// (and the top follows); before that it moves the top clip on its own for manual lining up.
function viewTarget(c) {
  const ov = overlayPair();
  return ov && c === ov.top && alignedView(ov.base, ov.top) ? ov.base : c;
}

function resetView(c) {
  c.zoom = 1;
  c.panX = 0;
  c.panY = 0;
  applyView(c);
  saveConfig();
}

function toggleFlip(c) {
  c.flip = !c.flip;
  applyView(c);
  saveConfig();
}

function attachPanelInput(c, i) {
  const clip = c;
  const p = c.ui.panel;
  let drag = null;

  p.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const t = viewTarget(c);
    drag = { x: e.clientX, y: e.clientY, t, panX: t.panX, panY: t.panY, moved: false };
    p.setPointerCapture(e.pointerId);
  });
  p.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    p.classList.add('panning');
    drag.t.panX = drag.panX + dx / p.clientWidth;
    drag.t.panY = drag.panY + dy / p.clientHeight;
    applyView(drag.t);
  });
  p.addEventListener('pointerup', e => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    p.classList.remove('panning');
    if (moved) saveConfig();
    else if (state.picking) pickPoint(p, e);
    else select(i);
  });
  p.addEventListener('pointercancel', () => {
    drag = null;
    p.classList.remove('panning');
  });

  p.addEventListener('wheel', e => {
    e.preventDefault();
    const c = viewTarget(clip);
    const r = p.getBoundingClientRect();
    // Zoom about the cursor: keep the video point under it fixed.
    const px = e.clientX - r.left - r.width / 2;
    const py = e.clientY - r.top - r.height / 2;
    const speed = e.ctrlKey ? 0.01 : 0.0015; // ctrlKey = trackpad pinch
    const z1 = clamp(c.zoom * Math.exp(-e.deltaY * speed), ZOOM_MIN, ZOOM_MAX);
    const k = z1 / c.zoom;
    c.panX = (px - k * (px - c.panX * r.width)) / r.width;
    c.panY = (py - k * (py - c.panY * r.height)) / r.height;
    c.zoom = z1;
    applyView(c);
    saveConfig();
  }, { passive: false });

  p.addEventListener('dblclick', e => {
    if (!e.target.closest('.tools') && !state.picking) resetView(viewTarget(c));
  });
}

// ---------------------------------------------------------------- alignment points

function startPicking() {
  const c = selectedClip();
  if (!c) return toast('Select a clip first (click it or press 1–9), then press A');
  // New points are kept aside until both are placed, so the overlay doesn't shift between clicks.
  state.picking = { c, step: 0, points: {} };
  c.ui.panel.classList.add('picking');
  drawAlign(c);
  updateChrome();
  toast(`${displayName(c.name)}: ${ALIGN_POINTS[0].prompt}`, 4000);
}

function stopPicking() {
  const pk = state.picking;
  if (!pk) return;
  state.picking = null;
  pk.c.ui.panel.classList.remove('picking');
  drawAlign(pk.c);
  updateChrome();
}

// All panels of the clip being picked share its geometry (side by side it's its own
// panel; in overlay the base and top panels are stacked), so any click on a panel of
// that size maps into the clip's video coordinates.
function pickPoint(panel, e) {
  const pk = state.picking;
  if (!overlayPair() && panel !== pk.c.ui.panel) return toast(`Click on ${displayName(pk.c.name)} to place its points (Esc cancels)`);
  const r = panel.getBoundingClientRect();
  const pt = ALIGN_POINTS[pk.step];
  pk.points[pt.id] = fromPanel(pk.c, e.clientX - r.left, e.clientY - r.top);
  pk.step++;
  if (pk.step < ALIGN_POINTS.length) {
    drawAlign(pk.c);
    toast(`${displayName(pk.c.name)}: now ${ALIGN_POINTS[pk.step].prompt}`, 4000);
    return;
  }
  const c = pk.c;
  c.align = pk.points;
  stopPicking();
  state.clips.forEach(applyView);
  saveConfig();
  const ov = overlayPair();
  const partner = ov && (c === ov.base ? ov.top : c === ov.top ? ov.base : null);
  toast(partner && !hasAlign(partner)
    ? `${displayName(c.name)} aligned. Set points on ${displayName(partner.name)} too to line them up.`
    : `${displayName(c.name)}: alignment points set`);
}

// ---------------------------------------------------------------- overlay

function clipNamed(name) {
  return state.clips.find(c => c.name === name);
}

function overlayPair() {
  if (!state.overlay.on || state.clips.length < 2) return null;
  const base = clipNamed(state.overlay.base) || state.clips[0];
  const top = clipNamed(state.overlay.top) || state.clips.find(c => c !== base);
  return top && top !== base ? { base, top } : null;
}

function buildOverlayControls() {
  const baseSel = $('#ov-base');
  const topSel = $('#ov-top');
  for (const sel of [baseSel, topSel]) {
    sel.replaceChildren(...state.clips.map((c, i) => new Option(`${i + 1} ${displayName(c.name)}`, c.name)));
  }
  const pick = (which, other) => sel => {
    sel.addEventListener('change', () => {
      // Picking the clip that's already in the other slot swaps them.
      if (sel.value === overlayPair()?.[other].name) state.overlay[other] = state.overlay[which] || overlayPair()[which].name;
      state.overlay[which] = sel.value;
      sel.blur();
      applyOverlayLayout();
      saveConfig();
    });
  };
  pick('base', 'top')(baseSel);
  pick('top', 'base')(topSel);

  const opacity = $('#ov-opacity');
  opacity.addEventListener('input', () => {
    state.overlay.opacity = Number(opacity.value) / 100;
    stage.style.setProperty('--ov-opacity', state.overlay.opacity);
  });
  opacity.addEventListener('change', () => { opacity.blur(); saveConfig(); });
}

function setOverlay(on) {
  if (on && state.clips.length < 2) return toast('Overlay needs at least two clips');
  state.overlay.on = on;
  applyOverlayLayout();
  saveConfig();
  const ov = overlayPair();
  if (ov && !(hasAlign(ov.base) && hasAlign(ov.top))) {
    toast('Press A on each clip to set alignment points, or drag the top clip into place', 5000);
  }
}

function swapOverlay() {
  const ov = overlayPair();
  if (!ov) return toast('Turn on overlay first (O)');
  state.overlay.base = ov.top.name;
  state.overlay.top = ov.base.name;
  applyOverlayLayout();
  saveConfig();
}

function applyOverlayLayout() {
  const ov = overlayPair();
  stage.classList.toggle('overlay', !!ov);
  stage.style.setProperty('--ov-opacity', state.overlay.opacity);
  for (const c of state.clips) {
    const role = !ov ? '' : c === ov.base ? 'base' : c === ov.top ? 'top' : 'hidden';
    if (role) c.ui.panel.dataset.role = role;
    else delete c.ui.panel.dataset.role;
    c.hidden = role === 'hidden';
    c.ui.lane.row.classList.toggle('ov-hidden', c.hidden);
  }
  if (selectedClip()?.hidden) select(-1);
  if (state.picking?.c.hidden) stopPicking();

  $('#ov-toggle').setAttribute('aria-pressed', String(!!ov));
  $('#ov-controls').hidden = !ov;
  if (ov) {
    $('#ov-base').value = ov.base.name;
    $('#ov-top').value = ov.top.name;
  }
  $('#ov-opacity').value = String(Math.round(state.overlay.opacity * 100));
  layout();
}

// ---------------------------------------------------------------- frame display

function seekIdx(c, idx, force = false) {
  c.targetIdx = idx;
  if (c.el.seeking) return; // onSeeked chains to the latest target
  if (!force && idx === c.shownIdx) return;
  c.pendingIdx = idx;
  c.el.currentTime = frameMid(c, idx);
}

function onSeeked(c) {
  if (c.pendingIdx >= 0) {
    c.shownIdx = c.pendingIdx;
    c.pendingIdx = -1;
  }
  if (c.el.paused && c.targetIdx !== c.shownIdx) seekIdx(c, c.targetIdx);
}

function setOut(c, out) {
  if (c.out === out) return;
  c.out = out;
  c.ui.panel.classList.toggle('out', out);
}

function updateInfo(c, idx) {
  const info = c.ui.info;
  const now = performance.now();
  info.replaceChildren(`Frame ${idx + 1}/${c.n}`);

  let highlight = null; // first non-sync marker the clip is on
  let onSync = false;
  for (const m of state.markers) {
    const mi = c.markers[m.id];
    const isSync = m.id === state.syncOn;
    if (mi == null) {
      if (isSync) info.append(el('span', 'dim unset', `${lower(m)} not set`));
      c.ui.badges[m.id].hidden = true;
      continue;
    }
    const delta = el('span', 'dim', `${abbrev(m)}${signed(idx - mi)}`);
    if (!isSync) delta.style.color = m.color;
    info.append(delta);

    if (state.playing) {
      // Also catch a marker frame that playback skipped over between two ticks.
      const crossed = c.lastIdx >= 0 && c.lastIdx < mi && idx > mi;
      if (idx === mi || crossed) c.flashUntil[m.id] = now + MARKER_HOLD_MS;
    }
    const on = idx === mi || now < (c.flashUntil[m.id] || 0);
    c.ui.badges[m.id].hidden = !on;
    if (on && isSync) onSync = true;
    else if (on && !highlight) highlight = m;
  }
  c.lastIdx = idx;

  const panel = c.ui.panel;
  panel.classList.toggle('at-marker', !!highlight);
  panel.classList.toggle('at-sync', !highlight && onSync);
  panel.style.setProperty('--hl', (highlight || syncMarker()).color);
}

function renderSynced(force = false) {
  state.clips.forEach((c, i) => {
    if (i === state.selected) return;
    const lt = syncTime(c) + state.g;
    setOut(c, lt < -1e-6 || lt >= c.duration);
    const idx = lt < 0 ? 0 : frameAt(c, lt);
    seekIdx(c, idx, force);
    updateInfo(c, idx);
  });
  updateTimeline();
}

function setLocal(c, idx) {
  c.localIdx = clamp(idx, 0, c.n - 1);
  setOut(c, false);
  seekIdx(c, c.localIdx);
  updateInfo(c, c.localIdx);
  updateTimeline();
}

function updateTimeline() {
  if (!state.clips.length) return;
  const span = state.gMax - state.gMin;
  const pct = g => `${((g - state.gMin) / span) * 100}%`;
  $('#tl-zero').style.left = pct(0);
  $('#tl-head').style.left = pct(state.g);
  for (const c of state.clips) {
    const { bar, head, row, ticks } = c.ui.lane;
    bar.style.left = pct(-syncTime(c));
    bar.style.width = `${(c.frames[c.n - 1] / span) * 100}%`;
    head.style.left = pct(c.frames[c.localIdx] - syncTime(c));
    row.classList.toggle('unset', !isSet(c, state.syncOn));
    for (const m of state.markers) {
      const tick = ticks[m.id];
      tick.hidden = m.id === state.syncOn || !isSet(c, m.id);
      if (tick.hidden) continue;
      tick.style.left = pct(markerOffset(c, m.id));
      tick.firstChild.textContent = signedSec(markerOffset(c, m.id));
    }
  }
  updateReadout();
}

function updateReadout() {
  const out = $('#readout');
  out.replaceChildren();
  const c = selectedClip();
  if (c) {
    const idx = c.localIdx;
    out.append(el('b', '', displayName(c.name)), `  frame ${idx + 1}/${c.n}  ·  ${c.frames[idx].toFixed(3)}s`);
    for (const m of state.markers) {
      if (isSet(c, m.id)) out.append(`  ·  ${abbrev(m)}${signed(idx - c.markers[m.id])}`);
    }
    return;
  }
  const ref = refClip();
  const frames = Math.round(state.g / ref.fd);
  const sign = state.g < -1e-9 ? '−' : '+';
  out.append(el('b', '', `${abbrev(syncMarker())}${sign}${Math.abs(frames)}`), `  ${sign}${Math.abs(state.g).toFixed(3)}s  ·  ${Math.round(ref.fps)} fps steps`);
}

function updateChrome() {
  $('#play-icon').setAttribute('d', state.playing ? 'M3 2h4v12H3zM9 2h4v12H9z' : 'M4 2v12l10-6z');
  $('#rate').value = String(state.rate);
  $('#loop').checked = state.loop;
  $('#sync-on').value = state.syncOn;

  const mode = $('#mode');
  const c = selectedClip();
  const sm = syncMarker();
  mode.replaceChildren();
  if (state.picking) {
    const pt = ALIGN_POINTS[state.picking.step];
    mode.append(el('span', 'pill adjust', 'Aligning'), el('b', '', displayName(state.picking.c.name)),
      `  ${pt.prompt} · Esc cancel`);
  } else if (c) {
    const keys = state.markers.filter(m => m.key).map(m => `${keyLabel(m)} ${lower(m)}`);
    mode.append(el('span', 'pill adjust', 'Adjusting'), el('b', '', displayName(c.name)),
      `  ← → step this clip · ${keys.join(' · ')} · Esc resync`);
  } else if (state.clips.length) {
    const unset = state.clips.filter(x => !isSet(x, state.syncOn)).length;
    mode.append(el('span', 'pill', 'Synced'),
      unset ? `${unset} clip${unset > 1 ? 's' : ''} still need a ${lower(sm)} frame — click one to set it`
        : `All clips aligned on their ${lower(sm)} frame`);
  }
  state.clips.forEach((x, i) => {
    x.ui.panel.classList.toggle('selected', i === state.selected);
    x.ui.lane.row.classList.toggle('selected', i === state.selected);
  });
}

// ---------------------------------------------------------------- playback

function togglePlay() {
  if (state.playing) pause();
  else play();
}

function play() {
  if (!state.clips.length) return;
  const c = selectedClip();
  if (c) {
    if (c.localIdx >= c.n - 1) c.el.currentTime = frameMid(c, 0);
    c.el.playbackRate = state.rate;
    c.el.loop = state.loop;
    c.el.play().catch(() => {});
    state.playing = 'solo';
  } else {
    state.playing = 'sync';
    restartFrom(state.g >= state.gMax - 1e-6 ? state.gMin : state.g);
  }
  updateChrome();
  requestAnimationFrame(tick);
}

// Park every clip on its frame for position g and hold the clock until all of them
// have finished seeking, so nothing starts behind and has to jump to catch up.
function restartFrom(g) {
  state.g = g;
  state.clips.forEach(c => {
    c.el.pause();
    c.el.playbackRate = state.rate;
    c.hardSeekAt = 0;
    const lt = syncTime(c) + g;
    seekIdx(c, lt < 0 ? 0 : frameAt(c, lt));
  });
  clock = { t0: performance.now(), g0: g, settling: true };
}

function pause() {
  const mode = state.playing;
  if (!mode) return;
  state.playing = null;
  clock = null;
  state.clips.forEach(c => {
    c.el.pause();
    c.el.loop = false;
    c.el.playbackRate = state.rate;
    c.flashUntil = {};
  });
  if (mode === 'solo') {
    const c = selectedClip();
    setLocal(c, frameAt(c, c.el.currentTime));
    seekIdx(c, c.localIdx, true);
  } else {
    state.g = snapG(state.g);
    renderSynced(true);
  }
  updateChrome();
}

function tick(now) {
  if (!state.playing) return;
  if (state.playing === 'solo') {
    const c = selectedClip();
    if (c.el.paused) return pause();
    c.localIdx = frameAt(c, c.el.currentTime);
    updateInfo(c, c.localIdx);
  } else {
    if (clock.settling) {
      if (state.clips.some(c => c.el.seeking)) {
        updateTimeline();
        return requestAnimationFrame(tick);
      }
      clock = { t0: now, g0: clock.g0 };
    }
    const g = clock.g0 + ((now - clock.t0) / 1000) * state.rate;
    if (g > state.gMax) {
      if (!state.loop) {
        state.g = state.gMax;
        return pause();
      }
      restartFrom(state.gMin);
      updateTimeline();
      return requestAnimationFrame(tick);
    }
    state.g = g;
    for (const c of state.clips) followClock(c, g, now);
  }
  updateTimeline();
  requestAnimationFrame(tick);
}

// Keep a natively playing clip locked to the shared clock: small drift is absorbed by
// nudging its playback rate, large drift (or a loop restart) by a hard seek.
function followClock(c, g, now) {
  if (c.hidden) {
    if (!c.el.paused) c.el.pause();
    return;
  }
  const lt = syncTime(c) + g;
  const end = Math.min(c.duration, c.el.duration || Infinity) - 0.02;
  if (lt < 0 || lt >= end) {
    if (!c.el.paused) c.el.pause();
    setOut(c, true);
    const idx = lt < 0 ? 0 : c.n - 1;
    if (c.shownIdx !== idx || c.targetIdx !== idx) seekIdx(c, idx, true);
    updateInfo(c, idx);
    return;
  }
  setOut(c, false);
  updateInfo(c, frameAt(c, c.el.currentTime));
  if (c.el.seeking) return;

  if (c.el.paused) {
    // Usually already parked on (or next to) the right frame; just start it and let the
    // rate nudge below absorb the small offset instead of paying for a seek.
    if (Math.abs(c.el.currentTime - lt) > 4 * c.fd) jump(c, lt + START_LATENCY * state.rate);
    c.shownIdx = -1;
    c.el.playbackRate = state.rate;
    c.el.play().catch(() => {});
    c.hardSeekAt = now;
    return;
  }
  if (now - c.hardSeekAt < 250) return;

  const drift = c.el.currentTime - lt;
  if (Math.abs(drift) > 4 * c.fd) {
    jump(c, lt + START_LATENCY * state.rate);
    c.hardSeekAt = now;
    return;
  }
  const nudged = clamp(state.rate - drift / 0.3, state.rate * 0.5, state.rate * 1.5);
  const rate = Math.max(0.0625, nudged);
  if (Math.abs(c.el.playbackRate - rate) > state.rate * 0.02) c.el.playbackRate = rate;
}

// A seek made to pull a playing clip back into sync. These are what cause visible
// hitches, so they're counted: `stats` in the console shows how many happened.
function jump(c, t) {
  c.pendingIdx = -1;
  c.el.currentTime = t;
  stats.jumps[c.name] = (stats.jumps[c.name] || 0) + 1;
  console.debug(`sync jump: ${c.name} → ${t.toFixed(3)}s`);
}

function setRate(r) {
  state.rate = r;
  if (state.playing === 'sync') clock = { t0: performance.now(), g0: state.g };
  state.clips.forEach(c => { c.el.playbackRate = r; });
  updateChrome();
  saveConfig();
}

// ---------------------------------------------------------------- navigation + editing

function step(n) {
  if (!state.clips.length) return;
  if (state.playing) pause();
  const c = selectedClip();
  if (c) return setLocal(c, c.localIdx + n);

  const ref = refClip();
  const lt = syncTime(ref) + state.g;
  let g = state.g + n * ref.fd;
  if (lt >= 0 && lt < ref.duration) {
    const idx = frameAt(ref, lt) + n;
    if (idx >= 0 && idx < ref.n) g = ref.frames[idx] - syncTime(ref);
  }
  state.g = clamp(g, state.gMin, state.gMax);
  renderSynced();
}

function goToEdge(dir) {
  if (!state.clips.length) return;
  if (state.playing) pause();
  const c = selectedClip();
  if (c) return setLocal(c, dir < 0 ? 0 : c.n - 1);
  state.g = dir < 0 ? state.gMin : state.gMax;
  renderSynced();
}

function goToSync() {
  if (!state.clips.length) return;
  if (state.playing) pause();
  const c = selectedClip();
  if (c) return setLocal(c, syncIdx(c));
  state.g = clamp(0, state.gMin, state.gMax);
  renderSynced();
}

// Jump to the next (or previous) non-sync marker, wrapping around: for the selected clip
// its own marker frames, otherwise every clip's marker moments on the shared timeline.
function goToMarker(dir) {
  if (!state.clips.length) return;
  if (state.playing) pause();
  const others = otherMarkers();
  if (!others.length) return toast(`${state.sportDef.label} only has one marker`);
  const names = others.map(lower).join(' / ');

  const c = selectedClip();
  if (c) {
    const idxs = others.filter(m => isSet(c, m.id)).map(m => c.markers[m.id]).sort((a, b) => a - b);
    if (!idxs.length) return toast(`No ${names} frame set for ${displayName(c.name)} yet`);
    let i = dir > 0 ? idxs.find(x => x > c.localIdx) : idxs.findLast(x => x < c.localIdx);
    if (i === undefined) i = dir > 0 ? idxs[0] : idxs[idxs.length - 1];
    return setLocal(c, i);
  }
  const times = state.clips
    .flatMap(x => others.filter(m => isSet(x, m.id)).map(m => markerOffset(x, m.id)))
    .sort((a, b) => a - b);
  if (!times.length) return toast(`No ${names} frames set yet — select a clip and mark them`);
  const eps = 1e-4;
  let t = dir > 0 ? times.find(x => x > state.g + eps) : times.findLast(x => x < state.g - eps);
  if (t === undefined) t = dir > 0 ? times[0] : times[times.length - 1];
  state.g = clamp(t, state.gMin, state.gMax);
  renderSynced();
}

function select(i) {
  if (i === state.selected || i >= state.clips.length) return;
  if (state.clips[i]?.hidden) return toast(`${displayName(state.clips[i].name)} isn't in the overlay — pick it as Base or Over`);
  if (state.playing) pause();
  if (state.picking && state.picking.c !== state.clips[i]) stopPicking();
  const prev = selectedClip();
  state.selected = i;
  if (prev) drawAlign(prev);
  const c = selectedClip();
  if (c) {
    c.localIdx = c.targetIdx;
    setOut(c, false);
    seekIdx(c, c.localIdx);
    updateInfo(c, c.localIdx);
    drawAlign(c);
  }
  renderSynced();
  updateChrome();
}

function setMarker(m) {
  const c = selectedClip();
  if (!c) return toast(`Select a clip first (click it or press 1–9), then press ${keyLabel(m) || `Set ${lower(m)}`}`);
  const name = displayName(c.name);
  const isSync = m.id === state.syncOn;
  if (!isSync && c.markers[m.id] === c.localIdx) {
    c.markers[m.id] = null;
    toast(`${name}: ${lower(m)} cleared`);
  } else {
    c.markers[m.id] = c.localIdx;
    let rel = '';
    if (!isSync && isSet(c, state.syncOn)) {
      const off = markerOffset(c, m.id);
      rel = ` (${Math.abs(off).toFixed(3)}s ${off < 0 ? 'before' : 'after'} ${lower(syncMarker())})`;
    }
    toast(`${name}: ${lower(m)} set to frame ${c.localIdx + 1}${rel}`);
  }
  if (isSync) computeRange();
  updateInfo(c, c.localIdx);
  updateTimeline();
  updateChrome();
  saveConfig();
}

function setSyncOn(id) {
  if (id === state.syncOn) return;
  if (state.playing) pause();
  state.syncOn = id;
  if (state.clips.length) {
    computeRange();
    state.g = clamp(0, state.gMin, state.gMax);
    renderSynced(true);
  }
  buildHelp();
  updateMarkerButtons();
  updateChrome();
  saveConfig();
  toast(`Clips now line up on ${lower(syncMarker())}`);
}

// ---------------------------------------------------------------- persistence + toast

function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const clips = { ...savedClips };
    for (const c of state.clips) {
      clips[c.name] = {
        // Keep markers for ids no longer in sports.json, in case they come back.
        markers: { ...(savedClips[c.name]?.markers || {}), ...c.markers },
        zoom: +c.zoom.toFixed(4),
        panX: +c.panX.toFixed(4),
        panY: +c.panY.toFixed(4),
        flip: c.flip,
        align: Object.fromEntries(Object.entries(c.align).map(([k, [u, v]]) => [k, [+u.toFixed(4), +v.toFixed(4)]])),
      };
    }
    savedClips = clips;
    const body = JSON.stringify({
      aspect: state.aspect, rate: state.rate, loop: state.loop, syncOn: state.syncOn, overlay: state.overlay, clips,
    }, null, 2);
    fetch(`/api/config?sport=${encodeURIComponent(state.sport)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
      .then(res => { if (!res.ok) throw new Error(res.statusText); })
      .catch(() => toast("Couldn't save settings — is the server still running?"));
  }, 400);
}

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches('input[type="text"], textarea')) return;
  if ($('#help').open && e.key !== '?') return;

  const c = selectedClip();
  let handled = true;
  switch (e.key) {
    case ' ': togglePlay(); break;
    case 'ArrowRight': step(e.shiftKey ? 10 : 1); break;
    case 'ArrowLeft': step(e.shiftKey ? -10 : -1); break;
    case 'Home': goToEdge(-1); break;
    case 'End': goToEdge(1); break;
    case 'Enter':
    case '0': goToSync(); break;
    case 'ArrowUp': setRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(state.rate) + 1)]); toast(`Speed ${state.rate}×`, 900); break;
    case 'ArrowDown': setRate(RATES[Math.max(0, RATES.indexOf(state.rate) - 1)]); toast(`Speed ${state.rate}×`, 900); break;
    case 'Escape':
      if (state.picking) stopPicking();
      else select(-1);
      break;
    case 'o': case 'O': setOverlay(!state.overlay.on); break;
    case 's': case 'S': swapOverlay(); break;
    case 'a': case 'A': startPicking(); break;
    case ']': goToMarker(1); break;
    case '[': goToMarker(-1); break;
    case 'f': case 'F': if (c) toggleFlip(c); break;
    case 'z': case 'Z': if (c) resetView(c); break;
    case 'l': case 'L':
      state.loop = !state.loop;
      updateChrome();
      saveConfig();
      toast(`Loop ${state.loop ? 'on' : 'off'}`, 900);
      break;
    case '?': {
      const help = $('#help');
      if (help.open) help.close();
      else help.showModal();
      break;
    }
    default: {
      const m = state.markers.find(x => x.key && x.key === e.key.toLowerCase());
      if (m) setMarker(m);
      else if (/^[1-9]$/.test(e.key)) select(Number(e.key) - 1);
      else handled = false;
    }
  }
  if (handled) e.preventDefault();
});

init();

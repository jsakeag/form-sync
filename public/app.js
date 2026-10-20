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
const RESERVED_KEYS = new Set([' ', 'f', 'z', 'l', 'o', 'a', 'g', 's', '?', '[', ']', ...'0123456789']);
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
  overlay: { on: false, base: '', top: '', opacity: 0.5, align: 'body' }, // base/top are clip names
  picking: null, // { c, kind: 'body' | 'court', points, ... } while placing alignment points
  court: null,   // shot type's court: named lines in metres, plus decoration for drawing
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
    // Clicks along court lines in this clip ({ line id: [[u, v], ...] }) and the
    // homography they give from the court plane to the video.
    court: Object.fromEntries(Object.entries(saved.court || {})
      .filter(([id, pts]) => state.court?.byId[id] && Array.isArray(pts))
      .map(([id, pts]) => [id, pts.filter(p => Array.isArray(p) && p.length === 2 && inPicture(p))])
      .filter(([, pts]) => pts.length)),
    courtH: null,
    H: null,        // view matrix: normalised video coordinates → panel pixels
    hidden: false,  // not shown (overlay mode with other clips stacked)
    shownIdx: -1,   // frame known to be on screen
    targetIdx: 0,   // frame we want on screen
    pendingIdx: -1, // frame an in-flight seek will land on
    localIdx: 0,    // position while adjusted on its own
    hardSeekAt: 0,
    out: false,
  };
  c.courtH = fitCourt(c.court);
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
  setupCourt(state.sportDef);
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
  buildCourtPicker();
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
    ['A', "Set the selected clip's body points for overlay: click the head, then the ground between the feet"],
    ...(state.court ? [['G', "Mark court lines on the selected clip for overlay: 2 clicks on each of 4+ lines, then Enter"]] : []),
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
      toolButton('Body points', 'For overlay: click the top of the head, then the ground between the feet (A)', () => { select(i); startPicking('body'); }),
      ...(state.court ? [toolButton('Court lines', 'For overlay: click along at least 4 court lines (G)', () => { select(i); startPicking('court'); })] : []),
      toolButton('Flip', 'Mirror horizontally (F)', () => toggleFlip(c)),
      toolButton('Reset view', 'Reset zoom and pan (double-click, Z)', () => resetView(c)),
    );

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('align-layer');
    svg.setAttribute('hidden', '');
    const courtPath = document.createElementNS(SVG_NS, 'path');
    courtPath.setAttribute('class', 'court-lines');
    const courtDots = document.createElementNS(SVG_NS, 'g');
    const line = document.createElementNS(SVG_NS, 'line');
    svg.append(courtPath, courtDots, line);
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
    c.ui = { panel, info, badges: badgeFor, align: { svg, line, marks, courtPath, courtDots } };
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

// ---------------------------------------------------------------- geometry
// 3×3 matrices are flat row-major arrays. A clip's view matrix `c.H` maps normalised video
// coordinates ([0..1, 0..1] of the source frame) to panel pixels. The CSS transform is
// derived from it, so plain zoom/pan, body alignment and the projective court alignment
// all go through the same path.

const M3 = {
  mul(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
    return r;
  },
  inv(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h;
    const B = f * g - d * i;
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!det) return null;
    return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map(v => v / det);
  },
  apply(m, [x, y]) {
    const w = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
  },
  // Like apply, but null for points behind the camera (used when drawing court lines).
  project(m, [x, y]) {
    const w = m[6] * x + m[7] * y + m[8];
    return w > 1e-9 ? [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w] : null;
  },
  translate: (x, y) => [1, 0, x, 0, 1, y, 0, 0, 1],
  scale: (sx, sy) => [sx, 0, 0, 0, sy, 0, 0, 0, 1],
};

// Normalised video point → panel pixel with no view transform (object-fit: contain).
function fitMatrix(c) {
  const vw = c.el.videoWidth || state.panelW;
  const vh = c.el.videoHeight || state.panelH;
  const s = Math.min(state.panelW / vw, state.panelH / vh);
  const dw = vw * s;
  const dh = vh * s;
  return [dw, 0, (state.panelW - dw) / 2, 0, dh, (state.panelH - dh) / 2, 0, 0, 1];
}

// Zoom about the panel centre, then pan; f = -1 mirrors.
function similarity(c, { tx, ty, z, f }) {
  const cx = state.panelW / 2;
  const cy = state.panelH / 2;
  return [M3.translate(cx + tx, cy + ty), M3.scale(z * f, z), M3.translate(-cx, -cy), fitMatrix(c)].reduce(M3.mul);
}

const ownView = c => ({ tx: c.panX * state.panelW, ty: c.panY * state.panelH, z: c.zoom, f: c.flip ? -1 : 1 });
const ownMatrix = c => similarity(c, ownView(c));
const toPanel = (c, pt) => M3.apply(c.H, pt);
const fromPanel = (c, x, y) => M3.apply(M3.inv(c.H), [x, y]);
const hasAlign = c => ALIGN_POINTS.every(pt => c.align[pt.id]);
// Clicks have to land on the picture: a guess at where a line runs off-screen hurts more
// than leaving the line out.
const inPicture = uv => uv.every(x => x >= -0.003 && x <= 1.003);

// Puts `top`'s feet on `base`'s feet and scales it to the same head-to-feet length.
// No rotation, so a lean in one clip stays visible.
function bodyAligned(base, top) {
  if (!hasAlign(base) || !hasAlign(top)) return null;
  const bm = ownMatrix(base);
  const [hx, hy] = M3.apply(bm, base.align.head);
  const [fx, fy] = M3.apply(bm, base.align.feet);
  const fit = fitMatrix(top);
  const centred = pt => {
    const [x, y] = M3.apply(fit, pt);
    return [x - state.panelW / 2, y - state.panelH / 2];
  };
  const [qhx, qhy] = centred(top.align.head);
  const [qfx, qfy] = centred(top.align.feet);
  const len = Math.hypot(qhx - qfx, qhy - qfy);
  if (len < 1) return null;
  const f = top.flip ? -1 : 1;
  const z = Math.hypot(hx - fx, hy - fy) / len;
  return similarity(top, { tx: fx - state.panelW / 2 - z * f * qfx, ty: fy - state.panelH / 2 - z * qfy, z, f });
}

// Maps the top clip's court onto the base clip's court: top video → court plane → base
// video → base panel. Exact on the ground; anything above it (the player) is only as
// comparable as the two camera positions are similar.
function courtAligned(base, top) {
  if (!base.courtH || !top.courtH) return null;
  const toCourt = M3.inv(top.courtH);
  return toCourt && [ownMatrix(base), base.courtH, toCourt].reduce(M3.mul);
}

function alignedMatrix(base, top) {
  return state.overlay.align === 'court' ? courtAligned(base, top) : bodyAligned(base, top);
}

function applyView(c) {
  if (!state.panelW) return;
  const ov = overlayPair();
  c.H = (ov && c === ov.top && alignedMatrix(ov.base, ov.top)) || ownMatrix(c);
  // CSS works in the element's own pixels (origin 0 0), so undo the contain fit first.
  const t = M3.mul(c.H, M3.inv(fitMatrix(c)));
  c.el.style.transform = `matrix3d(${t[0]},${t[3]},0,${t[6]},${t[1]},${t[4]},0,${t[7]},0,0,1,0,${t[2]},${t[5]},0,${t[8]})`;
  drawGuides(c);
  if (ov && c === ov.base) applyView(ov.top); // the aligned top clip follows the base
}

// In overlay mode, once the top clip is aligned, dragging and zooming it moves the base
// (and the top follows); before that it moves the top clip on its own for manual lining up.
function viewTarget(c) {
  const ov = overlayPair();
  return ov && c === ov.top && alignedMatrix(ov.base, ov.top) ? ov.base : c;
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

// ---------------------------------------------------------------- court
// Court alignment works from clicks along known court lines rather than corners: phone
// video rarely shows four corners, but almost always shows four lines.

function setupCourt(def) {
  const court = def.court;
  if (!court?.lines?.length) {
    state.court = null;
    return;
  }
  const lines = court.lines.map(l => {
    const [[x1, y1], [x2, y2]] = [l.from, l.to];
    // The infinite line aX + bY + c = 0 through the segment, with (a, b) a unit vector.
    const a = y2 - y1;
    const b = x1 - x2;
    const n = Math.hypot(a, b);
    return { ...l, eq: [a / n, b / n, -(a * x1 + b * y1) / n] };
  });
  const polylines = [
    ...lines.map(l => [l.from, l.to]),
    ...(court.decor || []).map(([x1, y1, x2, y2]) => [[x1, y1], [x2, y2]]),
  ];
  for (const a of court.arcs || []) {
    const from = ((a.from ?? 0) * Math.PI) / 180;
    const to = ((a.to ?? 360) * Math.PI) / 180;
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const t = from + ((to - from) * i) / 48;
      pts.push([a.x + a.r * Math.cos(t), a.y + a.r * Math.sin(t)]);
    }
    polylines.push(pts);
  }
  state.court = { ...court, lines, polylines, byId: Object.fromEntries(lines.map(l => [l.id, l])) };
}

// Solves Gx = b by Gaussian elimination with partial pivoting; null if singular.
function solveLinear(G, b) {
  const n = b.length;
  const A = G.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-10) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = col + 1; r < n; r++) {
      const k = A[r][col] / A[col][col];
      for (let j = col; j <= n; j++) A[r][j] -= k * A[col][j];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = A[r][n];
    for (let j = r + 1; j < n; j++) s -= A[r][j] * x[j];
    x[r] = s / A[r][r];
  }
  return x;
}

// Similarity that centres points on the origin with mean distance √2, which keeps the
// least-squares system well conditioned.
function normaliser(pts) {
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p[0] - mx, p[1] - my), 0) / pts.length || 1;
  const k = Math.SQRT2 / d;
  return [k, 0, -k * mx, 0, k, -k * my, 0, 0, 1];
}

// Lines with at least two clicks; a single click doesn't pin a line down, so it's left out.
const fittedLines = points => Object.entries(points).filter(([id, pts]) => state.court.byId[id] && pts.length >= 2);
const markedLines = points => fittedLines(points).length;

// Court plane (metres) → normalised video coordinates, from clicks along court lines.
// A video point p clicked on court line L satisfies Lᵀ·G·p = 0 for the video → court
// homography G, which is linear in G's entries, so four lines (two clicks each, in two
// directions) determine it and extra clicks are fitted by least squares.
function fitCourt(points) {
  if (!state.court || markedLines(points) < 4) return null;
  const obs = fittedLines(points).flatMap(([id, pts]) => pts.map(p => [state.court.byId[id], p]));
  const Tv = normaliser(obs.map(([, p]) => p));
  const Tc = normaliser(obs.flatMap(([l]) => [l.from, l.to]));
  const TcInv = M3.inv(Tc);
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  for (const [line, p] of obs) {
    // Lines map by the inverse transpose: L' = Tc⁻ᵀ L.
    const [l0, l1, l2] = line.eq;
    let a = TcInv[0] * l0 + TcInv[3] * l1 + TcInv[6] * l2;
    let b = TcInv[1] * l0 + TcInv[4] * l1 + TcInv[7] * l2;
    let c = TcInv[2] * l0 + TcInv[5] * l1 + TcInv[8] * l2;
    const n = Math.hypot(a, b);
    a /= n; b /= n; c /= n;
    const [x, y] = M3.apply(Tv, p);
    const row = [a * x, a * y, a, b * x, b * y, b, c * x, c * y];
    for (let i = 0; i < 8; i++) {
      Atb[i] -= row[i] * c;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  }
  const g = solveLinear(AtA, Atb);
  if (!g) return null;
  const G = [TcInv, [...g, 1], Tv].reduce(M3.mul);
  let H = M3.inv(G);
  if (!H) return null;
  // Every clicked point has to come out in front of the camera.
  const court = obs.map(([, p]) => M3.apply(G, p));
  const w = ([X, Y]) => H[6] * X + H[7] * Y + H[8];
  if (w(court[0]) < 0) H = H.map(v => -v);
  return court.every(X => w(X) > 0) ? H : null;
}

const clickCount = points => fittedLines(points).reduce((n, [, pts]) => n + pts.length, 0);

// Mean distance, in pixels of the source video, from each line's clicks to that line as
// fitted. The fit needs exactly 8 clicks, so only extra clicks can reveal a mistake.
function courtLineErrors(c, points, H) {
  const W = c.el.videoWidth || 1;
  const Hv = c.el.videoHeight || 1;
  const out = {};
  for (const [id, pts] of fittedLines(points)) {
    const line = state.court.byId[id];
    const a = M3.project(H, line.from);
    const b = M3.project(H, line.to);
    if (!a || !b) continue;
    const [ax, ay, bx, by] = [a[0] * W, a[1] * Hv, b[0] * W, b[1] * Hv];
    const len = Math.hypot(bx - ax, by - ay);
    if (!len) continue;
    out[id] = pts.reduce((s, [u, v]) => s + Math.abs((bx - ax) * (ay - v * Hv) - (ax - u * W) * (by - ay)) / len, 0) / pts.length;
  }
  return out;
}

// A line is flagged when its clicks sit more than this fraction of the frame height off the fit.
const OFF_LINE = 0.006;

function courtFitError(c, points, H) {
  if (clickCount(points) <= 8) return null;
  const errs = courtLineErrors(c, points, H);
  const ids = Object.keys(errs);
  const n = ids.reduce((s, id) => s + points[id].length, 0);
  return n ? ids.reduce((s, id) => s + errs[id] * points[id].length, 0) / n : null;
}

// The worst line, if it's far enough off to be a mis-click or the wrong line.
function worstCourtLine(c, points, H) {
  if (clickCount(points) <= 8) return null;
  const errs = courtLineErrors(c, points, H);
  const id = Object.keys(errs).sort((a, b) => errs[b] - errs[a])[0];
  return id && errs[id] > OFF_LINE * (c.el.videoHeight || 1) ? { id, err: errs[id], errs } : null;
}

// Body points, plus the court's lines projected through the clip's fit and the clicks
// along them, drawn over the video.
function drawGuides(c) {
  const { svg, line, marks, courtPath, courtDots } = c.ui.align;
  const pk = state.picking?.c === c ? state.picking : null;
  const selected = selectedClip() === c;
  const body = pk ? (pk.kind === 'body' ? pk.points : {}) : selected ? c.align : {};
  const courtPts = pk ? (pk.kind === 'court' ? pk.points : {}) : selected ? c.court : {};
  const courtH = pk ? pk.fit : c.courtH;
  const show = !!pk || Object.keys(body).length > 0 || Object.keys(courtPts).length > 0;
  svg.toggleAttribute('hidden', !show);
  if (!show || !c.H) return;

  const pos = {};
  for (const pt of ALIGN_POINTS) {
    const g = marks[pt.id];
    g.toggleAttribute('hidden', !body[pt.id]);
    if (!body[pt.id]) continue;
    pos[pt.id] = toPanel(c, body[pt.id]);
    g.setAttribute('transform', `translate(${pos[pt.id][0]} ${pos[pt.id][1]})`);
  }
  line.toggleAttribute('hidden', !(pos.head && pos.feet));
  if (pos.head && pos.feet) {
    line.setAttribute('x1', pos.head[0]);
    line.setAttribute('y1', pos.head[1]);
    line.setAttribute('x2', pos.feet[0]);
    line.setAttribute('y2', pos.feet[1]);
  }

  let d = '';
  if (courtH && Object.keys(courtPts).length) {
    const P = M3.mul(c.H, courtH);
    for (const poly of state.court.polylines) {
      // Subdivide so a segment that runs behind the camera is cut rather than flipped.
      const pts = poly.length > 2 ? poly : Array.from({ length: 33 }, (_, i) => [
        poly[0][0] + ((poly[1][0] - poly[0][0]) * i) / 32,
        poly[0][1] + ((poly[1][1] - poly[0][1]) * i) / 32,
      ]);
      let pen = 'M';
      for (const pt of pts) {
        const q = M3.project(P, pt);
        if (!q) { pen = 'M'; continue; }
        d += `${pen}${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
        pen = 'L';
      }
    }
  }
  courtPath.setAttribute('d', d);
  courtDots.replaceChildren(...Object.entries(courtPts).flatMap(([id, pts]) => pts.map(uv => {
    const [x, y] = toPanel(c, uv);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', `court-dot${pk?.current === id ? ' current' : ''}`);
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', pk?.current === id ? 5 : 3.5);
    return dot;
  })));
}

// ---------------------------------------------------------------- picking alignment points

function startPicking(kind) {
  const c = selectedClip();
  const key = kind === 'court' ? 'G' : 'A';
  if (!c) return toast(`Select a clip first (click it or press 1–9), then press ${key}`);
  if (kind === 'court' && !state.court) return toast(`${state.sportDef.label} has no court in sports.json`);
  stopPicking();
  // New points are kept aside until picking finishes, so the overlay doesn't shift mid-way.
  const points = kind === 'court' ? Object.fromEntries(Object.entries(c.court).map(([id, pts]) => [id, [...pts]])) : {};
  state.picking = { c, kind, step: 0, points, current: null, fit: null };
  if (kind === 'court') {
    state.picking.current = nextLine(points, null);
    state.picking.fit = fitCourt(points);
  }
  c.ui.panel.classList.add('picking');
  drawGuides(c);
  updateCourtPicker();
  updateChrome();
  if (kind === 'body') toast(`${displayName(c.name)}: ${ALIGN_POINTS[0].prompt}`, 4000);
}

function stopPicking() {
  const pk = state.picking;
  if (!pk) return;
  state.picking = null;
  pk.c.ui.panel.classList.remove('picking');
  drawGuides(pk.c);
  updateCourtPicker();
  updateChrome();
}

// First line after `after` (in sports.json order, wrapping) with no clicks yet.
function nextLine(points, after) {
  const ids = state.court.lines.map(l => l.id);
  const start = after ? ids.indexOf(after) + 1 : 0;
  for (let k = 0; k < ids.length; k++) {
    const id = ids[(start + k) % ids.length];
    if (!points[id]?.length) return id;
  }
  return null;
}

function refreshCourtPicking() {
  const pk = state.picking;
  pk.fit = fitCourt(pk.points);
  drawGuides(pk.c);
  updateCourtPicker();
  updateChrome();
}

// All panels of the clip being picked share its geometry (side by side it's its own
// panel; in overlay the base and top panels are stacked), so any click on a panel of
// that size maps into the clip's video coordinates.
function pickPoint(panel, e) {
  const pk = state.picking;
  if (!overlayPair() && panel !== pk.c.ui.panel) return toast(`Click on ${displayName(pk.c.name)} to place its points (Esc cancels)`);
  const r = panel.getBoundingClientRect();
  const uv = fromPanel(pk.c, e.clientX - r.left, e.clientY - r.top);
  if (!inPicture(uv)) {
    return toast(pk.kind === 'court' ? 'Click on the picture itself. Skip lines that are out of shot.' : 'Click on the picture itself');
  }

  if (pk.kind === 'court') {
    if (!pk.current) return toast('Pick a line in the court diagram first');
    // Stays on this line until another is picked, so extra clicks along it all count.
    (pk.points[pk.current] ||= []).push(uv);
    refreshCourtPicking();
    return;
  }

  pk.points[ALIGN_POINTS[pk.step].id] = uv;
  pk.step++;
  if (pk.step < ALIGN_POINTS.length) {
    drawGuides(pk.c);
    updateChrome();
    toast(`${displayName(pk.c.name)}: now ${ALIGN_POINTS[pk.step].prompt}`, 4000);
    return;
  }
  const c = pk.c;
  c.align = pk.points;
  finishPicking(c, hasAlign, 'Body points set');
}

function finishCourtPicking() {
  const pk = state.picking;
  const fit = fitCourt(pk.points);
  if (!fit) return toast('Mark at least 4 lines with 2 clicks each, with lines running in both directions');
  const c = pk.c;
  c.court = Object.fromEntries(Object.entries(pk.points).filter(([, pts]) => pts.length));
  c.courtH = fit;
  const err = courtFitError(c, c.court, fit);
  const worst = worstCourtLine(c, c.court, fit);
  finishPicking(c, x => !!x.courtH, `Court fitted from ${markedLines(c.court)} lines${err == null ? '' : ` (clicks off by ${err.toFixed(1)} px on average)`}${
    worst ? `. Check the ${state.court.byId[worst.id].label}, it's ${worst.err.toFixed(0)} px off` : ''}`);
}

function finishPicking(c, ready, message) {
  stopPicking();
  state.clips.forEach(applyView);
  saveConfig();
  const ov = overlayPair();
  const partner = ov && (c === ov.base ? ov.top : c === ov.top ? ov.base : null);
  toast(partner && !ready(partner)
    ? `${displayName(c.name)}: ${message.toLowerCase()}. Do ${displayName(partner.name)} too to line them up.`
    : `${displayName(c.name)}: ${message.toLowerCase()}`, 4000);
}

// Remove every click on the current line.
function removeCourtLine() {
  const pk = state.picking;
  if (!pk.points[pk.current]) return;
  delete pk.points[pk.current];
  toast(`Removed the ${state.court.byId[pk.current].label.toLowerCase()}`, 1500);
  refreshCourtPicking();
}

function clearCourtPoints() {
  const pk = state.picking;
  pk.points = {};
  pk.current = nextLine(pk.points, null);
  refreshCourtPicking();
}

function selectCourtLine(id) {
  if (state.picking?.kind !== 'court') return;
  state.picking.current = id;
  drawGuides(state.picking.c);
  updateCourtPicker();
  updateChrome();
}

function buildCourtPicker() {
  $('#cp-done').addEventListener('click', finishCourtPicking);
  $('#cp-cancel').addEventListener('click', stopPicking);
  $('#cp-clear').addEventListener('click', clearCourtPoints);
  for (const id of ['#cp-done', '#cp-cancel', '#cp-clear']) $(id).addEventListener('mousedown', e => e.preventDefault());
  if (!state.court) return;

  const svg = $('#cp-diagram');
  const flip = state.court.yUp ? -1 : 1; // facing the net / basket is always "up" in the diagram
  const pts = state.court.polylines.flat();
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1] * flip);
  const pad = 1;
  const [x0, x1, y0, y1] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...ys) - pad, Math.max(...ys) + pad];
  svg.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
  const pathOf = poly => poly.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1] * flip}`).join('');

  const decor = document.createElementNS(SVG_NS, 'path');
  decor.setAttribute('class', 'cl');
  decor.setAttribute('d', state.court.polylines.slice(state.court.lines.length).map(pathOf).join(''));
  svg.append(decor);
  for (const l of state.court.lines) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'fit-line');
    g.dataset.id = l.id;
    for (const cls of ['stroke', 'hit']) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('class', cls);
      p.setAttribute('d', pathOf([l.from, l.to]));
      g.append(p);
    }
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = l.label;
    g.append(title);
    g.addEventListener('click', () => selectCourtLine(l.id));
    svg.append(g);
  }
}

function updateCourtPicker() {
  const box = $('#court-picker');
  const pk = state.picking?.kind === 'court' ? state.picking : null;
  box.hidden = !pk;
  if (!pk) return;

  // Sit beside the clip being marked rather than on top of it.
  const pr = pk.c.ui.panel.getBoundingClientRect();
  const onLeft = pr.left + pr.width / 2 > innerWidth / 2;
  box.style.left = onLeft ? '14px' : '';
  box.style.right = onLeft ? '' : '14px';
  box.style.top = `${$('.topbar').getBoundingClientRect().bottom + 12}px`;

  $('#cp-clip').textContent = displayName(pk.c.name);
  const worst = pk.fit && worstCourtLine(pk.c, pk.points, pk.fit);
  const tol = OFF_LINE * (pk.c.el.videoHeight || 1);
  for (const g of $('#cp-diagram').querySelectorAll('.fit-line')) {
    const n = pk.points[g.dataset.id]?.length || 0;
    g.classList.toggle('marked', n >= 2);
    g.classList.toggle('partial', n === 1);
    g.classList.toggle('off', !!worst && worst.errs[g.dataset.id] > tol);
    g.classList.toggle('current', g.dataset.id === pk.current);
  }
  const marked = markedLines(pk.points);
  const hint = $('#cp-hint');
  hint.replaceChildren();
  if (pk.current) {
    const n = pk.points[pk.current]?.length || 0;
    hint.append('Click 2 or more points on ', el('b', '', state.court.byId[pk.current].label), n ? ` (${n} so far)` : '',
      ' anywhere along the part you can see, then pick the next line or press Tab.');
  } else {
    hint.append('Pick a line in the diagram.');
  }
  const status = marked < 4 ? ` (need 4, in both directions)` : pk.fit ? ' · fitted' : " · can't fit yet: add lines running the other way";
  hint.append(el('br'), `${marked} line${marked === 1 ? '' : 's'} marked${status}`);
  const err = pk.fit && courtFitError(pk.c, pk.points, pk.fit);
  if (err != null) hint.append(`, clicks off by ${err.toFixed(1)} px`);
  if (pk.fit && clickCount(pk.points) <= 8) {
    hint.append(el('br'), 'Mark a 5th line (or click a line a 3rd time) so mistakes can show up.');
  } else if (worst) {
    hint.append(el('br'), el('span', 'cp-warn',
      `${state.court.byId[worst.id].label} is ${worst.err.toFixed(0)} px off the fit (red). Pick it and press Backspace to remove it, then re-click it carefully or leave it out.`));
  }
  hint.append(el('br'), 'Skip lines that are out of shot · Backspace removes the current line · Enter finishes · Esc cancels');
  if (state.court.note) hint.append(el('br'), el('br'), state.court.note);
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

  const align = $('#ov-align');
  align.querySelector('option[value="court"]').disabled = !state.court;
  if (!state.court) state.overlay.align = 'body';
  align.addEventListener('change', () => {
    state.overlay.align = align.value;
    align.blur();
    applyOverlayLayout();
    saveConfig();
    alignmentHint();
  });
}

function alignmentHint() {
  const ov = overlayPair();
  if (!ov) return;
  if (state.overlay.align === 'court' && !(ov.base.courtH && ov.top.courtH)) {
    toast('Press G on each clip and click along at least 4 court lines to line up the courts', 5000);
  } else if (state.overlay.align === 'body' && !(hasAlign(ov.base) && hasAlign(ov.top))) {
    toast('Press A on each clip to set body points, or drag the top clip into place', 5000);
  }
}

function setOverlay(on) {
  if (on && state.clips.length < 2) return toast('Overlay needs at least two clips');
  state.overlay.on = on;
  applyOverlayLayout();
  saveConfig();
  alignmentHint();
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
  $('#ov-align').value = state.overlay.align;
  layout();
  updateCourtPicker();
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
    const pk = state.picking;
    const what = pk.kind === 'court'
      ? (pk.current ? `click along the ${state.court.byId[pk.current].label.toLowerCase()}` : 'pick a line in the diagram') + ' · Enter done'
      : ALIGN_POINTS[pk.step].prompt;
    mode.append(el('span', 'pill adjust', pk.kind === 'court' ? 'Court points' : 'Body points'),
      el('b', '', displayName(pk.c.name)), `  ${what} · Esc cancel`);
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
  if (prev) drawGuides(prev);
  const c = selectedClip();
  if (c) {
    c.localIdx = c.targetIdx;
    setOut(c, false);
    seekIdx(c, c.localIdx);
    updateInfo(c, c.localIdx);
    drawGuides(c);
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
        court: Object.fromEntries(Object.entries(c.court).map(([k, pts]) => [k, pts.map(([u, v]) => [+u.toFixed(5), +v.toFixed(5)])])),
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
  if (state.picking?.kind === 'court' && ['Enter', 'Backspace', 'Delete', 'Tab'].includes(e.key)) {
    e.preventDefault();
    if (e.key === 'Enter') return finishCourtPicking();
    if (e.key === 'Tab') return selectCourtLine(nextLine(state.picking.points, state.picking.current) || state.picking.current);
    return removeCourtLine();
  }

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
    case 'a': case 'A': startPicking('body'); break;
    case 'g': case 'G': startPicking('court'); break;
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

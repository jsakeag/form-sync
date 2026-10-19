'use strict';

// Sync model: every clip has a release frame. The shared timeline position `g` is
// measured in seconds from release, so clip i shows local time releaseTime(i) + g.
// Selecting a clip detaches it so it can be stepped on its own to mark its release
// and contact frames. Contact frames don't affect sync; they're highlighted so the
// difference in release-to-contact timing between clips is visible.

const RATES = [0.1, 0.25, 0.5, 1, 2];
const ASPECT_PRESETS = ['9:16', '1:2', '2:3', '3:4', '4:5', '1:1'];
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 10;
const START_LATENCY = 0.05; // seconds between play() and frames actually advancing
const CONTACT_HOLD_MS = 350;  // keep the contact highlight up long enough to see at full speed

const $ = sel => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const state = {
  clips: [],
  aspect: '9:16',
  rate: 0.25,
  loop: true,
  g: 0,
  gMin: 0,
  gMax: 0,
  playing: null, // null | 'sync' | 'solo'
  selected: -1,  // clip being adjusted on its own, -1 = all synced
};

let savedClips = {};
let clock = null;
let saveTimer = 0;
let toastTimer = 0;
const stats = { jumps: {} };

const stage = $('#stage');
const lanes = $('#lanes');
const gtrack = $('#gtrack');

// ---------------------------------------------------------------- clip helpers

const releaseTime = c => c.frames[c.release];
const selectedClip = () => state.clips[state.selected];
const displayName = name => name.replace(/\.[^.]+$/, '');
const signed = d => `${d >= 0 ? '+' : '−'}${Math.abs(d)}`;
const hasContact = c => c.contact != null;
const contactOffset = c => c.frames[c.contact] - releaseTime(c); // seconds after release

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
  const lt = releaseTime(ref) + g;
  if (lt < 0 || lt >= ref.duration) return g;
  return ref.frames[frameAt(ref, lt)] - releaseTime(ref);
}

function computeRange() {
  state.gMin = Math.min(...state.clips.map(c => -releaseTime(c)));
  state.gMax = Math.max(...state.clips.map(c => c.frames[c.n - 1] - releaseTime(c)));
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
  const releaseSet = Number.isInteger(saved.release);

  const c = {
    name,
    el: video,
    frames: table.frames,
    durs: table.durs,
    duration: table.duration,
    n,
    fd,
    fps: 1 / fd,
    release: releaseSet ? clamp(saved.release, 0, n - 1) : 0,
    releaseSet,
    contact: Number.isInteger(saved.contact) ? clamp(saved.contact, 0, n - 1) : null,
    contactFlashUntil: 0,
    lastIdx: -1,
    zoom: saved.zoom || 1,
    panX: saved.panX || 0,
    panY: saved.panY || 0,
    flip: !!saved.flip,
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

async function init() {
  buildStaticControls();
  let list = [];
  try {
    const [clipsRes, cfg] = await Promise.all([
      fetch('/api/clips').then(r => r.json()),
      fetch('/api/config').then(r => r.json()).catch(() => ({})),
    ]);
    list = clipsRes;
    savedClips = cfg.clips || {};
    if (cfg.aspect) state.aspect = cfg.aspect;
    if (RATES.includes(cfg.rate)) state.rate = cfg.rate;
    if (typeof cfg.loop === 'boolean') state.loop = cfg.loop;
  } catch (err) {
    $('#empty').textContent = `Couldn't reach the server: ${err.message}`;
    return;
  }

  const results = await Promise.allSettled(list.map(loadClip));
  state.clips = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const failed = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (failed.length) toast(failed.join(' · '), 6000);

  if (!state.clips.length) {
    $('#empty').textContent = list.length ? 'None of the clips could be played.' : 'No clips found in ./data';
    return;
  }

  buildPanels();
  buildLanes();
  buildAspectOptions();
  await Promise.all(state.clips.map(calibrate));
  computeRange();
  state.g = clamp(0, state.gMin, state.gMax);
  layout();
  renderSynced(true);
  updateChrome();
  if (state.clips.every(c => !c.releaseSet)) {
    toast('Click a clip, step to its release frame with ← →, press R. Press ? for all shortcuts.', 7000);
  }
}

// ---------------------------------------------------------------- building the UI

function buildPanels() {
  stage.replaceChildren();
  state.clips.forEach((c, i) => {
    const panel = el('div', 'panel');

    const name = el('div', 'chip chip-name');
    name.append(el('span', 'key', String(i + 1)), displayName(c.name), el('span', 'dim', `${Math.round(c.fps)} fps`));
    name.title = c.name;

    const info = el('div', 'chip chip-info');
    const badges = el('div', 'badges');
    badges.append(el('div', 'badge badge-release', 'Release'), el('div', 'badge badge-contact', 'Contact'));

    const tools = el('div', 'tools');
    tools.append(
      toolButton('Set release', 'Mark the frame this clip is showing as its release (R)', () => { select(i); setRelease(); }, 'primary'),
      toolButton('Set contact', 'Mark the frame this clip is showing as contact (C)', () => { select(i); setContact(); }, 'contact'),
      toolButton('Flip', 'Mirror horizontally (F)', () => toggleFlip(c)),
      toolButton('Reset view', 'Reset zoom and pan (double-click, Z)', () => resetView(c)),
    );

    panel.append(c.el, name, info, badges, tools);
    stage.append(panel);
    c.ui = { panel, info };
    attachPanelInput(c, i);
    applyView(c);
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
    const contact = el('div', 'lane-contact');
    contact.append(el('span', 'lane-contact-label'));
    track.append(bar, contact, head);
    row.append(label, track);
    lanes.append(row);
    c.ui.lane = { row, bar, head, contact };

    scrubber(track, x => {
      if (state.selected !== i) select(i);
      const t = clamp(gFromX(x) + releaseTime(c), 0, c.duration);
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
  bind('#btn-release', goToRelease);
  bind('#btn-contact', () => goToContact(1));
  bind('#help-btn', () => $('#help').showModal());

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
  const n = state.clips.length;
  if (!n) return;
  const ratio = parseAspect(state.aspect) || 9 / 16;
  const cs = getComputedStyle(stage);
  const gap = parseFloat(cs.columnGap) || 12;
  const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - gap * (n - 1);
  const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const w = Math.max(40, Math.min(availH * ratio, availW / n));
  stage.style.setProperty('--pw', `${Math.floor(w)}px`);
  stage.style.setProperty('--ph', `${Math.floor(w / ratio)}px`);
}

// ---------------------------------------------------------------- zoom / pan

function applyView(c) {
  c.el.style.transform = `translate(${c.panX * 100}%, ${c.panY * 100}%) scale(${c.zoom}) scaleX(${c.flip ? -1 : 1})`;
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
  const p = c.ui.panel;
  let drag = null;

  p.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, panX: c.panX, panY: c.panY, moved: false };
    p.setPointerCapture(e.pointerId);
  });
  p.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    p.classList.add('panning');
    c.panX = drag.panX + dx / p.clientWidth;
    c.panY = drag.panY + dy / p.clientHeight;
    applyView(c);
  });
  p.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    p.classList.remove('panning');
    if (moved) saveConfig();
    else select(i);
  });
  p.addEventListener('pointercancel', () => {
    drag = null;
    p.classList.remove('panning');
  });

  p.addEventListener('wheel', e => {
    e.preventDefault();
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
    if (!e.target.closest('.tools')) resetView(c);
  });
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
  const d = idx - c.release;
  info.replaceChildren(`Frame ${idx + 1}/${c.n}`);
  if (c.releaseSet) info.append(el('span', 'dim', `R${signed(d)}`));
  else info.append(el('span', 'dim unset', 'release not set'));
  if (hasContact(c)) info.append(el('span', 'dim contact', `C${signed(idx - c.contact)}`));

  const atContact = hasContact(c) && idx === c.contact;
  if (state.playing && hasContact(c)) {
    // Also catch a contact frame that playback skipped over between two ticks.
    const crossed = c.lastIdx >= 0 && c.lastIdx < c.contact && idx > c.contact;
    if (atContact || crossed) c.contactFlashUntil = performance.now() + CONTACT_HOLD_MS;
  }
  c.lastIdx = idx;
  c.ui.panel.classList.toggle('at-release', c.releaseSet && d === 0);
  c.ui.panel.classList.toggle('at-contact', atContact || performance.now() < c.contactFlashUntil);
}

function renderSynced(force = false) {
  state.clips.forEach((c, i) => {
    if (i === state.selected) return;
    const lt = releaseTime(c) + state.g;
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
  const span = state.gMax - state.gMin;
  const pct = g => `${((g - state.gMin) / span) * 100}%`;
  $('#tl-zero').style.left = pct(0);
  $('#tl-head').style.left = pct(state.g);
  for (const c of state.clips) {
    const { bar, head, row, contact } = c.ui.lane;
    bar.style.left = pct(-releaseTime(c));
    bar.style.width = `${(c.frames[c.n - 1] / span) * 100}%`;
    head.style.left = pct(c.frames[c.localIdx] - releaseTime(c));
    row.classList.toggle('unset', !c.releaseSet);
    contact.hidden = !hasContact(c);
    if (hasContact(c)) {
      contact.style.left = pct(contactOffset(c));
      contact.firstChild.textContent = `${contactOffset(c).toFixed(3)}s`;
    }
  }
  updateReadout();
}

function updateReadout() {
  const out = $('#readout');
  const c = selectedClip();
  if (c) {
    const idx = c.localIdx;
    const d = idx - c.release;
    out.innerHTML = '';
    out.append(el('b', '', displayName(c.name)), `  frame ${idx + 1}/${c.n}  ·  ${c.frames[idx].toFixed(3)}s`);
    if (c.releaseSet) out.append(`  ·  R${signed(d)}`);
    if (hasContact(c)) out.append(`  ·  C${signed(idx - c.contact)}`);
    return;
  }
  const ref = refClip();
  const frames = Math.round(state.g / ref.fd);
  const sign = state.g < -1e-9 ? '−' : '+';
  out.innerHTML = '';
  out.append(el('b', '', `R${sign}${Math.abs(frames)}`), `  ${sign}${Math.abs(state.g).toFixed(3)}s  ·  ${Math.round(ref.fps)} fps steps`);
}

function updateChrome() {
  $('#play-icon').setAttribute('d', state.playing ? 'M3 2h4v12H3zM9 2h4v12H9z' : 'M4 2v12l10-6z');
  $('#rate').value = String(state.rate);
  $('#loop').checked = state.loop;

  const mode = $('#mode');
  const c = selectedClip();
  mode.replaceChildren();
  if (c) {
    mode.append(el('span', 'pill adjust', 'Adjusting'), el('b', '', displayName(c.name)),
      '  ← → step this clip · R set release · C set contact · Esc resync');
  } else {
    const unset = state.clips.filter(x => !x.releaseSet).length;
    mode.append(el('span', 'pill', 'Synced'),
      unset ? `${unset} clip${unset > 1 ? 's' : ''} still need a release frame — click one to set it`
        : 'All clips aligned on their release frame');
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
    const lt = releaseTime(c) + g;
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
    c.contactFlashUntil = 0;
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
  const lt = releaseTime(c) + g;
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
  const lt = releaseTime(ref) + state.g;
  let g = state.g + n * ref.fd;
  if (lt >= 0 && lt < ref.duration) {
    const idx = frameAt(ref, lt) + n;
    if (idx >= 0 && idx < ref.n) g = ref.frames[idx] - releaseTime(ref);
  }
  state.g = clamp(g, state.gMin, state.gMax);
  renderSynced();
}

function goToEdge(dir) {
  if (state.playing) pause();
  const c = selectedClip();
  if (c) return setLocal(c, dir < 0 ? 0 : c.n - 1);
  state.g = dir < 0 ? state.gMin : state.gMax;
  renderSynced();
}

function goToRelease() {
  if (state.playing) pause();
  const c = selectedClip();
  if (c) return setLocal(c, c.release);
  state.g = clamp(0, state.gMin, state.gMax);
  renderSynced();
}

// Sync mode: jump to the next (or previous) clip's contact moment, wrapping around.
function goToContact(dir) {
  if (state.playing) pause();
  const c = selectedClip();
  if (c) {
    if (!hasContact(c)) return toast(`No contact frame set for ${displayName(c.name)} yet — press C to set it`);
    return setLocal(c, c.contact);
  }
  const times = state.clips.filter(hasContact).map(contactOffset).sort((a, b) => a - b);
  if (!times.length) return toast('No contact frames set yet — select a clip, step to contact, press C');
  const eps = 1e-4;
  let t = dir > 0 ? times.find(x => x > state.g + eps) : times.findLast(x => x < state.g - eps);
  if (t === undefined) t = dir > 0 ? times[0] : times[times.length - 1];
  state.g = clamp(t, state.gMin, state.gMax);
  renderSynced();
}

function select(i) {
  if (i === state.selected || i >= state.clips.length) return;
  if (state.playing) pause();
  state.selected = i;
  const c = selectedClip();
  if (c) {
    c.localIdx = c.targetIdx;
    setOut(c, false);
    seekIdx(c, c.localIdx);
    updateInfo(c, c.localIdx);
  }
  renderSynced();
  updateChrome();
}

function setRelease() {
  const c = selectedClip();
  if (!c) return toast('Select a clip first (click it or press 1–9), then press R');
  c.release = c.localIdx;
  c.releaseSet = true;
  computeRange();
  updateInfo(c, c.localIdx);
  updateTimeline();
  updateChrome();
  saveConfig();
  toast(`${displayName(c.name)}: release set to frame ${c.release + 1}`);
}

function setContact() {
  const c = selectedClip();
  if (!c) return toast('Select a clip first (click it or press 1–9), then press C');
  if (c.contact === c.localIdx) {
    c.contact = null;
    toast(`${displayName(c.name)}: contact cleared`);
  } else {
    c.contact = c.localIdx;
    const after = c.releaseSet ? ` (${contactOffset(c).toFixed(3)}s after release)` : '';
    toast(`${displayName(c.name)}: contact set to frame ${c.contact + 1}${after}`);
  }
  updateInfo(c, c.localIdx);
  updateTimeline();
  saveConfig();
}

// ---------------------------------------------------------------- persistence + toast

function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const clips = { ...savedClips };
    for (const c of state.clips) {
      clips[c.name] = {
        release: c.releaseSet ? c.release : null,
        contact: c.contact,
        zoom: +c.zoom.toFixed(4),
        panX: +c.panX.toFixed(4),
        panY: +c.panY.toFixed(4),
        flip: c.flip,
      };
    }
    savedClips = clips;
    const body = JSON.stringify({ aspect: state.aspect, rate: state.rate, loop: state.loop, clips }, null, 2);
    fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
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
    case '0': goToRelease(); break;
    case 'ArrowUp': setRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(state.rate) + 1)]); toast(`Speed ${state.rate}×`, 900); break;
    case 'ArrowDown': setRate(RATES[Math.max(0, RATES.indexOf(state.rate) - 1)]); toast(`Speed ${state.rate}×`, 900); break;
    case 'Escape': select(-1); break;
    case 'r': case 'R': setRelease(); break;
    case 'c': case 'C': setContact(); break;
    case ']': goToContact(1); break;
    case '[': goToContact(-1); break;
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
    default:
      if (/^[1-9]$/.test(e.key)) select(Number(e.key) - 1);
      else handled = false;
  }
  if (handled) e.preventDefault();
});

init();

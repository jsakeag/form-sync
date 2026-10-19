'use strict';

// Reads the video track's sample tables out of an MP4/MOV file and returns the
// presentation time of every frame, so stepping can land on exact frames even
// for variable-frame-rate phone footage.
function parseFrameTable(buf) {
  const dv = new DataView(buf);
  const fourcc = p => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));

  function children(box) {
    const out = [];
    let p = box.body;
    while (p + 8 <= box.end) {
      let size = dv.getUint32(p);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
      else if (size === 0) size = box.end - p;
      if (size < hdr || p + size > box.end) break;
      out.push({ type: fourcc(p + 4), body: p + hdr, end: p + size });
      p += size;
    }
    return out;
  }
  const child = (box, type) => (box ? children(box).find(b => b.type === type) : undefined);

  const moov = child({ body: 0, end: buf.byteLength }, 'moov');
  if (!moov) throw new Error('no moov box');
  const mvhd = child(moov, 'mvhd');
  const movieTimescale = dv.getUint32(mvhd.body + (dv.getUint8(mvhd.body) === 1 ? 20 : 12));

  for (const trak of children(moov).filter(b => b.type === 'trak')) {
    const mdia = child(trak, 'mdia');
    const hdlr = child(mdia, 'hdlr');
    if (!hdlr || fourcc(hdlr.body + 8) !== 'vide') continue;

    const mdhd = child(mdia, 'mdhd');
    const timescale = dv.getUint32(mdhd.body + (dv.getUint8(mdhd.body) === 1 ? 20 : 12));
    const stbl = child(child(mdia, 'minf'), 'stbl');

    const stts = child(stbl, 'stts');
    const dts = [];
    let t = 0;
    let lastDelta = 0;
    for (let i = 0, n = dv.getUint32(stts.body + 4); i < n; i++) {
      const count = dv.getUint32(stts.body + 8 + i * 8);
      lastDelta = dv.getUint32(stts.body + 12 + i * 8);
      for (let k = 0; k < count; k++) { dts.push(t); t += lastDelta; }
    }
    if (!dts.length) throw new Error('empty video track');

    const pts = Float64Array.from(dts);
    const ctts = child(stbl, 'ctts');
    if (ctts) {
      let s = 0;
      for (let i = 0, n = dv.getUint32(ctts.body + 4); i < n; i++) {
        const count = dv.getUint32(ctts.body + 8 + i * 8);
        const offset = dv.getInt32(ctts.body + 12 + i * 8);
        for (let k = 0; k < count && s < pts.length; k++) pts[s++] += offset;
      }
    }
    pts.sort();

    // The edit list says which slice of the media is presented (phone trims live here);
    // players map its media_time to t=0 and hide frames outside the segment.
    let origin = pts[0];
    let segment = Infinity;
    const elst = child(child(trak, 'edts'), 'elst');
    if (elst) {
      const v = dv.getUint8(elst.body);
      const size = v === 1 ? 20 : 12;
      for (let i = 0, n = dv.getUint32(elst.body + 4); i < n; i++) {
        const q = elst.body + 8 + i * size;
        const segDur = v === 1 ? Number(dv.getBigUint64(q)) : dv.getUint32(q);
        const mediaTime = v === 1 ? Number(dv.getBigInt64(q + 8)) : dv.getInt32(q + 4);
        if (mediaTime < 0) continue; // empty edit
        origin = mediaTime;
        if (segDur > 0) segment = (segDur / movieTimescale) * timescale;
        break;
      }
    }

    const frames = [];
    const durs = [];
    for (let i = 0; i < pts.length; i++) {
      const start = pts[i] - origin;
      const end = (i + 1 < pts.length ? pts[i + 1] : pts[i] + lastDelta) - origin;
      const s0 = Math.max(0, start);
      const e0 = Math.min(end, segment);
      // Skip frames the trim cuts down to a sliver; stepping onto them would look like a repeat.
      if (e0 - s0 < (end - start) / 2) continue;
      frames.push(s0 / timescale);
      durs.push((e0 - s0) / timescale);
    }
    if (!frames.length) throw new Error('edit list leaves no frames');
    // Chrome starts the timeline at the first frame it keeps.
    const first = frames[0];
    for (let i = 0; i < frames.length; i++) frames[i] -= first;
    return {
      frames: Float64Array.from(frames),
      durs: Float64Array.from(durs),
      duration: frames[frames.length - 1] + durs[durs.length - 1],
    };
  }
  throw new Error('no video track');
}

function uniformFrameTable(duration, fps) {
  const n = Math.max(1, Math.round(duration * fps));
  const frames = new Float64Array(n);
  const durs = new Float64Array(n).fill(1 / fps);
  for (let i = 0; i < n; i++) frames[i] = i / fps;
  return { frames, durs, duration: n / fps };
}

if (typeof module !== 'undefined') module.exports = { parseFrameTable, uniformFrameTable };

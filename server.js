'use strict';

// Zero-dependency local server: serves the player, streams clips from data/<shot type>/
// with HTTP range support (needed for seeking), and persists each shot type's sync
// settings to data/<shot type>/sync.json. Shot types and their markers live in sports.json.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SPORTS_FILE = path.join(ROOT, 'sports.json');
const PORT = Number(process.env.PORT) || 8765;

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  // H.264 .mov files are ISO-BMFF compatible; Chrome refuses video/quicktime but plays them as mp4.
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
};

function resolveInside(dir, rel) {
  const file = path.join(dir, rel);
  return file.startsWith(dir + path.sep) ? file : null;
}

// Read on every request so edits to sports.json apply on reload.
function loadSports() {
  return JSON.parse(fs.readFileSync(SPORTS_FILE, 'utf8'));
}

function sportDir(id) {
  return id && Object.hasOwn(loadSports(), id) ? resolveInside(DATA_DIR, id) : null;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      if (m[1] === '') start = Math.max(0, st.size - Number(m[2]));
      else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(end, Number(m[2]));
      }
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

function listClips(id) {
  const dir = sportDir(id);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => !name.startsWith('.') && VIDEO_EXT.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(name => ({ name, url: `/media/${encodeURIComponent(id)}/${encodeURIComponent(name)}` }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const sport = url.searchParams.get('sport');

  if (pathname === '/api/sports') {
    try {
      return send(res, 200, JSON.stringify(loadSports()), MIME['.json']);
    } catch (err) {
      return send(res, 500, `sports.json: ${err.message}`);
    }
  }

  if (pathname === '/api/clips') return send(res, 200, JSON.stringify(listClips(sport)), MIME['.json']);

  if (pathname === '/api/config') {
    const dir = sportDir(sport);
    if (!dir) return send(res, 400, 'Unknown or missing ?sport=');
    const file = path.join(dir, 'sync.json');
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          JSON.parse(body);
        } catch {
          return send(res, 400, 'Invalid JSON');
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFile(file, body, err => send(res, err ? 500 : 204, ''));
      });
      return;
    }
    return fs.readFile(file, 'utf8', (err, text) => send(res, 200, err ? '{}' : text, MIME['.json']));
  }

  if (pathname.startsWith('/media/')) {
    const file = resolveInside(DATA_DIR, pathname.slice('/media/'.length));
    return file ? sendFile(req, res, file) : send(res, 403, 'Forbidden');
  }

  const file = resolveInside(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
  return file ? sendFile(req, res, file) : send(res, 403, 'Forbidden');
});

const sports = loadSports();
for (const id of Object.keys(sports)) fs.mkdirSync(sportDir(id), { recursive: true });

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Form Sync running at http://localhost:${PORT}`);
  for (const [id, def] of Object.entries(sports)) {
    console.log(`  ${def.label}: ${listClips(id).length} clip(s) in data/${id}/`);
  }
});

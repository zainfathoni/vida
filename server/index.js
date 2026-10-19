import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { APP_DIR, config, providerStatus } from './config.js';
import { startJob, getJob, cancelJob } from './jobs.js';
import { probe, makeProxy, proxyPathFor, VIDEO_EXTENSIONS } from './media.js';
import { transcribe } from './transcribe.js';
import { exportProject, writeCaptions } from './export.js';
import { saveProject, openProject, PROJECT_EXT } from './project.js';
import { parseSubtitles } from '../public/lib/timeline.js';

const PUBLIC_DIR = path.join(APP_DIR, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

// Only files that the user added as sources (and their proxies) can be streamed.
const mediaAllowlist = new Set();
const allow = (p) => mediaAllowlist.add(path.resolve(p));

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
  res.end(data);
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024 * 1024) throw new Error('Request too large');
  }
  return JSON.parse(body || '{}');
}

function serveFile(req, res, file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return send(res, 404, 'Not found');
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    end = Math.min(end, st.size - 1);
    if (start > end || start < 0) return send(res, 416, 'Bad range', { 'Content-Range': `bytes */${st.size}` });
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }
}

function listDir(dir, kind) {
  const exts = kind === 'project' ? [PROJECT_EXT] : kind === 'subtitle' ? ['.srt', '.vtt'] : VIDEO_EXTENSIONS;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) dirs.push({ name: e.name, path: full });
    else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {}
      files.push({ name: e.name, path: full, size });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, dirs: dirs.sort(byName), files: files.sort(byName), sep: path.sep };
}

async function addSource(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const info = await probe(resolved);
  allow(resolved);
  const source = { path: resolved, name: path.basename(resolved), ...info };
  if (info.needsProxy) {
    const proxy = proxyPathFor(resolved);
    if (fs.existsSync(proxy)) {
      source.proxyPath = proxy;
      allow(proxy);
    } else {
      source.proxyJob = startJob('proxy', `Preview copy: ${source.name}`, async (job) => {
        const out = await makeProxy(resolved, info.duration, job);
        allow(out);
        return { proxyPath: out };
      }).id;
    }
  }
  return source;
}

const routes = {
  'GET /api/status': async () => {
    let ffmpegVersion = null;
    try {
      ffmpegVersion = execFileSync(config.ffmpeg, ['-version']).toString().split('\n')[0];
    } catch {}
    return { providers: providerStatus(), home: os.homedir(), cwd: process.cwd(), ffmpeg: ffmpegVersion, platform: process.platform };
  },
  'GET /api/fs': async (req, url) => listDir(path.resolve(url.searchParams.get('path') || os.homedir()), url.searchParams.get('kind')),
  'POST /api/sources': async (req) => {
    const { paths } = await readJson(req);
    const sources = [];
    const errors = [];
    for (const p of paths || []) {
      try {
        sources.push(await addSource(p));
      } catch (err) {
        errors.push(err.message);
      }
    }
    return { sources, errors };
  },
  'POST /api/proxy': async (req) => {
    const { path: file, duration } = await readJson(req);
    if (!mediaAllowlist.has(path.resolve(file))) throw new Error('Unknown source');
    return startJob('proxy', `Preview copy: ${path.basename(file)}`, async (job) => {
      const out = await makeProxy(file, duration, job);
      allow(out);
      return { proxyPath: out };
    });
  },
  'POST /api/project/save': async (req) => {
    const { file, project } = await readJson(req);
    saveProject(path.resolve(file), project);
    return { ok: true, file: path.resolve(file) };
  },
  'POST /api/project/open': async (req) => {
    const { file } = await readJson(req);
    const project = openProject(path.resolve(file));
    for (const s of project.sources) {
      if (s.missing) continue;
      allow(s.path);
      try {
        const info = await probe(s.path);
        s.needsProxy = info.needsProxy;
        if (info.needsProxy && fs.existsSync(proxyPathFor(s.path))) {
          s.proxyPath = proxyPathFor(s.path);
          allow(s.proxyPath);
        }
      } catch {
        s.missing = true;
      }
    }
    return { file: path.resolve(file), project };
  },
  'POST /api/transcribe': async (req) => {
    const { provider, source } = await readJson(req);
    if (!mediaAllowlist.has(path.resolve(source.path))) throw new Error('Unknown source');
    return startJob('transcribe', `Transcript: ${path.basename(source.path)}`, (job) => transcribe(provider, source, job));
  },
  'POST /api/subtitles/parse': async (req) => {
    const { file } = await readJson(req);
    const segments = parseSubtitles(fs.readFileSync(path.resolve(file), 'utf8'));
    if (!segments.length) throw new Error('No cues found in this file.');
    return { segments };
  },
  'POST /api/export': async (req) => {
    const { project, file } = await readJson(req);
    return startJob('export', `Export: ${path.basename(file)}`, (job) => exportProject(project, path.resolve(file), job));
  },
  'POST /api/captions': async (req) => {
    const { project, file } = await readJson(req);
    return writeCaptions(project, path.resolve(file).replace(/\.(mp4|srt|vtt)$/i, ''));
  },
};

const server = http.createServer(async (req, res) => {
  // Reject requests from other host names (DNS rebinding protection).
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, 'Forbidden host');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/media') {
      const file = path.resolve(url.searchParams.get('path') || '');
      if (!mediaAllowlist.has(file)) return send(res, 403, 'This file is not a project source.');
      return serveFile(req, res, file);
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)(\/cancel)?$/);
    if (jobMatch) {
      if (jobMatch[2] && req.method === 'POST') return send(res, 200, { cancelled: cancelJob(jobMatch[1]) });
      const job = getJob(jobMatch[1]);
      return job ? send(res, 200, job) : send(res, 404, { error: 'No such job' });
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return send(res, 200, await route(req, url));
    if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
    return serveFile(req, res, file);
  } catch (err) {
    send(res, err.status || 400, { error: err.message || String(err) });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  const url = `http://localhost:${config.port}/`;
  console.log(`Vida is running at ${url}`);
  console.log('Press Ctrl+C to stop.');
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    try {
      spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    } catch {}
  }
});

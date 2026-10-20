import {
  buildPlan, planDuration, locate, remapCaptions, resolveOutput, transcriptRows,
  formatClock, parseClock, MIN_CLIP,
} from './lib/timeline.js';
import { History } from './lib/history.js';

// ------------------------------------------------------------------ helpers

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};
const uid = (p) => p + Math.random().toString(36).slice(2, 10);
const COLORS = ['#4f8cff', '#f0814c', '#3cc68a', '#c86bff', '#f0c24c', '#4cd3f0', '#ff6b9a', '#9bd14c'];

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, code: data.code });
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), isError ? 6000 : 2500);
}

const mediaUrl = (src) => `/media?path=${encodeURIComponent(src.proxyPath || src.path)}`;

// -------------------------------------------------------------------- state

const state = {
  file: null,
  revision: null, // hash of the project file as Vida last read or wrote it
  doc: 0, // changes when New or Open replaces the project in the editor
  dirty: false,
  project: newProject(),
  selectedSourceId: null,
  selectedClipId: null,
  marks: {}, // sourceId -> {in, out}
  transcriptSel: null, // {anchor, focus} row indices
  status: null,
  history: new History(),
  focus: 'source',
};

function newProject() {
  return { name: 'Untitled', output: {}, sources: [], sequence: [] };
}

const project = () => state.project;
const sourceById = (id) => project().sources.find((s) => s.id === id);
const sourceColor = (id) => COLORS[Math.max(0, project().sources.findIndex((s) => s.id === id)) % COLORS.length];
const output = () => resolveOutput(project());
const plan = () => buildPlan(project().sequence, output().fps);

function transcripts() {
  const map = {};
  for (const s of project().sources) if (s.transcript) map[s.id] = s.transcript;
  return map;
}

/** Call before every change, so Undo can return to this state. */
const snapshot = () => ({ json: JSON.stringify(project()), revision: state.revision });

function checkpoint() {
  state.history.record(snapshot());
}

function changed({ timeline = true } = {}) {
  state.dirty = true;
  renderAll();
  if (timeline) program.reload();
  else program.refreshCues();
}

function restore(entry) {
  const runtime = new Map(project().sources.map((s) => [s.id, { proxyPath: s.proxyPath, needsProxy: s.needsProxy }]));
  state.project = JSON.parse(entry.json);
  if (entry.revision !== state.revision) {
    // This version is based on another revision of the file. Check the disk again.
    state.revision = entry.revision;
    dismissedRevision = undefined;
    hideDiskBanner();
    setTimeout(checkDisk);
  }
  for (const s of project().sources) Object.assign(s, runtime.get(s.id) || {});
  if (!sourceById(state.selectedSourceId)) state.selectedSourceId = null;
  if (!project().sequence.some((c) => c.id === state.selectedClipId)) state.selectedClipId = null;
  changed();
  if (!state.selectedSourceId) loadSource(null);
}

function undo() {
  const entry = state.history.undo(snapshot());
  if (entry) restore(entry);
}
function redo() {
  const entry = state.history.redo(snapshot());
  if (entry) restore(entry);
}

// ------------------------------------------------------------------ jobs UI

const activeJobs = new Map();

function watchJob(job, onDone) {
  activeJobs.set(job.id, { ...job, onDone });
  renderJobs();
  const tick = async () => {
    let j;
    try {
      j = await api(`/api/jobs/${job.id}`);
    } catch (err) {
      j = { ...job, status: 'error', error: err.message };
    }
    const entry = activeJobs.get(job.id);
    if (!entry) return;
    Object.assign(entry, j);
    renderJobs();
    if (j.status === 'running') return setTimeout(tick, 500);
    if (j.status === 'error') toast(`${j.label}: ${j.error}`, true);
    try {
      onDone && onDone(j);
    } finally {
      setTimeout(() => {
        activeJobs.delete(job.id);
        renderJobs();
      }, j.status === 'error' ? 8000 : 1500);
    }
  };
  setTimeout(tick, 300);
}

function renderJobs() {
  const box = $('jobs');
  box.replaceChildren();
  for (const j of activeJobs.values()) {
    const bar = el('div', { className: 'bar' }, el('div', { style: `width:${Math.round(j.progress * 100)}%` }));
    const label = j.status === 'error' ? `${j.label}: failed` : j.status === 'done' ? `${j.label}: done` : `${j.label} ${Math.round(j.progress * 100)}%`;
    const node = el('div', { className: `job ${j.status}`, title: j.error || j.message || '' }, el('span', { textContent: label }), bar);
    if (j.status === 'running') node.append(el('button', { className: 'small', textContent: 'Stop', onclick: () => api(`/api/jobs/${j.id}/cancel`, {}) }));
    box.append(node);
  }
}

// ------------------------------------------------------------- file dialog

const fileDialog = {
  mode: 'open',
  kind: 'video',
  multi: false,
  selected: new Set(),
  resolve: null,
  dir: null,

  open({ title, kind, mode, multi = false, defaultName = '', dir, hint = '' }) {
    Object.assign(this, { kind, mode, multi, selected: new Set() });
    $('fileTitle').textContent = title;
    $('fileNameRow').hidden = mode !== 'save';
    $('fileName').value = defaultName;
    $('fileHint').textContent = hint;
    $('fileDialog').showModal();
    this.load(dir || localStorage.getItem(`vida.dir.${kind}`) || '');
    return new Promise((resolve) => (this.resolve = resolve));
  },

  async load(dir) {
    try {
      const data = await api(`/api/fs?path=${encodeURIComponent(dir)}&kind=${this.kind}`);
      this.dir = data.path;
      this.sep = data.sep;
      this.parent = data.parent;
      $('filePath').value = data.path;
      const list = $('fileList');
      list.replaceChildren();
      for (const d of data.dirs) {
        list.append(el('li', { className: 'dir', ondblclick: () => this.load(d.path), onclick: () => this.load(d.path) }, el('span', { className: 'nm', textContent: d.name })));
      }
      for (const f of data.files) {
        const li = el('li', {}, el('span', { className: 'nm', textContent: f.name }), el('span', { className: 'sz', textContent: `${(f.size / 1e6).toFixed(1)} MB` }));
        li.onclick = () => {
          if (this.mode === 'save') {
            $('fileName').value = f.name;
            return;
          }
          if (!this.multi) {
            this.selected.clear();
            list.querySelectorAll('li.selected').forEach((n) => n.classList.remove('selected'));
          }
          if (this.selected.has(f.path)) this.selected.delete(f.path);
          else this.selected.add(f.path);
          li.classList.toggle('selected', this.selected.has(f.path));
        };
        li.ondblclick = () => {
          if (this.mode === 'save') return;
          this.selected = new Set([f.path]);
          this.finish(true);
        };
        list.append(li);
      }
      if (!data.dirs.length && !data.files.length) list.append(el('li', { className: 'hint', textContent: 'No matching files in this folder.' }));
    } catch (err) {
      toast(err.message, true);
    }
  },

  finish(ok) {
    $('fileDialog').close();
    if (!this.resolve) return;
    const resolve = this.resolve;
    this.resolve = null;
    if (!ok) return resolve(null);
    localStorage.setItem(`vida.dir.${this.kind}`, this.dir);
    if (this.mode === 'save') {
      const name = $('fileName').value.trim();
      return resolve(name ? (/^([a-zA-Z]:)?[\\/]/.test(name) ? name : this.dir + this.sep + name) : null);
    }
    resolve([...this.selected]);
  },
};

$('fileUp').onclick = () => fileDialog.parent && fileDialog.load(fileDialog.parent);
$('fileHome').onclick = () => fileDialog.load(state.status ? state.status.home : '');
$('fileGo').onclick = () => fileDialog.load($('filePath').value);
$('filePath').onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    fileDialog.load($('filePath').value);
  }
};
$('fileCancel').onclick = () => fileDialog.finish(false);
$('fileForm').onsubmit = (e) => {
  e.preventDefault();
  fileDialog.finish(true);
};
$('fileDialog').addEventListener('cancel', () => fileDialog.finish(false));

// ---------------------------------------------------------------- sources

async function addSources() {
  const paths = await fileDialog.open({ title: 'Add videos', kind: 'video', mode: 'open', multi: true, hint: 'Click files to select several. The files stay in place and are not changed.' });
  if (!paths || !paths.length) return;
  const known = new Set(project().sources.map((s) => s.path));
  const fresh = paths.filter((p) => !known.has(p));
  if (fresh.length < paths.length) toast('Some files are already in the project.');
  if (!fresh.length) return;
  toast('Reading video information…');
  try {
    const { sources, errors } = await api('/api/sources', { paths: fresh });
    errors.forEach((e) => toast(e, true));
    if (!sources.length) return;
    checkpoint();
    for (const s of sources) {
      const { proxyJob, ...src } = s;
      src.id = uid('s');
      src.transcript = null;
      project().sources.push(src);
      if (proxyJob) trackProxy(src, proxyJob);
    }
    state.selectedSourceId = state.selectedSourceId || project().sources[project().sources.length - sources.length].id;
    changed({ timeline: false });
    loadSource(state.selectedSourceId);
  } catch (err) {
    toast(err.message, true);
  }
}

function trackProxy(src, jobId) {
  src.proxyPending = true;
  watchJob({ id: jobId, label: `Preview copy: ${src.name}`, progress: 0, status: 'running' }, (j) => {
    src.proxyPending = false;
    if (j.status === 'done') {
      src.proxyPath = j.result.proxyPath;
      if (state.selectedSourceId === src.id) loadSource(src.id);
      program.reload();
    }
    renderSources();
  });
}

async function makeProxy(src) {
  try {
    const job = await api('/api/proxy', { path: src.path, duration: src.duration });
    trackProxy(src, job.id);
    renderSources();
  } catch (err) {
    toast(err.message, true);
  }
}

async function relinkSource(src) {
  const paths = await fileDialog.open({ title: `Find ${src.name}`, kind: 'video', mode: 'open' });
  if (!paths || !paths[0]) return;
  try {
    const { sources, errors } = await api('/api/sources', { paths: [paths[0]] });
    if (errors.length) throw new Error(errors[0]);
    checkpoint();
    const { proxyJob, ...fresh } = sources[0];
    Object.assign(src, fresh, { missing: false });
    if (proxyJob) trackProxy(src, proxyJob);
    changed();
    loadSource(src.id);
  } catch (err) {
    toast(err.message, true);
  }
}

function removeSource(src) {
  const used = project().sequence.filter((c) => c.sourceId === src.id).length;
  if (!confirm(`Remove "${src.name}" from the project?${used ? ` ${used} sequence clip(s) use it and will also be removed.` : ''} The file on disk is not deleted.`)) return;
  checkpoint();
  project().sources = project().sources.filter((s) => s !== src);
  project().sequence = project().sequence.filter((c) => c.sourceId !== src.id);
  if (state.selectedSourceId === src.id) {
    state.selectedSourceId = null;
    loadSource(null);
  }
  changed();
}

function renderSources() {
  const list = $('sourceList');
  list.replaceChildren();
  $('sourcesEmpty').hidden = project().sources.length > 0;
  for (const s of project().sources) {
    const badges = [];
    if (s.missing) badges.push(el('span', { className: 'badge warn', textContent: 'file missing' }));
    if (s.transcript) badges.push(el('span', { className: 'badge ok', textContent: `transcript · ${s.transcript.provider}` }));
    else if (!s.hasAudio) badges.push(el('span', { className: 'badge', textContent: 'no audio' }));
    else badges.push(el('span', { className: 'badge', textContent: 'no transcript' }));
    if (s.proxyPending) badges.push(el('span', { className: 'badge', textContent: 'making preview…' }));
    else if (s.proxyPath) badges.push(el('span', { className: 'badge', textContent: 'preview copy' }));
    const used = project().sequence.filter((c) => c.sourceId === s.id).length;
    const li = el(
      'li',
      { className: s.id === state.selectedSourceId ? 'active' : '', style: `--c:${sourceColor(s.id)}`, title: s.path, onclick: () => loadSource(s.id) },
      el('div', { className: 'name', textContent: s.name }),
      el('div', { className: 'meta', textContent: `${formatClock(s.duration, 1)} · ${s.width}×${s.height} · ${Math.round(s.fps * 100) / 100} fps · ${s.vcodec}${used ? ` · used ${used}×` : ''}` }),
      el('div', { className: 'meta' }, ...badges),
    );
    const actions = el('div', { className: 'row-actions' });
    if (s.missing) actions.append(el('button', { className: 'small', textContent: 'Find file…', onclick: (e) => (e.stopPropagation(), relinkSource(s)) }));
    else if (!s.proxyPath && !s.proxyPending) actions.append(el('button', { className: 'small', textContent: 'Make preview copy', title: 'Use this if the video does not play in the browser. Export still uses the original.', onclick: (e) => (e.stopPropagation(), makeProxy(s)) }));
    actions.append(el('button', { className: 'small danger', textContent: 'Remove', onclick: (e) => (e.stopPropagation(), removeSource(s)) }));
    li.append(actions);
    list.append(li);
  }
}

// ---------------------------------------------------------- source monitor

const sv = $('sourceVideo');

function currentSource() {
  return sourceById(state.selectedSourceId);
}

function loadSource(id, seekTo) {
  state.selectedSourceId = id;
  state.transcriptSel = null;
  const src = sourceById(id);
  renderSources();
  renderTranscript();
  $('sourceTitle').textContent = src ? src.name : '';
  if (!src) {
    sv.removeAttribute('src');
    sv.load();
    $('sourceMsg').textContent = 'Select a source';
    $('sourceMsg').hidden = false;
    renderSourceUi();
    return;
  }
  if (src.missing) {
    sv.removeAttribute('src');
    sv.load();
    $('sourceMsg').textContent = 'The file is missing. Use "Find file…" in the source list.';
    $('sourceMsg').hidden = false;
    renderSourceUi();
    return;
  }
  $('sourceMsg').hidden = true;
  const url = mediaUrl(src);
  if (sv.getAttribute('src') !== url) {
    sv.src = url;
  }
  const target = seekTo ?? (state.marks[id] && state.marks[id].in) ?? 0;
  const apply = () => (sv.currentTime = target);
  if (sv.readyState >= 1) apply();
  else sv.addEventListener('loadedmetadata', apply, { once: true });
  renderSourceUi();
}

sv.addEventListener('error', () => {
  const src = currentSource();
  if (!src || !sv.getAttribute('src')) return;
  $('sourceMsg').hidden = false;
  $('sourceMsg').textContent = src.proxyPending
    ? 'Making a preview copy for this video…'
    : 'The browser cannot play this video. Use "Make preview copy" in the source list. Export still uses the original file.';
});

function frameDur() {
  const src = currentSource();
  return 1 / ((src && src.fps) || 30);
}

function marks() {
  const id = state.selectedSourceId;
  if (!state.marks[id]) state.marks[id] = { in: null, out: null };
  return state.marks[id];
}

function renderSourceUi() {
  const src = currentSource();
  const dur = src ? src.duration : 0;
  $('srcTime').textContent = `${formatClock(sv.currentTime || 0)} / ${formatClock(dur)}`;
  $('srcPlay').textContent = sv.paused ? 'Play' : 'Pause';
  const seek = $('sourceSeek');
  seek.max = dur || 1;
  if (document.activeElement !== seek) seek.value = sv.currentTime || 0;
  const m = src ? marks() : { in: null, out: null };
  const inT = m.in ?? 0;
  const outT = m.out ?? dur;
  const range = $('sourceRange');
  if (src && (m.in != null || m.out != null) && dur) {
    const w = $('sourceScrub').clientWidth - 24;
    range.style.display = 'block';
    range.style.left = `${12 + (inT / dur) * w}px`;
    range.style.width = `${Math.max(2, ((outT - inT) / dur) * w)}px`;
  } else range.style.display = 'none';
  $('srcMarks').textContent = src
    ? `In ${m.in == null ? '–' : formatClock(m.in)} · Out ${m.out == null ? '–' : formatClock(m.out)} · Length ${formatClock(Math.max(0, outT - inT))}`
    : 'In – · Out –';
  for (const id of ['srcBack', 'srcPlay', 'srcFwd', 'srcIn', 'srcOut', 'srcAdd']) $(id).disabled = !src || src.missing;
  highlightTranscript();
}

['timeupdate', 'play', 'pause', 'loadedmetadata', 'seeked'].forEach((ev) => sv.addEventListener(ev, renderSourceUi));
$('sourceSeek').oninput = (e) => (sv.currentTime = Number(e.target.value));
$('srcPlay').onclick = () => (sv.paused ? sv.play() : sv.pause());
$('srcBack').onclick = () => step(-1);
$('srcFwd').onclick = () => step(1);
function step(frames) {
  sv.pause();
  sv.currentTime = Math.max(0, Math.min(currentSource().duration, sv.currentTime + frames * frameDur()));
}

function markIn() {
  const m = marks();
  m.in = sv.currentTime;
  if (m.out != null && m.out <= m.in) m.out = null;
  renderSourceUi();
}
function markOut() {
  const m = marks();
  m.out = sv.currentTime;
  if (m.in != null && m.in >= m.out) m.in = null;
  renderSourceUi();
}
$('srcIn').onclick = markIn;
$('srcOut').onclick = markOut;
$('srcAdd').onclick = () => addRangeToSequence();

function addRangeToSequence(range) {
  const src = currentSource();
  if (!src) return;
  const m = range || marks();
  const inT = m.in ?? 0;
  const outT = m.out ?? src.duration;
  if (outT - inT < MIN_CLIP) return toast('The range is too short. Mark In and Out first.', true);
  checkpoint();
  const clip = { id: uid('c'), sourceId: src.id, in: round3(inT), out: round3(Math.min(outT, src.duration)) };
  const seq = project().sequence;
  const at = seq.findIndex((c) => c.id === state.selectedClipId);
  seq.splice(at >= 0 ? at + 1 : seq.length, 0, clip);
  state.selectedClipId = clip.id;
  changed();
  toast(`Added ${formatClock(clip.out - clip.in)} from ${src.name}`);
}

const round3 = (t) => Math.round(t * 1000) / 1000;

// --------------------------------------------------------------- transcript

function transcriptRowsFor(src) {
  return src && src.transcript ? transcriptRows(src.transcript.segments, src.duration) : [];
}

function renderTranscript() {
  const src = currentSource();
  const tools = $('transcriptTools');
  const list = $('transcriptList');
  tools.replaceChildren();
  list.replaceChildren();
  $('transcriptTitle').textContent = src ? src.name : '';
  $('transcriptHint').hidden = !(src && src.transcript);
  if (!src) {
    tools.append(el('div', { className: 'status', textContent: 'Select a source to see its transcript.' }));
    renderTranscriptSel();
    return;
  }
  const p = state.status ? state.status.providers : null;
  const status = el('div', { className: 'status' });
  if (src.transcript) {
    const t = src.transcript;
    status.textContent = `${t.segments.length} lines · ${t.provider}${t.model ? ` (${t.model})` : ''} · times are source times`;
  } else if (!src.hasAudio) {
    status.textContent = 'This source has no audio track, so there is nothing to transcribe. You can still cut it.';
  } else {
    status.textContent = 'No transcript yet. Transcribe the audio or import an SRT or VTT file for this video.';
  }
  tools.append(status);
  if (src.hasAudio && !src.missing) {
    const b1 = el('button', { className: 'small', textContent: src.transcript ? 'Transcribe again (whisper.cpp)' : 'Transcribe (local whisper.cpp)', onclick: () => runTranscribe(src, 'whisper') });
    const b2 = el('button', { className: 'small', textContent: src.transcript ? 'Transcribe again (API)' : 'Transcribe (API)', onclick: () => runTranscribe(src, 'openai') });
    if (p) {
      b1.disabled = !p.whisper.ready;
      b1.title = p.whisper.detail;
      b2.disabled = !p.openai.ready;
      b2.title = p.openai.detail;
    }
    if (src.transcribing) b1.disabled = b2.disabled = true;
    tools.append(b1, b2);
  }
  tools.append(el('button', { className: 'small', textContent: 'Import SRT/VTT…', onclick: () => importSubtitles(src) }));
  if (src.transcript) tools.append(el('button', { className: 'small danger', textContent: 'Delete transcript', onclick: () => deleteTranscript(src) }));
  if (p && src.hasAudio && !src.transcript && !p.whisper.ready && !p.openai.ready) {
    tools.append(el('div', { className: 'status warn', textContent: 'No transcription provider is set up. See "Transcription setup" in README.md. Editing and export work without transcripts.' }));
  }

  transcriptRowsFor(src).forEach((row, i) => {
    const tx = el('span', { className: 'tx', textContent: row.gap ? `No speech · ${formatClock(row.end - row.start, 1)}` : row.text });
    const li = el('li', { className: row.gap ? 'gap' : '' }, el('span', { className: 'ts', textContent: formatClock(row.start, 1) }), tx);
    li.dataset.index = i;
    li.onclick = (e) => {
      if (tx.isContentEditable) return;
      if (e.shiftKey && state.transcriptSel) state.transcriptSel.focus = i;
      else state.transcriptSel = { anchor: i, focus: i };
      sv.currentTime = row.start;
      applyTranscriptSel();
    };
    if (!row.gap) {
      tx.ondblclick = (e) => {
        e.stopPropagation();
        tx.contentEditable = 'true';
        tx.focus();
      };
      tx.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          tx.blur();
        }
        if (e.key === 'Escape') {
          tx.textContent = row.text;
          tx.blur();
        }
      };
      tx.onblur = () => {
        tx.contentEditable = 'false';
        const text = tx.textContent.trim();
        if (text && text !== row.segment.text) {
          checkpoint();
          row.segment.text = text;
          delete row.segment.words; // word timing no longer matches the corrected text
          changed({ timeline: false });
        } else tx.textContent = row.text;
      };
    }
    list.append(li);
  });
  renderTranscriptSel();
}

function selRange() {
  const src = currentSource();
  const sel = state.transcriptSel;
  if (!src || !sel) return null;
  const rows = transcriptRowsFor(src);
  const a = Math.min(sel.anchor, sel.focus);
  const b = Math.max(sel.anchor, sel.focus);
  if (!rows[a] || !rows[b]) return null;
  return { a, b, in: rows[a].start, out: rows[b].end };
}

function applyTranscriptSel() {
  const r = selRange();
  if (r && r.a !== r.b) {
    const m = marks();
    m.in = r.in;
    m.out = r.out;
  }
  renderTranscriptSel();
  renderSourceUi();
}

function renderTranscriptSel() {
  const r = selRange();
  document.querySelectorAll('#transcriptList li').forEach((li) => {
    const i = Number(li.dataset.index);
    li.classList.toggle('selected', Boolean(r && i >= r.a && i <= r.b && r.a !== r.b));
  });
  const multi = r && r.a !== r.b;
  $('transcriptSelBar').hidden = !multi;
  if (multi) $('transcriptSelInfo').textContent = `${r.b - r.a + 1} lines · ${formatClock(r.in)}–${formatClock(r.out)}`;
}

$('transcriptAdd').onclick = () => {
  const r = selRange();
  if (r) addRangeToSequence({ in: r.in, out: r.out });
};

let lastHighlight = -1;
function highlightTranscript() {
  const src = currentSource();
  if (!src || !src.transcript) return;
  const t = sv.currentTime;
  const rows = transcriptRowsFor(src);
  const idx = rows.findIndex((r) => t >= r.start && t < r.end);
  if (idx === lastHighlight) return;
  lastHighlight = idx;
  document.querySelectorAll('#transcriptList li.current').forEach((n) => n.classList.remove('current'));
  const li = document.querySelector(`#transcriptList li[data-index="${idx}"]`);
  if (li) {
    li.classList.add('current');
    if (!sv.paused) li.scrollIntoView({ block: 'nearest' });
  }
}

async function runTranscribe(src, provider) {
  if (src.transcript && !confirm('Replace the current transcript? Your text corrections will be lost.')) return;
  try {
    const job = await api('/api/transcribe', { provider, source: { path: src.path, duration: src.duration, hasAudio: src.hasAudio } });
    src.transcribing = true;
    renderTranscript();
    watchJob(job, (j) => {
      src.transcribing = false;
      if (j.status === 'done') {
        checkpoint();
        src.transcript = j.result;
        changed({ timeline: false });
        toast(`Transcript ready: ${j.result.segments.length} lines`);
      } else renderTranscript();
    });
  } catch (err) {
    toast(err.message, true);
  }
}

async function importSubtitles(src) {
  const paths = await fileDialog.open({ title: `Import SRT or VTT for ${src.name}`, kind: 'subtitle', mode: 'open', hint: 'The cue times must be times in this source video.' });
  if (!paths || !paths[0]) return;
  try {
    const { segments } = await api('/api/subtitles/parse', { file: paths[0] });
    if (src.transcript && !confirm('Replace the current transcript?')) return;
    checkpoint();
    src.transcript = { provider: 'imported', model: paths[0].split(/[\\/]/).pop(), createdAt: new Date().toISOString(), segments };
    changed({ timeline: false });
    toast(`Imported ${segments.length} cues`);
  } catch (err) {
    toast(err.message, true);
  }
}

function deleteTranscript(src) {
  if (!confirm('Delete this transcript?')) return;
  checkpoint();
  src.transcript = null;
  changed({ timeline: false });
}

// ------------------------------------------------------------ program view

// Two video elements: one plays the current clip, the other waits at the
// start of the next clip. At a cut they swap, which keeps joins short.
const program = {
  videos: [$('progA'), $('progB')],
  active: 0,
  plan: [],
  cues: [],
  t: 0,
  index: -1,
  playing: false,
  raf: 0,

  get cur() {
    return this.videos[this.active];
  },
  get other() {
    return this.videos[1 - this.active];
  },

  reload() {
    this.plan = plan();
    this.cues = remapCaptions(this.plan, transcripts());
    const total = planDuration(this.plan);
    if (!this.plan.length) {
      this.pause();
      this.t = 0;
      this.index = -1;
      this.videos.forEach((v) => {
        v.removeAttribute('src');
        v.load();
      });
    } else {
      this.seek(Math.min(this.t, Math.max(0, total - 0.001)), { keepPlaying: this.playing });
    }
    renderProgramUi();
  },

  refreshCues() {
    this.cues = remapCaptions(this.plan, transcripts());
    renderProgramUi();
  },

  prepare(video, entry, time) {
    const src = sourceById(entry.sourceId);
    if (!src || src.missing) return;
    const url = mediaUrl(src);
    if (video.getAttribute('src') !== url) video.src = url;
    const apply = () => {
      if (Math.abs(video.currentTime - time) > 0.01) video.currentTime = time;
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener('loadedmetadata', apply, { once: true });
  },

  show() {
    this.cur.classList.remove('hidden');
    this.other.classList.add('hidden');
    this.other.muted = true;
    this.cur.muted = false;
  },

  preloadNext() {
    const next = this.plan[this.index + 1];
    if (next) this.prepare(this.other, next, next.in);
  },

  seek(t, { keepPlaying = false } = {}) {
    if (!this.plan.length) return;
    const total = planDuration(this.plan);
    t = Math.max(0, Math.min(t, total));
    const loc = locate(this.plan, t);
    this.t = t;
    this.index = loc.index;
    this.cur.pause();
    this.prepare(this.cur, loc.entry, loc.sourceTime);
    this.show();
    this.other.pause();
    this.preloadNext();
    if (keepPlaying) this.play();
    renderProgramUi();
  },

  play() {
    if (!this.plan.length) return;
    if (this.t >= planDuration(this.plan) - 0.01) this.seek(0);
    this.playing = true;
    this.cur.play().catch(() => {});
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.tick());
    renderProgramUi();
  },

  pause() {
    this.playing = false;
    this.videos.forEach((v) => v.pause());
    cancelAnimationFrame(this.raf);
    renderProgramUi();
  },

  tick() {
    if (!this.playing) return;
    const entry = this.plan[this.index];
    if (!entry) return this.pause();
    const src = sourceById(entry.sourceId);
    if (!src || src.missing) {
      // Nothing to play for a missing file: go on with the next clip.
      const next = this.plan[this.index + 1];
      if (next) this.seek(next.offset, { keepPlaying: true });
      else this.pause();
      return;
    }
    const v = this.cur;
    const half = 0.5 / output().fps;
    if (v.currentTime >= entry.out - half || v.ended) {
      const next = this.plan[this.index + 1];
      if (!next) {
        this.t = planDuration(this.plan);
        this.pause();
        return;
      }
      this.index += 1;
      this.active = 1 - this.active;
      // The waiting element should already be at next.in. Set it again in case it moved.
      if (Math.abs(this.cur.currentTime - next.in) > 0.05) this.cur.currentTime = next.in;
      this.cur.play().catch(() => {});
      this.show();
      v.pause();
      this.preloadNext();
      this.t = next.offset;
    } else {
      this.t = entry.offset + Math.max(0, v.currentTime - entry.in);
    }
    renderProgramUi();
    this.raf = requestAnimationFrame(() => this.tick());
  },
};

function renderProgramUi() {
  const total = planDuration(program.plan);
  $('prgTime').textContent = `${formatClock(program.t)} / ${formatClock(total)}`;
  $('prgPlay').textContent = program.playing ? 'Pause' : 'Play';
  const seek = $('programSeek');
  seek.max = total || 1;
  if (document.activeElement !== seek) seek.value = program.t;
  const curEntry = program.plan[program.index];
  const curSrc = curEntry && sourceById(curEntry.sourceId);
  const msg = $('programMsg');
  msg.textContent = !program.plan.length ? 'Add clips to the sequence' : 'The source file of this clip is missing. Export is blocked until you find it.';
  msg.hidden = program.plan.length > 0 && !(curSrc && curSrc.missing);
  program.videos.forEach((v) => (v.style.opacity = curSrc && curSrc.missing ? '0' : ''));
  ['prgPlay', 'prgPrev', 'prgNext', 'programSeek'].forEach((id) => ($(id).disabled = !program.plan.length));
  const cue = $('showCaptions').checked ? program.cues.find((c) => program.t >= c.start && program.t < c.end) : null;
  const overlay = $('captionOverlay');
  const text = cue ? cue.text : '';
  if (overlay.dataset.text !== text) {
    overlay.dataset.text = text;
    overlay.replaceChildren(...(text ? [el('span', { textContent: text })] : []));
  }
  const ph = $('playhead');
  const pps = Number($('zoom').value);
  ph.style.left = `${12 + program.t * pps}px`;
  ph.style.display = program.plan.length ? 'block' : 'none';
  if (program.playing) {
    const tl = $('timeline');
    const x = 12 + program.t * pps;
    if (x > tl.scrollLeft + tl.clientWidth - 40 || x < tl.scrollLeft) tl.scrollLeft = x - 60;
  }
}

$('prgPlay').onclick = () => (program.playing ? program.pause() : program.play());
$('programSeek').oninput = (e) => program.seek(Number(e.target.value), { keepPlaying: program.playing });
$('prgPrev').onclick = () => {
  const p = program.plan;
  if (!p.length) return;
  const cur = p[program.index] || p[0];
  const target = program.t - cur.offset > 0.5 ? cur.offset : (p[program.index - 1] || cur).offset;
  program.seek(target, { keepPlaying: program.playing });
};
$('prgNext').onclick = () => {
  const n = program.plan[program.index + 1];
  if (n) program.seek(n.offset, { keepPlaying: program.playing });
};
$('showCaptions').onchange = renderProgramUi;

// ----------------------------------------------------------------- timeline

let dragId = null;

function renderTimeline() {
  const track = $('track');
  track.replaceChildren();
  const pps = Number($('zoom').value);
  const p = plan();
  const total = planDuration(p);
  $('seqInfo').textContent = p.length ? `${p.length} clips · ${formatClock(total)}` : 'empty';
  p.forEach((entry, i) => {
    const clip = project().sequence[i];
    const src = sourceById(clip.sourceId);
    const node = el(
      'div',
      { className: `clip${clip.id === state.selectedClipId ? ' selected' : ''}`, draggable: true, style: `--c:${sourceColor(clip.sourceId)};width:${Math.max(28, entry.duration * pps - 2)}px`, title: `${src ? src.name : '?'}\n${formatClock(clip.in)} – ${formatClock(clip.out)}` },
      el('div', { className: 'cl-name', textContent: src ? src.name : 'missing source' }),
      el('div', { className: 'cl-meta', textContent: `${formatClock(clip.in, 1)}–${formatClock(clip.out, 1)}` }),
      el('div', { className: 'cl-num', textContent: `#${i + 1} · ${formatClock(entry.duration, 1)}` }),
    );
    node.dataset.id = clip.id;
    node.onclick = (e) => {
      selectClip(clip.id);
      const rect = node.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      program.seek(entry.offset + frac * entry.duration, { keepPlaying: program.playing });
    };
    node.ondblclick = () => openClipInSource(clip);
    node.ondragstart = (e) => {
      dragId = clip.id;
      node.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', clip.id);
    };
    node.ondragend = () => {
      dragId = null;
      document.querySelectorAll('.clip').forEach((n) => n.classList.remove('dragging', 'drop-before', 'drop-after'));
    };
    node.ondragover = (e) => {
      if (!dragId || dragId === clip.id) return;
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      node.classList.toggle('drop-after', after);
      node.classList.toggle('drop-before', !after);
    };
    node.ondragleave = () => node.classList.remove('drop-before', 'drop-after');
    node.ondrop = (e) => {
      e.preventDefault();
      const after = node.classList.contains('drop-after');
      moveClipTo(dragId, clip.id, after);
    };
    track.append(node);
  });
  track.style.width = `${Math.max(total * pps + 40, 0)}px`;
  renderInspector();
}

function moveClipTo(id, targetId, after) {
  const seq = project().sequence;
  const from = seq.findIndex((c) => c.id === id);
  if (from < 0) return;
  checkpoint();
  const [clip] = seq.splice(from, 1);
  let to = seq.findIndex((c) => c.id === targetId);
  if (after) to += 1;
  seq.splice(to, 0, clip);
  changed();
}

function moveClip(delta) {
  const seq = project().sequence;
  const i = seq.findIndex((c) => c.id === state.selectedClipId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= seq.length) return;
  checkpoint();
  [seq[i], seq[j]] = [seq[j], seq[i]];
  changed();
}

function selectClip(id) {
  state.selectedClipId = id;
  document.querySelectorAll('#track .clip').forEach((n) => n.classList.toggle('selected', n.dataset.id === id));
  renderInspector();
}

function openClipInSource(clip) {
  state.marks[clip.sourceId] = { in: clip.in, out: clip.out };
  loadSource(clip.sourceId, clip.in);
}

function removeClip() {
  const seq = project().sequence;
  const i = seq.findIndex((c) => c.id === state.selectedClipId);
  if (i < 0) return;
  checkpoint();
  seq.splice(i, 1);
  state.selectedClipId = seq[Math.min(i, seq.length - 1)] ? seq[Math.min(i, seq.length - 1)].id : null;
  changed();
}

function splitClip() {
  const seq = project().sequence;
  const i = seq.findIndex((c) => c.id === state.selectedClipId);
  const p = program.plan[i];
  if (i < 0 || !p) return;
  const at = p.in + (program.t - p.offset);
  if (program.index !== i || at - p.in < MIN_CLIP || seq[i].out - at < MIN_CLIP) {
    return toast('Move the preview playhead inside the selected clip first.', true);
  }
  checkpoint();
  const clip = seq[i];
  const second = { id: uid('c'), sourceId: clip.sourceId, in: round3(at), out: clip.out };
  clip.out = round3(at);
  seq.splice(i + 1, 0, second);
  changed();
}

function setClipEdge(clip, edge, value) {
  const src = sourceById(clip.sourceId);
  const max = src ? src.duration : Infinity;
  let v = Math.max(0, Math.min(max, value));
  if (edge === 'in') v = Math.min(v, clip.out - MIN_CLIP);
  else v = Math.max(v, clip.in + MIN_CLIP);
  checkpoint();
  clip[edge] = round3(v);
  changed();
}

function renderInspector() {
  const box = $('inspector');
  box.replaceChildren();
  const seq = project().sequence;
  const i = seq.findIndex((c) => c.id === state.selectedClipId);
  if (i < 0) {
    box.append(el('span', { className: 'hint', textContent: seq.length ? 'Select a clip to trim, move, split, or remove it. Drag clips to change the order.' : 'Mark In and Out in the source view, or select transcript lines, then add the range to the sequence.' }));
    return;
  }
  const clip = seq[i];
  const src = sourceById(clip.sourceId);
  const fd = 1 / ((src && src.fps) || 30);
  const edgeField = (edge) => {
    const input = el('input', { value: formatClock(clip[edge], 3), title: 'Source time (m:ss.sss)' });
    input.onchange = () => {
      const v = parseClock(input.value);
      if (v == null) return toast('Use a time like 1:02.500', true);
      setClipEdge(clip, edge, v);
    };
    const sameSource = state.selectedSourceId === clip.sourceId;
    return el(
      'span',
      { className: 'field' },
      el('span', { className: 'label', textContent: edge === 'in' ? 'In' : 'Out' }),
      el('button', { className: 'small', textContent: '−1f', title: 'One frame earlier', onclick: () => setClipEdge(clip, edge, clip[edge] - fd) }),
      input,
      el('button', { className: 'small', textContent: '+1f', title: 'One frame later', onclick: () => setClipEdge(clip, edge, clip[edge] + fd) }),
      el('button', { className: 'small', textContent: 'From source', disabled: !sameSource, title: sameSource ? 'Use the source view position' : 'Open this clip in the source view first (double-click the clip)', onclick: () => setClipEdge(clip, edge, sv.currentTime) }),
    );
  };
  box.append(
    el('span', { className: 'label', textContent: `#${i + 1} ${src ? src.name : ''}` }),
    edgeField('in'),
    edgeField('out'),
    el('span', { className: 'label', textContent: `Length ${formatClock(clip.out - clip.in)}` }),
    el('button', { className: 'small', textContent: '← Move', disabled: i === 0, onclick: () => moveClip(-1) }),
    el('button', { className: 'small', textContent: 'Move →', disabled: i === seq.length - 1, onclick: () => moveClip(1) }),
    el('button', { className: 'small', textContent: 'Split at playhead', onclick: splitClip }),
    el('button', { className: 'small', textContent: 'Open in source', onclick: () => openClipInSource(clip) }),
    el('button', { className: 'small danger', textContent: 'Remove', onclick: removeClip }),
  );
}

$('zoom').oninput = () => {
  renderTimeline();
  renderProgramUi();
};

// ----------------------------------------------------------- project files

function renderTitle() {
  $('projectName').value = project().name;
  $('dirty').classList.toggle('on', state.dirty);
  document.title = `${state.dirty ? '• ' : ''}${project().name} – Vida`;
  $('btnUndo').disabled = !state.history.canUndo;
  $('btnRedo').disabled = !state.history.canRedo;
  const o = output();
  $('outputInfo').textContent = project().sequence.length ? `Output ${o.width}×${o.height} · ${o.fps} fps` : '';
}

$('projectName').onchange = (e) => {
  checkpoint();
  project().name = e.target.value.trim() || 'Untitled';
  changed({ timeline: false });
};

function confirmDiscard() {
  return !state.dirty || confirm('Discard unsaved changes?');
}

function newProjectAction() {
  if (!confirmDiscard()) return;
  program.pause();
  state.project = newProject();
  state.doc++;
  Object.assign(state, { file: null, revision: null, dirty: false, selectedSourceId: null, selectedClipId: null, marks: {} });
  state.history.clear();
  hideDiskBanner();
  loadSource(null);
  renderAll();
  program.reload();
}

async function openProjectAction() {
  if (!confirmDiscard()) return;
  const paths = await fileDialog.open({ title: 'Open project', kind: 'project', mode: 'open', hint: 'Project files end with .vida.json' });
  if (!paths || !paths[0]) return;
  await openProjectFile(paths[0]);
}

async function openProjectFile(file) {
  try {
    const { project: p, file: resolved, revision } = await api('/api/project/open', { file });
    program.pause();
    state.project = { name: p.name, output: p.output || {}, sources: p.sources, sequence: p.sequence };
    state.doc++;
    Object.assign(state, { file: resolved, revision, dirty: false, selectedClipId: null, marks: {} });
    state.history.clear();
    hideDiskBanner();
    localStorage.setItem('vida.lastProject', resolved);
    const missing = p.sources.filter((s) => s.missing).length;
    for (const s of p.sources) if (s.needsProxy && !s.proxyPath && !s.missing) makeProxy(s);
    loadSource(p.sources[0] ? p.sources[0].id : null);
    renderAll();
    program.t = 0;
    program.reload();
    toast(missing ? `Opened. ${missing} source file(s) are missing.` : 'Project opened', missing > 0);
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

async function saveProjectAction(saveAs = false, { overwrite = false, file: target } = {}) {
  let file = target || state.file;
  if (!file || saveAs) {
    const firstDir = project().sources[0] ? project().sources[0].path.replace(/[\\/][^\\/]*$/, '') : undefined;
    file = await fileDialog.open({ title: 'Save project', kind: 'project', mode: 'save', defaultName: `${project().name}.vida.json`, dir: state.file ? state.file.replace(/[\\/][^\\/]*$/, '') : firstDir, hint: 'The project file keeps your cuts and transcripts. It does not copy the videos.' });
    if (!file) return false;
    if (!file.endsWith('.vida.json')) file = file.replace(/\.json$/, '') + '.vida.json';
  }
  // The save is for this project and this version. The person can keep
  // editing, or open another project, before the server answers.
  const { doc, file: startFile, revision: startRevision } = state;
  const sent = JSON.stringify(project());
  saving++;
  try {
    // The server refuses to replace a file that changed on disk since Vida read it.
    const baseRevision = file === startFile ? startRevision : null;
    const res = await api('/api/project/save', { file, project: project(), baseRevision, overwrite });
    if (state.doc !== doc) {
      toast(`Saved ${res.file}. That project is not open now.`);
      return true;
    }
    state.history.saved(startRevision, res.revision, { otherFile: res.file !== startFile });
    // An Undo during the save can go to a version with another revision. Keep that revision.
    if (state.revision === startRevision) state.revision = res.revision;
    state.file = res.file;
    // Edits made during the save are not in the file yet.
    state.dirty = JSON.stringify(project()) !== sent;
    hideDiskBanner();
    localStorage.setItem('vida.lastProject', res.file);
    renderTitle();
    toast(`Saved ${res.file}`);
    return true;
  } catch (err) {
    if (err.code === 'conflict' && state.doc === doc) showDiskBanner(err.message, { file, conflict: true });
    else toast(err.message, true);
    return false;
  } finally {
    saving--;
  }
}

// ------------------------------------------------- project changes on disk
// An agent or another program can change the project file while it is open.
// Vida checks the file on disk and never replaces or discards a version
// without an explicit action by the user.

let bannerFile = null;
let dismissedRevision;
let saving = 0; // the disk changes during a save are Vida's own

function showDiskBanner(message, { file = state.file, conflict = false, deleted = false } = {}) {
  bannerFile = file;
  $('diskMsg').textContent = message;
  $('diskReload').hidden = deleted || file !== state.file;
  $('diskReload').textContent = state.dirty ? 'Reload from disk (Undo keeps your edits)' : 'Reload from disk';
  $('diskOverwrite').hidden = !conflict;
  $('diskBanner').hidden = false;
}

function hideDiskBanner() {
  $('diskBanner').hidden = true;
  bannerFile = null;
}

async function checkDisk() {
  if (!state.file || document.hidden || saving) return;
  const { file, revision } = state;
  let disk;
  try {
    disk = (await api(`/api/project/revision?file=${encodeURIComponent(file)}`)).revision;
  } catch {
    return;
  }
  // Ignore the answer if Vida opened or saved a file while the request ran.
  if (state.file !== file || state.revision !== revision) return;
  if (disk === revision || disk === dismissedRevision || !$('diskBanner').hidden) return;
  showDiskBanner(
    disk === null
      ? 'The project file was moved or deleted on disk. Save as… writes your version to a file.'
      : `The project file changed on disk${state.dirty ? ', and you have unsaved changes' : ''}. Reload it to see the new version.`,
    { deleted: disk === null },
  );
  dismissedRevision = disk;
}

$('diskReload').onclick = async () => {
  const before = snapshot();
  const hadEdits = state.dirty;
  if (await openProjectFile(state.file)) {
    // Undo returns to the version that was in Vida before the reload, with its
    // old revision. A normal Save of it is rejected as stale.
    state.history.record(before);
    renderTitle();
    toast(hadEdits ? 'Reloaded from disk. Undo (Ctrl+Z) brings back your unsaved version. To keep it, use Save as… or Replace.' : 'Reloaded from disk.');
  }
};
$('diskSaveAs').onclick = () => saveProjectAction(true);
$('diskOverwrite').onclick = () => saveProjectAction(false, { overwrite: true, file: bannerFile });
$('diskDismiss').onclick = hideDiskBanner;
setInterval(checkDisk, 2000);
window.addEventListener('focus', checkDisk);

$('btnNew').onclick = newProjectAction;
$('btnOpen').onclick = openProjectAction;
$('btnSave').onclick = () => saveProjectAction(false);
$('btnSaveAs').onclick = () => saveProjectAction(true);
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
$('btnAddSources').onclick = addSources;
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ------------------------------------------------------------------- export

function defaultExportPath() {
  const base = state.file ? state.file.replace(/\.vida\.json$/, '') : project().sources[0] ? project().sources[0].path.replace(/[\\/][^\\/]*$/, '') + '/' + project().name : project().name;
  const dir = base.replace(/[\\/][^\\/]*$/, '');
  const name = base.split(/[\\/]/).pop();
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${dir}${sep}exports${sep}${name}.mp4`;
}

function exportProjectData() {
  const size = $('expSize').value;
  const fps = $('expFps').value;
  const [w, h] = size === 'auto' ? [null, null] : size.split('x').map(Number);
  return { ...project(), output: { width: w, height: h, fps: fps === 'auto' ? null : Number(fps) } };
}

function updateExportSummary() {
  const data = exportProjectData();
  const o = resolveOutput(data);
  const p = buildPlan(data.sequence, o.fps);
  const cues = remapCaptions(p, transcripts());
  $('expSummary').textContent = `${p.length} clips · ${formatClock(planDuration(p))} · ${o.width}×${o.height} at ${o.fps} fps · ${cues.length} caption cues`;
}

function openExport() {
  if (!project().sequence.length) return toast('The sequence is empty.', true);
  const o = project().output || {};
  $('expSize').value = o.width && o.height ? `${o.width}x${o.height}` : 'auto';
  if (!$('expSize').value) $('expSize').value = 'auto';
  $('expFps').value = o.fps ? String(o.fps) : 'auto';
  if (!$('expFps').value) $('expFps').value = 'auto';
  if (!$('expFile').value || !$('exportDialog').dataset.touched) $('expFile').value = defaultExportPath();
  $('expResult').textContent = '';
  $('expResult').className = 'result';
  $('expProgress').hidden = true;
  updateExportSummary();
  $('exportDialog').showModal();
}

function storeOutputSettings() {
  const out = exportProjectData().output;
  const prev = project().output || {};
  if (out.width !== (prev.width ?? null) || out.height !== (prev.height ?? null) || out.fps !== (prev.fps ?? null)) {
    checkpoint();
    project().output = out;
    changed();
  }
}

$('expSize').onchange = () => (storeOutputSettings(), updateExportSummary());
$('expFps').onchange = () => (storeOutputSettings(), updateExportSummary());
$('expFile').oninput = () => ($('exportDialog').dataset.touched = '1');
$('expBrowse').onclick = async () => {
  const cur = $('expFile').value;
  const file = await fileDialog.open({ title: 'Export to', kind: 'video', mode: 'save', defaultName: cur.split(/[\\/]/).pop() || 'export.mp4', dir: cur.replace(/[\\/][^\\/]*$/, '') });
  if (file) {
    $('expFile').value = /\.mp4$/i.test(file) ? file : `${file}.mp4`;
    $('exportDialog').dataset.touched = '1';
  }
  if (!$('exportDialog').open) $('exportDialog').showModal();
};
$('expClose').onclick = () => $('exportDialog').close();
$('expCaptions').onclick = async () => {
  try {
    const res = await api('/api/captions', { project: exportProjectData(), file: $('expFile').value });
    $('expResult').className = 'result';
    $('expResult').textContent = `Wrote ${res.cues} cues:\n${res.srt}\n${res.vtt}`;
  } catch (err) {
    $('expResult').className = 'result error';
    $('expResult').textContent = err.message;
  }
};
$('expStart').onclick = async () => {
  const file = $('expFile').value.trim();
  if (!/\.mp4$/i.test(file)) return toast('The file name must end with .mp4', true);
  try {
    const job = await api('/api/export', { project: exportProjectData(), file });
    $('expStart').disabled = true;
    $('expProgress').hidden = false;
    $('expResult').className = 'result';
    $('expResult').textContent = 'Rendering…';
    const bar = $('expProgress').firstElementChild;
    watchJob(job, (j) => {
      $('expStart').disabled = false;
      clearInterval(poll);
      bar.style.width = j.status === 'done' ? '100%' : bar.style.width;
      if (j.status === 'done') {
        const r = j.result;
        $('expResult').textContent = `Done: ${formatClock(r.duration)} at ${r.settings.width}×${r.settings.height}, ${r.settings.fps} fps, ${r.cues} caption cues.\n${r.video}\n${r.srt}\n${r.vtt}`;
      } else {
        $('expResult').className = 'result error';
        $('expResult').textContent = j.status === 'cancelled' ? 'Export stopped.' : j.error;
      }
    });
    const poll = setInterval(() => {
      const j = activeJobs.get(job.id);
      if (j) bar.style.width = `${Math.round(j.progress * 100)}%`;
    }, 300);
  } catch (err) {
    toast(err.message, true);
  }
};
$('btnExport').onclick = openExport;

// ----------------------------------------------------------------- keyboard

document.querySelector('#sourceMonitor').addEventListener('pointerdown', () => (state.focus = 'source'));
document.querySelector('#programMonitor').addEventListener('pointerdown', () => (state.focus = 'program'));
document.querySelector('.timeline-panel').addEventListener('pointerdown', () => (state.focus = 'program'));

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target.isContentEditable || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveProjectAction(e.shiftKey);
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod) return;
  const src = currentSource();
  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (state.focus === 'program') program.playing ? program.pause() : program.play();
      else if (src) sv.paused ? sv.play() : sv.pause();
      break;
    case 'i':
    case 'I':
      if (src) markIn();
      break;
    case 'o':
    case 'O':
      if (src) markOut();
      break;
    case 'a':
    case 'A':
      if (src) addRangeToSequence();
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
      if (src && state.focus === 'source') {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        e.shiftKey ? (sv.currentTime = Math.max(0, sv.currentTime + dir)) : step(dir);
      }
      break;
    case 'Delete':
    case 'Backspace':
      if (state.selectedClipId) {
        e.preventDefault();
        removeClip();
      }
      break;
  }
});

// --------------------------------------------------------------------- boot

function renderAll() {
  renderTitle();
  renderSources();
  renderTranscript();
  renderTimeline();
  renderSourceUi();
  renderProgramUi();
}

window.addEventListener('resize', renderSourceUi);

async function boot() {
  try {
    state.status = await api('/api/status');
    if (!state.status.ffmpeg) toast('FFmpeg was not found. Install FFmpeg, or set FFMPEG_PATH and FFPROBE_PATH.', true);
  } catch (err) {
    toast(`Cannot reach the Vida server: ${err.message}`, true);
  }
  renderAll();
  program.reload();
  const params = new URLSearchParams(location.search);
  const last = params.get('project');
  if (last) openProjectFile(last);
}

window.vida = { state, program }; // for debugging in the browser console
boot();

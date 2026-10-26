// Shared timeline logic. The browser (preview) and the server (export) both use
// this module, so the preview, the exported video, and the captions agree.
//
// All transcript times are source times in seconds. A sequence clip refers to
// a source range [in, out). Export quantizes each clip to whole output frames;
// captions use the same quantized durations, so cue times match the video.

export const MIN_CLIP = 0.1;

/** Output settings: explicit values, or the first clip's source with even sizes. */
export function resolveOutput(project) {
  const o = project.output || {};
  const first = project.sequence[0] && project.sources.find((s) => s.id === project.sequence[0].sourceId);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const width = even(Number(o.width) || (first && first.width) || 1920);
  const height = even(Number(o.height) || (first && first.height) || 1080);
  const fps = snapFps(Number(o.fps) || (first && first.fps) || 30);
  return { width, height, fps };
}

const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

/** Variable frame rate files report averages such as 59.87. Use the nearest standard rate. */
export function snapFps(fps) {
  const near = STANDARD_FPS.reduce((best, r) => (Math.abs(r - fps) < Math.abs(best - fps) ? r : best));
  return Math.abs(near - fps) / near < 0.01 ? near : Math.round(fps * 1000) / 1000;
}

/** Number of output frames for a clip. Never less than one frame. */
export function clipFrames(clip, fps) {
  if (!Number.isFinite(clip.in) || !Number.isFinite(clip.out) || clip.out <= clip.in) {
    throw new RangeError(`Clip "${clip.id}" has a bad range (in ${clip.in}, out ${clip.out}). Out must be after In.`);
  }
  return Math.max(1, Math.round((clip.out - clip.in) * fps));
}

// The UI rounds times to milliseconds, so an out point can be up to 0.5 ms past the end.
const END_TOLERANCE = 0.001;

/**
 * Checks a project before Vida saves, opens, or renders it.
 * Returns a list of error messages. An empty list means the project is valid.
 * A source marked `missing` (file not found) may have no duration; its clips
 * are not checked against the media length.
 */
export function validateProject(project) {
  const errors = [];
  if (!project || typeof project !== 'object') return ['The project is not a JSON object.'];
  const { sources, sequence, output } = project;
  if (!Array.isArray(sources)) errors.push('"sources" must be a list.');
  if (!Array.isArray(sequence)) errors.push('"sequence" must be a list.');
  if (errors.length) return errors;
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
  const t = (n) => (isNum(n) ? n.toFixed(3) : JSON.stringify(n));

  const byId = new Map();
  sources.forEach((s, i) => {
    const where = `sources[${i}]`;
    if (!s || typeof s !== 'object') return errors.push(`${where} is not an object.`);
    if (typeof s.id !== 'string' || !s.id) return errors.push(`${where} needs a non-empty string "id".`);
    if (byId.has(s.id)) errors.push(`${where}: the id "${s.id}" is used by more than one source.`);
    byId.set(s.id, s);
    if (typeof s.path !== 'string' || !s.path) errors.push(`${where} ("${s.id}") needs a "path" to the video file.`);
    if (!s.missing && !(isNum(s.duration) && s.duration > 0)) {
      errors.push(`${where} ("${s.id}"): duration ${t(s.duration)} is not a positive number of seconds.`);
    }
    const segments = s.transcript && s.transcript.segments;
    if (s.transcript != null && !Array.isArray(segments)) errors.push(`${where} ("${s.id}"): transcript.segments must be a list.`);
    (Array.isArray(segments) ? segments : []).forEach((g, k) => {
      if (!g || !isNum(g.start) || !isNum(g.end) || g.end < g.start || typeof g.text !== 'string') {
        errors.push(`${where} ("${s.id}"): transcript.segments[${k}] needs numbers start <= end and a string text.`);
      } else if (g.words != null && (!Array.isArray(g.words) || g.words.some((w) => !w || !isNum(w.start) || !isNum(w.end) || w.end < w.start || typeof w.text !== 'string' || (w.off != null && typeof w.off !== 'boolean')))) {
        errors.push(`${where} ("${s.id}"): transcript.segments[${k}].words must be a list of { start, end, text, off? } with numbers start <= end.`);
      }
    });
  });

  const clipIds = new Set();
  sequence.forEach((c, i) => {
    const where = `sequence[${i}]`;
    if (!c || typeof c !== 'object') return errors.push(`${where} is not an object.`);
    const label = `${where} (id ${JSON.stringify(c.id)})`;
    if (typeof c.id !== 'string' || !c.id) errors.push(`${where} needs a non-empty string "id".`);
    else if (clipIds.has(c.id)) errors.push(`${label}: the id is used by more than one clip.`);
    clipIds.add(c.id);
    const src = byId.get(c.sourceId);
    if (!src) {
      errors.push(`${label}: sourceId ${JSON.stringify(c.sourceId)} is not in "sources". Known ids: ${[...byId.keys()].join(', ') || 'none'}.`);
    }
    if (!isNum(c.in) || !isNum(c.out)) return errors.push(`${label}: "in" and "out" must be finite numbers of seconds (got in ${t(c.in)}, out ${t(c.out)}).`);
    if (c.in < 0) errors.push(`${label}: in ${t(c.in)} is before the start of the source (0).`);
    if (c.out <= c.in) errors.push(`${label}: out ${t(c.out)} is not after in ${t(c.in)}. Swap them or fix the range.`);
    else if (c.out - c.in < MIN_CLIP - 1e-9) errors.push(`${label}: the clip is ${t(c.out - c.in)} s long. The minimum is ${MIN_CLIP} s.`);
    if (src && !src.missing && isNum(src.duration) && c.out > src.duration + END_TOLERANCE) {
      errors.push(`${label}: out ${t(c.out)} is past the end of "${src.name || src.id}" (${t(src.duration)} s).`);
    }
  });

  const o = output || {};
  for (const key of ['width', 'height', 'fps']) {
    if (o[key] != null && !(isNum(o[key]) && o[key] > 0)) errors.push(`output.${key} must be a positive number or null (got ${JSON.stringify(o[key])}).`);
  }
  return errors;
}

/** Throws one error that lists every problem in the project. */
export function assertValidProject(project) {
  const errors = validateProject(project);
  if (errors.length) {
    throw Object.assign(new Error(`The project is not valid:\n- ${errors.join('\n- ')}`), { status: 422, errors });
  }
}

/**
 * Builds the export plan. Each entry has the source range, the quantized
 * duration, and the offset of the clip in the final video.
 */
export function buildPlan(sequence, fps) {
  let frameCursor = 0;
  return sequence.map((clip) => {
    const frames = clipFrames(clip, fps);
    const entry = {
      clipId: clip.id,
      sourceId: clip.sourceId,
      in: clip.in,
      out: clip.in + frames / fps, // effective out point after quantization
      frames,
      offset: frameCursor / fps,
      duration: frames / fps,
    };
    frameCursor += frames;
    return entry;
  });
}

export function planDuration(plan) {
  return plan.reduce((sum, p) => sum + p.duration, 0);
}

/** Finds the plan entry at a sequence time. Returns {index, entry, sourceTime}. */
export function locate(plan, t) {
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    if (t < p.offset + p.duration || i === plan.length - 1) {
      const local = Math.min(Math.max(t - p.offset, 0), p.duration);
      return { index: i, entry: p, sourceTime: p.in + local };
    }
  }
  return null;
}

// ---------------------------------------------------------------- captions

const DEFAULT_GROUP = { maxChars: 84, maxDuration: 6, maxGap: 0.7 };

/**
 * Replaces word k of a transcript segment with the words in `text`.
 * One word keeps the time of the old word. Several words share its time
 * evenly. Empty text removes the word. The segment text follows the words.
 * Returns false if the change would remove the last word.
 */
export function editWord(segment, k, text) {
  const old = segment.words[k];
  const parts = String(text).trim().split(/\s+/).filter(Boolean);
  if (!parts.length && segment.words.length === 1) return false;
  const step = (old.end - old.start) / Math.max(1, parts.length);
  const round = (t) => Math.round(t * 1000) / 1000;
  const words = parts.map((t, i) => ({
    ...(parts.length === 1 ? old : old.off ? { off: true } : {}),
    start: parts.length === 1 ? old.start : round(old.start + i * step),
    end: parts.length === 1 ? old.end : i === parts.length - 1 ? old.end : round(old.start + (i + 1) * step),
    text: t,
  }));
  segment.words.splice(k, 1, ...words);
  segment.text = segment.words.map((w) => w.text).join(' ');
  return true;
}

/** Groups timed words into caption-sized segments. */
export function groupWords(words, opts = {}) {
  const o = { ...DEFAULT_GROUP, ...opts };
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.words.length) {
      cur.text = cur.words.map((w) => w.text).join(' ');
      out.push(cur);
    }
    cur = null;
  };
  for (const w of words) {
    const text = String(w.text).trim();
    if (!text) continue;
    const word = { start: w.start, end: Math.max(w.end, w.start), text };
    if (cur) {
      const len = cur.words.reduce((n, x) => n + x.text.length + 1, 0) + text.length;
      const gap = word.start - cur.end;
      const last = cur.words[cur.words.length - 1].text;
      const sentenceEnd = /[.!?]["')\]]?$/.test(last) && len > 24;
      if (gap > o.maxGap || len > o.maxChars || word.end - cur.start > o.maxDuration || sentenceEnd) flush();
    }
    if (!cur) cur = { start: word.start, end: word.end, words: [] };
    cur.words.push(word);
    cur.end = Math.max(cur.end, word.end);
  }
  flush();
  return out;
}

/**
 * Maps source transcripts into the final sequence.
 * transcripts: { [sourceId]: { segments: [{start, end, text, words?}] } }
 * Words are kept only when their midpoint is inside the clip and they are not
 * turned off (off: true). Segments without
 * word timing are kept when at least 0.25 s of them is inside the clip.
 * A cue never crosses a cut.
 */
export function remapCaptions(plan, transcripts, opts = {}) {
  const cues = [];
  for (const p of plan) {
    const tr = transcripts[p.sourceId];
    if (!tr || !tr.segments) continue;
    const toSeq = (t) => p.offset + Math.min(Math.max(t, p.in), p.out) - p.in;
    const words = [];
    for (const seg of tr.segments) {
      if (seg.end <= p.in || seg.start >= p.out) continue;
      if (seg.words && seg.words.length) {
        for (const w of seg.words) {
          if (w.off) continue; // the person turned this word off in the captions
          const mid = (w.start + w.end) / 2;
          if (mid >= p.in && mid < p.out) words.push({ start: toSeq(w.start), end: toSeq(w.end), text: w.text });
        }
      } else {
        const s = Math.max(seg.start, p.in);
        const e = Math.min(seg.end, p.out);
        if (e - s >= 0.25) cues.push({ start: toSeq(s), end: toSeq(e), text: seg.text.trim() });
      }
    }
    for (const g of groupWords(words, opts)) cues.push({ start: g.start, end: g.end, text: g.text });
  }
  cues.sort((a, b) => a.start - b.start);
  // Remove overlaps and empty cues.
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
  }
  return cues.filter((c) => c.text && c.end - c.start >= 0.05);
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

export function formatTimestamp(t, sep = ',') {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSRT(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}\n`)
    .join('\n');
}

export function toVTT(cues) {
  const body = cues
    .map((c) => `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${c.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

function parseTime(str) {
  const m = str.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  const [, h = '0', mi, s, frac] = m;
  return Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(frac.padEnd(3, '0')) / 1000;
}

/** Parses SRT or WebVTT text into segments [{start, end, text}]. */
export function parseSubtitles(text) {
  const blocks = String(text).replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split('-->');
    const start = parseTime(a);
    const end = parseTime(b.trim().split(/\s+/)[0]);
    if (start == null || end == null) continue;
    const body = lines
      .slice(idx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (body) segments.push({ start, end, text: body });
  }
  return segments;
}

/** Formats seconds for the UI, for example 1:02.35 or 1:02:03.40. */
export function formatClock(t, decimals = 2) {
  if (!Number.isFinite(t)) return '--:--';
  const neg = t < 0;
  t = Math.abs(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return `${neg ? '-' : ''}${h ? `${h}:${pad(m)}` : m}:${s}`;
}

/** Parses "1:02.5", "62.5", or "1:01:02" into seconds. Returns null if invalid. */
export function parseClock(str) {
  const parts = String(str).trim().split(':');
  if (parts.length > 3 || parts.some((p) => p === '' || isNaN(Number(p)))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Transcript rows for the UI: speech segments plus visible gaps without speech. */
export function transcriptRows(segments, duration, minGap = 2) {
  const rows = [];
  let cursor = 0;
  for (const seg of segments) {
    if (seg.start - cursor >= minGap) rows.push({ gap: true, start: cursor, end: seg.start });
    rows.push({ gap: false, start: seg.start, end: seg.end, text: seg.text, segment: seg });
    cursor = Math.max(cursor, seg.end);
  }
  if (Number.isFinite(duration) && duration - cursor >= minGap) rows.push({ gap: true, start: cursor, end: duration });
  return rows;
}

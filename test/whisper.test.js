// Optional check with a real whisper.cpp install (set WHISPER_CPP_BIN,
// WHISPER_CPP_MODEL, and WHISPER_CPP_VAD_MODEL). It transcribes the fixture
// sources, remaps the transcripts through cuts and reorder, renders the
// sequence, transcribes the rendered video again, and compares the two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../server/config.js';
import { probe } from '../server/media.js';
import { transcribe } from '../server/transcribe.js';
import { exportProject } from '../server/export.js';
import { parseSubtitles } from '../public/lib/timeline.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = process.env.FIXTURES || path.join(APP, 'fixtures');
const job = { progress() {}, onCancel() {}, cancelled: false };
const ready = config.whisperBin && config.whisperModel && fs.existsSync(path.join(FIX, 'truth.json'));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

test('whisper.cpp transcripts survive cuts and reorder', { skip: !ready && 'whisper.cpp or fixtures not available', timeout: 900000 }, async (t) => {
  const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'truth.json'), 'utf8'));
  const sources = [];
  for (const [id, s] of Object.entries(truth.sources)) {
    const file = path.join(FIX, s.file);
    const info = await probe(file);
    const src = { id, path: file, name: s.file, ...info, transcript: null };
    if (info.hasAudio) src.transcript = await transcribe('whisper', src, job);
    sources.push(src);
  }

  await t.test('source transcript lines start near the known phrase times', () => {
    for (const s of sources.filter((x) => x.transcript)) {
      for (const ph of truth.sources[s.id].phrases) {
        const line = s.transcript.segments.find((g) => Math.abs(g.start - ph.start) < 0.8);
        assert.ok(line, `${s.id}: no line near ${ph.start} (${ph.text}); got ${s.transcript.segments.map((g) => g.start).join(', ')}`);
      }
    }
  });

  const sequence = [
    { id: 'c1', sourceId: 'B', in: 4.5, out: 8.5 },
    { id: 'c2', sourceId: 'A', in: 10.0, out: 23.0 },
    { id: 'c3', sourceId: 'C', in: 2.0, out: 4.0 },
    { id: 'c4', sourceId: 'A', in: 0.5, out: 4.5 },
    { id: 'c5', sourceId: 'B', in: 0.5, out: 4.2 },
  ];
  const project = { name: 'w', output: {}, sources, sequence };
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vida-w-')), 'w.mp4');
  const result = await exportProject(project, out, job);
  const cues = parseSubtitles(fs.readFileSync(result.srt, 'utf8'));
  const info = await probe(out);
  const again = await transcribe('whisper', { path: out, ...info }, job);

  await t.test('each remapped caption matches speech found in the rendered video', () => {
    const rows = [];
    for (const c of cues) {
      const words = norm(c.text);
      const match = again.segments.find((g) => {
        const gw = new Set(norm(g.text));
        const shared = words.filter((w) => gw.has(w)).length;
        return shared / words.length >= 0.5 && Math.abs(g.start - c.start) < 0.8;
      });
      rows.push(`${c.start.toFixed(2)} "${c.text}" -> ${match ? `${match.start.toFixed(2)} "${match.text}"` : 'NO MATCH'}`);
      assert.ok(match, `caption at ${c.start} "${c.text}" not found in rendered speech: ${JSON.stringify(again.segments.map((g) => [g.start, g.text]))}`);
    }
    t.diagnostic(rows.join(' | '));
  });
});

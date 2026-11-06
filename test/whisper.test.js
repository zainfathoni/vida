// Optional check with a real whisper.cpp install (set WHISPER_CPP_BIN and
// WHISPER_CPP_MODEL). It transcribes the fixture
// sources, remaps the transcripts through cuts and reorder, renders the
// sequence, transcribes the rendered video again, and compares the two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../server/config.js';
import { probe } from '../server/media.js';
import { transcribe } from '../server/transcribe.js';
import { exportProject } from '../server/export.js';
import { buildPlan, remapCaptions, parseSubtitles } from '../public/lib/timeline.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = process.env.FIXTURES || path.join(APP, 'fixtures');
const job = { progress() {}, onCancel() {}, cancelled: false };
const ready = config.whisperBin && config.whisperModel && fs.existsSync(path.join(FIX, 'truth.json'));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

test('local provider keeps lexical brackets and aligned subwords', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vida-whisper-response-'));
  const previous = { whisperBin: config.whisperBin, whisperModel: config.whisperModel };
  t.after(() => {
    Object.assign(config, previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const audio = path.join(root, 'silence.wav');
  execFileSync(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '8', audio]);
  const response = path.join(root, 'response.json');
  config.whisperBin = path.join(root, 'provider');
  config.whisperModel = path.join(root, 'model.bin');
  fs.writeFileSync(config.whisperBin, `#!${process.execPath}
const fs = require('node:fs');
fs.copyFileSync(${JSON.stringify(response)}, process.argv[process.argv.indexOf('-of') + 1] + '.json');
`, { mode: 0o755 });
  const header = Buffer.alloc(48);
  header.writeUInt32LE(0x67676d6c, 0);
  header.writeInt32LE(4, 20);
  header.writeInt32LE(4, 36);
  const token = (text, t_dtw, id = 123) => ({ text, t_dtw, id });
  const run = async (tokens, { duration = 8, segmentEnd = 8000 } = {}) => {
    fs.writeFileSync(response, JSON.stringify({ transcription: [{ offsets: { from: 0, to: segmentEnd }, tokens }] }));
    const result = await transcribe('whisper', { path: audio, duration, hasAudio: true }, job);
    return result.segments.flatMap((s) => s.words);
  };
  for (const vocab of [51864, 51865]) {
    await t.test(`vocabulary ${vocab}: lexical text and control IDs`, async () => {
      header.writeInt32LE(vocab, 4);
      fs.writeFileSync(config.whisperModel, header);
      const eot = vocab === 51864 ? 50256 : 50257;
      const words = await run([
        token('[_BEG_]', -1, eot + 107),
        token(' (Jakarta)', 100), token(' [word]', 200),
        token(' [_EOT_]', 300, eot - 1),
        token('[_TT_20]', -1, eot + 127),
        token('[_NOSP_]', -1, eot + 105),
        token('[_EOT_]', -1, eot),
      ]);
      assert.deepEqual(words.map((w) => w.text), ['(Jakarta)', '[word]', '[_EOT_]']);
      assert.deepEqual(words.map((w) => w.start), [1, 2, 3]);
      const split = await run([
        token(' (', -1), token('Jak', 100), token('arta', 120), token(')', -1),
        token(' [', -1), token('word', 200), token(']', -1),
      ]);
      assert.deepEqual(split.map((w) => w.text), ['(Jakarta)', '[word]']);
      assert.deepEqual(split.map((w) => w.start), [1, 2]);
      for (const text of [' (Jakarta)', ' [word]']) {
        await assert.rejects(run([token(text, -1)]), /no DTW word alignment/);
      }
      await assert.rejects(run([{ text: ' [word]', t_dtw: 100 }]), /no valid token ID/);
    });
  }
  await t.test('aligned subwords override soft limits, not next word or source end', async () => {
    const parts = [token(' inter', 100), token('continental', 350)];
    const words = await run([...parts, token(' next', 500)], { segmentEnd: 2000 });
    assert.deepEqual(words[0], { text: 'intercontinental', start: 1, end: 3.5 });
    const next = await run([...parts, token(' next', 320)], { segmentEnd: 2000 });
    assert.equal(next[0].end, 3.2);
    const source = await run(parts, { segmentEnd: 2000, duration: 3.3 });
    assert.equal(source[0].end, 3.3);
  });
});

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

  await t.test('words stay with their spoken phrase across pauses and cuts', () => {
    const camera = sources.find((s) => s.id === 'B');
    const words = camera.transcript.segments.flatMap((s) => s.words);
    for (const [spellings, phrase] of [
      [['thank'], truth.sources.B.phrases[2]],
      [['two', '2'], truth.sources.B.phrases[0]],
    ]) {
      const word = words.find((w) => spellings.includes(norm(w.text).join('')));
      assert.ok(word, `missing ${spellings.join('/')} in the source transcript`);
      assert.ok(word.start >= phrase.start - 0.25 && word.end <= phrase.end + 0.25,
        `${word.text} at ${word.start}–${word.end} is outside its spoken phrase ${phrase.start}–${phrase.end}`);
    }
    const cut = buildPlan([{ id: 'only-fox', sourceId: 'B', in: 4.5, out: 8.5 }], 30);
    const kept = norm(remapCaptions(cut, { B: camera.transcript }).map((c) => c.text).join(' '));
    assert.deepEqual(kept, norm(truth.sources.B.phrases[1].text));
    const phrase = truth.sources.B.phrases[2];
    const ending = buildPlan([{ id: 'ending', sourceId: 'B', in: phrase.start, out: phrase.end }], 30);
    assert.deepEqual(norm(remapCaptions(ending, { B: camera.transcript }).map((c) => c.text).join(' ')), norm(phrase.text));
  });

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

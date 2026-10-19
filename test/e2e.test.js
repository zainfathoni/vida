// End-to-end check with generated fixtures (no real recordings).
// It exports a sequence with cuts from three sources in a new order, then
// measures the result: frame-exact joins, A/V sync, silence for a source
// without audio, caption timing, project persistence, and unchanged originals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probe } from '../server/media.js';
import { exportProject } from '../server/export.js';
import { saveProject, openProject } from '../server/project.js';
import { buildPlan, parseSubtitles } from '../public/lib/timeline.js';
import { frameStats, flashOnsets, audioSamples, beepOnsets, rms, probeDurations } from './analyze.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = process.env.FIXTURES || path.join(APP, 'fixtures');
if (!fs.existsSync(path.join(FIX, 'truth.json'))) execFileSync('node', [path.join(APP, 'scripts/make-fixtures.js'), FIX], { stdio: 'inherit' });
const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'truth.json'), 'utf8'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'vida-e2e-'));
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const job = { progress() {}, onCancel() {}, cancelled: false };

// Cuts from three sources, in a different order than the sources.
// A is used twice; the later part of A comes before the earlier part.
const CUTS = [
  { sourceId: 'B', in: 4.0, out: 8.0 },
  { sourceId: 'A', in: 9.9, out: 18.0 }, // includes a silent demo part (no speech after 12 s)
  { sourceId: 'C', in: 3.0, out: 6.0 }, // source without audio
  { sourceId: 'A', in: 0.5, out: 4.2 },
  { sourceId: 'B', in: 10.0, out: 14.3 },
  { sourceId: 'A', in: 7.0, out: 8.6 }, // starts inside a spoken phrase
];

async function makeProject() {
  const sources = [];
  for (const [id, s] of Object.entries(truth.sources)) {
    const file = path.join(FIX, s.file);
    const info = await probe(file);
    const srt = path.join(FIX, s.file.replace(/\.mp4$/, '.truth.srt'));
    const transcript = fs.existsSync(srt) ? { provider: 'imported', segments: parseSubtitles(fs.readFileSync(srt, 'utf8')) } : null;
    sources.push({ id, path: file, name: s.file, ...info, transcript });
  }
  return { name: 'e2e', output: {}, sources, sequence: CUTS.map((c, i) => ({ id: `c${i}`, ...c })) };
}

test('export, captions, and persistence with generated fixtures', { timeout: 600000 }, async (t) => {
  const project = await makeProject();
  const before = Object.fromEntries(project.sources.map((s) => [s.id, sha(s.path)]));
  const outFile = path.join(WORK, 'out', 'episode.mp4');
  const result = await exportProject(project, outFile, job);
  const fps = result.settings.fps;
  const frameDur = 1 / fps;
  const plan = buildPlan(project.sequence, fps);
  const totalFrames = plan.reduce((n, p) => n + p.frames, 0);

  await t.test('output settings follow the first clip (camera B)', () => {
    assert.deepEqual(result.settings, { width: 1920, height: 1080, fps: 30 });
  });

  await t.test('video frame count and audio length match the plan', () => {
    const streams = probeDurations(outFile);
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    assert.equal(Number(v.nb_read_frames), totalFrames);
    assert.ok(Math.abs(Number(a.duration) - totalFrames / fps) < 0.03, `audio ${a.duration} vs ${totalFrames / fps}`);
  });

  const frames = frameStats(outFile);
  const samples = audioSamples(outFile);

  await t.test('every frame comes from the expected source (frame-exact joins)', () => {
    // Reference colors measured from the fixtures themselves.
    const ref = {};
    for (const s of project.sources) {
      const fr = frameStats(s.path).filter((f) => f.Y < 200);
      ref[s.id] = { U: fr.reduce((a, f) => a + f.U, 0) / fr.length, V: fr.reduce((a, f) => a + f.V, 0) / fr.length };
    }
    const classify = (f) => Object.entries(ref).sort((x, y) => Math.hypot(x[1].U - f.U, x[1].V - f.V) - Math.hypot(y[1].U - f.U, y[1].V - f.V))[0][0];
    const wrong = [];
    let n = 0;
    for (const p of plan) {
      for (let k = 0; k < p.frames; k++, n++) {
        const f = frames[n];
        if (f.Y > 200) continue; // flash frame, no color
        if (classify(f) !== p.sourceId) wrong.push({ frame: n, expected: p.sourceId, got: classify(f) });
      }
    }
    assert.deepEqual(wrong, []);
  });

  // Expected flash times in the output, from the known source times.
  const expectedFlashes = [];
  for (const p of plan) {
    for (const ft of truth.sources[p.sourceId].flashes) {
      if (ft >= p.in && ft + truth.flash <= p.out) expectedFlashes.push({ t: p.offset + ft - p.in, sourceId: p.sourceId, audio: truth.sources[p.sourceId].hasAudio });
    }
  }

  await t.test('flash frames appear at the remapped times (±1 frame)', () => {
    const got = flashOnsets(frames);
    assert.equal(got.length, expectedFlashes.length, `got ${got} expected ${expectedFlashes.map((e) => e.t.toFixed(3))}`);
    got.forEach((g, i) => assert.ok(Math.abs(g - expectedFlashes[i].t) <= frameDur + 0.001, `flash ${i}: ${g} vs ${expectedFlashes[i].t}`));
  });

  await t.test('audio beeps match the flash frames at every cut (A/V sync)', () => {
    const beeps = beepOnsets(samples);
    const withAudio = expectedFlashes.filter((e) => e.audio);
    assert.equal(beeps.length, withAudio.length, `beeps ${beeps.map((b) => b.toFixed(3))}`);
    const flashes = flashOnsets(frames);
    const offsets = [];
    withAudio.forEach((e, i) => {
      const flash = flashes.find((f) => Math.abs(f - e.t) <= frameDur + 0.001);
      const offset = beeps[i] - flash;
      offsets.push(Number((offset * 1000).toFixed(1)));
      assert.ok(Math.abs(offset) <= frameDur + 0.005, `beep ${beeps[i]} vs flash ${flash}`);
      assert.ok(Math.abs(beeps[i] - e.t) <= 0.02, `beep ${beeps[i]} vs expected ${e.t}`);
    });
    t.diagnostic(`beep minus flash offsets (ms): ${offsets.join(', ')}`);
  });

  await t.test('the clip from the source without audio is silent', () => {
    const c = plan.find((p) => p.sourceId === 'C');
    assert.ok(rms(samples, 48000, c.offset + 0.05, c.offset + c.duration - 0.05) < 0.001);
  });

  await t.test('captions follow cuts and new order', () => {
    const cues = parseSubtitles(fs.readFileSync(result.srt, 'utf8'));
    const vtt = parseSubtitles(fs.readFileSync(result.vtt, 'utf8'));
    assert.deepEqual(vtt, cues);
    // Independent expectation: each known phrase, clipped to each cut, moved by the cut offset.
    const expected = [];
    for (const p of plan) {
      for (const ph of truth.sources[p.sourceId].phrases) {
        const s = Math.max(ph.start, p.in);
        const e = Math.min(ph.end, p.out);
        if (e - s >= 0.25) expected.push({ start: p.offset + s - p.in, end: p.offset + e - p.in, text: ph.text });
      }
    }
    assert.equal(cues.length, expected.length);
    cues.forEach((c, i) => {
      assert.equal(c.text, expected[i].text);
      assert.ok(Math.abs(c.start - expected[i].start) < 0.002 && Math.abs(c.end - expected[i].end) < 0.002, `cue ${i} ${c.start}-${c.end} vs ${expected[i].start}-${expected[i].end}`);
    });
    // The audio really has speech under each cue, and the gap before the first speech is quiet.
    for (const c of cues) {
      const mid = (c.start + c.end) / 2;
      assert.ok(rms(samples, 48000, mid - 0.4, mid + 0.4) > 0.02, `no speech under cue "${c.text}" at ${mid}`);
    }
    t.diagnostic(cues.map((c) => `${c.start.toFixed(3)}-${c.end.toFixed(3)} ${c.text}`).join(' | '));
  });

  await t.test('project saves, reopens, and finds moved sources by relative path', () => {
    const moved = path.join(WORK, 'moved');
    fs.mkdirSync(path.join(moved, 'media'), { recursive: true });
    const projFile = path.join(WORK, 'orig', 'ep.vida.json');
    const copy = { ...project, sources: project.sources.map((s) => ({ ...s, path: path.join(WORK, 'orig', 'media', path.basename(s.path)) })) };
    fs.mkdirSync(path.join(WORK, 'orig', 'media'), { recursive: true });
    for (const s of project.sources) fs.copyFileSync(s.path, path.join(WORK, 'orig', 'media', path.basename(s.path)));
    saveProject(projFile, copy);
    const reopened = openProject(projFile);
    assert.deepEqual(reopened.sequence, project.sequence);
    assert.deepEqual(reopened.sources.map((s) => s.transcript), project.sources.map((s) => s.transcript));
    assert.ok(reopened.sources.every((s) => !s.missing));
    // Move the whole folder: absolute paths break, relative paths still work.
    fs.renameSync(path.join(WORK, 'orig'), path.join(moved, 'orig'));
    const again = openProject(path.join(moved, 'orig', 'ep.vida.json'));
    assert.ok(again.sources.every((s) => !s.missing && s.path.startsWith(moved)));
    assert.deepEqual(again.sequence, project.sequence);
  });

  await t.test('source files are unchanged', () => {
    for (const s of project.sources) assert.equal(sha(s.path), before[s.id]);
  });

  await t.test('export refuses to overwrite a source file', async () => {
    await assert.rejects(exportProject(project, project.sources[0].path, job), /cannot replace a source/);
  });

  t.diagnostic(`output: ${outFile}`);
});

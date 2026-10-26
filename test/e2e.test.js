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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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

  await t.test('project saves, reopens, and finds moved sources by relative path', async () => {
    const moved = path.join(WORK, 'moved');
    fs.mkdirSync(path.join(moved, 'media'), { recursive: true });
    const projFile = path.join(WORK, 'orig', 'ep.vida.json');
    const selects = [{ id: 'k1', name: 'Thanks', sourceId: 'B', in: 10.2, out: 12.8 }];
    const copy = { ...project, selects, sources: project.sources.map((s) => ({ ...s, path: path.join(WORK, 'orig', 'media', path.basename(s.path)) })) };
    fs.mkdirSync(path.join(WORK, 'orig', 'media'), { recursive: true });
    for (const s of project.sources) fs.copyFileSync(s.path, path.join(WORK, 'orig', 'media', path.basename(s.path)));
    await saveProject(projFile, copy);
    const reopened = openProject(projFile);
    assert.deepEqual(reopened.sequence, project.sequence);
    assert.deepEqual(reopened.selects, selects);
    // A select past the real end of camera-B (16 s) is not saved.
    await assert.rejects(saveProject(projFile, { ...copy, selects: [{ ...selects[0], out: 17 }] }, { overwrite: true }), /selects\[0\] \(id "k1"\): out 17\.000 is past the end of "camera-B\.mp4"/);
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

// An agent writes a project file by hand and uses the vida command.
// Sources have only an id and a path relative to the project file; Vida reads
// the media facts. The cuts touch the boundaries and come from three sources.
test('agent workflow: vida validate, captions, and export from a hand-written project', { timeout: 600000 }, async (t) => {
  const dir = path.join(WORK, 'agent');
  fs.mkdirSync(dir, { recursive: true });
  const vida = (...args) => spawnSync('node', [path.join(APP, 'bin/vida.js'), ...args], { encoding: 'utf8' });
  const sources = Object.entries(truth.sources).map(([id, s]) => {
    const srt = path.join(FIX, s.file.replace(/\.mp4$/, '.truth.srt'));
    const transcript = fs.existsSync(srt) ? { provider: 'imported', segments: parseSubtitles(fs.readFileSync(srt, 'utf8')) } : null;
    return { id, path: path.relative(dir, path.join(FIX, s.file)), transcript };
  });
  const before = Object.fromEntries(Object.entries(truth.sources).map(([id, s]) => [id, sha(path.join(FIX, s.file))]));
  const sequence = [
    { id: 'thanks', sourceId: 'B', in: 10.2, out: 16 }, // ends at the last frame of B: 174 frames
    { id: 'blank', sourceId: 'C', in: 0, out: 0.1 }, // starts at 0, minimum length: 3 frames
    { id: 'settings', sourceId: 'A', in: 6, out: 8.9 }, // 87 frames
    { id: 'hello', sourceId: 'B', in: 0.7, out: 4.1 }, // 102 frames
  ];
  const write = (name, data) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ app: 'vida', version: 1, name: 'agent', output: {}, sources, sequence, ...data }, null, 2));
    return file;
  };
  const draft = write('draft.vida.json', {});
  const draftBytes = fs.readFileSync(draft, 'utf8');

  await t.test('validate reads the media and reports the plan', () => {
    const r = vida('validate', draft, '--json');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const info = JSON.parse(r.stdout);
    assert.equal(info.clips, 4);
    assert.ok(Math.abs(info.duration - 366 / 30) < 1e-9, `duration ${info.duration}`);
    assert.deepEqual(info.output, { width: 1920, height: 1080, fps: 30 });
    assert.deepEqual(info.sources.map((s) => s.duration), [24, 16, 10]);
  });

  await t.test('captions follow the cuts', () => {
    const r = vida('captions', draft, '--out', path.join(dir, 'out', 'cut.mp4'));
    assert.equal(r.status, 0, r.stderr);
    const cues = parseSubtitles(fs.readFileSync(path.join(dir, 'out', 'cut.srt'), 'utf8'));
    const phrase = (id, k) => truth.sources[id].phrases[k];
    // Clip offsets in frames: 0, 174, 177, 264. Each phrase is fully inside its clip.
    const expected = [
      { start: 0 + phrase('B', 2).start - 10.2, end: 0 + phrase('B', 2).end - 10.2, text: phrase('B', 2).text },
      { start: 177 / 30 + phrase('A', 1).start - 6, end: 177 / 30 + phrase('A', 1).end - 6, text: phrase('A', 1).text },
      { start: 264 / 30 + phrase('B', 0).start - 0.7, end: 264 / 30 + phrase('B', 0).end - 0.7, text: phrase('B', 0).text },
    ];
    assert.equal(cues.length, expected.length, JSON.stringify(cues));
    cues.forEach((c, i) => {
      assert.equal(c.text, expected[i].text);
      assert.ok(Math.abs(c.start - expected[i].start) < 0.002 && Math.abs(c.end - expected[i].end) < 0.002, `cue ${i}: ${c.start}-${c.end}`);
    });
    assert.ok(fs.existsSync(path.join(dir, 'out', 'cut.vtt')));
  });

  await t.test('export renders the exact frame count and leaves the project and sources unchanged', () => {
    const r = vida('export', draft);
    assert.equal(r.status, 0, r.stderr);
    const out = path.join(dir, 'exports', 'draft.mp4');
    assert.equal(JSON.parse(r.stdout).video, out);
    const v = probeDurations(out).find((s) => s.codec_type === 'video');
    assert.equal(Number(v.nb_read_frames), 366);
    assert.equal(fs.readFileSync(draft, 'utf8'), draftBytes);
    for (const [id, s] of Object.entries(truth.sources)) assert.equal(sha(path.join(FIX, s.file)), before[id]);
  });

  await t.test('bad cuts are rejected before rendering, with the clip named', () => {
    const cases = [
      ['reversed', { sequence: [{ id: 'r', sourceId: 'A', in: 5, out: 4 }] }, /sequence\[0\] \(id "r"\): out 4\.000 is not after in 5\.000/],
      // The file claims a longer duration; Vida checks the real length of the media.
      ['too-long', { sources: sources.map((s) => (s.id === 'B' ? { ...s, duration: 99 } : s)), sequence: [{ id: 'l', sourceId: 'B', in: 10, out: 16.5 }] }, /out 16\.500 is past the end of "camera-B\.mp4" \(16\.000 s\)/],
      ['no-source', { sequence: [{ id: 'n', sourceId: 'D', in: 0, out: 1 }] }, /sourceId "D" is not in "sources"/],
      ['not-number', { sequence: [{ id: 'x', sourceId: 'A', in: '1', out: 2 }] }, /finite numbers/],
    ];
    for (const [name, data, pattern] of cases) {
      const file = write(`${name}.vida.json`, data);
      const out = path.join(dir, 'bad', `${name}.mp4`);
      const v = vida('validate', file);
      assert.equal(v.status, 1, `${name} should fail`);
      assert.match(v.stderr, pattern);
      const e = vida('export', file, '--out', out);
      assert.equal(e.status, 1);
      assert.ok(!fs.existsSync(out) && !fs.existsSync(out.replace(/mp4$/, 'srt')), `${name} wrote output`);
    }
  });
});

test('save does not replace a project file that changed on disk', async () => {
  const dir = path.join(WORK, 'conflict');
  const file = path.join(dir, 'ep.vida.json');
  const project = await makeProject();
  const first = await saveProject(file, project);
  assert.match(first.revision, /^[0-9a-f]{64}$/);
  assert.equal(openProject(file).revision, first.revision);

  // An agent changes the file on disk.
  const agentEdit = JSON.parse(fs.readFileSync(file, 'utf8'));
  agentEdit.sequence = agentEdit.sequence.slice(0, 2);
  fs.writeFileSync(file, JSON.stringify(agentEdit, null, 2));
  const onDisk = fs.readFileSync(file, 'utf8');

  // A stale save, a save without a revision, and an invalid save all fail and keep the agent's edit.
  const stale = { ...project, sequence: project.sequence.slice(1) };
  await assert.rejects(saveProject(file, stale, { baseRevision: first.revision }), (err) => err.status === 409 && /changed on disk/.test(err.message));
  await assert.rejects(saveProject(file, stale), (err) => err.status === 409 && /already exists/.test(err.message));
  const fresh = openProject(file).revision;
  await assert.rejects(saveProject(file, { ...stale, sequence: [{ id: 'r', sourceId: 'A', in: 5, out: 4 }] }, { baseRevision: fresh }), /not after in/);
  assert.equal(fs.readFileSync(file, 'utf8'), onDisk);

  // Saving on top of the new revision works.
  const second = await saveProject(file, stale, { baseRevision: fresh });
  assert.equal(openProject(file).sequence.length, project.sequence.length - 1);

  // A deleted file is not created again by a stale save; overwrite is explicit.
  fs.rmSync(file);
  await assert.rejects(saveProject(file, project, { baseRevision: second.revision }), /moved or deleted/);
  assert.ok(!fs.existsSync(file));
  await saveProject(file, project, { overwrite: true });
  assert.equal(openProject(file).sequence.length, project.sequence.length);
});

// The HTTP routes get media facts from the caller. Vida must use the real files.
test('HTTP save, captions, and export check the real media, not the submitted facts', { timeout: 120000 }, async (t) => {
  const dir = path.join(WORK, 'http');
  fs.mkdirSync(dir, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn('node', [path.join(APP, 'server/index.js')], { env: { ...process.env, PORT: String(port), VIDA_DATA_DIR: path.join(dir, 'data') } });
  t.after(() => server.kill());
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => /running at/.test(d) && resolve());
    server.on('exit', () => reject(new Error('server stopped')));
  });
  const post = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const exportJob = async (body) => {
    let { status, body: job } = await post('/api/export', body);
    while (status === 200 && job.status === 'running') {
      await new Promise((r) => setTimeout(r, 200));
      job = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}`)).json();
    }
    return job;
  };
  const base = await makeProject();
  // camera-B is 16 s long. The clip ends at 20 s.
  const late = (patch) => ({ ...base, sources: base.sources.map((s) => (s.id === 'B' ? { ...s, ...patch } : s)), sequence: [{ id: 'late', sourceId: 'B', in: 10, out: 20 }] });
  for (const [name, project] of [['stale duration', late({ duration: 99 })], ['false missing flag', late({ missing: true })]]) {
    const file = path.join(dir, `${name}.vida.json`);
    const out = path.join(dir, `${name}.mp4`);
    const save = await post('/api/project/save', { file, project });
    assert.equal(save.status, 422, `${name}: save ${JSON.stringify(save.body)}`);
    assert.match(save.body.error, /out 20\.000 is past the end of "camera-B\.mp4" \(16\.000 s\)/);
    const captions = await post('/api/captions', { file: out, project });
    assert.equal(captions.status, 422, name);
    const job = await exportJob({ file: out, project });
    assert.equal(job.status, 'error', name);
    assert.match(job.error, /past the end/);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(name)), [], `${name} wrote files`);
  }

  // A source whose file is really gone: the project can be saved (to relink it later), but not rendered.
  const gone = { ...base, sources: base.sources.map((s) => (s.id === 'C' ? { ...s, path: path.join(dir, 'gone.mp4') } : s)) };
  const goneFile = path.join(dir, 'gone.vida.json');
  assert.equal((await post('/api/project/save', { file: goneFile, project: gone })).status, 200);
  const captions = await post('/api/captions', { file: path.join(dir, 'gone-out.mp4'), project: gone });
  assert.equal(captions.status, 422);
  assert.match(captions.body.error, /source "C" is not found/);
  assert.equal((await exportJob({ file: path.join(dir, 'gone-out.mp4'), project: gone })).status, 'error');
  assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('gone-out')));

  // A stale save over HTTP is rejected and the disk bytes stay the same.
  const { body: opened } = await post('/api/project/open', { file: goneFile });
  fs.writeFileSync(goneFile, fs.readFileSync(goneFile, 'utf8').replace('"name": "e2e"', '"name": "agent edit"'));
  const disk = fs.readFileSync(goneFile);
  const stale = await post('/api/project/save', { file: goneFile, project: gone, baseRevision: opened.revision });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'conflict');
  assert.deepEqual(fs.readFileSync(goneFile), disk);
});

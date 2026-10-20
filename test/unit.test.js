import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlan, locate, remapCaptions, groupWords, toSRT, toVTT, parseSubtitles,
  formatTimestamp, parseClock, transcriptRows, resolveOutput, snapFps, validateProject,
} from '../public/lib/timeline.js';
import { History } from '../public/lib/history.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('plan quantizes clips to whole output frames and stacks offsets', () => {
  const plan = buildPlan(
    [
      { id: 'a', sourceId: 'S', in: 10, out: 11.016 }, // 30.48 frames -> 30
      { id: 'b', sourceId: 'T', in: 2, out: 2.06 }, // 1.8 frames -> 2
      { id: 'c', sourceId: 'S', in: 0, out: 0.01 }, // less than a frame -> 1
    ],
    30,
  );
  assert.deepEqual(plan.map((p) => p.frames), [30, 2, 1]);
  close(plan[0].out, 11);
  close(plan[1].offset, 1);
  close(plan[2].offset, 32 / 30);
  const loc = locate(plan, 1.04);
  assert.equal(loc.index, 1);
  close(loc.sourceTime, 2.04);
});

test('captions with word timing: cut inside a sentence, reorder, same source twice', () => {
  const words = (start, text) => text.split(' ').map((w, i) => ({ start: start + i * 0.5, end: start + i * 0.5 + 0.4, text: w }));
  const transcripts = {
    S: { segments: [{ start: 0, end: 4, text: 'one two three four five six seven eight', words: words(0, 'one two three four five six seven eight') }] },
    T: { segments: [{ start: 1, end: 2.5, text: 'hello there friend', words: words(1, 'hello there friend') }] },
  };
  // T first, then the second half of S, then the first half of S.
  const plan = buildPlan(
    [
      { id: 'x', sourceId: 'T', in: 0, out: 3 },
      { id: 'y', sourceId: 'S', in: 2, out: 4 },
      { id: 'z', sourceId: 'S', in: 0, out: 1.45 },
    ],
    25,
  );
  const cues = remapCaptions(plan, transcripts);
  assert.deepEqual(
    cues.map((c) => c.text),
    ['hello there friend', 'five six seven eight', 'one two three'],
  );
  // "five" starts at source 2.0 -> sequence 3 + 0 = 3.0
  close(cues[1].start, 3);
  close(cues[1].end, 3 + 1.9);
  // "three" (1.0–1.4) ends at 1.4, inside the 1.45 s cut that starts at sequence 5.0
  close(cues[2].start, 5);
  close(cues[2].end, 6.4);
  // No cue crosses a cut.
  for (const c of cues) {
    const p = plan.find((e) => c.start >= e.offset - 1e-9 && c.start < e.offset + e.duration);
    assert.ok(c.end <= p.offset + p.duration + 1e-9);
  }
});

test('a word is kept only when its midpoint is inside the cut', () => {
  const tr = { S: { segments: [{ start: 0, end: 2, text: 'a b', words: [{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }] }] } };
  const cues = remapCaptions(buildPlan([{ id: '1', sourceId: 'S', in: 0.6, out: 2 }], 10), tr);
  assert.deepEqual(cues.map((c) => c.text), ['b']);
});

test('captions without word timing are clipped to the cut; short leftovers are dropped', () => {
  const tr = { S: { segments: [{ start: 1, end: 3, text: 'first line' }, { start: 3.5, end: 6, text: 'second line' }] } };
  const plan = buildPlan(
    [
      { id: '1', sourceId: 'S', in: 2, out: 3.6 }, // 1.0 s of first line, 0.1 s of second (dropped)
      { id: '2', sourceId: 'S', in: 5, out: 8 },
    ],
    30,
  );
  const cues = remapCaptions(plan, tr);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'first line');
  close(cues[0].start, 0);
  close(cues[0].end, 1);
  assert.equal(cues[1].text, 'second line');
  close(cues[1].start, 1.6);
  close(cues[1].end, 2.6);
});

test('word grouping splits at pauses and long lines', () => {
  const ws = [
    { start: 0, end: 0.3, text: 'Hi' },
    { start: 0.35, end: 0.6, text: 'there' },
    { start: 2, end: 2.3, text: 'after' },
    { start: 2.35, end: 2.6, text: 'pause' },
  ];
  assert.deepEqual(groupWords(ws).map((g) => g.text), ['Hi there', 'after pause']);
  const many = Array.from({ length: 40 }, (_, i) => ({ start: i * 0.1, end: i * 0.1 + 0.08, text: 'word' }));
  assert.ok(groupWords(many).every((g) => g.text.length <= 84));
});

test('SRT and VTT formats and parsing', () => {
  const cues = [
    { start: 0, end: 1.5, text: 'Hello' },
    { start: 3661.25, end: 3662.0004, text: 'Later' },
  ];
  const srt = toSRT(cues);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n01:01:01,250 --> 01:01:02,000\nLater\n');
  assert.ok(toVTT(cues).startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello\n'));
  assert.deepEqual(parseSubtitles(srt), [
    { start: 0, end: 1.5, text: 'Hello' },
    { start: 3661.25, end: 3662, text: 'Later' },
  ]);
  const vtt = 'WEBVTT\r\n\r\nNOTE x\r\n\r\nid1\r\n00:05.100 --> 00:06.200 align:start\r\n<v Bob>Two</v>\r\nlines\r\n';
  assert.deepEqual(parseSubtitles(vtt), [{ start: 5.1, end: 6.2, text: 'Two lines' }]);
  assert.equal(formatTimestamp(59.9996), '00:01:00,000');
});

test('clock parsing and transcript rows with gaps', () => {
  assert.equal(parseClock('1:02.5'), 62.5);
  assert.equal(parseClock('1:00:00'), 3600);
  assert.equal(parseClock('x'), null);
  const rows = transcriptRows([{ start: 0.5, end: 2, text: 'a' }, { start: 9, end: 10, text: 'b' }], 15);
  assert.deepEqual(rows.map((r) => (r.gap ? `gap ${r.start}-${r.end}` : r.text)), ['a', 'gap 2-9', 'b', 'gap 10-15']);
});

test('output settings and frame rate snapping', () => {
  const p = { output: {}, sources: [{ id: 'S', width: 1281, height: 721, fps: 59.94 }], sequence: [{ sourceId: 'S' }] };
  assert.deepEqual(resolveOutput(p), { width: 1282, height: 722, fps: 59.94 });
  assert.deepEqual(resolveOutput({ ...p, output: { width: 1920, height: 1080, fps: 30 } }), { width: 1920, height: 1080, fps: 30 });
  assert.equal(snapFps(30), 30);
  assert.equal(snapFps(29.97), 29.97);
  assert.equal(snapFps(24.02), 24);
  assert.equal(snapFps(12.5), 12.5);
});

test('validation accepts boundary cuts from several sources', () => {
  const sources = [
    { id: 'A', path: '/v/a.mp4', name: 'a.mp4', duration: 24 },
    { id: 'B', path: '/v/b.mp4', name: 'b.mp4', duration: 16.4 },
  ];
  const sequence = [
    { id: 'c1', sourceId: 'B', in: 10.2, out: 16.4 }, // out exactly at the end
    { id: 'c2', sourceId: 'A', in: 0, out: 0.1 }, // in at 0, exactly the minimum length
    { id: 'c3', sourceId: 'B', in: 0.7, out: 16.4004 }, // UI millisecond rounding past the end
    { id: 'c4', sourceId: 'A', in: 6, out: 8.9 },
  ];
  assert.deepEqual(validateProject({ sources, sequence, output: { width: null, fps: 30 } }), []);
  // A missing file has no duration to check against.
  assert.deepEqual(validateProject({ sources: [{ id: 'M', path: '/gone.mp4', missing: true }], sequence: [{ id: 'x', sourceId: 'M', in: 1, out: 99 }] }), []);
});

test('validation rejects bad cuts and names the clip', () => {
  const sources = [{ id: 'A', path: '/v/a.mp4', name: 'a.mp4', duration: 24 }];
  const check = (clip) => validateProject({ sources, sequence: [{ id: 'k', sourceId: 'A', in: 1, out: 2, ...clip }] });
  const one = (clip, pattern) => {
    const errors = check(clip);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], pattern);
    assert.match(errors[0], /"k"/);
  };
  one({ in: 5, out: 4 }, /out 4\.000 is not after in 5\.000/);
  one({ in: 5, out: 5 }, /not after in/);
  one({ out: 24.01 }, /past the end of "a\.mp4" \(24\.000 s\)/);
  one({ in: -0.5 }, /before the start/);
  one({ in: 1, out: 1.09 }, /minimum is 0\.1 s/);
  one({ in: NaN }, /finite numbers/);
  one({ out: '2' }, /finite numbers/);
  one({ out: null }, /finite numbers/);
  one({ sourceId: 'Z' }, /sourceId "Z" is not in "sources"\. Known ids: A/);
  const dup = validateProject({ sources: [...sources, { ...sources[0] }], sequence: [{ id: 'k', sourceId: 'A', in: 0, out: 1 }, { id: 'k', sourceId: 'A', in: 1, out: 2 }] });
  assert.equal(dup.length, 2);
  assert.match(validateProject({ sources: [{ id: 'A', path: '/a.mp4' }], sequence: [] })[0], /duration/);
  assert.match(validateProject({ sources: [], sequence: {} })[0], /"sequence" must be a list/);
  // The export plan refuses a reversed cut instead of making it one frame long.
  assert.throws(() => buildPlan([{ id: 'r', sourceId: 'A', in: 5, out: 4 }], 30), /Clip "r" has a bad range/);
});

test('undo across a reload returns the old revision, so a normal save is stale', () => {
  // R1: the file Vida opened. D: the file after an agent changed it. R2, R3: files that Vida wrote.
  const h = new History();
  h.record({ json: 'v0', revision: 'R1' }); // an edit made after opening R1
  h.record({ json: 'v1', revision: 'R1' }); // Reload from disk: the unsaved version v1 is based on R1
  // Vida now shows D. Undo returns v1 with R1, not with D.
  assert.deepEqual(h.undo({ json: 'disk', revision: 'D' }), { json: 'v1', revision: 'R1' });
  // Redo returns the disk version with D.
  assert.deepEqual(h.redo({ json: 'v1', revision: 'R1' }), { json: 'disk', revision: 'D' });
  // Vida saves an edit on top of D (D -> R2). Entries based on D move to R2; entries from before the reload do not.
  h.record({ json: 'disk', revision: 'D' });
  h.saved('D', 'R2');
  assert.deepEqual(h.undo({ json: 'v2', revision: 'R2' }), { json: 'disk', revision: 'R2' });
  assert.deepEqual(h.undo({ json: 'disk', revision: 'R2' }), { json: 'v1', revision: 'R1' });
  // Save as to another file: every entry belongs to the new file.
  h.saved('R1', 'R3', { otherFile: true });
  assert.deepEqual(h.undo({ json: 'v1', revision: 'R3' }), { json: 'v0', revision: 'R3' });
  assert.deepEqual(h.redo({ json: 'v0', revision: 'R3' }), { json: 'v1', revision: 'R3' });
});

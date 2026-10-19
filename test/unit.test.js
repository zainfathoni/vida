import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlan, locate, remapCaptions, groupWords, toSRT, toVTT, parseSubtitles,
  formatTimestamp, parseClock, transcriptRows, resolveOutput, snapFps,
} from '../public/lib/timeline.js';

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

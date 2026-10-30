// Source safety checks use disposable media, not personal recordings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../server/config.js';
import { exportProject, writeCaptions } from '../server/export.js';
import { probe } from '../server/media.js';

const job = { progress() {}, onCancel() {} };

test('exports and captions never replace a source through another path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vida-source-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'fixture.mp4');
  execFileSync(config.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=64x48:r=10:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture,
  ]);
  const original = fs.readFileSync(fixture);
  const projectFor = (file) => ({
    sources: [{ id: 'source', path: file }],
    sequence: [{ id: 'cut', sourceId: 'source', in: 0, out: 0.4 }],
  });

  for (const kind of ['literal', 'source symlink', 'output symlink', 'hard link', 'directory symlink', 'case-only', 'partial', 'partial symlink', 'export .srt', 'export .vtt', 'captions .srt', 'captions .vtt']) {
    await t.test(kind, async (t) => {
      const dir = fs.mkdtempSync(path.join(root, 'case-'));
      let source = path.join(dir, 'source.mp4');
      let output = path.join(dir, 'render.mp4');
      if (kind === 'partial') source = output + '.part.mp4';
      fs.copyFileSync(fixture, source);
      const originalPath = source;
      if (kind === 'literal') output = source;
      if (kind === 'source symlink') {
        source = path.join(dir, 'alias.mp4');
        fs.symlinkSync(originalPath, source);
        output = originalPath;
      }
      if (kind === 'output symlink') fs.symlinkSync(source, output);
      if (kind === 'hard link') fs.linkSync(source, output);
      if (kind === 'directory symlink') {
        fs.symlinkSync(dir, path.join(dir, 'alias'), 'dir');
        output = path.join(dir, 'alias', 'source.mp4');
      }
      if (kind === 'case-only') {
        output = path.join(dir, 'SOURCE.MP4');
        if (!fs.existsSync(output)) return t.skip('The filesystem is case-sensitive.');
        assert.equal(fs.statSync(output).ino, fs.statSync(source).ino);
      }
      if (kind === 'partial symlink') fs.symlinkSync(source, output + '.part.mp4');
      if (kind.startsWith('export ') || kind.startsWith('captions ')) {
        fs.symlinkSync(source, output.replace(/\.mp4$/, kind.split(' ')[1]));
      }

      try {
        const project = projectFor(source);
        await assert.rejects(
          kind.startsWith('captions ')
            ? writeCaptions(project, output.replace(/\.mp4$/, ''))
            : exportProject(project, output, job),
          /The output file cannot replace a source file/,
        );
        if (kind.startsWith('export ')) assert.equal(fs.existsSync(output), false, 'Reject before rendering the video.');
      } finally {
        assert.ok(fs.readFileSync(originalPath).equals(original), 'Source bytes must not change.');
        assert.ok(fs.readFileSync(source).equals(original), 'The source path must still refer to the original bytes.');
      }
    });
  }

  await t.test('new and existing unrelated outputs remain valid', async () => {
    const output = path.join(root, 'new-folder', 'render.mp4');
    const project = projectFor(fixture);
    // An unused missing source is allowed and must not prevent export.
    project.sources.push({ id: 'missing', path: path.join(root, 'missing.mp4') });
    for (let i = 0; i < 2; i++) {
      const result = await exportProject(project, output, job);
      const info = await probe(result.video);
      assert.equal(info.width, 64);
      assert.equal(info.height, 48);
      assert.ok(Math.abs(info.duration - 0.4) < 0.03);
      assert.equal(fs.readFileSync(result.srt, 'utf8'), '');
      assert.match(fs.readFileSync(result.vtt, 'utf8'), /^WEBVTT/);
      assert.ok(fs.readFileSync(fixture).equals(original), 'Source bytes must not change.');
    }
  });
});

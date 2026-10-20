#!/usr/bin/env node
// Vida command line: check and render a .vida.json project without the browser.
// It uses the same project, validation, timeline, and export code as the app.
import path from 'node:path';
import { loadProject } from '../server/project.js';
import { exportProject, writeCaptions, captionFiles } from '../server/export.js';
import { buildPlan, planDuration, resolveOutput } from '../public/lib/timeline.js';

const USAGE = `Usage:
  vida validate <project.vida.json> [--json]
  vida captions <project.vida.json> [--out <file.mp4|.srt|.vtt>]
  vida export   <project.vida.json> [--out <file.mp4>]

validate  Reads every source with ffprobe and checks the project. Exit code 1 if it is not valid.
captions  Writes <name>.srt and <name>.vtt for the sequence.
export    Writes <name>.mp4, <name>.srt, and <name>.vtt.

Default output: <project folder>/exports/<project file name>.mp4
Source videos are never changed. The project file is only read.`;

function parseArgs(argv) {
  const [command, file, ...rest] = argv;
  const opts = { command, file, json: false, out: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json') opts.json = true;
    else if (rest[i] === '--out' && rest[i + 1]) opts.out = rest[++i];
    else throw new Error(`Unknown option: ${rest[i]}`);
  }
  return opts;
}

function defaultOutput(file) {
  const base = path.basename(file).replace(/\.vida\.json$/, '');
  return path.join(path.dirname(path.resolve(file)), 'exports', `${base}.mp4`);
}

function summary(project) {
  const settings = resolveOutput(project);
  const plan = buildPlan(project.sequence, settings.fps);
  const { cues } = captionFiles(project);
  return {
    name: project.name,
    sources: project.sources.map((s) => ({ id: s.id, name: s.name, duration: s.duration, missing: s.missing, transcript: s.transcript ? s.transcript.segments.length : 0 })),
    clips: plan.length,
    duration: planDuration(plan),
    output: settings,
    captionCues: cues.length,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!['validate', 'captions', 'export'].includes(opts.command) || !opts.file) {
    console.error(USAGE);
    return 2;
  }
  let project;
  try {
    project = await loadProject(path.resolve(opts.file), { requireMedia: true });
  } catch (err) {
    if (opts.json) console.log(JSON.stringify({ ok: false, errors: err.errors || [err.message] }, null, 2));
    else console.error(err.message);
    return 1;
  }

  if (opts.command === 'validate') {
    const info = summary(project);
    if (opts.json) console.log(JSON.stringify({ ok: true, ...info }, null, 2));
    else {
      console.log(`Valid: ${info.name}`);
      console.log(`${info.clips} clips, ${info.duration.toFixed(3)} s, ${info.output.width}x${info.output.height} at ${info.output.fps} fps, ${info.captionCues} caption cues`);
      for (const s of info.sources) console.log(`  source ${s.id}: ${s.name}, ${s.duration.toFixed(3)} s, ${s.transcript} transcript lines`);
    }
    return 0;
  }

  const out = path.resolve(opts.out || defaultOutput(opts.file));
  if (opts.command === 'captions') {
    console.log(JSON.stringify(await writeCaptions(project, out.replace(/\.(mp4|srt|vtt)$/i, '')), null, 2));
    return 0;
  }

  if (!/\.mp4$/i.test(out)) throw new Error('The output file name must end with .mp4.');
  let cancel = null;
  const job = {
    progress: (p) => process.stderr.write(`\rRendering ${Math.round(p * 100)}%`),
    onCancel: (fn) => (cancel = fn),
    cancelled: false,
  };
  // Ctrl+C stops FFmpeg; exportProject then deletes the partial file.
  process.on('SIGINT', () => (cancel ? cancel() : process.exit(130)));
  const result = await exportProject(project, out, job);
  process.stderr.write('\n');
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message || String(err));
    process.exit(1);
  },
);

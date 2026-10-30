import fs from 'node:fs';
import path from 'node:path';
import { assertValidProject, buildPlan, planDuration, remapCaptions, resolveOutput, toSRT, toVTT } from '../public/lib/timeline.js';
import { runFfmpeg } from './media.js';
import { checkMedia } from './project.js';

const AUDIO_RATE = 48000;

/** Builds the ffmpeg arguments. Each clip is cut, scaled, padded, and joined with the concat filter. */
export function buildExportArgs(project, outFile) {
  const { width, height, fps } = resolveOutput(project);
  const plan = buildPlan(project.sequence, fps);
  const byId = new Map(project.sources.map((s) => [s.id, s]));
  const inputs = [];
  const filters = [];
  const labels = [];
  plan.forEach((p, k) => {
    const src = byId.get(p.sourceId);
    if (!src) throw new Error(`Clip ${k + 1} refers to a missing source.`);
    if (!fs.existsSync(src.path)) throw new Error(`Source file not found: ${src.path}`);
    const vi = k;
    // Input seeking is frame accurate when transcoding. Read a little extra; trim filters cut exactly.
    inputs.push('-ss', p.in.toFixed(6), '-t', (p.duration + 1).toFixed(6), '-i', src.path);
    const samples = Math.round((p.frames / fps) * AUDIO_RATE);
    filters.push(
      `[${vi}:v:0]fps=fps=${fps}:start_time=0,scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,` +
        `tpad=stop_mode=clone:stop_duration=2,trim=end_frame=${p.frames},setpts=PTS-STARTPTS[v${k}]`,
    );
    if (src.hasAudio) {
      filters.push(
        `[${vi}:a:0]aresample=${AUDIO_RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `apad,atrim=end_sample=${samples},asetpts=PTS-STARTPTS[a${k}]`,
      );
    } else {
      // Sources without audio get silence of the same length.
      filters.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=end_sample=${samples},aformat=sample_fmts=fltp[a${k}]`);
    }
    labels.push(`[v${k}][a${k}]`);
  });
  filters.push(`${labels.join('')}concat=n=${plan.length}:v=1:a=1[vout][aout]`);
  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE),
    '-movflags', '+faststart',
    outFile,
  ];
  return { args, plan, settings: { width, height, fps } };
}

function transcriptsOf(project) {
  const map = {};
  for (const s of project.sources) if (s.transcript) map[s.id] = s.transcript;
  return map;
}

export function captionFiles(project) {
  assertValidProject(project);
  const { fps } = resolveOutput(project);
  const cues = remapCaptions(buildPlan(project.sequence, fps), transcriptsOf(project));
  return { cues, srt: toSRT(cues), vtt: toVTT(cues) };
}

function assertSafeOutput(project, file) {
  const resolved = path.resolve(file);
  let output;
  try {
    output = fs.statSync(resolved);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const s of project.sources) {
    // stat follows symlinks and detects case-only paths and hard links.
    const source = output && !s.missing ? fs.statSync(s.path) : null;
    if (path.resolve(s.path) === resolved || (source && source.dev === output.dev && source.ino === output.ino)) {
      throw new Error('The output file cannot replace a source file.');
    }
  }
}

/** Writes base.srt and base.vtt next to the video. */
export async function writeCaptions(project, base) {
  project = await checkMedia(project, { requireMedia: true });
  const { cues, srt, vtt } = captionFiles(project);
  for (const ext of ['.srt', '.vtt']) assertSafeOutput(project, base + ext);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.writeFileSync(`${base}.srt`, srt);
  fs.writeFileSync(`${base}.vtt`, vtt);
  return { srt: `${base}.srt`, vtt: `${base}.vtt`, cues: cues.length };
}

export async function exportProject(project, outFile, job) {
  project = await checkMedia(project, { requireMedia: true });
  if (!project.sequence.length) throw new Error('The sequence is empty.');
  if (!/\.mp4$/i.test(outFile)) throw new Error('The output file name must end with .mp4.');
  const base = outFile.replace(/\.mp4$/i, '');
  for (const file of [outFile, outFile + '.part.mp4', base + '.srt', base + '.vtt']) {
    assertSafeOutput(project, file);
  }
  const { args, plan, settings } = buildExportArgs(project, outFile + '.part.mp4');
  const total = planDuration(plan);
  let proc;
  job.onCancel(() => proc && proc.kill('SIGKILL'));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  job.progress(0, 'Rendering video');
  try {
    await runFfmpeg(args, { onProgress: (t) => job.progress(Math.min(0.99, t / total)), onSpawn: (p) => (proc = p) });
  } catch (err) {
    fs.rmSync(outFile + '.part.mp4', { force: true });
    throw err;
  }
  fs.renameSync(outFile + '.part.mp4', outFile);
  const captions = await writeCaptions(project, base);
  return { video: outFile, ...captions, duration: total, settings };
}

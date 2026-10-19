import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { config, DATA_DIR } from './config.js';

export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'];
const BROWSER_CODECS = ['h264', 'vp8', 'vp9', 'av1'];

function parseRate(rate) {
  if (!rate || rate === '0/0') return 0;
  const [n, d] = rate.split('/').map(Number);
  return d ? n / d : n;
}

/** Reads media facts with ffprobe. */
export function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(
      config.ffprobe,
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`ffprobe failed for ${path.basename(file)}: ${stderr || err.message}`));
        const info = JSON.parse(stdout);
        const v = info.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        const a = info.streams.find((s) => s.codec_type === 'audio');
        if (!v) return reject(new Error(`${path.basename(file)} has no video stream.`));
        let rotation = 0;
        for (const sd of v.side_data_list || []) if (sd.rotation !== undefined) rotation = Number(sd.rotation);
        if (v.tags && v.tags.rotate) rotation = Number(v.tags.rotate);
        const turned = Math.abs(rotation) % 180 === 90;
        const duration = Number(info.format.duration || v.duration || 0);
        const pixFmt = v.pix_fmt || '';
        const tenBit = /10|12/.test(pixFmt);
        resolve({
          duration,
          width: turned ? v.height : v.width,
          height: turned ? v.width : v.height,
          fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
          vcodec: v.codec_name,
          pixFmt,
          hasAudio: Boolean(a),
          acodec: a ? a.codec_name : null,
          size: Number(info.format.size || 0),
          needsProxy: !BROWSER_CODECS.includes(v.codec_name) || tenBit,
        });
      },
    );
  });
}

/**
 * Runs ffmpeg with -progress. Calls onProgress(seconds) while it runs.
 * Returns a promise and a kill function.
 */
export function runFfmpeg(args, { onProgress, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args]);
    if (onSpawn) onSpawn(proc);
    let stderr = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && onProgress) onProgress(Number(m[1]) / 1e6);
      }
    });
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    proc.on('error', (err) => reject(new Error(`Cannot start ffmpeg (${config.ffmpeg}): ${err.message}`)));
    proc.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `ffmpeg stopped (${signal})` : `ffmpeg failed (code ${code}):\n${stderr.trim().split('\n').slice(-12).join('\n')}`));
    });
  });
}

function sourceKey(file) {
  const st = fs.statSync(file);
  return createHash('sha1').update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
}

export function proxyPathFor(file) {
  return path.join(DATA_DIR, 'proxies', `${sourceKey(file)}.mp4`);
}

/**
 * Makes a small H.264 copy for preview only. Export always reads the original.
 * Keyframes every second give fast seeking in the browser.
 */
export async function makeProxy(file, duration, job) {
  const out = proxyPathFor(file);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.part.mp4`;
  let proc;
  job.onCancel(() => proc && proc.kill('SIGKILL'));
  await runFfmpeg(
    [
      '-i', file,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=-2:min(720\\,ih),format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '30', '-keyint_min', '30',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      tmp,
    ],
    { onProgress: (t) => job.progress(duration ? t / duration : 0), onSpawn: (p) => (proc = p) },
  );
  fs.renameSync(tmp, out);
  return out;
}

/** Extracts mono 16 kHz audio for transcription. */
export async function extractAudio(file, out, { format = 'wav', start, duration } = {}) {
  const args = [];
  if (start !== undefined) args.push('-ss', String(start));
  if (duration !== undefined) args.push('-t', String(duration));
  args.push('-i', file, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000');
  if (format === 'wav') args.push('-c:a', 'pcm_s16le');
  else args.push('-c:a', 'libmp3lame', '-b:a', '32k');
  args.push(out);
  await runFfmpeg(args);
  return out;
}

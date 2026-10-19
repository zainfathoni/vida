// Measures a rendered video: per-frame brightness and color, white flash frames,
// and 3 kHz beep onsets in the audio. Used by the end-to-end test.
import { execFileSync } from 'node:child_process';

export function frameStats(file) {
  const out = execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-vf', 'scale=64:36,signalstats,metadata=print:file=-', '-f', 'null', '-'],
    { maxBuffer: 256 * 1024 * 1024 },
  ).toString();
  const frames = [];
  let cur = null;
  for (const line of out.split('\n')) {
    const m = line.match(/^frame:(\d+)\s+pts:\S+\s+pts_time:([\d.]+)/);
    if (m) {
      cur = { n: Number(m[1]), t: Number(m[2]) };
      frames.push(cur);
      continue;
    }
    const kv = line.match(/lavfi\.signalstats\.(YAVG|UAVG|VAVG)=([\d.]+)/);
    if (kv && cur) cur[kv[1][0]] = Number(kv[2]);
  }
  return frames;
}

/** Onset times of flash runs (frames with Y average above 200). */
export function flashOnsets(frames) {
  const onsets = [];
  let prev = false;
  for (const f of frames) {
    const on = f.Y > 200;
    if (on && !prev) onsets.push(f.t);
    prev = on;
  }
  return onsets;
}

export function audioSamples(file, rate = 48000) {
  const buf = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], {
    maxBuffer: 512 * 1024 * 1024,
  });
  const samples = new Float32Array(buf.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
  return samples;
}

function goertzel(samples, start, n, freq, rate) {
  const k = 2 * Math.cos((2 * Math.PI * freq) / rate);
  let s1 = 0;
  let s2 = 0;
  for (let i = start; i < start + n; i++) {
    const s0 = samples[i] + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / n;
}

/** Onset times of the 3 kHz beeps, with 2.5 ms resolution. */
export function beepOnsets(samples, rate = 48000, freq = 3000) {
  const win = Math.round(rate * 0.005);
  const hop = Math.round(rate * 0.0025);
  const onsets = [];
  let prev = false;
  let lastOn = -1;
  for (let i = 0; i + win < samples.length; i += hop) {
    const on = goertzel(samples, i, win, freq, rate) > 0.08;
    const t = i / rate;
    if (on && !prev && t - lastOn > 0.2) {
      onsets.push(t);
      lastOn = t;
    }
    prev = on;
  }
  return onsets;
}

export function rms(samples, rate, from, to) {
  const a = Math.max(0, Math.round(from * rate));
  const b = Math.min(samples.length, Math.round(to * rate));
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return b > a ? Math.sqrt(sum / (b - a)) : 0;
}

export function probeDurations(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,duration,width,height,r_frame_rate', '-of', 'json', file]).toString();
  return JSON.parse(out).streams;
}

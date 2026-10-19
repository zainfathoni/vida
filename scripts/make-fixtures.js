// Generates test videos with known content, for checks without real recordings.
// Each source has its own background color, white flash frames at known times,
// a 3 kHz beep at the same times (A/V sync marker), and synthetic speech (flite)
// at known times. truth.json records all of it.
//
// Usage: node scripts/make-fixtures.js <output-folder>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { toSRT } from '../public/lib/timeline.js';

const outDir = path.resolve(process.argv[2] || 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

const FLASH = 0.1; // seconds

const SOURCES = [
  {
    id: 'A', file: 'screen-A.mp4', label: 'SCREEN A', color: '0x2050c0', w: 1280, h: 800, fps: 60, dur: 24, codec: 'libx264', audio: true,
    flashes: [0.8, 3.9, 5.9, 8.1, 10.4, 12.7, 15.2, 17.6, 19.9, 23.3],
    phrases: [
      [1.0, 'Welcome to the screen recording.'],
      [6.3, 'First I open the settings page.'],
      [10.6, 'Now I show the demo.'],
      [20.4, 'That was the end of the demo.'],
    ],
  },
  {
    id: 'B', file: 'camera-B.mp4', label: 'CAMERA B', color: '0xc03020', w: 1920, h: 1080, fps: 30, dur: 16, codec: 'libx265', audio: true,
    flashes: [0.5, 4.3, 7.6, 9.8, 13.9],
    phrases: [
      [1.0, 'Hello from the camera. This is take two.'],
      [5.0, 'The quick brown fox jumps.'],
      [10.4, 'Thank you for watching this episode.'],
    ],
  },
  {
    id: 'C', file: 'screen-C-silent.mp4', label: 'SCREEN C', color: '0x20a040', w: 1280, h: 720, fps: 30, dur: 10, codec: 'libx264', audio: false,
    flashes: [1.2, 3.4, 5.7, 8.3],
    phrases: [],
  },
];

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const duration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'].find((f) => fs.existsSync(f));

const truth = { flash: FLASH, sources: {} };
const tmp = fs.mkdtempSync(path.join(outDir, '.tmp-'));

for (const s of SOURCES) {
  const enable = s.flashes.map((t) => `between(t,${t},${(t + FLASH).toFixed(3)})`).join('+');
  const text = FONT ? `,drawtext=fontfile='${FONT}':text='${s.label}  %{pts\\:hms}':x=40:y=40:fontsize=${Math.round(s.h / 14)}:fontcolor=white` : '';
  const vf = `drawgrid=w=${s.w / 8}:h=${s.h / 8}:t=2:c=white@0.15${text},drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${enable}'`;
  const args = ['-f', 'lavfi', '-i', `color=c=${s.color}:s=${s.w}x${s.h}:r=${s.fps}:d=${s.dur}`];
  const phrases = [];
  if (s.audio) {
    const inputs = [];
    const mixes = [];
    s.phrases.forEach(([start, said], i) => {
      const wav = path.join(tmp, `${s.id}${i}.wav`);
      ff(['-f', 'lavfi', '-i', `flite=text='${said.replace(/'/g, '')}':voice=slt`, '-ar', '48000', wav]);
      phrases.push({ start, end: +(start + duration(wav)).toFixed(3), text: said });
      inputs.push('-i', wav);
      mixes.push(`[${i + 2}:a]adelay=${Math.round(start * 1000)}:all=1,volume=1.5[p${i}]`);
    });
    const beeps = s.flashes.map((t) => `between(t,${t},${(t + FLASH).toFixed(3)})`).join('+');
    args.push('-f', 'lavfi', '-i', `aevalsrc='0.4*sin(2*PI*3000*t)*(${beeps})':s=48000:d=${s.dur}:c=stereo`, ...inputs);
    const labels = ['[1:a]', ...s.phrases.map((_, i) => `[p${i}]`)].join('');
    args.push('-filter_complex', `[0:v]${vf}[v];${mixes.join(';')}${mixes.length ? ';' : ''}${labels}amix=inputs=${s.phrases.length + 1}:normalize=0:duration=first,aformat=channel_layouts=stereo[a]`);
    args.push('-map', '[v]', '-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  } else {
    args.push('-vf', vf);
  }
  args.push('-c:v', s.codec, '-pix_fmt', 'yuv420p', '-preset', 'veryfast');
  if (s.codec === 'libx265') args.push('-tag:v', 'hvc1', '-x265-params', 'log-level=error');
  args.push('-t', String(s.dur), path.join(outDir, s.file));
  ff(args);
  truth.sources[s.id] = { file: s.file, color: s.color, width: s.w, height: s.h, fps: s.fps, duration: s.dur, hasAudio: s.audio, flashes: s.flashes, phrases };
  if (phrases.length) fs.writeFileSync(path.join(outDir, s.file.replace(/\.mp4$/, '.truth.srt')), toSRT(phrases));
  console.log(`made ${s.file}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(path.join(outDir, 'truth.json'), JSON.stringify(truth, null, 2));
console.log(`wrote ${path.join(outDir, 'truth.json')}`);

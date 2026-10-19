import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { extractAudio } from './media.js';
import { groupWords } from '../public/lib/timeline.js';

// Two real providers: local whisper.cpp and an OpenAI-compatible API.
// If a provider fails, the job fails. The app never invents a transcript.

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vida-'));
}

function toTranscript(provider, model, words, segments) {
  const timed = words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && String(w.text).trim());
  const segs = timed.length
    ? groupWords(timed)
    : segments.filter((s) => s.text.trim()).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
  if (!segs.length) throw new Error('The provider returned no speech. The transcript was not changed.');
  return { provider, model, createdAt: new Date().toISOString(), segments: segs };
}

// whisper.cpp often stretches the last word of a phrase over the following
// silence. Limit a word to a length that its letters can plausibly take.
function clampWord(w, duration) {
  const maxLen = Math.min(1.5, 0.25 + 0.09 * w.text.length);
  const start = Math.min(w.start, duration || Infinity);
  return { ...w, start, end: Math.min(w.end, start + maxLen, duration || Infinity) };
}

async function whisperCpp(source, job) {
  if (!config.whisperBin || !config.whisperModel || !fs.existsSync(config.whisperModel)) {
    throw new Error('whisper.cpp is not set up. See README: WHISPER_CPP_BIN and WHISPER_CPP_MODEL.');
  }
  const dir = tempDir();
  try {
    job.progress(0.02, 'Extracting audio');
    const wav = await extractAudio(source.path, path.join(dir, 'audio.wav'));
    const lang = /\.en\.bin$/.test(config.whisperModel) ? 'en' : config.whisperLanguage;
    const threads = String(Math.max(1, Math.min(8, os.cpus().length)));
    const args = ['-m', config.whisperModel, '-f', wav, '-l', lang, '-t', threads, '-ml', '1', '-sow', '-oj', '-of', path.join(dir, 'out'), '-pp'];
    // Voice activity detection keeps word times out of silent parts.
    if (config.whisperVadModel && fs.existsSync(config.whisperVadModel)) args.push('--vad', '-vm', config.whisperVadModel);
    job.progress(0.05, 'Transcribing with whisper.cpp');
    await new Promise((resolve, reject) => {
      const proc = spawn(config.whisperBin, args);
      job.onCancel(() => proc.kill('SIGKILL'));
      let err = '';
      const onData = (d) => {
        const s = d.toString();
        err = (err + s).slice(-4000);
        const m = s.match(/progress\s*=\s*(\d+)%/g);
        if (m) job.progress(0.05 + 0.9 * (Number(m[m.length - 1].match(/\d+/)[0]) / 100));
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => reject(new Error(`Cannot start whisper.cpp: ${e.message}`)));
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`whisper.cpp failed (code ${code}): ${err.trim().split('\n').slice(-5).join(' ')}`))));
    });
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
    const words = (json.transcription || [])
      .map((t) => ({ start: t.offsets.from / 1000, end: t.offsets.to / 1000, text: t.text.trim() }))
      // whisper.cpp marks non-speech with brackets, for example [BLANK_AUDIO].
      .filter((w) => w.text && !/^\[.*\]$|^\(.*\)$/.test(w.text))
      .map((w) => clampWord(w, source.duration));
    return toTranscript('whisper.cpp', path.basename(config.whisperModel), words, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CHUNK_SECONDS = 20 * 60; // keeps each upload below the 25 MB API limit

async function openaiApi(source, job) {
  if (!config.openaiKey) throw new Error('OPENAI_API_KEY is not set. See README.');
  const dir = tempDir();
  const words = [];
  const segments = [];
  try {
    const total = source.duration || 0;
    const chunks = Math.max(1, Math.ceil(total / CHUNK_SECONDS));
    for (let i = 0; i < chunks; i++) {
      if (job.cancelled) throw new Error('Cancelled');
      const offset = i * CHUNK_SECONDS;
      job.progress(i / chunks, `Uploading audio part ${i + 1} of ${chunks}`);
      const file = await extractAudio(source.path, path.join(dir, `part${i}.mp3`), { format: 'mp3', start: offset, duration: CHUNK_SECONDS });
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), `part${i}.mp3`);
      form.append('model', config.openaiModel);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
      const res = await fetch(`${config.openaiBaseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.openaiKey}` },
        body: form,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Transcription API error ${res.status}: ${text.slice(0, 300)}`);
      const data = JSON.parse(text);
      if (!Array.isArray(data.words) && !Array.isArray(data.segments)) {
        throw new Error(`Model ${config.openaiModel} returned no timestamps. Use a model that supports verbose_json timestamps, for example whisper-1.`);
      }
      for (const w of data.words || []) words.push({ start: w.start + offset, end: w.end + offset, text: w.word });
      for (const s of data.segments || []) segments.push({ start: s.start + offset, end: s.end + offset, text: s.text });
    }
    return toTranscript('openai-compatible', config.openaiModel, words, segments);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function transcribe(provider, source, job) {
  if (!source.hasAudio) throw new Error('This source has no audio track.');
  if (provider === 'whisper') return whisperCpp(source, job);
  if (provider === 'openai') return openaiApi(source, job);
  throw new Error(`Unknown provider: ${provider}`);
}

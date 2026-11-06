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

// DTW needs an alignment-head preset. Read the GGML model header, not its
// filename: models can be renamed, and quantization does not change the preset.
function whisperAlignmentModel(file) {
  const header = Buffer.alloc(48);
  const fd = fs.openSync(file, 'r');
  let size;
  try { size = fs.readSync(fd, header, 0, header.length, 0); }
  finally { fs.closeSync(fd); }
  if (size === header.length && header.readUInt32LE(0) === 0x67676d6c) {
    const vocab = header.readInt32LE(4);
    const layers = header.readInt32LE(20);
    const textLayers = header.readInt32LE(36);
    const model = { 4: 'tiny', 6: 'base', 12: 'small', 24: 'medium' }[layers];
    if (model && textLayers === layers && (vocab === 51864 || vocab === 51865)) {
      return model + (vocab === 51864 ? '.en' : '');
    }
    if (layers === 32 && vocab === 51866) {
      if (textLayers === 4) return 'large.v3.turbo';
      if (textLayers === 32) return 'large.v3';
    }
    // Large v1 and v2 have the same header but different alignment heads.
    const version = path.basename(file).match(/large[-.]v([12])(?:[-.]|$)/);
    if (layers === 32 && textLayers === 32 && vocab === 51865 && version) return `large.v${version[1]}`;
  }
  throw new Error('Cannot choose DTW alignment for this model. Use a standard whisper.cpp model; large-v1 and large-v2 must keep their version in the file name.');
}

function whisperWords(json, duration, alignment) {
  // whisper.cpp reserves IDs from EOT onward for control tokens. The English
  // vocabulary has one fewer lexical token than multilingual vocabularies.
  const eot = alignment.endsWith('.en') ? 50256 : 50257;
  const words = [];
  let word = null;
  let prefix = '';
  const flush = () => {
    if (!word) return;
    if (word.start === null) {
      if (words.length) words[words.length - 1].text += ` ${word.text}`;
      else prefix += `${word.text} `;
    } else {
      word.text = prefix + word.text;
      prefix = '';
      words.push(word);
    }
    word = null;
  };
  for (const segment of json.transcription || []) {
    if (!Array.isArray(segment.tokens)) throw new Error('whisper.cpp returned no alignment tokens. Update whisper.cpp to a version with DTW and full JSON output.');
    for (const token of segment.tokens) {
      if (!Number.isInteger(token.id) || token.id < 0) throw new Error('whisper.cpp returned no valid token ID. Update whisper.cpp to a version with full JSON output.');
      if (token.id >= eot) continue;
      const text = token.text;
      for (const part of text.split(/(\s+)/u)) {
        if (!part) continue;
        if (/^\s+$/u.test(part)) { flush(); continue; }
        if (!word) word = { start: null, end: 0, limit: 0, text: '' };
        word.text += part;
        word.limit = Math.max(word.limit, segment.offsets.to / 1000);
        // Punctuation belongs to the text, but its alignment can be in silence.
        if (/[\p{L}\p{N}]/u.test(part)) {
          if (!Number.isFinite(token.t_dtw) || token.t_dtw < 0) {
            throw new Error('whisper.cpp returned no DTW word alignment. Update whisper.cpp; flash attention must be disabled for DTW.');
          }
          word.start ??= token.t_dtw / 100;
          word.end = token.t_dtw / 100;
        }
      }
    }
  }
  flush();
  return words.map((w, i) => {
    const start = Math.min(w.start, duration);
    // Segment and length limits stop estimated tails in silence. An aligned
    // subword can extend past both; only the next word and source end cap it.
    const end = Math.max(w.end, start + Math.min(1.5, 0.25 + 0.09 * w.text.length));
    return { start, end: Math.min(end, Math.max(w.end, w.limit), words[i + 1]?.start ?? duration, duration), text: w.text };
  });
}

async function whisperCpp(source, job) {
  if (!config.whisperBin || !config.whisperModel || !fs.existsSync(config.whisperModel)) {
    throw new Error('whisper.cpp is not set up. See README: WHISPER_CPP_BIN and WHISPER_CPP_MODEL.');
  }
  const alignment = whisperAlignmentModel(config.whisperModel);
  const dir = tempDir();
  try {
    job.progress(0.02, 'Extracting audio');
    const wav = await extractAudio(source.path, path.join(dir, 'audio.wav'));
    const lang = alignment.endsWith('.en') ? 'en' : config.whisperLanguage;
    const threads = String(Math.max(1, Math.min(8, os.cpus().length)));
    // DTW token times are centiseconds on the original audio timeline. VAD
    // removes silence and changes that timeline; flash attention disables DTW.
    const args = ['-m', config.whisperModel, '-f', wav, '-l', lang, '-t', threads, '-nfa', '-dtw', alignment, '-ojf', '-of', path.join(dir, 'out'), '-pp'];
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
    const words = whisperWords(json, source.duration, alignment);
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.VIDA_DATA_DIR || path.join(os.homedir(), '.vida');

// Loads KEY=VALUE lines from .env in the app folder. Real environment
// variables have priority. Values are never sent to the browser.
function loadDotEnv() {
  const file = path.join(APP_DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

function findOnPath(names) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  for (const name of names) {
    try {
      const out = execFileSync(finder, [name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (out) return out.split(/\r?\n/)[0];
    } catch {
      // not found
    }
  }
  return null;
}

export const config = {
  port: Number(process.env.PORT || 5178),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  whisperBin: process.env.WHISPER_CPP_BIN || findOnPath(['whisper-cli', 'whisper-cpp']),
  whisperModel: process.env.WHISPER_CPP_MODEL || '',
  whisperVadModel: process.env.WHISPER_CPP_VAD_MODEL || '',
  whisperLanguage: process.env.WHISPER_LANGUAGE || 'auto',
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  openaiModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1',
};

/** Provider status for the UI. It contains no secret values. */
export function providerStatus() {
  const whisperReady = Boolean(config.whisperBin && config.whisperModel && fs.existsSync(config.whisperModel));
  return {
    whisper: {
      ready: whisperReady,
      detail: whisperReady
        ? `whisper.cpp, model ${path.basename(config.whisperModel)}${config.whisperVadModel ? ' with VAD' : ' (no VAD model: word times are less exact)'}`
        : !config.whisperBin
          ? 'whisper.cpp program not found. Set WHISPER_CPP_BIN.'
          : 'Model file not set or not found. Set WHISPER_CPP_MODEL.',
    },
    openai: {
      ready: Boolean(config.openaiKey),
      detail: config.openaiKey
        ? `API model ${config.openaiModel} at ${new URL(config.openaiBaseUrl).host} (audio is uploaded)`
        : 'OPENAI_API_KEY is not set.',
    },
  };
}

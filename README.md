# Vida

Vida is a small local video editor for episodes made from several recordings, for example Screen Studio exports and DJI Pocket camera files.

With Vida, you can:

- Import several videos. Vida reads the files in place. It does not copy or change them.
- Read a timestamped transcript for each video. Parts without speech (for example, silent screen demonstrations) show as "No speech" rows. Vida does not remove them.
- Select sections with In and Out marks, or by selecting transcript lines.
- Arrange the sections in an ordered sequence. You can drag, trim to the frame, split, and remove clips.
- Preview the combined sequence with captions.
- Save the project and open it again. The project file keeps only your edit decisions and transcripts.
- Export one MP4 and SRT and VTT captions. Caption times come from the source transcripts and move with each cut and each change of order.

Vida runs on your computer. It has no accounts, no cloud storage, and no publishing. It does not do multicam, automatic vertical crops, or motion graphics.

## Requirements

- Node.js 20 or newer. Vida has no npm dependencies.
- FFmpeg with `ffprobe`. On macOS: `brew install ffmpeg`.
- A Chromium-based browser or Safari.
- Optional: whisper.cpp for local transcription (see below).

## Start

```sh
cd vida
npm start          # starts the server and opens http://localhost:5178/
```

To start without opening a browser, use `npm run serve`. To use a different port, set `PORT=5200`.

The server listens on `127.0.0.1` only. Stop it with Ctrl+C.

## Workflow

1. Click **Add videos…**, go to the folder, select the files, and click **OK**. You can type a path in the path field.
2. Select a source. To get a transcript, click **Transcribe (local whisper.cpp)**, or **Import SRT/VTT…** if you already have captions for that video.
3. Mark a section:
   - Play or scrub the source, then press **I** (In) and **O** (Out), or
   - click a transcript line, then Shift+click another line. The selection sets In and Out.
4. Press **A** or click **Add to sequence**. The new clip goes after the selected clip.
   To keep a range for later, press **N** or click **Save select**, and give it a name. The range shows in the **Selects** list. Click a select to open its range, or click **Add to sequence**.
5. In the **Sequence** panel, drag clips to change the order. Select a clip to change In and Out (type a time, or use −1f and +1f), split it at the preview playhead, or remove it. Double-click a clip to open it in the source view.
6. Play the **Sequence preview**. Captions show on the preview.
7. Click **Save** (Ctrl+S). Project files end with `.vida.json`.
8. Click **Export…**. Select the size and frame rate, and click **Export video and captions**.

To correct transcript text, double-click it, type, and press Enter. The export uses the corrected text.

- In a line with word times (whisper.cpp or the API), each word is separate. Double-click a word to correct it. The word keeps its time. If you type more than one word, the new words share the time of the old word. Clear the text to delete the word.
- Alt+click (Option+click on a Mac) a word to turn it off in the captions, for example a filler word. The word stays in the transcript, struck through. Alt+click it again to turn it on.
- In a line without word times (imported SRT/VTT), double-click the line to correct the whole line.

### When the project file changes on disk

Another program or an agent can change the project file while it is open in Vida. Vida checks the file every 2 seconds. When the file changed, a bar shows **Reload from disk**, **Save as…**, and **Keep editing**. After a reload, **Undo** brings back the version that you had before.

**Save** fails when the file on disk is not the file that your version is based on, also after Undo goes back to a version from before a reload. The file on disk stays the same. To keep your version, click **Save as…**, or **Replace the file on disk** in the bar.

This check is not a file lock. A change that another program writes in the few milliseconds while Vida saves can be lost. Agents must write their edits to a new draft file (see [docs/agent-workflow.md](docs/agent-workflow.md)).

## Command line and agents

You can check and render a project without the browser:

```sh
node bin/vida.js validate "Episode 12.vida.json"
node bin/vida.js captions "Episode 12.vida.json"
node bin/vida.js export   "Episode 12.vida.json" --out exports/episode-12.mp4
```

An agent can write a `.vida.json` file, validate it, render it, and give it to you to review in Vida. See [docs/agent-workflow.md](docs/agent-workflow.md) for the project format and the workflow, and [AGENTS.md](AGENTS.md) for the rules that agents follow.

### Keyboard

| Key | Action |
| --- | --- |
| Space | Play or pause the last-used view |
| I / O | Mark In / Out in the source view |
| A | Add the marked range to the sequence |
| N | Save the marked range as a named select |
| J / K / L | Back one second / pause / play (the last-used view). Browsers cannot play video in reverse |
| ← / → | One frame back / forward in the last-used view. Shift: one second |
| ↑ / ↓ | Select the previous / next clip and move the sequence preview to its start |
| X | Select the clip at the sequence preview playhead |
| [ / ] | Move In / Out of the selected clip to the sequence preview playhead |
| S | Split the selected clip at the sequence preview playhead |
| Delete | Remove the selected clip |
| Ctrl+S / Ctrl+Shift+S | Save / Save as |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo |

## Transcription setup

Vida never makes a transcript itself. If no provider is set up, the transcript panel tells you, and you can still cut and export without captions. If a provider fails, the transcript does not change.

Put settings in a `.env` file in the `vida` folder (copy `.env.example`), or set environment variables. The browser never receives these values. Do not commit `.env`.

### Option 1: whisper.cpp (local, recommended)

Audio stays on your computer.

1. Install whisper.cpp. On macOS: `brew install whisper-cpp`. This installs `whisper-cli`.
2. Download a model, for example [ggml-base.en.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin) (English, 148 MB) or `ggml-small.bin` (multilingual) from the same place.
3. Download the voice activity detection model [ggml-silero-v5.1.2.bin](https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin). Without it, whisper.cpp often puts word times inside silent parts, and captions start too early.
4. Set the paths in `.env`:

   ```sh
   WHISPER_CPP_BIN=/opt/homebrew/bin/whisper-cli
   WHISPER_CPP_MODEL=/Users/you/models/ggml-base.en.bin
   WHISPER_CPP_VAD_MODEL=/Users/you/models/ggml-silero-v5.1.2.bin
   # WHISPER_LANGUAGE=auto   (for multilingual models; .en models use English)
   ```

5. Restart Vida.

### Option 2: OpenAI-compatible API

This option uploads the audio of the video to the API provider.

```sh
OPENAI_API_KEY=...                       # keep it in .env only
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_TRANSCRIBE_MODEL=whisper-1        # the model must return timestamps (verbose_json)
```

Vida sends 20-minute parts, so each upload stays below the 25 MB limit.

### Option 3: Import captions

**Import SRT/VTT…** reads captions that another tool made for that source video. The cue times must be times in that source video.

## How it works

- `server/` is a small Node HTTP server. It lists folders, reads media facts with `ffprobe`, streams source files to the browser, runs transcription, saves projects, and runs FFmpeg for export.
- `public/` is the browser app (plain JavaScript, no build step).
- `public/lib/timeline.js` has the timeline rules and the project validation. The preview, the export, and `bin/vida.js` all use it, so they agree.
- `bin/vida.js` is the command line tool (`validate`, `captions`, `export`).

### Timing rules

- Every clip is a range `[in, out)` in seconds of source time. Transcripts also use source time.
- At export, each clip becomes a whole number of output frames: `frames = round((out − in) × fps)`. The clip offset in the final video is the sum of the frames before it, divided by fps. Captions use the same numbers.
- With word times (whisper.cpp, API), a caption keeps a word when the middle of the word is inside the clip. Without word times (imported SRT/VTT, or a line that you corrected), a caption line is cut to the clip and kept when at least 0.25 s of it is inside the clip. A caption never crosses a cut.

### Export

- One FFmpeg run cuts each clip from the original file (frame-accurate seek), scales it to fit the output size with black bars (no crop), sets a constant frame rate, and joins the clips with the `concat` filter.
- Audio is resampled to 48 kHz stereo. Each clip's audio is padded or trimmed to the exact length of its video, so audio and video stay in sync after many cuts. A source without audio gets silence.
- Output: H.264 (CRF 18) and AAC 192 kbit/s MP4, plus `.srt` and `.vtt` files with the same name.
- Vida refuses to write an output file to the path of a source file.

### Waveforms

The source view and each clip in the sequence show the audio waveform, so you can see speech and silence before you cut. The marked In/Out range is brighter in the source waveform. Vida reads the audio once with FFmpeg and keeps the peaks (one value for each 10 ms) in `~/.vida/waveforms/`. The source file is only read. A video without audio has no waveform.

### Preview copies

Browsers cannot play some camera files, for example HEVC (H.265) or 10-bit video. For these files, Vida makes a 720p H.264 preview copy in `~/.vida/proxies/`. The preview copy is only for the preview. Export always reads the original file. If a video does not play, click **Make preview copy** in the source list.

### Project file

A `.vida.json` file contains the source paths (absolute and relative to the project file), media facts, transcripts, the sequence, and output settings. [docs/agent-workflow.md](docs/agent-workflow.md) describes each field and the validation rules. Vida does not open, save, or export a project with a bad clip, for example a clip with Out before In, a clip past the end of its video, or a clip that refers to a source that is not in the project. The error names the clip. If you move the project folder together with the videos, Vida finds the videos by the relative path. If a file is missing, the source shows **file missing** and **Find file…**.

## Tests

```sh
npm test            # timeline unit tests (fast)
npm run test:e2e    # makes test videos with FFmpeg, exports sequences, and measures them (about 1 minute)
node --test test/whisper.test.js   # optional, needs whisper.cpp settings
```

The end-to-end test makes three videos with different sizes, frame rates, codecs, and durations. One video has no audio. Each video has a different color, white flash frames with a 3 kHz beep at known times, and synthetic speech at known times. The test exports cuts from all three videos in a new order and checks:

- the video frame count and the audio length,
- that every frame comes from the correct source (frame-exact joins),
- that flashes and beeps are at the remapped times and stay in sync at every cut,
- that the clip from the source without audio is silent,
- that the SRT and VTT cues have the remapped times and that speech is under each cue,
- that a saved project opens again, also after you move the folder,
- that the source files do not change,
- that `bin/vida.js` validates, captions, and exports a hand-written project with boundary cuts from three sources, and refuses bad cuts without writing files,
- that a save does not replace a project file that changed on disk, and that Undo across a reload keeps the old revision,
- that the HTTP save, captions, and export routes use the real media length, not a duration or `missing` value from the request.

## Limits

- The preview switches between two video elements at each cut. A cut in the preview can show a short delay. The export has no delay.
- Variable frame rate sources are converted to a constant frame rate at export.
- No audio level controls, no transitions, no AI suggestions.
- Undo history is not saved with the project.
- Tests used generated videos only. Tests with real Screen Studio and DJI Pocket recordings are still necessary.

## Licence

Vida is available under the [MIT License](LICENSE).

Vida does not include FFmpeg, whisper.cpp, or whisper models. You install them yourself, and their own licences apply to them. FFmpeg is LGPL or GPL, depending on how it was built. whisper.cpp and the models in the links above are MIT.

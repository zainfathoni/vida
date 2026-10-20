# Vida: instructions for agents

Vida is a local video editor: Node 20+, plain browser JavaScript, FFmpeg/ffprobe, no npm dependencies. The server listens on 127.0.0.1 only.

## Editing a video project for a person

Read [docs/agent-workflow.md](docs/agent-workflow.md) first. It has the project format, the validation rules, and the commands.

- Write edits to a `.vida.json` file. Use a new file for a draft, for example `<name> (agent draft).vida.json`. Do not write to a file that the person has open in Vida: the save check rejects stale saves, but it is not a lock, and a write during a save can be lost.
- Run `node bin/vida.js validate <file>` after every change, and fix every error before you continue.
- Render with `node bin/vida.js captions <file>` and `node bin/vida.js export <file>`. Do not call FFmpeg yourself to cut the edit; Vida's export keeps captions, audio, and frames in sync.
- Never change, move, re-encode, or delete source videos. Never write an output file to a source path.
- Never invent transcript text or times. Use transcripts from whisper.cpp, the API provider, or SRT/VTT files for that video. If a source has no transcript, say so.
- Tell the person the project path so they can review it in Vida (**Open…**, or `http://localhost:5178/?project=<URL-encoded path>`). Say which choices you made and why. The person decides what is final.
- Do not commit media, exports, `.env`, or project files that contain private paths.

## Changing Vida's code

- `public/lib/timeline.js` is the source of truth for timing, captions, and project validation. The browser, the server, and `bin/vida.js` all use it. Do not copy its logic.
- `server/project.js` opens, validates, and saves projects. Saves must keep the revision check (no silent overwrite of a file that changed on disk). `checkMedia` reads the real media facts before save, captions, and export; do not trust facts from the request or the file. `public/lib/history.js` keeps the revision with each Undo entry.
- `server/export.js` renders. It validates before it writes anything.
- Tests: `npm test` (unit, fast) and `npm run test:e2e` (generates fixtures with FFmpeg, about 30 s). `node --test test/whisper.test.js` needs whisper.cpp settings.
- Write user-facing text and docs in ASD-STE100 Simplified Technical English.

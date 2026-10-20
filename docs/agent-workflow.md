# Agent workflow and project format

A local agent (or a script) can make a Vida edit without the browser. The agent writes a `.vida.json` project file, checks it with `vida validate`, renders it with `vida export` or `vida captions`, and gives the same file to a person, who opens it in Vida to review it.

Vida does not choose edits. The agent (or the person who instructs it) chooses the cuts. Vida checks that the cuts are possible and renders them exactly.

## Commands

Run the commands from the Vida folder with `node bin/vida.js`, or with `npm run vida --`. After `npm link`, the command is `vida`.

```sh
node bin/vida.js validate "<project>.vida.json" [--json]
node bin/vida.js captions "<project>.vida.json" [--out <file.mp4|.srt|.vtt>]
node bin/vida.js export   "<project>.vida.json" [--out <file.mp4>]
```

| Command | What it does | Exit code |
| --- | --- | --- |
| `validate` | Reads each source with ffprobe, checks the project, and prints the clip count, length, output size, and number of caption cues. `--json` prints `{ "ok": true, ... }` or `{ "ok": false, "errors": [...] }`. | 0 valid, 1 not valid |
| `captions` | Writes `<name>.srt` and `<name>.vtt`. | 0 written, 1 error |
| `export` | Writes `<name>.mp4` (H.264, AAC), `<name>.srt`, and `<name>.vtt`. Progress goes to stderr; the result goes to stdout as JSON. Ctrl+C stops FFmpeg and deletes the partial file. | 0 written, 1 error |

The default output is `<project folder>/exports/<project file name>.mp4`. This is the same as the default in the Export dialog. The commands only read the project file. They never change the source videos, and they refuse to write an output file to the path of a source file.

`captions` and `export` validate the project first. If the project is not valid, they write nothing.

The commands do not need the Vida server. They need Node.js 20+ and FFmpeg with ffprobe (or `FFMPEG_PATH` and `FFPROBE_PATH`).

## Workflow

1. **Get sources and transcripts.** The easiest start is a project that the person made in Vida: they add the videos, make or import transcripts, and save. The agent can also write a new file (see the format below). Do not invent transcript text. Use only text from whisper.cpp, the API provider, or an SRT/VTT file for that video.
2. **Make a copy for the draft.** Do not edit a project that is open in Vida with unsaved changes. Write the draft to a new file, for example `Episode 12 (agent draft).vida.json`.
3. **Choose the cuts.** Use `sources[].transcript.segments` (and `words`, when present) to find source times. Add clips to `sequence` in the order of the final video.
4. **Validate.** Run `node bin/vida.js validate "<draft>.vida.json"`. Fix every error that it prints, then run it again.
5. **Render.** Run `node bin/vida.js captions ...` for a fast check of the caption text and times, then `node bin/vida.js export ...`.
6. **Hand over for review.** Give the person the path. They open it with **Open…**, or with `http://localhost:5178/?project=<URL-encoded absolute path>` while the server runs (`npm run serve`).

### If the person has the project open

Vida checks the project file on disk every 2 seconds and when the window gets focus. When the file changed (or was moved or deleted), Vida shows a bar above the editor:

- **Reload from disk** loads the file from disk. If the person had unsaved changes, **Undo** (Ctrl+Z) brings them back. That version is still based on the old file, so a normal **Save** of it fails (see below). To keep it, use **Save as…** or **Replace the file on disk**.
- **Save as…** writes the version in the browser to a different file.
- **Keep editing** closes the bar.

**Save** sends the revision (hash) of the file that the version in the browser is based on. If the file on disk has a different revision, the save fails, the file on disk stays the same, and the bar shows **Replace the file on disk**. Only that button (or **Save as…**) writes that version.

**What this protects, and what it does not.** The check protects against a change that is complete before the person clicks **Save**. It is not a file lock. The server compares the hash, then writes a temporary file and renames it over the project file. If another program writes the project file in the few milliseconds between the compare and the rename, that change is lost. Thus:

- Write agent edits to a **new draft file**, not to the file that the person has open.
- To change the open file, wait until the person has saved and is not editing, or ask them to close it first. Tell the person when you are done, so they can click **Reload from disk**.
- Write the whole file in one step (write a temporary file, then rename it). Vida can then never read a half-written file.

## Project format (`.vida.json`, version 1)

```json
{
  "app": "vida",
  "version": 1,
  "name": "Episode 12",
  "output": { "width": null, "height": null, "fps": null },
  "sources": [
    {
      "id": "camera",
      "path": "media/camera-B.mp4",
      "transcript": {
        "provider": "whisper.cpp",
        "segments": [
          {
            "start": 1.26, "end": 3.76, "text": "hello from the camera, this is take",
            "words": [{ "start": 1.26, "end": 1.68, "text": "hello" }]
          }
        ]
      }
    }
  ],
  "sequence": [
    { "id": "c1", "sourceId": "camera", "in": 1.11, "out": 3.91 }
  ]
}
```

### Top level

| Field | Required | Meaning |
| --- | --- | --- |
| `app` | yes | Always `"vida"`. |
| `version` | yes | `1`. Vida refuses files with a higher version. |
| `name` | no | Project name. The default is the file name. |
| `output` | no | `width`, `height`, `fps`. `null` or a missing value means "same as the source of the first clip". Width and height are rounded to even numbers. |
| `sources` | yes | List of source videos. |
| `sequence` | yes | Ordered list of clips. The first clip plays first. |
| `savedAt`, `relativePath` | no | Vida writes these when it saves. |

### Sources

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique string. Clips refer to it. |
| `path` | yes | Absolute path, or a path relative to the project file. |
| `name` | no | Display name. The default is the file name. |
| `transcript` | no | `{ provider, model?, createdAt?, segments }`. `provider` is `"whisper.cpp"`, `"openai"`, or `"imported"`. |
| `duration`, `width`, `height`, `fps`, `vcodec`, `pixFmt`, `hasAudio`, `acodec`, `size` | no | Media facts. Vida does not trust these values. Before it opens, saves, makes captions, or exports (in the commands and in the HTTP API), it reads every source file again with ffprobe and uses the facts of the file on disk. A `missing` value in the file is also ignored: a source is missing only if its file is not found. |

Transcript segments: `start` and `end` are seconds in the source video, `text` is a string, and `words` (optional) is a list of `{ start, end, text }`. Without `words`, a caption line is cut to the clip and kept when at least 0.25 s of it is inside the clip. With `words`, a word is kept when its middle is inside the clip.

### Clips (`sequence`)

| Field | Meaning |
| --- | --- |
| `id` | Unique string. |
| `sourceId` | The `id` of a source. |
| `in` | Start in source seconds. |
| `out` | End in source seconds. The clip is the range `[in, out)`. |

### Validation rules

Vida checks these rules before it opens, saves, or renders a project. The error names the clip, for example `sequence[2] (id "c3"): out 16.500 is past the end of "camera-B.mp4" (16.000 s)`.

- `sources` and `sequence` are lists. Source ids and clip ids are unique non-empty strings.
- Each source has a `path`. If the file exists, its duration must be a positive number.
- Each `sourceId` is the id of a source in the same project.
- `in` and `out` are finite numbers (not strings, not `null`).
- `0 ≤ in`, and `out` is after `in` by at least 0.1 s (the shortest clip that the editor makes).
- `out` is not more than 1 ms past the end of the source file.
- `output.width`, `output.height`, and `output.fps` are positive numbers or `null`.
- Transcript segments have numbers `start ≤ end` and a string `text`.

A source whose file is not found is allowed when you open or save the project in Vida (the source shows **file missing** and **Find file…**, so the person can relink it). Captions and export fail if a clip uses such a source.

### Timing

Export makes each clip a whole number of output frames: `frames = round((out − in) × fps)`. The clip starts at the sum of the frames before it, divided by fps. Captions use the same numbers, so they match the video. For example, at 30 fps a clip from 10.2 to 16.0 is 174 frames, and the next clip starts at 5.8 s.

## HTTP API (server must run)

The browser uses these routes. A script can use them too. The server accepts requests to `localhost` and `127.0.0.1` only.

| Route | Body | Result |
| --- | --- | --- |
| `POST /api/project/open` | `{ file }` | `{ file, project, revision }`. Reads media facts and validates. |
| `POST /api/project/save` | `{ file, project, baseRevision, overwrite }` | `{ file, revision }`. HTTP 409 with `code: "conflict"` if the file on disk does not have the revision `baseRevision`, or if it exists and `baseRevision` is `null`. HTTP 422 if the project is not valid for the media on disk. `overwrite: true` skips only the revision check. |
| `GET /api/project/revision?file=` | — | `{ revision }`. `null` if the file does not exist. |
| `POST /api/export` | `{ project, file }` | A job. Poll `GET /api/jobs/<id>` until `status` is `done` or `error`. A project that is not valid for the media on disk ends with `status: "error"` and writes nothing. |
| `POST /api/captions` | `{ project, file }` | `{ srt, vtt, cues }`. HTTP 422 if the project is not valid for the media on disk. |

`revision` is the SHA-256 of the bytes of the project file.

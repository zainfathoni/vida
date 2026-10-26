import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertValidProject } from '../public/lib/timeline.js';
import { probe } from './media.js';

export const PROJECT_EXT = '.vida.json';
export const PROJECT_VERSION = 1;

const conflict = (message) => Object.assign(new Error(message), { status: 409, code: 'conflict' });

/**
 * Checks a project against the media files on disk. The media facts in the
 * project (duration, missing, size, audio) come from the caller and can be old
 * or wrong, so Vida reads every source file again with ffprobe and uses those
 * facts. A source is missing only if its file is not found.
 * - requireMedia: false (open, save): a missing source is allowed, so the
 *   person can relink it in the UI. Its clips are not checked against a length.
 * - requireMedia: true (export, captions): every source that a clip uses must exist.
 * Returns a copy of the project with the real facts. Throws a list of all problems.
 */
export async function checkMedia(project, { requireMedia = false } = {}) {
  if (!project || !Array.isArray(project.sources) || !Array.isArray(project.sequence)) assertValidProject(project);
  const sources = [];
  for (const s of project.sources) {
    if (!s || typeof s !== 'object' || typeof s.path !== 'string' || !fs.existsSync(s.path)) {
      sources.push(s && typeof s === 'object' ? { ...s, missing: true } : s);
      continue;
    }
    try {
      sources.push({ ...s, ...(await probe(s.path)), missing: false });
    } catch (err) {
      throw Object.assign(new Error(`Cannot read source "${s.id}" (${s.path}): ${err.message}`), { status: 422 });
    }
  }
  const checked = { ...project, sources };
  assertValidProject(checked);
  if (requireMedia) {
    const errors = [];
    checked.sequence.forEach((c, i) => {
      const src = sources.find((x) => x.id === c.sourceId);
      if (src.missing) errors.push(`sequence[${i}] (id "${c.id}"): the file of source "${src.id}" is not found: ${src.path}`);
    });
    if (errors.length) throw Object.assign(new Error(`The project is not valid:\n- ${errors.join('\n- ')}`), { status: 422, errors });
  }
  return checked;
}

/** The revision of a project file is a hash of its bytes. Returns null if the file does not exist. */
export function projectRevision(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Saves the project. The file stores edit decisions and transcripts only;
 * source videos stay where they are and are never changed.
 * Each source keeps an absolute path and a path relative to the project file,
 * so a moved folder can still be opened.
 *
 * Vida checks the media (see checkMedia) and the revision before it writes:
 * - baseRevision is the revision from openProject or the last save. The file
 *   on disk must still have this revision.
 * - Without baseRevision, the file must not exist yet.
 * - overwrite: true skips the revision check. Use it only after the user agrees.
 * The check protects against changes that are complete before the save starts.
 * It is not a lock: Vida compares the hash, then writes a temporary file and
 * renames it. A program that writes the file in the few milliseconds between
 * the compare and the rename can lose its change.
 */
export async function saveProject(file, project, { baseRevision, overwrite = false } = {}) {
  if (!file.endsWith(PROJECT_EXT)) throw new Error(`The project file name must end with ${PROJECT_EXT}`);
  project = await checkMedia(project);
  const dir = path.dirname(path.resolve(file));
  if (!overwrite) {
    const current = projectRevision(file);
    if (baseRevision == null && current !== null) {
      throw conflict(`${file} already exists. Open it first, or confirm that you want to replace it.`);
    }
    if (baseRevision != null && current !== baseRevision) {
      throw conflict(current === null
        ? `${file} was moved or deleted after Vida opened it.`
        : `${file} changed on disk after Vida opened it. Your version was not saved.`);
    }
  }
  const data = {
    app: 'vida',
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    name: project.name || path.basename(file, PROJECT_EXT),
    output: project.output || {},
    sources: project.sources.map(({ missing, proxyPath, needsProxy, proxyPending, proxyJob, transcribing, ...s }) => ({
      ...s,
      path: path.resolve(s.path),
      relativePath: path.relative(dir, path.resolve(s.path)),
    })),
    sequence: project.sequence.map(({ id, sourceId, in: i, out }) => ({ id, sourceId, in: i, out })),
    selects: (project.selects || []).map(({ id, name, sourceId, in: i, out }) => ({ id, name, sourceId, in: i, out })),
  };
  fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return { ...data, revision: createHash('sha256').update(text).digest('hex') };
}

/**
 * Reads a project file. Resolves moved sources by their relative path and
 * marks sources whose file is not found as `missing`. The result has the
 * file's `revision`. It does not read the media and does not validate.
 */
export function openProject(file) {
  const bytes = fs.readFileSync(file);
  const data = JSON.parse(bytes.toString('utf8'));
  if (data.app !== 'vida') throw new Error('This is not a Vida project file ("app" must be "vida").');
  if (data.version > PROJECT_VERSION) throw new Error('This project was made by a newer version of Vida.');
  if (!Array.isArray(data.sources) || !Array.isArray(data.sequence)) throw new Error('A Vida project needs "sources" and "sequence" lists.');
  if (data.selects == null) data.selects = [];
  const dir = path.dirname(path.resolve(file));
  for (const s of data.sources) {
    if (typeof s.path === 'string') {
      s.path = path.resolve(dir, s.path);
      if (!fs.existsSync(s.path) && s.relativePath) {
        const alt = path.resolve(dir, s.relativePath);
        if (fs.existsSync(alt)) s.path = alt;
      }
    }
    if (!s.name && typeof s.path === 'string') s.name = path.basename(s.path);
    s.missing = typeof s.path !== 'string' || !fs.existsSync(s.path);
  }
  data.revision = createHash('sha256').update(bytes).digest('hex');
  return data;
}

/** Opens a project file and checks it against the media on disk (see checkMedia). */
export async function loadProject(file, options) {
  return checkMedia(openProject(file), options);
}

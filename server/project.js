import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_EXT = '.vida.json';
export const PROJECT_VERSION = 1;

/**
 * Saves the project. The file stores edit decisions and transcripts only;
 * source videos stay where they are and are never changed.
 * Each source keeps an absolute path and a path relative to the project file,
 * so a moved folder can still be opened.
 */
export function saveProject(file, project) {
  if (!file.endsWith(PROJECT_EXT)) throw new Error(`The project file name must end with ${PROJECT_EXT}`);
  const dir = path.dirname(path.resolve(file));
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
  };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return data;
}

export function openProject(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.app !== 'vida') throw new Error('This is not a Vida project file.');
  if (data.version > PROJECT_VERSION) throw new Error('This project was made by a newer version of Vida.');
  const dir = path.dirname(path.resolve(file));
  for (const s of data.sources) {
    if (!fs.existsSync(s.path) && s.relativePath) {
      const alt = path.resolve(dir, s.relativePath);
      if (fs.existsSync(alt)) s.path = alt;
    }
    s.missing = !fs.existsSync(s.path);
  }
  return data;
}

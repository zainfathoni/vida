import { randomUUID } from 'node:crypto';

const jobs = new Map();

/**
 * Starts a background job. fn receives a job handle and must return the result.
 * The UI polls /api/jobs/:id for status, progress, and the result.
 */
export function startJob(kind, label, fn) {
  const job = { id: randomUUID(), kind, label, status: 'running', progress: 0, message: '', result: null, error: null, cancel: null };
  jobs.set(job.id, job);
  const handle = {
    progress(p, message) {
      job.progress = Math.max(0, Math.min(1, p));
      if (message !== undefined) job.message = message;
    },
    onCancel(fn) {
      job.cancel = fn;
    },
    get cancelled() {
      return job.status === 'cancelled';
    },
  };
  Promise.resolve()
    .then(() => fn(handle))
    .then((result) => {
      if (job.status === 'cancelled') return;
      job.status = 'done';
      job.progress = 1;
      job.result = result;
    })
    .catch((err) => {
      if (job.status === 'cancelled') return;
      job.status = 'error';
      job.error = String(err && err.message ? err.message : err);
    });
  return job;
}

export function getJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  const { cancel, ...view } = job;
  return view;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.status = 'cancelled';
  if (job.cancel) job.cancel();
  return true;
}

// Resumable chunked upload (TDR §2, hardened after field failures), shared by
// Command feed uploads and customer footage intake (TDR §8).
//
// Every stage is labelled so a failure names the exact request that died —
// never a bare "Failed to fetch". Parts retry with backoff and a stall
// timeout; a transfer that still fails keeps its row and R2 session (no
// abort), so re-selecting the same file resumes from the last good part
// instead of restarting a multi-gigabyte upload.
import { api } from './api';
import { validateUpload, extensionOf } from './mediaPolicy';

const PART_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 4000];
const PART_STALL_TIMEOUT_MS = 10 * 60 * 1000;   // a 50 MB part at ~1 Mbps ≈ 7 min

export class UploadError extends Error {
  // `hint` is the longer "what usually causes this", kept apart so a page can
  // show it on demand.
  constructor(message, { stage, partNumber = null, totalParts = null, status = null, resumable = false, cause = null, hint = null } = {}) {
    super(message);
    this.name = 'UploadError';
    Object.assign(this, { stage, partNumber, totalParts, status, resumable, cause, hint });
  }
}

// fetch() rejects with a bare TypeError for anything network-level. Turn
// that into something a person can act on.
const NETWORK_HINT = 'Usual causes: the connection dropped, a firewall/VPN/browser extension blocked the storage host, ' +
  'or the file is a cloud placeholder (iCloud/OneDrive) that became unreadable mid-upload.';
function describeNetworkFailure(err) {
  return `the request never got a response (${err?.message || 'network error'}).`;
}

async function apiStep(stage, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UploadError) throw err;
    const status = err?.status ?? null;
    const detail = status ? `${err.message} (HTTP ${status})` : describeNetworkFailure(err);
    throw new UploadError(`${stage} failed: ${detail}`, { stage, status, resumable: stage !== 'Registering the upload', cause: err, hint: status ? null : NETWORK_HINT });
  }
}

async function putPart(url, blob, { partNumber, totalParts }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('stalled — no response within 10 minutes')), PART_STALL_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { method: 'PUT', body: blob, signal: ctl.signal });
      clearTimeout(timer);
      if (!resp.ok) {
        let body = '';
        try { body = (await resp.text()).slice(0, 200); } catch { /* opaque */ }
        throw new UploadError(
          `Uploading part ${partNumber}/${totalParts} to storage was rejected: HTTP ${resp.status}${body ? ` — ${body}` : ''}`,
          { stage: 'Uploading to storage', partNumber, totalParts, status: resp.status, resumable: true },
        );
      }
      const etag = resp.headers.get('ETag');
      if (!etag) {
        // CORS must expose ETag or multipart assembly is impossible — say so
        // instead of failing later with an opaque invalid-part error.
        throw new UploadError(
          `Part ${partNumber}/${totalParts} uploaded but the storage response hid its ETag header — the bucket CORS policy is missing 'ExposeHeaders: ETag'.`,
          { stage: 'Uploading to storage', partNumber, totalParts, resumable: false },
        );
      }
      return etag;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof UploadError && !(err.status >= 500)) throw err;   // 4xx/CORS: retrying won't help
      lastErr = err;
      if (attempt < PART_ATTEMPTS) await new Promise(r => setTimeout(r, BACKOFF_MS[attempt - 1]));
    }
  }
  if (lastErr instanceof UploadError) throw lastErr;
  throw new UploadError(
    `Uploading part ${partNumber}/${totalParts} to storage failed after ${PART_ATTEMPTS} attempts: ${describeNetworkFailure(lastErr)}`,
    { stage: 'Uploading to storage', partNumber, totalParts, resumable: true, cause: lastErr, hint: NETWORK_HINT },
  );
}

// The identity the server uses to recognise a file it has seen before (to
// resume it, or to refuse a duplicate): SHA-256 of the first MB plus the size.
export async function fileFingerprint(file) {
  const head = await file.slice(0, 1024 * 1024).arrayBuffer().catch(err => {
    throw new UploadError(
      `Could not read "${file.name}" from disk (${err?.message || 'unreadable'}) — if it lives in iCloud/OneDrive, download it fully first.`,
      { stage: 'Checking the file', resumable: false, cause: err },
    );
  });
  const digest = await crypto.subtle.digest('SHA-256', head);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') + `:${file.size}`;
}

// Send every part the server does not already hold, in order. `upload` is the
// register response's upload block: { mode, uploadId, part_size, uploaded_parts }.
async function sendParts(file, upload, { presign, putLocal, onProgress, resumed }) {
  const partSize = upload.part_size;
  const totalParts = Math.max(1, Math.ceil(file.size / partSize));
  const done = new Map((upload.uploaded_parts || []).map(p => [p.partNumber, p.etag]));
  const parts = [];
  const report = (partNumber, extra = 0) =>
    onProgress?.({
      pct: Math.min(1, ((partNumber - 1) * partSize + extra) / file.size),
      part: partNumber, totalParts, resumed: !!resumed,
    });

  for (let offset = 0, partNumber = 1; offset < file.size; offset += partSize, partNumber++) {
    const blob = file.slice(offset, offset + partSize);
    if (done.has(partNumber)) {
      parts.push({ partNumber, etag: done.get(partNumber) });   // already stored from the interrupted run
      report(partNumber, blob.size);
      continue;
    }
    if (upload.mode === 'r2') {
      const { url } = await apiStep(`Preparing part ${partNumber}/${totalParts}`, () => presign(partNumber));
      report(partNumber);
      const etag = await putPart(url, blob, { partNumber, totalParts });
      parts.push({ partNumber, etag });
    } else {
      await apiStep(`Uploading part ${partNumber}/${totalParts}`, () => putLocal(partNumber, blob));
      parts.push({ partNumber });
    }
    report(partNumber, blob.size);
  }
  return parts;
}

export async function uploadFeed(jobId, file, { label = 'Behind Home', captureProfileKey = '', onProgress } = {}) {
  const verdict = validateUpload({ name: file.name, size: file.size, type: file.type });
  if (!verdict.ok) throw new UploadError(verdict.error, { stage: 'Checking the file', resumable: false });
  const hash = await fileFingerprint(file);

  const reg = await apiStep('Registering the upload', () => api.commandRegisterFeed(jobId, {
    label, capture_profile_key: captureProfileKey,
    original_name: file.name, size_bytes: file.size, content_hash: hash,
  }));
  if (reg.duplicate) return { feed: reg.feed, duplicate: true };

  const { feed, upload } = reg;
  const parts = await sendParts(file, upload, {
    presign: n => api.commandPresignPart(feed.id, upload.uploadId, n),
    putLocal: (n, blob) => api.commandUploadLocalPart(feed.id, n, blob),
    onProgress, resumed: reg.resumed,
  });
  const result = await apiStep('Finalizing the upload', () => api.commandCompleteFeed(feed.id, upload.uploadId, parts));
  return { feed: result.feed, duplicate: false, resumed: !!reg.resumed };
}

// The browser-side check for a customer file, against the same per-kind
// rules the API enforces on register (from /api/intake/config).
export function checkIntakeFile(file, spec) {
  if (!spec) return null;
  const ext = extensionOf(file.name);
  const isVideo = spec.key === 'video';
  if (!spec.extensions.includes(ext) && !(isVideo && String(file.type).startsWith('video/'))) {
    return `“${file.name}” is not a supported ${spec.label.toLowerCase()} file. Supported: ${spec.extensions.join(' ')}`;
  }
  if (!file.size) return `“${file.name}” is empty (0 bytes) — if it lives in iCloud or OneDrive, download it fully first.`;
  if (file.size > spec.max_bytes) {
    const limit = spec.max_bytes >= 1024 ** 3 ? `${spec.max_bytes / 1024 ** 3} GB` : `${spec.max_bytes / 1024 ** 2} MB`;
    return `“${file.name}” is larger than the ${limit} limit for this file type.`;
  }
  return null;
}

// A customer file into their submission. Same engine as Command; on top:
// the server may say the file is already attached (here or on another of the
// customer's submissions), or that this is a resume of an interrupted
// transfer. A transfer that fails is marked paused so the status page says
// "choose the same file again to resume" rather than "uploading" forever.
export async function uploadIntakeFile(publicId, file, { kind, cameraView = '', label = '', spec = null, onRegistered, onProgress } = {}) {
  const problem = checkIntakeFile(file, spec);
  if (problem) throw new UploadError(problem, { stage: 'Checking the file', resumable: false });
  const hash = await fileFingerprint(file);

  const reg = await apiStep('Registering the upload', () => api.intakeRegisterFile(publicId, {
    kind, camera_view: cameraView, label, original_name: file.name, size_bytes: file.size,
    mime_type: file.type || '', content_hash: hash,
  }));
  if (reg.duplicate) return { duplicate: true, file: reg.file, elsewhere: reg.elsewhere || null, message: reg.message };

  const { file: row, upload } = reg;
  onRegistered?.(row, { resumed: !!reg.resumed });
  try {
    const parts = await sendParts(file, upload, {
      presign: n => api.intakePresignPart(row.id, upload.uploadId, n),
      putLocal: (n, blob) => api.intakeUploadLocalPart(row.id, n, blob),
      onProgress, resumed: reg.resumed,
    });
    const result = await apiStep('Finalizing the upload', () => api.intakeCompleteFile(row.id, upload.uploadId, parts));
    return { duplicate: false, file: result.file, resumed: !!reg.resumed };
  } catch (err) {
    api.intakePauseFile(row.id).catch(() => { /* the row stays resumable either way */ });
    if (err instanceof UploadError) err.fileId = row.id;
    throw err;
  }
}

export { validateUpload };

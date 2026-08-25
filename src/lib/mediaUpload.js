// Resumable chunked feed upload (TDR §2, hardened after field failures).
//
// Every stage is labelled so a failure names the exact request that died —
// never a bare "Failed to fetch". Parts retry with backoff and a stall
// timeout; a transfer that still fails keeps its feed row and R2 session
// (no abort), so re-selecting the same file resumes from the last good
// part instead of restarting a multi-gigabyte upload.
import { api } from './api';
import { validateUpload } from './mediaPolicy';

const PART_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 4000];
const PART_STALL_TIMEOUT_MS = 10 * 60 * 1000;   // a 50 MB part at ~1 Mbps ≈ 7 min

export class UploadError extends Error {
  constructor(message, { stage, partNumber = null, totalParts = null, status = null, resumable = false, cause = null } = {}) {
    super(message);
    this.name = 'UploadError';
    Object.assign(this, { stage, partNumber, totalParts, status, resumable, cause });
  }
}

// fetch() rejects with a bare TypeError for anything network-level. Turn
// that into something a person can act on.
function describeNetworkFailure(err) {
  return `the request never got a response (${err?.message || 'network error'}). ` +
    'Usual causes: the connection dropped, a firewall/VPN/browser extension blocked the storage host, ' +
    'or the file is a cloud placeholder (iCloud/OneDrive) that became unreadable mid-upload.';
}

async function apiStep(stage, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UploadError) throw err;
    const status = err?.status ?? null;
    const detail = status ? `${err.message} (HTTP ${status})` : describeNetworkFailure(err);
    throw new UploadError(`${stage} failed: ${detail}`, { stage, status, resumable: stage !== 'Registering the upload', cause: err });
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
    { stage: 'Uploading to storage', partNumber, totalParts, resumable: true, cause: lastErr },
  );
}

export async function uploadFeed(jobId, file, { label = 'Behind Home', captureProfileKey = '', onProgress } = {}) {
  const verdict = validateUpload({ name: file.name, size: file.size, type: file.type });
  if (!verdict.ok) throw new UploadError(verdict.error, { stage: 'Checking the file', resumable: false });

  const head = await file.slice(0, 1024 * 1024).arrayBuffer().catch(err => {
    throw new UploadError(
      `Could not read "${file.name}" from disk (${err?.message || 'unreadable'}) — if it lives in iCloud/OneDrive, download it fully first.`,
      { stage: 'Checking the file', resumable: false, cause: err },
    );
  });
  const digest = await crypto.subtle.digest('SHA-256', head);
  const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') + `:${file.size}`;

  const reg = await apiStep('Registering the upload', () => api.commandRegisterFeed(jobId, {
    label, capture_profile_key: captureProfileKey,
    original_name: file.name, size_bytes: file.size, content_hash: hash,
  }));
  if (reg.duplicate) return { feed: reg.feed, duplicate: true };

  const { feed, upload } = reg;
  const partSize = upload.part_size;
  const totalParts = Math.max(1, Math.ceil(file.size / partSize));
  const done = new Map((upload.uploaded_parts || []).map(p => [p.partNumber, p.etag]));
  const parts = [];
  const report = (partNumber, extra = 0) =>
    onProgress?.({
      pct: Math.min(1, ((partNumber - 1) * partSize + extra) / file.size),
      part: partNumber, totalParts, resumed: !!reg.resumed,
    });

  for (let offset = 0, partNumber = 1; offset < file.size; offset += partSize, partNumber++) {
    const blob = file.slice(offset, offset + partSize);
    if (done.has(partNumber)) {
      parts.push({ partNumber, etag: done.get(partNumber) });   // already on R2 from the interrupted run
      report(partNumber, blob.size);
      continue;
    }
    if (upload.mode === 'r2') {
      const { url } = await apiStep(`Preparing part ${partNumber}/${totalParts}`, () => api.commandPresignPart(feed.id, upload.uploadId, partNumber));
      report(partNumber);
      const etag = await putPart(url, blob, { partNumber, totalParts });
      parts.push({ partNumber, etag });
    } else {
      await apiStep(`Uploading part ${partNumber}/${totalParts}`, () => api.commandUploadLocalPart(feed.id, partNumber, blob));
      parts.push({ partNumber });
    }
    report(partNumber, blob.size);
  }

  const result = await apiStep('Finalizing the upload', () => api.commandCompleteFeed(feed.id, upload.uploadId, parts));
  return { feed: result.feed, duplicate: false, resumed: !!reg.resumed };
}

export { validateUpload };

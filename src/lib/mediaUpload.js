// Resumable chunked feed upload (TDR §2). R2 mode: presigned part PUTs
// direct to storage. Local dev mode: parts relay through the API. Dedupe:
// SHA-256 of the first MB + size registers as content hash server-side.
import { api } from './api';

export async function uploadFeed(jobId, file, { label = 'Behind Home', captureProfileKey = '', onProgress } = {}) {
  const head = await file.slice(0, 1024 * 1024).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', head);
  const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') + `:${file.size}`;

  const reg = await api.commandRegisterFeed(jobId, {
    label, capture_profile_key: captureProfileKey,
    original_name: file.name, size_bytes: file.size, content_hash: hash,
  });
  if (reg.duplicate) return { feed: reg.feed, duplicate: true };

  const { feed, upload } = reg;
  const partSize = upload.part_size;
  const parts = [];
  try {
    let partNumber = 1;
    for (let offset = 0; offset < file.size; offset += partSize, partNumber++) {
      const blob = file.slice(offset, offset + partSize);
      if (upload.mode === 'r2') {
        const { url } = await api.commandPresignPart(feed.id, upload.uploadId, partNumber);
        const resp = await fetch(url, { method: 'PUT', body: blob });
        if (!resp.ok) throw new Error(`Part ${partNumber} failed (${resp.status})`);
        parts.push({ partNumber, etag: resp.headers.get('ETag') });
      } else {
        await api.commandUploadLocalPart(feed.id, partNumber, blob);
      }
      onProgress?.(Math.min(1, (offset + blob.size) / file.size));
    }
    const done = await api.commandCompleteFeed(feed.id, upload.uploadId, parts);
    return { feed: done.feed, duplicate: false };
  } catch (err) {
    await api.commandAbortFeed(feed.id, upload.uploadId).catch(() => {});
    throw err;
  }
}

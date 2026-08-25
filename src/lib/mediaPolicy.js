// Supported-media policy for Command footage uploads. One module, used by
// the browser before any byte is sent and mirrored by the API on register,
// so the two can never disagree. Pure functions — unit-tested from node.
//
// Policy (docs/COMMAND_OPS.md §3.8):
//   Containers  .mp4 .mov .m4v .mts .m2ts
//   Codecs      anything ffmpeg decodes; H.264 and HEVC are the verified set
//   Size        hard cap 128 GB (R2 part math), advisory above 16 GB
//   Frame rate  any; VFR is normalized to CFR in the proxy

export const ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mts', '.m2ts'];
export const MAX_UPLOAD_BYTES = 128 * 1024 ** 3;       // 2,621 parts of 50 MB — well under R2's 10,000
export const ADVISORY_BYTES = 16 * 1024 ** 3;          // above this, suggest clipping before upload

const gb = n => `${(n / 1024 ** 3).toFixed(1)} GB`;

export function extensionOf(name) {
  const m = String(name || '').match(/\.[A-Za-z0-9]+$/);
  return m ? m[0].toLowerCase() : '';
}

// → { ok, error?, warning? } — error blocks the upload, warning does not.
export function validateUpload({ name, size, type = '' }) {
  const ext = extensionOf(name);
  if (!ALLOWED_EXTENSIONS.includes(ext) && !String(type).startsWith('video/')) {
    return { ok: false, error: `"${name}" is not a supported video file. Supported: ${ALLOWED_EXTENSIONS.join(' ')}` };
  }
  if (!size || size <= 0) {
    return { ok: false, error: `"${name}" is empty (0 bytes) — if it lives in iCloud/OneDrive, download it fully before uploading.` };
  }
  if (size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `"${name}" is ${gb(size)} — above the ${gb(MAX_UPLOAD_BYTES)} limit. Split the recording or re-encode before uploading.` };
  }
  if (size > ADVISORY_BYTES) {
    return { ok: true, warning: `${gb(size)} is a large upload — it will take a while and processing is slower for 4K/high-FPS sources. Consider clipping to the innings you need.` };
  }
  return { ok: true };
}

// Media storage adapter (TDR §2). Two backends:
//  - r2:    Cloudflare R2 via S3-compatible presigned multipart (prod). Zero
//           egress; short-TTL signed GET URLs for playback.
//  - local: dev-only disk backend under DM_MEDIA_DIR so the entire pipeline
//           runs without credentials; parts POST through the API.
// Selection: DM_STORAGE=r2 requires R2_* env; anything else falls back local.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, ListPartsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const MODE = process.env.DM_STORAGE === 'r2' ? 'r2' : 'local';
const LOCAL_DIR = process.env.DM_MEDIA_DIR || path.join(process.env.DM_DB_PATH ? path.dirname(process.env.DM_DB_PATH) : path.join(process.cwd(), 'server', 'data'), 'media');
if (MODE === 'local') fs.mkdirSync(LOCAL_DIR, { recursive: true });

let r2 = null;
function client() {
  if (!r2) {
    r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
  }
  return r2;
}
const BUCKET = () => process.env.R2_BUCKET;

export const storageMode = MODE;

// A half-configured bucket must never crash the service: taking the public
// site down is worse than refusing uploads. Report it instead — the upload
// guard and the ops page both read storageReady.
const R2_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
export const missingStorageConfig = MODE === 'r2' ? R2_VARS.filter(v => !process.env[v]) : [];
export const storageReady = missingStorageConfig.length === 0;
if (!storageReady) {
  console.error(JSON.stringify({
    level: 'error', event: 'storage_misconfigured',
    message: `DM_STORAGE=r2 but missing: ${missingStorageConfig.join(', ')} — uploads are refused until these are set`,
  }));
}

export function localPathFor(key) {
  const safe = key.replace(/\.\./g, '_');
  return path.join(LOCAL_DIR, safe);
}

// ── Upload session (presigned multipart on R2; API-relayed parts locally) ──
export async function createUpload(key) {
  if (MODE === 'r2') {
    const { UploadId } = await client().send(new CreateMultipartUploadCommand({ Bucket: BUCKET(), Key: key }));
    return { mode: 'r2', uploadId: UploadId };
  }
  fs.mkdirSync(path.dirname(localPathFor(key)), { recursive: true });
  fs.writeFileSync(localPathFor(key) + '.parts', '');
  return { mode: 'local' };
}

export async function presignPart(key, uploadId, partNumber) {
  return getSignedUrl(client(), new UploadPartCommand({ Bucket: BUCKET(), Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: 3600 });
}

export function appendLocalPart(key, chunk) {
  fs.appendFileSync(localPathFor(key) + '.parts', chunk);
}

// Parts already uploaded for an in-flight multipart session — lets a
// resumed transfer skip what R2 already has instead of restarting.
export async function listUploadedParts(key, uploadId) {
  if (MODE !== 'r2' || !uploadId) return [];
  const parts = [];
  let marker;
  do {
    const page = await client().send(new ListPartsCommand({ Bucket: BUCKET(), Key: key, UploadId: uploadId, PartNumberMarker: marker }));
    for (const p of page.Parts || []) parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size });
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);
  return parts;
}

export async function completeUpload(key, uploadId, parts) {
  if (MODE === 'r2') {
    await client().send(new CompleteMultipartUploadCommand({
      Bucket: BUCKET(), Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts.map(p => ({ ETag: p.etag, PartNumber: p.partNumber })) },
    }));
    return;
  }
  fs.renameSync(localPathFor(key) + '.parts', localPathFor(key));
}

export async function abortUpload(key, uploadId) {
  if (MODE === 'r2') {
    await client().send(new AbortMultipartUploadCommand({ Bucket: BUCKET(), Key: key, UploadId: uploadId })).catch(() => {});
    return;
  }
  fs.rmSync(localPathFor(key) + '.parts', { force: true });
}

// Key listing/deletion — used by backup retention, not the media path.
export async function listObjects(prefix) {
  if (MODE === 'r2') {
    const keys = [];
    let token;
    do {
      const page = await client().send(new ListObjectsV2Command({ Bucket: BUCKET(), Prefix: prefix, ContinuationToken: token }));
      for (const obj of page.Contents || []) keys.push(obj.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
  const dir = localPathFor(prefix);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(name => `${prefix}${name}`);
}

export async function deleteObject(key) {
  if (MODE === 'r2') {
    await client().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
    return;
  }
  fs.rmSync(localPathFor(key), { force: true });
}

// Round-trip proof that the configured backend actually works: write a tiny
// object, read it back, compare, delete. Verifies credentials, bucket name,
// and permissions without uploading a multi-gigabyte video first.
export async function selfTest() {
  const key = `command/_healthcheck/${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const payload = `diamond-metrics storage check ${new Date().toISOString()}`;
  const scratch = path.join(os.tmpdir(), `dm-storage-check-${process.pid}`);
  const readBack = `${scratch}.read`;
  const started = Date.now();
  const steps = [];
  try {
    fs.writeFileSync(scratch, payload);
    await putObject(key, scratch);
    steps.push('write');
    const fetched = await fetchToScratch(key, readBack);
    steps.push('read');
    if (fs.readFileSync(fetched, 'utf8') !== payload) throw new Error('content read back did not match what was written');
    steps.push('verify');
    await deleteObject(key);
    steps.push('delete');
    return { ok: true, mode: MODE, bucket: MODE === 'r2' ? BUCKET() : LOCAL_DIR, ms: Date.now() - started, steps };
  } catch (err) {
    return { ok: false, mode: MODE, bucket: MODE === 'r2' ? BUCKET() : LOCAL_DIR, ms: Date.now() - started, steps, error: String(err?.message || err) };
  } finally {
    fs.rmSync(scratch, { force: true });
    fs.rmSync(readBack, { force: true });
  }
}

export async function putObject(key, filePath) {
  if (MODE === 'r2') {
    await client().send(new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: fs.createReadStream(filePath) }));
    return;
  }
  fs.mkdirSync(path.dirname(localPathFor(key)), { recursive: true });
  fs.copyFileSync(filePath, localPathFor(key));
}

// Worker-side: materialize an object to a local scratch path for ffmpeg.
export async function fetchToScratch(key, scratchPath) {
  if (MODE === 'r2') {
    const res = await client().send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
    await fs.promises.writeFile(scratchPath, res.Body);
    return scratchPath;
  }
  return localPathFor(key);   // already on disk
}

// Playback: short-TTL signed URL (R2) or the role-gated API stream (local).
// Worker-side source access. R2: a long-TTL presigned GET that ffmpeg/
// ffprobe stream directly (range requests) — no gigabyte scratch copy, no
// page-cache OOM on a small instance. Local: the file path itself.
export async function workerSourceRef(key) {
  if (MODE === 'r2') {
    return getSignedUrl(client(), new GetObjectCommand({ Bucket: BUCKET(), Key: key }), { expiresIn: 6 * 3600 });
  }
  return localPathFor(key);
}

export async function playbackUrl(key) {
  if (MODE === 'r2') {
    return getSignedUrl(client(), new GetObjectCommand({ Bucket: BUCKET(), Key: key }), { expiresIn: 900 });
  }
  return `/api/command/media/${encodeURIComponent(key)}`;
}

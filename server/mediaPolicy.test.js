// The supported-media policy is the contract between the pre-upload check,
// the server guard, and the docs — pin it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUpload, MAX_UPLOAD_BYTES, ADVISORY_BYTES, extensionOf } from '../src/lib/mediaPolicy.js';

test('accepts the supported containers, case-insensitively', () => {
  for (const name of ['game.mp4', 'GAME.MP4', 'clip.MOV', 'cam.m4v', 'avchd.MTS', 'deck.m2ts']) {
    assert.equal(validateUpload({ name, size: 1000 }).ok, true, name);
  }
});

test('rejects non-video files with a message that names the file and the rule', () => {
  const v = validateUpload({ name: 'roster.xlsx', size: 1000 });
  assert.equal(v.ok, false);
  assert.match(v.error, /roster\.xlsx/);
  assert.match(v.error, /\.mp4/);
  // unknown extension but a video MIME type still passes (phone exports)
  assert.equal(validateUpload({ name: 'clip.weird', size: 1000, type: 'video/quicktime' }).ok, true);
});

test('rejects empty files with the cloud-placeholder hint', () => {
  const v = validateUpload({ name: 'game.mp4', size: 0 });
  assert.equal(v.ok, false);
  assert.match(v.error, /iCloud|OneDrive/);
});

test('size cap blocks, advisory warns, normal passes silently', () => {
  const over = validateUpload({ name: 'game.mp4', size: MAX_UPLOAD_BYTES + 1 });
  assert.equal(over.ok, false);
  assert.match(over.error, /128\.0 GB limit/);

  const big = validateUpload({ name: 'game.mp4', size: ADVISORY_BYTES + 1 });
  assert.equal(big.ok, true);
  assert.match(big.warning, /large upload/);

  const fine = validateUpload({ name: 'game.mp4', size: 900 * 1024 ** 2 });
  assert.deepEqual(fine, { ok: true });
});

test('extensionOf is defensive', () => {
  assert.equal(extensionOf('a.b.MP4'), '.mp4');
  assert.equal(extensionOf('noext'), '');
  assert.equal(extensionOf(null), '');
});

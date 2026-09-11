import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseProbe, withFrameAccounting, makeProbeCache } from './liveProbe.js';

// ffprobe's output for one real session's two recordings (2026-09-11): the
// relay's 720p30 live copy and the phone's 1080p60 master of the same 50 seconds.
const LIVE = {
  streams: [
    { codec_name: 'h264', profile: 'High', codec_type: 'video', width: 1280, height: 720,
      duration: '50.287578', bit_rate: '1293922', nb_frames: '1508' },
    { codec_name: 'aac', profile: 'LC', codec_type: 'audio', sample_rate: '48000', channels: 1,
      duration: '50.303979', bit_rate: '97474', nb_frames: '2358' },
  ],
  format: { duration: '50.304000', size: '8800268', bit_rate: '1399533' },
};
const MASTER = {
  streams: [
    { codec_name: 'hevc', profile: 'Main', codec_type: 'video', width: 1920, height: 1080,
      duration: '50.790000', bit_rate: '25053940', nb_frames: '3035' },
    { codec_name: 'aac', profile: 'LC', codec_type: 'audio', sample_rate: '48000', channels: 1,
      duration: '50.705083', bit_rate: '130294', nb_frames: '2378' },
  ],
  format: { duration: '50.790000', size: '159957847', bit_rate: '25195171' },
};

const flush = () => new Promise(setImmediate);

test('the live copy reads as what the relay kept: 720p30 H.264', () => {
  const p = summariseProbe(LIVE);
  assert.equal(p.width, 1280);
  assert.equal(p.height, 720);
  assert.equal(p.video_codec, 'h264');
  assert.equal(p.average_fps, 29.99, 'frame rate is counted frames over length, not the container’s claim');
  assert.equal(p.video_bit_rate, 1293922);
  assert.equal(p.audio_codec, 'aac');
  assert.equal(p.audio_sample_rate, 48000);
  assert.equal(p.audio_channels, 1);
});

test('the master reads as what the phone kept: 1080p60 HEVC', () => {
  const p = summariseProbe(MASTER);
  assert.equal(p.height, 1080);
  assert.equal(p.video_codec, 'hevc');
  assert.equal(p.video_profile, 'Main');
  assert.equal(p.average_fps, 59.76);
  assert.equal(p.video_bit_rate, 25053940);
});

test('frames are accounted against the rate the recording declared', () => {
  const master = withFrameAccounting(summariseProbe(MASTER), 60);
  assert.equal(master.frames_expected, 3047);
  assert.equal(master.frames_missing, 12);
  const live = withFrameAccounting(summariseProbe(LIVE), 30);
  assert.equal(live.frames_expected, 1508);
  assert.equal(live.frames_missing, 0, 'a partial last frame is not a dropped one');
});

test('with no declared rate there is nothing to account against', () => {
  assert.equal(withFrameAccounting(summariseProbe(LIVE), null).frames_expected, undefined);
});

test('a file with no sample table still reports what it can', () => {
  const p = summariseProbe({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }], format: { duration: '12.5' } });
  assert.equal(p.frames_counted, null);
  assert.equal(p.average_fps, null);
  assert.equal(p.duration_seconds, 12.5);
});

test('each object is probed once, and a lookup never waits for it', async () => {
  let calls = 0;
  let release;
  const lookup = makeProbeCache(() => { calls += 1; return new Promise((r) => { release = r; }); });

  const first = lookup('live', 'a.mp4', 10);
  assert.equal(first.pending, true);
  assert.equal(lookup('live', 'a.mp4', 10), first, 'a second poll joins the probe in flight');
  await flush();
  assert.equal(calls, 1);

  release({ width: 1280 });
  await flush();
  assert.deepEqual(lookup('live', 'a.mp4', 10).probe, { width: 1280 });
  assert.equal(lookup('live', 'a.mp4', 10).pending, false);
  assert.equal(calls, 1);
});

test('an object of another size is another file, and is measured again', async () => {
  let calls = 0;
  const lookup = makeProbeCache(async () => { calls += 1; return {}; });
  lookup('live', 'a.mp4', 10);
  await flush();
  lookup('live', 'a.mp4', 20);
  await flush();
  assert.equal(calls, 2);
});

test('a failure is retried after a pause, not on every poll', async () => {
  let t = 0;
  let calls = 0;
  const lookup = makeProbeCache(async () => { calls += 1; throw new Error('moov atom not found'); },
    { now: () => t, retryAfterMs: 1000 });

  lookup('live', 'a.mp4', 10);
  await flush();
  assert.equal(lookup('live', 'a.mp4', 10).error, 'moov atom not found');
  t = 500;
  lookup('live', 'a.mp4', 10);
  await flush();
  assert.equal(calls, 1);

  t = 2000;
  lookup('live', 'a.mp4', 10);
  await flush();
  assert.equal(calls, 2);
});

test('only two probes run at once', async () => {
  let active = 0;
  let peak = 0;
  const releases = [];
  const lookup = makeProbeCache(() => {
    active += 1;
    peak = Math.max(peak, active);
    return new Promise((r) => releases.push(() => { active -= 1; r({}); }));
  });

  for (const key of ['1', '2', '3', '4', '5']) lookup('live', key, 1);
  await flush();
  assert.equal(active, 2);
  while (releases.length) {
    releases.shift()();
    await flush();
  }
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

// What is actually in each recording, measured from the file itself.
//
// ffprobe reads the MP4's own index — resolution, codecs, and a frame count from
// the sample table — through the localhost media gateway, so even a two-hour
// master costs a few ranged reads, not a download. The phone declares the rate it
// recorded at; the file says how many frames it holds. The gap is dropped frames.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ENTRIES = [
  'stream=codec_type,codec_name,profile,width,height,nb_frames,bit_rate,duration,sample_rate,channels',
  'format=duration,bit_rate',
].join(':');

/** A probe over the site's bundled ffprobe, reading through its media gateway. */
export function makeProber({ ffprobe, sourceUrl, timeoutMs = 60_000 }) {
  return async (bucket, key) => {
    const url = await sourceUrl(key, bucket);
    try {
      const { stdout } = await run(ffprobe, [
        '-rw_timeout', '30000000',   // one blocked read fails rather than parking the probe (µs)
        '-v', 'error', '-show_entries', ENTRIES, '-of', 'json', url,
      ], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
      return summariseProbe(JSON.parse(stdout));
    } catch (err) {
      // execFile's message is the whole command line, gateway token included;
      // keep only ffprobe's own last word.
      if (err.killed) throw new Error('ffprobe timed out');
      const said = String(err.stderr || '').trim().split('\n').pop();
      throw new Error(said ? said.replace(url, 'recording') : 'ffprobe failed');
    }
  };
}

const positive = (v) => (Number(v) > 0 ? Number(v) : null);

/** ffprobe's JSON, reduced to what the console compares. */
export function summariseProbe(info) {
  const video = info.streams?.find((s) => s.codec_type === 'video') ?? {};
  const audio = info.streams?.find((s) => s.codec_type === 'audio') ?? {};
  const duration = positive(video.duration) ?? positive(info.format?.duration);
  const frames = positive(video.nb_frames);
  return {
    width: positive(video.width),
    height: positive(video.height),
    video_codec: video.codec_name ?? null,
    video_profile: video.profile ?? null,
    // Frames held over the file's length. r_frame_rate is only the container's
    // claim (it read 240 on one jittery file); this is a count.
    average_fps: frames && duration ? Math.round((frames / duration) * 100) / 100 : null,
    frames_counted: frames,
    duration_seconds: duration,
    video_bit_rate: positive(video.bit_rate),
    bit_rate: positive(info.format?.bit_rate),
    audio_codec: audio.codec_name ?? null,
    audio_sample_rate: positive(audio.sample_rate),
    audio_channels: positive(audio.channels),
    audio_bit_rate: positive(audio.bit_rate),
  };
}

/**
 * Frames the file should hold at the rate it was recorded at, against what it
 * does. Floored, so a partial last frame never reads as a drop.
 */
export function withFrameAccounting(probe, expectedFps) {
  if (!probe?.frames_counted || !probe.duration_seconds || !expectedFps) return probe;
  const expected = Math.floor(probe.duration_seconds * expectedFps);
  const missing = Math.max(0, expected - probe.frames_counted);
  return { ...probe, frames_expected: expected, frames_missing: missing, frame_loss: expected ? missing / expected : 0 };
}

/**
 * Recordings do not change once shipped, so each is measured once and kept. A
 * lookup never waits: it answers from the cache and, on a miss, queues the probe
 * for a later poll to find. Failures retry after a pause rather than every poll,
 * and only a couple run at once — a long game is a dozen segments on one core.
 */
export function makeProbeCache(probe, { maxConcurrent = 2, retryAfterMs = 5 * 60_000, now = Date.now } = {}) {
  const entries = new Map();
  const queue = [];
  let running = 0;

  const pump = () => {
    while (running < maxConcurrent && queue.length) {
      const job = queue.shift();
      running += 1;
      job().finally(() => { running -= 1; pump(); });
    }
  };

  return function lookup(bucket, key, bytes) {
    const id = `${bucket}/${key}`;
    const known = entries.get(id);
    const retry = known?.error && now() - known.at > retryAfterMs;
    if (known && known.bytes === bytes && !retry) return known;

    const entry = { bytes, pending: true, probe: null, error: null, at: now() };
    entries.set(id, entry);
    queue.push(() => Promise.resolve()
      .then(() => probe(bucket, key))
      .then((result) => { entry.probe = result; })
      .catch((err) => { entry.error = String(err?.message || err); })
      .finally(() => { entry.pending = false; entry.at = now(); }));
    pump();
    return entry;
  };
}

// Timecode parsing/formatting for the full-game player. These are the only
// pure pieces of the navigation, and getting them wrong sends an analyst to
// the wrong moment in a two-hour recording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimecode, parseSeek } from '../src/lib/timecode.js';

test('timecode formatting spans a full game', () => {
  assert.equal(formatTimecode(0), '0:00:00.00');
  assert.equal(formatTimecode(45.5), '0:00:45.50');
  assert.equal(formatTimecode(3661.25), '1:01:01.25');
  assert.equal(formatTimecode(7200), '2:00:00.00');
  assert.equal(formatTimecode(NaN), '0:00:00.00');
  assert.equal(formatTimecode(-5), '0:00:00.00');
  // A hundredths value that rounds to 100 must carry, not print ".100".
  assert.equal(formatTimecode(11.999), '0:00:12.00');
});

test('seek input accepts every form an analyst would type', () => {
  const fps = 59.94;
  assert.deepEqual(parseSeek('#12345', fps), { frame: 12345 });
  assert.deepEqual(parseSeek('120', fps), { frame: Math.floor(120 * fps) });      // bare seconds
  assert.deepEqual(parseSeek('2:00', fps), { frame: Math.floor(120 * fps) });     // mm:ss
  assert.deepEqual(parseSeek('1:00:00', fps), { frame: Math.floor(3600 * fps) }); // hh:mm:ss
  assert.deepEqual(parseSeek('0:01:30.5', fps), { frame: Math.floor(90.5 * fps) });
});

test('seek input rejects junk instead of jumping somewhere arbitrary', () => {
  for (const bad of ['', '   ', 'abc', '1:2:3:4:x', '#-5', '-30', '#abc']) {
    assert.equal(parseSeek(bad, 60), null, `${JSON.stringify(bad)} must not parse`);
  }
});

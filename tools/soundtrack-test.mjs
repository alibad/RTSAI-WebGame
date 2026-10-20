import assert from 'node:assert/strict';
import { Soundtrack, retiredTrack } from '../web/src/sim/soundtrack.ts';

const tracks = [{ id: 'music/rtsai-cedar-signal.ogg', title: 'Cedar Signal' },
  { id: 'music/rtsai-final-push.ogg', title: 'Final Push' },
  { id: 'music/rtsai-black-ore.ogg', title: 'Black Ore' }];
let current = tracks[0], played = [], output = [], allTracks = tracks;
const native = json => {
  const request = JSON.parse(json);
  if (request.cmd === 'music-list') return JSON.stringify({ tracks: allTracks });
  if (request.cmd === 'music-play') {
    current = allTracks.find(track => track.id === request.id) ?? current;
    played.push(current.id);
  }
  return '{}';
};
const policy = new Soundtrack(native, () => JSON.stringify({ music: current, credits: 24400 }));
assert(retiredTrack({ id: 'rtsai-final-push', title: 'Other title' }));
assert(retiredTrack({ id: 'rtsai-final-push.ogg', title: 'Other title' }));
assert(retiredTrack({ id: 'other', title: 'Final Push' }));
assert.deepEqual(JSON.parse(policy.command('{"cmd":"music-list"}')).tracks, [tracks[0], tracks[2]]);
assert(JSON.parse(policy.command(JSON.stringify({ cmd: 'music-play', id: tracks[1].id }))).error);
assert.deepEqual(played, []);
policy.command('{"cmd":"music-next"}'); assert.equal(current, tracks[2]);
policy.command('{"cmd":"music-next"}'); assert.equal(current, tracks[0]);
policy.command('{"cmd":"music-previous"}'); assert.equal(current, tracks[2]);

// Simulate native automatic rotation, including PCM emitted before UiState changes.
current = tracks[1];
policy.buffer(7, () => output.push('retired PCM'));
const ui = JSON.parse(policy.settle());
assert.equal(ui.music.id, tracks[0].id);
assert.equal(ui.credits, 24400);
assert.deepEqual(output, [], 'Not even an opening sample of the retired track reaches Web Audio');
policy.buffer(8, () => output.push('safe PCM'));
policy.event(8, () => output.push('pause'));
assert.deepEqual(output, [], 'Pause follows the buffered stream, including paused seeks');
policy.settle(); assert.deepEqual(output, ['safe PCM', 'pause']);
policy.buffer(9, () => output.push('stopped PCM'));
policy.stop(9); policy.settle(); assert.deepEqual(output, ['safe PCM', 'pause']);
policy.buffer(10, () => output.push('old-world PCM'));
policy.reset(); policy.settle(); assert.deepEqual(output, ['safe PCM', 'pause']);
allTracks = [tracks[1]]; current = tracks[1];
policy.buffer(11, () => output.push('only retired PCM'));
assert.equal(JSON.parse(policy.settle()).music, null);
assert.deepEqual(output, ['safe PCM', 'pause']);
console.log('PASS retired soundtrack: legacy catalogs, direct selection, next/previous/wrap, automatic rotation, zero retired PCM, paused seek ordering, stop/reset and empty library');

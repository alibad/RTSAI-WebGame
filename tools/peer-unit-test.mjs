import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const out = path.resolve('artifacts/peer-unit');
fs.mkdirSync(out, { recursive: true });
execFileSync(process.execPath, ['web/node_modules/typescript/bin/tsc', 'web/src/peer.ts', '--target', 'ES2022', '--module', 'ESNext', '--skipLibCheck', '--outDir', out]);
const { PeerLockstep, DirectPeer, MAX_INPUT_DELAY, inputDelay, peerOptions, peerColors, validatePeerScenario, checkSdp, routeSummary } = await import(pathToFileURL(path.join(out, 'peer.js')));

// ---- lockstep: two players, no input delay. A frame needs every player's orders; the engines' reports are compared
// as they arrive and never hold a frame back.
const order = (frame, data = 'AAAA') => ({ kind: 'orders', frame, data });
const hash = (frame, value = 123) => ({ kind: 'hash', frame, hash: value, defeat: '0' });
const completed = [], peer = new PeerLockstep(2, frame => completed.push(frame));
peer.receive(2, [order(1)]); assert.equal(completed.length, 0);
assert.deepEqual(peer.waitingFor(), [1]);
peer.receive(1, [order(1)]); assert.equal(completed.length, 1);
assert.deepEqual(completed[0].packets.map(p => p.client), [1, 2]);
peer.receive(1, [order(2)]); peer.receive(2, [order(2)]);
assert.equal(completed.length, 2, 'frames do not wait for the reports');
peer.receive(1, [hash(1)]); assert.equal(peer.checked, 0);
peer.receive(2, [hash(1)]); assert.equal(peer.checked, 1);
peer.receive(1, [hash(2)]);
assert.throws(() => peer.receive(2, [hash(2, 124)]), /Synchronization mismatch at frame 2/);
assert.equal(completed.length, 2, 'mismatch cannot advance');
assert.equal(peer.stopped, true);
assert.throws(() => peer.receive(2, [hash(2)]), /match stopped/);

// ---- input delay: the orders issued at frame n run at frame n + delay, so they travel while earlier frames play
const delayed = [], late = new PeerLockstep(2, frame => delayed.push(frame), 3);
assert.equal(late.delay, 3);
late.receive(1, [order(1, 'AAAA')]);
assert.deepEqual(delayed.map(f => f.frame), [1, 2, 3], 'the first frames run without orders');
assert.ok(delayed.every(f => f.packets.length === 2 && f.packets.every(p => p.data === '')));
assert.deepEqual(late.waitingFor(), [2], 'frame 4 waits for player 2');
late.receive(2, [order(1, 'BBBB')]);
assert.deepEqual(delayed.at(-1), { frame: 4, packets: [{ client: 1, data: 'AAAA' }, { client: 2, data: 'BBBB' }] });
late.receive(1, [order(2), order(3), order(4)]);
assert.equal(late.frame, 4, 'a player ahead of the other still waits for it');
late.receive(2, [order(2), order(3)]);
assert.equal(late.frame, 6);
assert.deepEqual(late.waitingFor(), [2]);
late.receive(1, [order(1, 'AAAA')]);   // a repeat of a frame already played is ignored
assert.throws(() => late.receive(2, [order(12)]), /Invalid peer frame/, 'no engine can be that far ahead');
// Reports arrive later than the frames they describe; the first difference names its frame.
const reported = new PeerLockstep(2, () => {}, 2);
for (let f = 1; f <= 6; f++) { reported.receive(1, [order(f)]); reported.receive(2, [order(f)]); }
assert.equal(reported.frame, 8); assert.equal(reported.checked, 0);
for (let f = 1; f <= 4; f++) { reported.receive(1, [hash(f)]); reported.receive(2, [hash(f)]); }
assert.equal(reported.checked, 4);
reported.receive(2, [hash(6)]); reported.receive(1, [hash(6)]); assert.equal(reported.checked, 4, 'frame 5 is still open');
reported.receive(1, [hash(5)]);
assert.throws(() => reported.receive(2, [hash(5, 9)]), /Synchronization mismatch at frame 5/);
// An engine that stops reporting stops the match instead of running unchecked.
const silent = new PeerLockstep(2, () => {});
assert.throws(() => { for (let f = 1; f <= 300; f++) { silent.receive(1, [order(f)]); silent.receive(2, [order(f)]); } }, /stopped reporting/);
assert.equal(silent.frame, 251);
assert.throws(() => new PeerLockstep(2, () => {}, MAX_INPUT_DELAY + 1), /input delay/);
assert.throws(() => new PeerLockstep(2, () => {}, -1), /input delay/);
// The delay for a line: 40 ms frames, one frame of room. Nearby players get the floor of two frames.
assert.deepEqual([0, 20, 40, 41, 75, 100, 150, 5000, NaN].map(inputDelay), [2, 2, 2, 3, 3, 4, 5, MAX_INPUT_DELAY, 3]);
const fresh = (n = 2) => new PeerLockstep(n, () => {});
assert.throws(() => fresh().receive(3, [order(1)]), /Invalid peer packet/);
assert.throws(() => fresh().receive(0, [order(1)]), /Invalid peer packet/);
assert.throws(() => fresh().receive(1, [order(3)]), /Invalid peer frame/);
assert.throws(() => fresh().receive(1, [{ ...order(1), data: '!invalid!' }]), /Invalid peer orders/);
assert.throws(() => fresh().receive(1, Array.from({ length: 17 }, () => order(1))), /Invalid peer packet/);
const duplicate = fresh(); duplicate.receive(1, [order(1)]); duplicate.receive(1, [order(1)]);
assert.throws(() => duplicate.receive(1, [{ ...order(1), data: 'BBBB' }]), /Conflicting peer orders/);
assert.throws(() => fresh().receive(1, [{ ...hash(1), hash: 2147483648 }]), /Invalid peer synchronization/);
assert.throws(() => fresh().receive(1, [null]), /Invalid peer event/);
const repeatedHash = fresh(); repeatedHash.receive(1, [hash(1)]);
assert.throws(() => repeatedHash.receive(1, [hash(1, 999)]), /Conflicting peer synchronization/);
assert.throws(() => new PeerLockstep(1, () => {}), /player count/);

// ---- lockstep: three players, frames wait for the slowest
const three = [], trio = new PeerLockstep(3, f => three.push(f));
trio.receive(1, [order(1)]); trio.receive(3, [order(1)]); assert.equal(three.length, 0);
trio.receive(2, [order(1)]); assert.deepEqual(three.map(f => f.packets.map(p => p.client)), [[1, 2, 3]]);
trio.receive(1, [order(2)]); trio.receive(2, [order(2)]); assert.deepEqual(trio.waitingFor(), [3]);
trio.receive(3, [order(2)]); assert.equal(three.length, 2);
trio.receive(1, [hash(1)]); trio.receive(2, [hash(1)]); assert.equal(trio.checked, 0, 'third report still missing');
trio.receive(3, [hash(1)]); assert.equal(trio.checked, 1);
trio.receive(1, [hash(2)]); trio.receive(2, [hash(2)]);
assert.throws(() => trio.receive(3, [hash(2, 7)]), /Synchronization mismatch at frame 2/);

// ---- scenarios: humans first, then bots, in slot order
const catalog = { maps: [{ id: 'arena', uid: 'map-sha', slots: ['Multi0', 'Multi1'] }, { id: 'fronts', uid: 'fronts-sha', slots: ['Multi0', 'Multi1', 'Multi2', 'Multi3'] }],
  factions: [{ id: 'china', random: false }, { id: 'iran', random: false }, { id: 'yemen', random: false }, { id: 'Random', random: true }], bots: [{ type: 'normal' }, { type: 'hard' }] };
const human = (faction, i) => ({ client: i + 1, slot: `Multi${i}`, faction, spawn: i + 1, team: 0, color: peerColors[i] });
const scenario = { multiplayer: true, map: 'arena', mapUid: 'map-sha', seed: 123, options: { ...peerOptions }, players: ['china', 'iran'].map(human) };
assert.deepEqual(validatePeerScenario(scenario, catalog), scenario);
const withBots = { ...scenario, map: 'fronts', mapUid: 'fronts-sha', players: [...['china', 'iran', 'yemen'].map(human), { bot: 'hard', slot: 'Multi3', faction: 'iran', spawn: 4, team: 2, color: peerColors[3] }] };
assert.deepEqual(validatePeerScenario(withBots, catalog), withBots);
assert.throws(() => validatePeerScenario(null, catalog), /Invalid peer match settings/);
for (const patch of [{ map: 'unknown' }, { mapUid: 'different-map' }, { seed: 2147483647 }, { players: [] }, { players: [human('china', 0)] }, { options: { ...peerOptions, cheats: 'True' } }]) assert.throws(() => validatePeerScenario({ ...scenario, ...patch }, catalog));
for (const patch of [{ faction: 'Random' }, { faction: 'unknown' }, { spawn: 50 }, { client: 2 }, { team: 999 }, { slot: 'Multi1' }, { color: 'bad' }, { bot: 'normal' }]) assert.throws(() => validatePeerScenario({ ...scenario, players: [{ ...scenario.players[0], ...patch }, scenario.players[1]] }, catalog), /Invalid peer players/);
const bot = withBots.players[3];
for (const patch of [{ bot: 'cheater' }, { client: 4 }]) assert.throws(() => validatePeerScenario({ ...withBots, players: [...withBots.players.slice(0, 3), { ...bot, ...patch }] }, catalog), /Invalid peer players/);
assert.throws(() => validatePeerScenario({ ...withBots, players: [withBots.players[0], bot, withBots.players[1]] }, catalog), /Invalid peer players/, 'a bot cannot sit between humans');
assert.throws(() => validatePeerScenario({ ...scenario, players: [...scenario.players, { ...bot, slot: 'Multi2', spawn: 3, color: peerColors[2] }] }, catalog), /Invalid peer players/, 'more players than slots');
for (const sdp of ['invalid', '', 42, 'v=0\r\nm=audio 9\r\n', 'x'.repeat(30000)]) assert.throws(() => checkSdp(sdp));
const sdp = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
assert.equal(checkSdp(sdp), sdp);

// ---- connection hygiene
globalThis.MediaStream = class { getTracks() { return []; } getTrackById() { return null; } addTrack() {} };
globalThis.RTCPeerConnection = class { signalingState = 'stable'; remoteDescription = {}; localDescription = null; close() { this.closed = true; } getTransceivers() { return []; } };
const connection = new DirectPeer([]), channel = { close() { this.closed = true; } };
connection.pc.ondatachannel({ channel });
let fatal = '';
connection.onClose = reason => { fatal = reason; };
channel.onmessage({ data: '[]' });
assert.match(fatal, /Invalid peer message/); assert.equal(connection.pc.closed, true); assert.equal(channel.closed, true);
const answered = new DirectPeer([]);
await assert.rejects(answered.answer(sdp), /answering again/);
await assert.rejects(answered.accept(sdp), /already answered/);
answered.close();

// ---- what a failed join reports about each side's routes (multiplayer.ts joinFailed): kinds and NAT, never addresses
const candidate = (kind, address, port, protocol = 'udp') => `a=candidate:1 1 ${protocol} 1686052607 ${address} ${port} typ ${kind}${kind === 'srflx' ? ' raddr 0.0.0.0 rport 0' : ''} generation 0`;
const description = (...lines) => ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', ...lines].join('\r\n');
const home = routeSummary(description(candidate('host', 'a1b2.local', 50000), candidate('host', 'a1b2.local', 9, 'tcp'), candidate('srflx', '203.0.113.5', 60474)));
assert.deepEqual(home, { routes: 'host,srflx', nat: 'keeps one port' });
const carrier = routeSummary(description(candidate('host', 'c3d4.local', 50001), candidate('srflx', '198.51.100.7', 31001), candidate('srflx', '198.51.100.7', 31877)));
assert.deepEqual(carrier, { routes: 'host,srflx', nat: 'new port per server' });
// The game's offer has audio, video and data sections, each on its own socket: three public ports, one per socket.
const sections = (...per) => ['v=0', ...per.flatMap((lines, i) => [`m=${['audio', 'video', 'application'][i]} 9 UDP/TLS/RTP/SAVPF 111`, ...lines])].join('\r\n');
assert.equal(routeSummary(sections(...[40001, 40002, 40003].map((p, i) => [candidate('host', 'a1b2.local', 50000 + i), candidate('srflx', '203.0.113.5', p)]))).nat, 'keeps one port');
// Two network interfaces in one section: two sockets, two public ports, still one port per socket.
assert.equal(routeSummary(description(candidate('host', 'a1b2.local', 50000), candidate('host', 'f9e8.local', 50001), candidate('srflx', '203.0.113.5', 40001), candidate('srflx', '203.0.113.5', 40002))).nat, 'keeps one port');
assert.deepEqual(routeSummary(description(candidate('host', 'e5f6.local', 50002))), { routes: 'host', nat: 'no public route' });
assert.deepEqual(routeSummary(null), { routes: 'none', nat: 'no public route' });
assert(!JSON.stringify([home, carrier]).match(/\d+\.\d+\.\d+\.\d+|\.local/), 'no address leaves the summary');

// Matchmaking itself is Firestore; its access rules are tested in RTSAI-Web (tools/firestore-rules-test.mjs).
console.log('PASS N-player lockstep with input delay, scenarios with AI, connection hygiene, and failed-join route summaries.');

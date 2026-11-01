// A guest's failed join is reported once, to the owner's event log (multiplayer.ts joinFailed), in a real browser with
// real WebRTC connections and the matchmaker stubbed: the host never answers; the direct line never opens (the host's
// answer names unreachable routes); a join that connects reports nothing; neither does a guest who gives up, nor an
// expired invite. The report names the step, the routes each side offered and their NAT, and never an address.
//   node tools/join-failure-browser-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from '../web/node_modules/typescript/lib/typescript.js';
import { browserArgs, browserExecutable } from './browser-launch.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(pathToFileURL(process.env.RTSAI_PLAYWRIGHT_MODULE ?? path.join(repo, 'web/node_modules/playwright-core/index.mjs')).href);
const js = (file, replace = (s) => s) => ts.transpileModule(replace(fs.readFileSync(path.join(repo, 'web/src', file), 'utf8')),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;

// The session with its neighbours stubbed (window.__test drives the matchmaker), and a 3 s wait for the direct line.
const files = {
  '/peer.js': js('peer.ts'),
  '/multiplayer.js': js('multiplayer.ts', (s) => s
    .replace(/import \{ useStore \} from '\.\/store';/, `const useStore = { getState: () => ({ setup: { multiplayer: true, maps: [], factions: [] }, profile: 'public', phase: 'setup' }), subscribe: () => () => {} };`)
    .replace(/import \{ buildIdentity \} from '\.\/sim\/build-identity';/, `const buildIdentity = async () => 'test-build';`)
    .replace(/import \{[^}]*\} from '\.\/net\/matchmaker';/, `const { answerJoin, closeMatch, createMatch, joinMatch, removeJoin, watchJoins } = window.__test.matchmaker;`)
    .replace(/import \{ track \} from '\.\/net\/track';/, `const track = (name, props) => window.__test.tracked.push({ name, props });`)
    .replace(/import \{ savedMap \} from '\.\/net\/saved-maps';/, `const savedMap = async () => null;`)
    .replace("from './peer';", "from './peer.js';")
    .replace('OPEN_WAIT_MS = 20000', 'OPEN_WAIT_MS = 3000')),
  '/index.html': '<!doctype html><title>join failure</title>',
};
for (const [name, code] of Object.entries(files)) if (name.endsWith('.js')) assert(!/from '\.\/(store|sim|net)/.test(code), `${name}: an import was not stubbed`);

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('http://join.test/**', (r) => {
    const body = files[new URL(r.request().url()).pathname];
    return body ? r.fulfill({ body, contentType: body.startsWith('<!doctype') ? 'text/html' : 'text/javascript' }) : r.fulfill({ status: 404 });
  });
  await page.goto('http://join.test/index.html');
  await page.evaluate(async () => {
    const T = window.__test = { tracked: [], answer: null, joinError: null };
    T.matchmaker = {
      joinMatch: async (_room, _version, offer) => { if (T.joinError) throw Error(T.joinError); T.offer = offer; return { answer: (ms) => T.answer(offer, ms), cancel: async () => {} }; },
      answerJoin: async () => {}, closeMatch: async () => {}, createMatch: async () => 'ABCDEF', removeJoin: async () => {}, watchJoins: async () => () => {},
    };
    const { MultiplayerSession } = await import('/multiplayer.js');
    const { DirectPeer } = await import('/peer.js');
    T.session = () => new MultiplayerSession({ client: { on() {} } });
    // A real host in this page: it answers the guest's offer with its own real routes...
    T.realHost = async (offer) => { const host = new DirectPeer(); T.host = host; return host.answer(offer); };
    // ...or a host that goes away right after answering, naming routes no one can reach: TEST-NET addresses behind a
    // carrier-like NAT (a new public port per server). Nothing answers the guest's checks, so the line never opens.
    T.deadHost = async (offer) => { const answer = await T.realHost(offer); T.host.close(); T.host = null; return T.unreachable(answer); };
    T.unreachable = (answer) => answer.split('\r\n').filter((l) => !l.startsWith('a=candidate:')).flatMap((l) => l.startsWith('m=application')
      ? [l, 'a=candidate:1 1 udp 2122260223 192.0.2.1 9 typ host generation 0', 'a=candidate:2 1 udp 1686052607 192.0.2.2 31001 typ srflx raddr 0.0.0.0 rport 0', 'a=candidate:3 1 udp 1686052607 192.0.2.2 31877 typ srflx raddr 0.0.0.0 rport 0'] : [l]).join('\r\n');
    T.run = async (answer, { leaveWhileConnecting } = {}) => {
      T.tracked.length = 0; T.answer = answer;
      const s = T.session();
      // Give up half a second into the direct connection, as a player pressing Cancel would.
      if (leaveWhileConnecting) s.subscribe(() => { if (s.snapshot().status === 'Connecting directly…') setTimeout(() => s.leave(false), 500); });
      await s.join('ABCDEF');
      await new Promise((r) => setTimeout(r, 4000)); // past the direct line's wait: nothing late may appear
      const result = { view: s.snapshot(), tracked: structuredClone(T.tracked) };
      s.leave(false); T.host?.close(); T.host = null;
      return result;
    };
  });
  const run = (answer, extra = {}) => page.evaluate(([a, e]) => { const T = window.__test; T.joinError = e.joinError ?? null; return T.run(T[a] ?? (async () => { throw Error("Your host didn't respond. Check that they still have the match open."); }), e); }, [answer, extra]);
  const noAddress = (props) => assert(!/\d+\.\d+\.\d+\.\d+|\.local\b|[0-9a-f]{1,4}:[0-9a-f]{1,4}:/i.test(JSON.stringify(props)), `an address leaked: ${JSON.stringify(props)}`);

  // 1. The host never answers.
  let r = await run('silentHost');
  assert.equal(r.tracked.length, 1, JSON.stringify(r.tracked));
  assert.equal(r.tracked[0].name, 'game_error');
  assert.equal(r.tracked[0].props.where, 'network');
  assert.equal(r.tracked[0].props.message, 'Multiplayer join failed: the host never answered');
  assert.equal(r.tracked[0].props.side, 'guest');
  assert.match(r.tracked[0].props.shown, /didn't respond/);
  assert.match(r.view.error, /didn't respond/);
  noAddress(r.tracked[0].props);
  console.log('PASS host never answers:', JSON.stringify(r.tracked[0].props));

  // 2. The direct line never opens: reported once, with both sides' routes and NAT.
  r = await run('deadHost');
  assert.equal(r.tracked.length, 1, JSON.stringify(r.tracked));
  const p = r.tracked[0].props;
  assert.equal(p.message, 'Multiplayer join failed: the direct line never opened');
  assert.match(p.your_routes, /host/);
  assert.equal(p.host_routes, 'host,srflx');
  assert.equal(p.host_nat, 'new port per server');
  assert(['new', 'checking', 'failed', 'disconnected'].includes(p.ice), p.ice);
  assert(p.seconds >= 2 && p.seconds <= 6, `seconds ${p.seconds}`);
  assert.match(r.view.error, /Couldn't connect/);
  noAddress(p);
  console.log('PASS direct line never opens:', JSON.stringify(p));

  // 3. A real host: the line opens, the guest says hello, nothing is reported.
  r = await run('realHost');
  assert.deepEqual(r.tracked, []);
  assert.equal(r.view.error, '');
  console.log('PASS a join that connects reports nothing');

  // 4. The guest gives up while connecting: no report, and no late error on screen.
  r = await run('deadHost', { leaveWhileConnecting: true });
  assert.deepEqual(r.tracked, []);
  assert.equal(r.view.stage, 'idle'); assert.equal(r.view.error, '');
  console.log('PASS a guest who gives up is not a failure');

  // 5. An expired invite is the matchmaker's answer, not a network failure.
  r = await run('realHost', { joinError: 'This invite has expired or the host closed the match. Ask your host for a new link.' });
  assert.deepEqual(r.tracked, []);
  assert.match(r.view.error, /expired/);
  console.log('PASS an expired invite is not reported');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
console.log('PASS failed joins are reported once, with routes and no addresses.');

// Acceptance for the normal two-mode game, including the original-country assets.
// Use --project-art-only only for an intentionally reduced developer fixture.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { checkProfile } from './ea-gate.mjs';
import { verifySpriteBundle } from './public-sprite-inputs.mjs';
const root = path.resolve(process.argv[2] || 'data');
const fallback = process.argv.includes('--project-art-only');
const profiles = [];
for (const id of ['public', 'public-classic']) {
  const dir = path.join(root, id);
  const profile = { id, dir };
  assert.ok(fs.existsSync(dir), `Missing gameplay mode: ${id}`);
  const bundle = verifySpriteBundle(profile);
  const originals = checkProfile(profile);
  if (id === 'public' && !fallback) {
    assert.ok(originals?.files > 0, 'Normal isometric game is missing original-country art; this is the substitute-art fallback');
    assert.ok(originals.audio?.files > 0, 'Normal isometric game is missing original-country voices');
  }
  if (id === 'public-classic') assert.equal(originals, null, 'Classic uses its project content');
  profiles.push({ id, bundle, originals });
}
console.log(JSON.stringify({ passed: true, variant: fallback ? 'explicit-project-only-fixture' : 'normal-game', profiles }));

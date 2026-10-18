import crypto from 'node:crypto';

const identityPattern = /^(public(?:-classic)?):(aot|interp):[a-f0-9]{64}:[a-f0-9]{64}$/;
export function validateArchive(version) {
  if (!identityPattern.test(version?.identity ?? '')
    || !/^https:\/\/[a-f0-9]{8}\.rtsai-play-cdn\.pages\.dev\/$/.test(version.assetHost ?? '')
    || !/^rt-[a-f0-9]{12}\/$/.test(version.rtRoot ?? '')
    || !/^data-[a-f0-9]{12}\/$/.test(version.dataRoot ?? '')
    || (version.clientRoot !== undefined && !/^saved-clients\/[a-f0-9]{7,40}\/$/.test(version.clientRoot)))
    throw Error('Invalid saved-game archive entry');
  return version;
}

/** The manifest only names verified published bytes, and retains every earlier saved-game version. */
export async function createSaveVersionCatalog(previous, builds, fetcher = fetch) {
  if (previous && (previous.schema !== 1 || !Array.isArray(previous.versions))) throw Error('Invalid existing saved-game catalog');
  const versions = new Map((previous?.versions ?? []).map(v => [validateArchive(v).identity, v]));
  const hashes = new Map();
  async function digest(url) {
    if (!hashes.has(url)) hashes.set(url, (async () => {
      const response = await fetcher(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw Error(`Saved-game archive is unavailable (${response.status}): ${url}`);
      return crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    })());
    return hashes.get(url);
  }
  for (const build of builds) {
    for (const profile of build.profiles) {
      const runtime = 'aot';
      const [simulator, content] = await Promise.all([
        digest(`${build.assetHost}${build.rtRoot}${profile}/${runtime}/_framework/runtime-identity.json`),
        digest(`${build.assetHost}${build.dataRoot}${profile}/web-bundle.pack`),
      ]);
      const version = validateArchive({ identity: `${profile}:${runtime}:${simulator}:${content}`,
        assetHost: build.assetHost, rtRoot: build.rtRoot, dataRoot: build.dataRoot, ...(build.clientRoot ? { clientRoot: build.clientRoot } : {}) });
      if (!versions.has(version.identity)) versions.set(version.identity, version);
    }
  }
  return { schema: 1, versions: [...versions.values()] };
}

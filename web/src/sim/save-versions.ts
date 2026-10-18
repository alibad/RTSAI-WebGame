/** Published, immutable engine/content pairs. A saved battle keeps its rules when the live game changes. */
export interface SaveVersion {
  identity: string;
  assetHost: string;
  rtRoot: string;
  dataRoot: string;
  /** Frozen compatible UI/worker, served on the same origin so the browser's saved battles stay available. */
  clientRoot?: string;
}
export interface SaveVersionCatalog { schema: 1; versions: SaveVersion[] }

export function parseIdentity(identity: string) {
  const match = /^(public(?:-classic)?):(aot|interp):([a-f0-9]{64}):([a-f0-9]{64})$/.exec(identity);
  return match ? { profile: match[1], runtime: match[2], simulator: match[3], content: match[4] } : null;
}

export function validSaveVersion(value: unknown): value is SaveVersion {
  if (!value || typeof value !== 'object') return false;
  const v = value as SaveVersion;
  return typeof v.identity === 'string' && !!parseIdentity(v.identity)
    && typeof v.assetHost === 'string' && /^https:\/\/[a-f0-9]{8}\.rtsai-play-cdn\.pages\.dev\/$/.test(v.assetHost)
    && /^rt-[a-f0-9]{12}\/$/.test(v.rtRoot) && /^data-[a-f0-9]{12}\/$/.test(v.dataRoot)
    && (v.clientRoot === undefined || /^saved-clients\/[a-f0-9]{7,40}\/$/.test(v.clientRoot));
}

export function currentGameUrl(href: string) {
  const url = new URL('./', href);
  url.pathname = url.pathname.replace(/saved-clients\/[a-f0-9]{7,40}\/$/, '');
  return url;
}

let catalog: Promise<SaveVersionCatalog> | null = null;
export function saveVersions(): Promise<SaveVersionCatalog> {
  return catalog ??= fetch(new URL('save-versions.json', currentGameUrl(location.href)), { cache: 'no-cache', signal: AbortSignal.timeout(30000) })
    .then(async response => {
      if (!response.ok) throw Error('The saved battle’s game files could not be reached. Your save has been kept; try again when connected.');
      const value = await response.json() as SaveVersionCatalog;
      if (value.schema !== 1 || !Array.isArray(value.versions) || !value.versions.every(validSaveVersion))
        throw Error('The saved-game version list is invalid. Your save has been kept.');
      return value;
    }).catch(error => { catalog = null; throw error; });
}

/** Only the site's published catalog can select executable engine files, never an imported save or arbitrary URL. */
export async function findSaveVersion(identity: string) {
  if (!parseIdentity(identity)) return null;
  return (await saveVersions()).versions.find(v => v.identity === identity) ?? null;
}

export async function gameAssets(profile: string, runtime: string) {
  const identity = new URLSearchParams(location.search).get('saveVersion');
  if (!identity) return { rtBase: import.meta.env?.VITE_RT_BASE || 'rt/', dataBase: import.meta.env?.VITE_DATA_BASE || 'data/' };
  const version = await findSaveVersion(identity);
  const parsed = parseIdentity(identity);
  if (!version || parsed?.profile !== profile || parsed.runtime !== runtime)
    throw Error('The original game files for this save are unavailable. Your saved battle has been kept.');
  return { rtBase: version.assetHost + version.rtRoot, dataBase: version.assetHost + version.dataRoot };
}

export function savedBattleUrl(href: string, version: SaveVersion, id: string, readonly: boolean) {
  const parsed = parseIdentity(version.identity)!;
  const url = new URL(version.clientRoot ?? './', currentGameUrl(href));
  url.searchParams.set('profile', parsed.profile);
  url.searchParams.set('runtime', parsed.runtime);
  url.searchParams.set('mode', 'skirmish');
  url.searchParams.set('saveVersion', version.identity);
  url.searchParams.set('openMatch', id);
  if (readonly) url.searchParams.set('watch', '1');
  return url;
}

import { currentGameUrl, parseIdentity } from './save-versions';

export interface RecoveredBattlefield {
  schema: 1;
  identity: string;
  map: string;
  files: Record<string, string>;
  notice: string;
}

/** Only reviewed, same-origin recovery exports can repair a legacy save that omitted its map. */
export async function recoverBattlefield(identity: string, map: string): Promise<RecoveredBattlefield | undefined> {
  const version = parseIdentity(identity);
  if (!version || !/^map-[a-f0-9]{16}$/.test(map)) return undefined;
  const name = `${map}.${version.simulator.slice(0, 12)}.${version.content.slice(0, 12)}.json`;
  const response = await fetch(new URL(`saved-maps/${name}`, currentGameUrl(location.href)), { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw Error('The battlefield recovery files could not be reached. Try again when connected.');
  const value = await response.json() as RecoveredBattlefield;
  if (value.schema !== 1 || value.identity !== identity || value.map !== map || typeof value.notice !== 'string'
    || !value.files || typeof value.files !== 'object' || !value.files['map.yaml'] || !value.files['map.bin']
    || Object.entries(value.files).some(([key, data]) => !/^[a-zA-Z0-9_.-]+$/.test(key) || typeof data !== 'string'))
    throw Error('These recovery files do not match this saved battle.');
  return value;
}

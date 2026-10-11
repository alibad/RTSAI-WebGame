export async function buildIdentity(profile: string, runtime: string) {
  const base = new URL('./', location.href);
  const digest = async (path: string) => {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error('Cannot identify this simulator. Reload before connecting.');
    const bytes = await response.arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
  };
  const folder = profile ? profile + '/' : '';
  const simulator = await digest(`${import.meta.env.VITE_RT_BASE ?? 'rt/'}${folder}${runtime}/_framework/runtime-identity.json`);
  const content = await digest(`${import.meta.env.VITE_DATA_BASE ?? 'data/'}${folder}web-bundle.pack`);
  return `${profile}:${runtime}:${simulator}:${content}`;
}

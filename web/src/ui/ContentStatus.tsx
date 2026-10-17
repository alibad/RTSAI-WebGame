import { useEffect, useState } from 'react';

type Status = { revision: string; savedRevision: string; verified: boolean; current: boolean };
/** Only the local shared-content server exposes this identity. Public releases keep their own release status. */
export function ContentStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => void fetch(new URL('api/content-status', location.href), { signal: controller.signal, cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(setStatus).catch(() => {});
    refresh(); const timer = setInterval(refresh, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  if (!status) return null;
  return <aside className="menu-notice" aria-label="Local content status" role="status">
    <strong>Local content {status.revision.slice(0, 10)}</strong> · Built · {status.verified ? 'Verified in desktop + web' : 'Verification pending'}
    <br />{status.current ? 'Saved content matches this build. Classic + RA2.' : `New edits saved (${status.savedRevision.slice(0, 10)}). Rebuild in Studio; this session keeps its rules.`}
  </aside>;
}

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { GameButton } from "./kit/game";

// A release later retires older asset roots from the CDN, and a tab left open on an earlier release then asks for files
// that are gone (missing files answer 404 since the CDN has a 404.html). Every release publishes BUILD.json beside the
// page: when its roots differ from the ones this page was built with, offer a reload. Never forced: the player may be
// in the middle of a battle.
const RT_BASE = import.meta.env.VITE_RT_BASE as string | undefined;
const DATA_BASE = import.meta.env.VITE_DATA_BASE as string | undefined;
const CHECK_EVERY_MS = 10 * 60_000;

export function newerRelease(build: { rtRoot?: unknown; dataRoot?: unknown } | null, rtBase = RT_BASE, dataBase = DATA_BASE) {
  if (!build || typeof build.rtRoot !== "string" || typeof build.dataRoot !== "string" || !rtBase || !dataBase) return false;
  return !rtBase.endsWith(build.rtRoot) || !dataBase.endsWith(build.dataRoot);
}

export function ReleaseNotice({ playing }: { playing: boolean }) {
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    if (import.meta.env.VITE_STATIC_BUILD !== "1" || newer) return;
    const controller = new AbortController();
    const check = () => {
      if (document.hidden) return;
      void fetch(new URL("BUILD.json", location.href), { cache: "no-store", signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null)).then((b) => { if (newerRelease(b)) setNewer(true); }).catch(() => {});
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", check);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [newer]);
  if (!newer) return null;
  return (
    <div className="release-notice" role="status" data-ui-sfx>
      <RefreshCw size={15} aria-hidden="true" />
      <span>{playing ? "New version ready. Reload after this battle." : "New version ready."}</span>
      <GameButton size="sm" variant={playing ? "secondary" : "primary"} onClick={() => location.reload()}>Reload</GameButton>
    </div>
  );
}

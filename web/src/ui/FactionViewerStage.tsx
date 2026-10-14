// The unit on the simulator's card, drawn by the website's own Faction viewer (RTSAI-Web ViewerStage and its FrameStore,
// through the "@site" alias: the same files rtsai.net/viewer runs). Turn it, play its actions, recolour it. Its data
// is the viewer's export (web/public/viewer/<faction>.json, tools/sync-viewer.mjs); its art is the site's published
// art. Units the viewer has no art for show their portrait or the engine's cameo.

import { useEffect, useState, type CSSProperties } from "react";
import { FrameStore } from "@site/app/components/art/review/frames";
import { ViewerStage } from "@site/app/components/art/viewer/ViewerStage";
import "@site/app/components/art/viewer/viewer.css";

type ViewerUnit = { id: string; art: { spec: unknown; sprite: unknown } | null };
type ViewerFaction = { id: string; units: ViewerUnit[] };

const factions = new Map<string, Promise<ViewerFaction | null>>();
function viewerFaction(faction: string) {
  let p = factions.get(faction);
  if (!p) {
    p = fetch(new URL(`viewer/${faction}.json`, new URL("./", location.href))).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    factions.set(faction, p);
  }
  return p;
}

// One frame cache for the page: the cards come and go, the decoded art stays.
let frames: InstanceType<typeof FrameStore> | null = null;
const frameStore = () => { if (!frames) { frames = new FrameStore(); frames.revive(); } return frames; };

export function FactionViewerStage({ unit, faction, fallback, color = "F21818", interactive = false }: {
  unit: string; faction: string; fallback: string | null; color?: string; interactive?: boolean;
}) {
  const [data, setData] = useState<ViewerFaction | null>(null);
  const [tint, setTint] = useState(color);
  useEffect(() => { let live = true; void viewerFaction(faction).then((d) => { if (live) setData(d); }); return () => { live = false; }; }, [faction]);
  useEffect(() => setTint(color), [color]);
  const u = data?.units.find((x) => x.id.toLowerCase() === unit.toLowerCase());
  if (!u?.art) return fallback ? <img src={fallback} alt="" draggable={false} /> : <div className="sim-card-blank" />;
  const item = { key: u.id, spec: u.art.spec, sprite: u.art.sprite };
  return (
    <div className="site-viewer" data-interactive={interactive} style={{ "--side-tint": `#${tint}` } as CSSProperties}>
      <ViewerStage frames={frameStore()} item={item} color={tint} onColor={setTint} />
    </div>
  );
}

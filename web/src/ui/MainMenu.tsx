import { useState, type ReactNode } from "react";
import { BookOpen, Check, ChevronRight, Crosshair, Globe2, LoaderCircle, Map as MapIcon, MonitorX, Swords, X } from "lucide-react";
import { EA_NOTICE } from "../legal";
import { useStore } from "../store";
import { gpuInfo } from "../gpu";

// The main menu: the battlefield drifting behind, the battlefield view to play in, and the game's choices as cards.
// Images live in public/menu (cropped from real matches by the game itself), relative to the page.

interface View { id: "isometric" | "classic"; name: string; hint: string; image: string }
const VIEWS: View[] = [
  { id: "isometric", name: "Isometric", hint: "Diamond grid · the Red Alert 2 look", image: "menu/isometric.webp" },
  { id: "classic", name: "Classic / top-down", hint: "Square grid · the original Red Alert look", image: "menu/classic.webp" },
];

/** A static build only offers the modes it was built with (tools/build-public.mjs, VITE_GAME_MODES). */
function offered(view: View) {
  if (import.meta.env.VITE_STATIC_BUILD !== "1") return true;
  return (import.meta.env.VITE_GAME_MODES ?? "public").split(",").includes(view.id === "classic" ? "public-classic" : "public");
}

function MenuCard({ title, text, image, icon, wide, onClick }: { title: string; text: string; image?: string; icon: ReactNode; wide?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={wide ? "menu-card wide" : "menu-card"} onClick={onClick}>
      {image && <span className="menu-card-art" style={{ backgroundImage: `url("${image}")` }} aria-hidden="true" />}
      <span className="menu-card-brackets" aria-hidden="true"><i /><i /><i /><i /></span>
      <span className="menu-card-icon" aria-hidden="true">{icon}</span>
      <span className="menu-card-body"><b>{title}</b><small>{text}</small></span>
      <ChevronRight className="menu-card-go" size={wide ? 20 : 26} aria-hidden="true" />
    </button>
  );
}

/** The browser is drawing without the graphics card (gpu.ts): say so, and how to fix it, until the player hides it. */
function GpuNotice() {
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem("rtsai.gpuNotice") === "hidden"; } catch { return false; } });
  if (hidden || !gpuInfo().software) return null;
  const hide = () => { setHidden(true); try { sessionStorage.setItem("rtsai.gpuNotice", "hidden"); } catch { /* private mode */ } };
  return (
    <div className="menu-gpu" role="status">
      <MonitorX size={18} aria-hidden="true" />
      <p><b>Your graphics card isn't being used, so the game will feel slow.</b> Restart your browser. If that doesn't help, turn on <i>Use graphics acceleration when available</i> in its settings (Chrome and Edge: Settings → System).</p>
      <button type="button" onClick={hide} aria-label="Hide this notice"><X size={16} /></button>
    </div>
  );
}

export function MainMenu({ onSkirmish, onCampaign, onSimulator, onEditor, onEarth }: { onSkirmish: () => void; onCampaign: () => void; onSimulator: () => void; onEditor: () => void; onEarth: () => void }) {
  const profile = useStore((s) => s.profile);
  const current = profile === "public-classic" ? "classic" : "isometric";
  const [switching, setSwitching] = useState<View["id"] | null>(null);
  const views = VIEWS.filter(offered);

  // A different view is a different game profile: the page reloads into it.
  function choose(view: View) {
    if (view.id === current || switching) return;
    setSwitching(view.id);
    const url = new URL(location.href);
    url.searchParams.set("game", view.id);
    url.searchParams.set("profile", view.id === "classic" ? "public-classic" : "public");
    location.assign(url);
  }

  return (
    <div className="menu-root" data-ui-sfx>
      <div className="menu-backdrop" style={{ backgroundImage: 'url("menu/backdrop.webp")' }} aria-hidden="true" />
      <div className="menu-shade" aria-hidden="true" />
      <main className="menu-content">
        <header className="menu-title">
          <span className="menu-eyebrow">Modern real-time strategy</span>
          <h1>RTS <b>AI</b></h1>
        </header>
        <GpuNotice />
        {views.length > 1 && <section className="menu-views" aria-label="Gameplay mode">
          <span className="menu-eyebrow">Battlefield view</span>
          <div className="menu-view-row">
            {views.map((view) => {
              const selected = view.id === current;
              return (
                <button key={view.id} type="button" className="view-tile" aria-label={view.name} aria-pressed={selected} data-selected={selected} disabled={!!switching && switching !== view.id} onClick={() => choose(view)}>
                  <img src={view.image} alt="" draggable={false} />
                  <span className="view-tile-label"><b>{view.name}</b><small>{view.hint}</small></span>
                  {selected && <span className="view-tile-badge"><Check size={12} strokeWidth={3} /> Selected</span>}
                  {switching === view.id && <span className="view-tile-switching"><LoaderCircle className="menu-spin" size={18} /> Switching…</span>}
                </button>
              );
            })}
          </div>
        </section>}
        <section className="menu-cards" aria-label="Play">
          <MenuCard title="Skirmish" text="Pick a nation, build a base, defeat the AI." image="menu/skirmish.webp" icon={<Swords size={22} />} onClick={onSkirmish} />
          <MenuCard title="Campaign" text="Lines of Hope · Follow the story through missions and films." image="menu/campaign.webp" icon={<BookOpen size={22} />} onClick={onCampaign} />
        </section>
        <div className="menu-row">
          <MenuCard wide title="Battle simulator" text="Any map, any forces: drop them in, command one side against the AI." icon={<Crosshair size={20} />} onClick={onSimulator} />
          <MenuCard wide title="Map editor" text="Open, paint and build maps, make random ones, or turn any real place into a battlefield." icon={<MapIcon size={20} />} onClick={onEditor} />
        </div>
        <button type="button" className="menu-earth" onClick={onEarth}><Globe2 size={18} aria-hidden="true" /><span><b>Play a real place</b><small>Search the world, choose an area, generate and play.</small></span><ChevronRight size={18} aria-hidden="true" /></button>
        <p data-testid="ea-notice" className="menu-notice">{EA_NOTICE}</p>
        <p className="menu-notice"><a href="credits.html" target="_blank" rel="noopener">Credits &amp; licenses</a></p>
      </main>
    </div>
  );
}

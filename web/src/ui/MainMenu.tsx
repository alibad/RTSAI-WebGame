import { useState, type ReactNode } from "react";
import { BookOpen, Check, ChevronRight, FlaskConical, LoaderCircle, Map as MapIcon, Swords } from "lucide-react";
import { EA_NOTICE } from "../legal";
import { useStore } from "../store";

// The main menu: the battlefield drifting behind, the battlefield view to play in, and the game's choices as cards.
// Images live in public/menu (cropped from real matches by the game itself), relative to the page.

interface View { id: "isometric" | "classic"; name: string; hint: string; image: string }
const VIEWS: View[] = [
  { id: "isometric", name: "Isometric", hint: "Diamond grid · the Red Alert 2 look", image: "menu/isometric.webp" },
  { id: "classic", name: "Classic / top-down", hint: "Square grid · the original Red Alert look", image: "menu/classic.webp" },
];

// Top-down draws the same unit and building art as isometric (only the ground changes), so players saw two choices
// that looked the same. The menu leaves it out until it has its own art; ?game=classic still opens it, and from there
// the menu offers the way back.
const IN_MENU: View["id"][] = ["isometric"];

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

export function MainMenu({ onSkirmish, onCampaign, onWorkshop, onMapStudio }: { onSkirmish: () => void; onCampaign: () => void; onWorkshop: () => void; onMapStudio?: () => void }) {
  const profile = useStore((s) => s.profile);
  const current = profile === "public-classic" ? "classic" : "isometric";
  const [switching, setSwitching] = useState<View["id"] | null>(null);
  const views = VIEWS.filter((view) => offered(view) && (IN_MENU.includes(view.id) || view.id === current));

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
          <MenuCard title="Campaign" text="Lines of Hope · two story arcs, six operations." image="menu/campaign.webp" icon={<BookOpen size={22} />} onClick={onCampaign} />
        </section>
        <div className="menu-row">
          <MenuCard wide title="Scenario workshop" text="Set up a practice battle, then play it." icon={<FlaskConical size={20} />} onClick={onWorkshop} />
          {onMapStudio && <MenuCard wide title="Map studio" text={import.meta.env.VITE_STATIC_BUILD === "1" ? "Turn any real place into a battlefield, then play it here or with friends." : "Browse the map library or make a battlefield from a real place."} icon={<MapIcon size={20} />} onClick={onMapStudio} />}
        </div>
        <p data-testid="ea-notice" className="menu-notice">{EA_NOTICE}</p>
      </main>
    </div>
  );
}

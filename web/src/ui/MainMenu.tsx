import { useState, type ReactNode } from "react";
import { BookOpen, ChevronRight, Crosshair, Map as MapIcon, MonitorX, Swords, X } from "lucide-react";
import { EA_NOTICE } from "../legal";
import { gpuInfo } from "../gpu";
import { useStore } from '../store';
import { ContentStatus } from './ContentStatus';

// One entry to the game; Classic remains available through existing links and saved matches.
// Images live in public/menu, relative to the page.

function MenuCard({ title, text, image, icon, wide, onClick, disabled }: { title: string; text: string; image?: string; icon: ReactNode; wide?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={wide ? "menu-card wide" : "menu-card"} onClick={onClick} disabled={disabled}>
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

export function MainMenu({ onSkirmish, onCampaign, onSimulator, onEditor }: { onSkirmish: () => void; onCampaign: () => void; onSimulator: () => void; onEditor: () => void }) {
  const classic = useStore(s => s.setup?.modId === 'rtsai-classic-core');
  return (
    <div className="menu-root" data-ui-sfx>
      <div className="menu-backdrop" style={{ backgroundImage: 'url("menu/backdrop.webp")' }} aria-hidden="true" />
      <div className="menu-shade" aria-hidden="true" />
      <main className="menu-content">
        <header className="menu-title">
          <span className="menu-eyebrow">{classic ? 'Classic · OpenRA' : 'Modern real-time strategy'}</span>
          <h1>RTS <b>AI</b></h1>
        </header>
        <GpuNotice />
        <section className="menu-cards" aria-label="Play">
          <MenuCard title="Skirmish" text="Pick a nation, build a base, defeat the AI." image="menu/skirmish.webp" icon={<Swords size={22} />} onClick={onSkirmish} />
          <MenuCard title="Campaign" text={classic ? 'Classic campaigns are available in the desktop game.' : 'Lines of Hope · Follow the story through missions and films.'} disabled={classic} image="menu/campaign.webp" icon={<BookOpen size={22} />} onClick={onCampaign} />
        </section>
        <div className="menu-row">
          <MenuCard wide title="Battle simulator" text="Any map, any forces: drop them in, command one side against the AI." icon={<Crosshair size={20} />} onClick={onSimulator} />
          <MenuCard wide title="Map editor" text="Open, paint and build maps, make random ones, or turn any real place into a battlefield." icon={<MapIcon size={20} />} onClick={onEditor} />
        </div>
        <p data-testid="ea-notice" className="menu-notice">{EA_NOTICE}</p>
        <p className="menu-notice"><a href="credits.html" target="_blank" rel="noopener">Credits &amp; licenses</a></p>
        <ContentStatus />
      </main>
    </div>
  );
}

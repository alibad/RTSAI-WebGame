import portraits from "../portraits.json";
import { useStore } from "../store";

/** Keep the complete original art visible, with its name in a separate row. */
export function UnitPortrait({ type, label, icon }: { type: string; label: string; icon?: string | null }) {
  const profile = useStore((s) => s.profile);
  const faction = useStore((s) => s.info?.players.find((p) => p.name === s.info?.localPlayer)?.faction);
  const key = type === "dog" ? `dog-${faction}` : type;
  const portrait = profile === "public" ? (portraits as Record<string, { file: string }>)[key] : undefined;
  if (!portrait) return icon ? <img src={icon} alt="" draggable={false} /> : <div className="portrait-fallback">{label}</div>;
  return <>
    <img src={`./portraits/${portrait.file}`} alt="" draggable={false} />
    <span className="portrait-label" title={label}>{label}</span>
  </>;
}

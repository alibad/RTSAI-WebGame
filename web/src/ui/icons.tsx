// Small project-drawn silhouettes for the sidebar tabs and command buttons (24 x 24, currentColor).

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const S = (props: P, d: string) => (
  <svg viewBox="0 0 24 24" width={22} height={22} fill="currentColor" aria-hidden {...props}><path d={d} /></svg>
);

/** Factory with a chimney (Building queue). */
export const BuildingIcon = (p: P) => S(p, "M2 21V11l5 3V11l5 3V11l5 3V4h3v17Z M5 17h2v2H5Zm4 0h2v2H9Zm4 0h2v2h-2Z");
/** Turret on a pad (Support / defences). */
export const DefenseIcon = (p: P) => S(p, "M3 21v-3h18v3Z M6 17v-4a6 6 0 0 1 12 0v4Z M13 9.2 20.5 6l.6 1.4L14 10.6Z");
/** Rifleman (Infantry). */
export const InfantryIcon = (p: P) => S(p, "M12 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z M9 8.5h6l1 6h-2l-.4 7h-3.2L10 14.5H8Z M15.5 9l5.5-3 .6 1-5.4 3.4Z");
/** Tank (Vehicle). */
export const VehicleIcon = (p: P) => S(p, "M3 15h18l-2 4H5Z M6 11h10v3H6Z M11 10.5h2l7.5-2.2.4 1.4-7.9 2.3Z M2.5 15.5h19");
/** Jet (Aircraft). */
export const AircraftIcon = (p: P) => S(p, "M12 2c.9 0 1.4 1.4 1.4 3.4V9l7.6 5v2l-7.6-2.4V18l2.2 1.7V21L12 20l-3.6 1v-1.3L10.6 18v-4.4L3 16v-2l7.6-5V5.4C10.6 3.4 11.1 2 12 2Z");
/** Warship (Ship). */
export const ShipIcon = (p: P) => S(p, "M2 15h20l-3 5H5Z M6 11h9v3H6Z M9 7h3v3H9Z M15 12h2.5l2-2.5.9.6L18.5 13H15Z");

export const QUEUE_ICONS: Record<string, (p: P) => React.JSX.Element> = {
  Building: BuildingIcon,
  Support: DefenseIcon,
  Defense: DefenseIcon,
  Infantry: InfantryIcon,
  Vehicle: VehicleIcon,
  Aircraft: AircraftIcon,
  Ship: ShipIcon,
};

/** Wrench (repair mode). */
export const RepairIcon = (p: P) => S(p, "M21 6.5a5 5 0 0 1-6.6 4.7L6 19.6a2 2 0 0 1-2.8-2.8l8.4-8.4A5 5 0 0 1 17.5 2l-3 3 .6 2.9 2.9.6Z");
/** Coin with a dollar sign (sell mode). */
export const SellIcon = (p: P) => S(p, "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-.9 4v1.2c-1.9.3-3.1 1.5-3.1 3 0 1.9 1.5 2.6 3.1 3v3.2c-.9-.2-1.7-.7-2.1-1.4L7.6 16c.7 1.1 2 1.8 3.5 2V19h1.8v-1.1c2-.3 3.3-1.5 3.3-3.2 0-2-1.6-2.7-3.3-3.1V8.6c.7.2 1.2.5 1.6 1l1.4-1.1c-.7-.8-1.7-1.3-3-1.4V6Zm0 3c-.9.2-1.3.7-1.3 1.2 0 .6.4 1 1.3 1.3Zm1.8 4.9v2.6c1-.2 1.5-.7 1.5-1.3 0-.7-.5-1-1.5-1.3Z");
export const StopIcon = (p: P) => S(p, "M6 6h12v12H6Z");
export const DeployIcon = (p: P) => S(p, "M12 4a8 8 0 0 1 7.4 5H17l3 4 3-4h-1.5A10 10 0 0 0 3 9.5l1.9.6A8 8 0 0 1 12 4Zm0 16a8 8 0 0 1-7.4-5H7l-3-4-3 4h1.5A10 10 0 0 0 21 14.5l-1.9-.6A8 8 0 0 1 12 20Z");
export const GuardIcon = (p: P) => S(p, "M12 2 21 5.5V12c0 5-3.8 8.9-9 10-5.2-1.1-9-5-9-10V5.5Z");
export const AttackMoveIcon = (p: P) => S(p, "M12 2v4.1A6 6 0 0 1 17.9 11H22v2h-4.1A6 6 0 0 1 13 17.9V22h-2v-4.1A6 6 0 0 1 6.1 13H2v-2h4.1A6 6 0 0 1 11 6.1V2Zm0 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z");
export const ScatterIcon = (p: P) => S(p, "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM3 3h6L7 5l3 3-2 2-3-3-2 2Zm18 0v6l-2-2-3 3-2-2 3-3-2-2ZM3 21v-6l2 2 3-3 2 2-3 3 2 2Zm18 0h-6l2-2-3-3 2-2 3 3 2-2Z");
export const PowerIcon = (p: P) => S(p, "M13 2 4 14h7l-1 8 9-12h-7Z");

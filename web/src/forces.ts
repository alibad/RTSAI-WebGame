// Which militaries a real place involves, for a mission on the fly: the forces named in the public sources around
// it (OpenStreetMap operators, Wikipedia articles: "hosts the United States Air Force") and the country it is in,
// mapped onto the game's nations, then the likely threat: that side's regional rival. Both stay editable.

import { geocode } from "./place-search";

export interface Force { id: string; why: string }

/** Forces named in text: the first pattern that matches gives the nation. */
const NAMED: [RegExp, string][] = [
  [/\b(United States|U\.?S\.? (military|forces|Air Force|Navy|Army|Marines?|base)|USAF|CENTCOM|American)\b/i, "america"],
  [/\b(Royal Air Force|Royal Navy|British Army|British|RAF)\b/, "england"],
  [/\b(French|Armée)\b/i, "france"],
  [/\b(Bundeswehr|German|Luftwaffe)\b/i, "germany"],
  [/\b(Republic of Korea|South Korea|Korean)\b/i, "korea"],
  [/\b(Russian|Russia)\b/i, "russia"],
  [/\b(People's Liberation Army|PLA|Chinese)\b/, "china"],
  [/\b(Islamic Revolutionary Guard|IRGC|Iranian|Iran)\b/i, "iran"],
  [/\b(Royal Saudi|Saudi)\b/i, "saudi"],
  [/\b(Turkish|Türk)\b/i, "turkey"],
  [/\b(Israel Defense Forces|IDF|Israeli)\b/, "israel"],
  [/\b(Houthi|Ansar Allah|Yemeni)\b/i, "yemen"],
  [/\b(Hezbollah|Hizbullah)\b/i, "hezbollah"],
  [/\b(Iraqi)\b/i, "iraq"],
  [/\b(Libyan)\b/i, "libya"],
  [/\b(Cuban)\b/i, "cuba"],
];

/** The country a place is in (ISO 3166 alpha-2) -> the nation that holds it; Gulf states without a nation of their own
 * fight as their bloc's (the GCC: Saudi Arabia). */
const HOME: Record<string, string> = {
  us: "america", gb: "england", fr: "france", de: "germany", kr: "korea", cu: "cuba", ly: "libya", iq: "iraq", ru: "russia",
  sa: "saudi", ir: "iran", cn: "china", tr: "turkey", il: "israel", ye: "yemen", lb: "hezbollah",
  qa: "saudi", ae: "saudi", bh: "saudi", kw: "saudi", om: "saudi",
};

/** Each nation's likeliest opponent in the game's world, first match among the nations present. */
const RIVALS: Record<string, string[]> = {
  america: ["iran", "russia", "china"], england: ["russia", "iran"], france: ["russia", "libya"], germany: ["russia"],
  korea: ["china", "russia"], russia: ["america", "germany", "turkey"], china: ["america", "korea"],
  iran: ["america", "israel", "saudi"], saudi: ["iran", "yemen"], turkey: ["russia", "iran"], israel: ["hezbollah", "iran"],
  yemen: ["saudi", "america"], hezbollah: ["israel"], iraq: ["america", "iran"], libya: ["france", "america"], cuba: ["america"],
};

const NAME: Record<string, string> = {
  america: "the United States", england: "Britain", france: "France", germany: "Germany", korea: "Korea", cuba: "Cuba",
  libya: "Libya", iraq: "Iraq", russia: "Russia", saudi: "Saudi Arabia", iran: "Iran", china: "China", turkey: "Turkey",
  israel: "Israel", yemen: "the Houthis", hezbollah: "Hezbollah",
};
export const forceName = (id: string) => NAME[id] ?? id;

/** The defender (the forces at the place, else its country's) and the attacker (the defender's rival), with reasons. */
export function inferForces(country: string | null, sources: { text: string; from: string }[], playable: string[]): { defender: Force; attacker: Force } | null {
  const ok = (id: string | undefined): id is string => !!id && playable.includes(id);
  const named: Force[] = [];
  for (const s of sources)
    for (const [re, id] of NAMED) {
      const m = s.text.match(re);
      if (m && ok(id) && !named.some((f) => f.id === id)) named.push({ id, why: `“${m[0]}” in ${s.from}` });
    }
  const home = country ? HOME[country.toLowerCase()] : undefined;
  const homeForce = ok(home) ? { id: home, why: `the country it is in (${country!.toUpperCase()})` } : null;
  // A foreign force named at the site holds it (a host nation's base used by an ally); else the country's own.
  const defender = named.find((f) => f.id !== home && homeForce && !(RIVALS[f.id] ?? []).includes(home!)) ?? homeForce ?? named[0];
  if (!defender) return null;
  const rivalNamed = named.find((f) => (RIVALS[defender.id] ?? []).includes(f.id));
  const rival = rivalNamed?.id ?? (RIVALS[defender.id] ?? []).find(ok);
  if (!rival) return null;
  return { defender, attacker: { id: rival, why: rivalNamed ? rivalNamed.why : `the regional rival of ${forceName(defender.id)}` } };
}

/** The country code of a place (OpenStreetMap's Nominatim), or null offshore or offline. */
export async function countryAt(lat: number, lon: number, signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await geocode<{ address?: { country_code?: string } }>("reverse", { zoom: "3", lat: String(lat), lon: String(lon) }, signal);
    return r?.address?.country_code ?? null;
  } catch { return null; }
}

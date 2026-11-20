// The adviser's tech tree for one player. adviser-tree.json holds every faction's items and adviser-rosters.json which
// faction fields which (both written by tools/sync-adviser-tree.mjs from the companion's tech tree).
import adviserTree from "./adviser-tree.json";
import adviserRosters from "./adviser-rosters.json";
import { baseType, type AdviserObservation, type AdviserTechItem } from "./adviser";

const rosterSets = Object.values(adviserRosters as Record<string, string[]>).map((items) => new Set(items));
const rosterKinds = new Set(rosterSets.flatMap((roster) => [...roster]));
let treeCache: { key: string; tree: Record<string, AdviserTechItem> } | null = null;
/**
 * The tech tree of the player's own faction, not of all sixteen: the adviser names units from it ("the Barracks
 * trains Basij Riflemen", not "G.I.s" for Iran). The faction is read from what the player owns and can build: the
 * rosters holding the most of it. Several can fit (the five original Allies share their opening); their items are
 * all kept. Nothing recognised yet: the whole tree, as before.
 */
export function adviserTreeFor(observation: Pick<AdviserObservation, "units" | "buildings" | "availableProduction">): Record<string, AdviserTechItem> {
  const kinds = [...new Set([...observation.units, ...observation.buildings].map((actor) => baseType(actor.kind)).concat(observation.availableProduction.map(baseType)))].filter((kind) => rosterKinds.has(kind)).sort();
  const key = kinds.join(",");
  if (treeCache?.key === key) return treeCache.tree;
  const scores = rosterSets.map((roster) => kinds.filter((kind) => roster.has(kind)).length), best = Math.max(0, ...scores);
  const fits = best > 0 ? rosterSets.filter((_, i) => scores[i] === best) : [];
  const tree = fits.length && fits.length < rosterSets.length ? Object.fromEntries(Object.entries(adviserTree as Record<string, AdviserTechItem>).filter(([item]) => fits.some((roster) => roster.has(item)))) : adviserTree as Record<string, AdviserTechItem>;
  treeCache = { key, tree };
  return tree;
}

// How the HUD shows a selected actor: its name, and whether its picture is the engine's cameo or the actor itself
// drawn from its own sprites (Renderer.renderActor) because its art has no real cameo.

/** The nine countries that field the original Westwood art in the isometric game (docs/DEPLOY-PUBLIC.md). */
export const ORIGINAL_COUNTRIES = new Set(["america", "germany", "england", "france", "korea", "cuba", "libya", "iraq", "russia"]);

/**
 * Actors Westwood drew no cameo for: Red Alert 2 never builds a Construction Yard (an MCV deploys into one), so the
 * mod gives the original countries' yards a stand-in, a crane on a plate (RTSAI-Mod tools/standalone-art.py). The
 * modern nations' yards have the base kit's real cameos.
 */
const NO_ORIGINAL_CAMEO = new Set(["gacnst", "nacnst"]);

/** The name the HUD shows for an actor type: the engine's, else a plain word; never the type id. */
export function actorName(type: string, labels: ReadonlyMap<string, string>, building: boolean) {
  return labels.get(type) || (building ? "Structure" : "Unit");
}

/**
 * Whether the HUD draws the actor itself instead of the engine's cameo for its type: when the engine has no cameo for
 * it (`icon` null), or for a Construction Yard whose cameo would be wrong. The engine draws a type's cameo in the local
 * player's art (Ui.cs Icon): an original country's player gets the stand-in, a modern nation's player gets its own
 * nation's yard, right for its own yards only. The Classic view draws the base kit's yards, which all have cameos.
 */
export function drawsActor(type: string, icon: string | null | undefined, localFaction: string | undefined, ownerFaction: string | undefined, profile: string) {
  if (icon === null) return true;
  if (!NO_ORIGINAL_CAMEO.has(type) || profile === "public-classic") return false;
  return ORIGINAL_COUNTRIES.has(localFaction ?? "") || (!!ownerFaction && ownerFaction !== localFaction);
}

/** An actor's drawn picture is kept per type and owner: the owner's art and colours. */
export const pictureKey = (type: string, owner: number) => `${type}@${owner}`;

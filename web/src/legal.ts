/**
 * Legal notices shown in the game UI. The public isometric game draws the nine original countries with original
 * Westwood art and gives them their original unit voices and sounds (the Attack Dog barks with its original clips for
 * every faction) under EA's Command & Conquer Franchise Modding Guidelines (free, non-commercial), which require this
 * notice; tools/build-public.mjs also writes it to the static root's NOTICE file. No C&C music is used.
 */
export const EA_NOTICE =
  "Original Command & Conquer art, unit voices and sounds are used under EA's free, non-commercial modding guidelines. EA has not endorsed and does not support this product.";

/** The GPL source of this exact build: the commit of RTSAI-WebGame it was built from. NOTICE names the other sources. */
const commit = import.meta.env.VITE_GAME_COMMIT;
export const SOURCE_URL = `https://github.com/alibad/RTSAI-WebGame${commit ? `/tree/${commit}` : ""}`;

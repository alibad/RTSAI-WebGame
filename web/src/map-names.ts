// Names for the engine's random maps (MapGen.cs titles them "<landscape> <4 digits>", and the landscape is already a
// chip of its own). A name is drawn from the map's seed and landscape alone, so every browser that makes the same map
// (a multiplayer guest makes the host's map from its request) shows the same name. The map files keep the engine's
// title: the map uid hashes them, and multiplayer matches maps by uid.

type Words = { first: string[]; second: string[]; nouns: string[] };

/** Word lists per landscape, by the landscape names MapGen.cs reports ("Mountain lakes"). */
const LANDSCAPES: Record<string, Words> = {
  "Lakes": {
    first: ["Cold", "Still", "Clear", "Grey", "Silver", "Mist", "Reed", "Swan", "Heron", "Black", "Glass", "Deep", "Pike", "Otter", "Willow", "Rush", "Teal", "Blue"],
    second: ["water", "mere", "brook", "wash", "fen", "haven", "bay"],
    nouns: ["Basin", "Shallows", "Narrows", "Shore", "Reach", "Inlet", "Sound", "Crossing", "Strand", "Isles", "Banks", "Landing", "Fords", "Waters", "Bay"],
  },
  "Ponds": {
    first: ["Reed", "Mud", "Rain", "Duck", "Moss", "Willow", "Cress", "Lily", "Marsh", "Sedge", "Peat", "Mill", "Rush", "Alder", "Mallard", "Newt", "Bitter", "Green"],
    second: ["pool", "mere", "well", "spring", "fen", "mire", "brook"],
    nouns: ["Fens", "Pools", "Marsh", "Hollow", "Mire", "Bottoms", "Meadows", "Springs", "Flats", "Crossing", "Wetlands", "Bog", "Reeds", "Fords"],
  },
  "Plains": {
    first: ["Wind", "Gold", "Dust", "Wheat", "Long", "Broad", "Far", "Sun", "Barley", "Red", "Amber", "Flint", "Lark", "Plough", "Thistle", "Corn", "Oat", "Bright", "Harrow"],
    second: ["field", "ford", "mead", "stead", "worth", "ley", "acre"],
    nouns: ["Fields", "Flats", "Steppe", "Expanse", "Downs", "Prairie", "Crossing", "Road", "Line", "Front", "Run", "Reach", "Meadows", "Junction"],
  },
  "Parkland": {
    first: ["Oak", "Elm", "Lime", "Rose", "Ivy", "Fair", "Green", "Bright", "Hazel", "Beech", "Laurel", "Linden", "Maple", "Kings", "Bell", "Swan", "Queens", "Holly"],
    second: ["field", "gate", "wick", "ley", "mead", "dale", "brook"],
    nouns: ["Park", "Gardens", "Commons", "Grove", "Glade", "Meadows", "Lawns", "Estate", "Chase", "Walk", "Arbor", "Crossing", "Row"],
  },
  "Woodlands": {
    first: ["Oak", "Pine", "Ash", "Thorn", "Briar", "Fern", "Moss", "Raven", "Wolf", "Elk", "Black", "Dark", "Birch", "Alder", "Yew", "Fox", "Owl", "Bracken", "Cedar", "Hart"],
    second: ["wood", "holt", "hurst", "shaw", "grove", "den", "field"],
    nouns: ["Woods", "Forest", "Thicket", "Timberline", "Wilds", "Hollow", "Clearing", "Weald", "Copse", "Trail", "Pines", "Glen", "Deepwood", "Crossing"],
  },
  "Rocky hills": {
    first: ["Flint", "Stone", "Grey", "Crag", "Slate", "Iron", "Rust", "Red", "Shale", "Hawk", "Scree", "Cinder", "Copper", "Bramble", "Chalk", "Rook", "Bleak", "Granite"],
    second: ["back", "rock", "hill", "tor", "cleft", "knoll", "barrow", "stone"],
    nouns: ["Hills", "Bluffs", "Crags", "Tors", "Knolls", "Rise", "Ridges", "Rocks", "Uplands", "Outcrop", "Scarp", "Barrens", "Spur", "Heights", "Breaks"],
  },
  "Mountain lakes": {
    first: ["Cold", "Frost", "Ice", "High", "Snow", "Clear", "Silver", "Grey", "Eagle", "Pine", "Stone", "Mist", "Echo", "Iron", "Glass", "Cloud", "White", "Raven"],
    second: ["water", "mere", "tarn", "fall", "spring", "brook", "lake", "pool"],
    nouns: ["Tarns", "Basin", "Gap", "Pass", "Falls", "Meres", "Heights", "Shore", "Narrows", "Hollow", "Reach", "Divide", "Watershed", "Highlands"],
  },
  "Mountains": {
    first: ["Iron", "Storm", "Thunder", "Eagle", "Frost", "Grey", "Black", "High", "Stone", "Wolf", "Ice", "Cloud", "Raven", "Hammer", "Anvil", "Hawk", "Granite", "Bitter"],
    second: ["crest", "peak", "horn", "fell", "crag", "spire", "cliff"],
    nouns: ["Pass", "Gap", "Ridge", "Heights", "Peaks", "Divide", "Spur", "Saddle", "Summit", "Notch", "Escarpment", "Crags", "Range", "Cliffs", "Ascent"],
  },
  "Open ground": {
    first: ["Dust", "Sand", "Salt", "Bare", "Wind", "Sun", "Long", "Broad", "Far", "Pale", "Bone", "Ash", "Chalk", "Glass", "Dry", "White"],
    second: ["flat", "field", "pan", "reach", "march", "moor", "stead"],
    nouns: ["Flats", "Expanse", "Field", "Plain", "Pan", "Barrens", "Steppe", "Front", "Line", "Crossing", "Range", "Run", "Waste", "Proving Ground"],
  },
};

/** For a landscape this list does not know (a newer generator): neutral words that fit any terrain. */
const ANY: Words = {
  first: ["Iron", "Stone", "Grey", "Red", "Black", "Silver", "Storm", "Wolf", "Raven", "Hawk", "Cold", "Long", "High", "Far"],
  second: ["field", "ford", "gate", "ridge", "wood", "water"],
  nouns: ["Crossing", "Front", "Line", "Reach", "Ridge", "Fields", "Pass", "Basin", "Heights", "Hollow", "Junction", "Run"],
};

/** Words that read well before any landform ("Silent Narrows", "Broken Ridge"). */
const ADJECTIVES = ["Broken", "Silent", "Burning", "Hidden", "Lost", "Shattered", "Forgotten", "Last", "Crooked", "Sunken", "Bitter", "Lonely",
  "Iron", "Northern", "Southern", "Eastern", "Western", "Old", "Outer", "Far", "Frozen", "Red", "Black", "Golden"];

/** FNV-1a: the seed and landscape as one 32-bit number. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: a small seeded generator, the same sequence in every browser. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * "Coldwater Gap", "Ironreed Basin", "Silent Narrows": a random map's name, from the seed the engine made it with and
 * its landscape (MapGen.cs: the request's seed, moved on when a layout did not fit). The same seed and landscape always
 * give the same name.
 */
export function generatedMapName(seed: number | string, landscape: string) {
  const words = LANDSCAPES[landscape] ?? ANY;
  const next = random(hash(`${landscape}|${seed}`));
  const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
  // A landform that does not repeat the words before it ("Marsh Marsh", "Coldmere Mere").
  const landform = (...before: string[]) => {
    const clashes = (noun: string) => before.some((w) => noun.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(noun.toLowerCase()));
    const noun = pick(words.nouns);
    return clashes(noun) ? words.nouns.find((n) => !clashes(n)) ?? noun : noun;
  };
  const roll = next();
  if (roll < 0.62) {
    // A place name and a landform: "Coldwater Gap", with no clashing join ("Snowwater", "Cressspring").
    const first = pick(words.first), end = first.at(-1)!.toLowerCase();
    let second = pick(words.second);
    for (let i = 0; i < 6 && second[0] === end; i++) second = pick(words.second);
    if (second[0] === end) second = words.second.find((w) => w[0] !== end) ?? second;
    return `${first}${second} ${landform(first, second)}`;
  }
  const first = roll < 0.8 ? pick(words.first) : pick(ADJECTIVES);
  return `${first} ${landform(first)}`;
}

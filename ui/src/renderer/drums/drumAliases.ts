/**
 * drumAliases.ts
 * ----------------------------------------------------------------------------
 * Deterministic, stable, random-LOOKING drum sample names (e.g. kick_thunder,
 * snare_crack). The same file always maps to the same alias, so the name shown
 * in the Drum Browser and on the drum-sequencer track row ALWAYS match, and the
 * real filenames never reach the UI.
 *
 * The alias depends only on (category, the file list for that category in a kit),
 * so any caller that passes the same list gets identical names — including the
 * 2-digit suffix that disambiguates two files which hash to the same word.
 */

export type DrumCat = 'kick' | 'snare' | 'hihat' | 'openhat' | 'perc' | 'clapsnap' | 'rim';

/** FNV-1a 32-bit hash. Stable across runs, fast, no deps. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

const WORD_BANK: Record<DrumCat, readonly string[]> = {
  kick: [
    'thunder', 'anvil', 'doom', 'quake', 'void', 'mass', 'sub', 'deep',
    'mortar', 'crater', 'fist', 'kong', 'stomp', 'lurch', 'dread', 'slug',
    'boulder', 'pit', 'gravel', 'tank', 'iron', 'piston', 'forge', 'monolith',
    'gut', 'belly', 'cellar', 'thud', 'magma', 'oak', 'rumble', 'collapse',
  ],
  snare: [
    'crack', 'whip', 'sting', 'edge', 'rip', 'blade', 'knock', 'rim',
    'glass', 'ice', 'shard', 'fang', 'jolt', 'spark', 'lash', 'flick',
    'bone', 'shell', 'crisp', 'wire', 'pin', 'nail', 'snap', 'slap',
    'flint', 'kindle', 'rivet', 'split', 'tin', 'reed', 'birch', 'strike',
  ],
  hihat: [
    'tick', 'chip', 'dust', 'sand', 'salt', 'crisp', 'hush', 'mist',
    'blink', 'flit', 'wisp', 'fleck', 'prick', 'glint', 'spit', 'fizz',
    'scratch', 'whisper', 'tap', 'sliver', 'shimmer', 'thread', 'lint',
    'ash', 'grit', 'shave', 'speck', 'crumb', 'ember', 'tinder', 'sift', 'flicker',
  ],
  openhat: [
    'wash', 'splash', 'hiss', 'foam', 'gust', 'spray', 'bloom', 'breath',
    'haze', 'drift', 'sigh', 'plume', 'vapor', 'swell', 'sustain', 'halo',
    'ghost', 'smoke', 'drone', 'tide', 'wave', 'spume', 'fog', 'cascade',
    'aerosol', 'ember', 'gauze', 'silk', 'cloud', 'breeze', 'mist', 'lull',
  ],
  perc: [
    'shake', 'rattle', 'clave', 'bell', 'woody', 'tribal', 'ride', 'ping',
    'tink', 'gourd', 'shaker', 'plink', 'conga', 'agogo', 'chant', 'totem',
    'click', 'block', 'cowbell', 'pebble', 'hoof', 'tabla', 'rim', 'cinder',
    'brass', 'kettle', 'ladle', 'tongue', 'twig', 'reed', 'shell', 'cog',
  ],
  // CLAPS & SNAPS and RIM arrived with the lossless library (2026-08-20). Same
  // rule as the rest: the word is a hash of the file, so the display name is
  // stable and tells you nothing about the original filename.
  clapsnap: [
    'smack', 'pop', 'slap', 'flick', 'click', 'tap', 'crisp', 'sharp',
    'quick', 'bright', 'tight', 'punch', 'burst', 'strike', 'pat', 'patter',
    'crackle', 'zip', 'dart', 'ping', 'bite', 'edge', 'flash', 'jolt',
    'clip', 'swat', 'whack', 'thump', 'brisk', 'nip', 'flare', 'pulse',
  ],
  rim: [
    'click', 'knock', 'tick', 'wood', 'stick', 'rap', 'clack', 'pin',
    'edge', 'shell', 'tin', 'block', 'ping', 'dry', 'thin', 'crisp',
    'snip', 'tock', 'peck', 'nudge', 'chip', 'bead', 'spike', 'notch',
    'rivet', 'bolt', 'nail', 'splint', 'twig', 'husk', 'flint', 'rod',
  ],
};

// Cache the file→alias map per list reference (the kit arrays are stable JSON
// imports, so the same array object is passed every time). Map preserves
// insertion order, which is hash-sorted — handy for a random-looking list order.
const cache = new WeakMap<readonly string[], Map<string, string>>();

/** file → alias map for one category's file list, in hash-sorted order. */
export function aliasMap(category: DrumCat, files: readonly string[]): Map<string, string> {
  const hit = cache.get(files);
  if (hit) return hit;
  const words = WORD_BANK[category];
  const used = new Map<string, number>(); // word -> count, for suffix disambiguation
  // Sort by hash so the suffix order + display order look random, not alphabetical.
  const sorted = [...files].sort((a, b) => fnv1a(a) - fnv1a(b));
  const out = new Map<string, string>();
  for (const f of sorted) {
    const word = words[fnv1a(f) % words.length];
    const seen = used.get(word) ?? 0;
    used.set(word, seen + 1);
    const suffix = seen === 0 ? '' : String(seen + 1).padStart(2, '0');
    out.set(f, `${category}_${word}${suffix}`);
  }
  cache.set(files, out);
  return out;
}

/** The alias for a single file within its category list (falls back to the raw
 *  name only if the file somehow isn't in the list). */
export function drumAlias(category: DrumCat, files: readonly string[], file: string): string {
  return aliasMap(category, files).get(file) ?? file;
}

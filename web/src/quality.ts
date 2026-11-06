/**
 * How much of the city to hold at once.
 *
 * A desktop holds everything within 800 m in full detail and a ring of
 * distant tiles out to 2.6 km - 1.3-1.6 GB in all while a game streams
 * through the city (scripts/games-bench.ts). A phone's browser gets
 * nowhere near that: iOS reloads the tab, and with it the game, long before.
 * So a phone - a coarse pointer - runs on a smaller budget: full detail
 * close by only, a shorter distant ring hidden in nearer fog, ground
 * photos at half size and fewer pixels. `?quality=low` or `?quality=high`
 * picks one by hand. See docs/performance.md.
 */

export type Tier = 'high' | 'low';

function choose(): Tier {
  const q = new URLSearchParams(location.search).get('quality');
  if (q === 'low' || q === 'high') return q;
  return matchMedia('(pointer: coarse)').matches ? 'low' : 'high';
}

export const tier: Tier = choose();
export const LOW = tier === 'low';

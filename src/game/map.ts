// The layout of Brambleford, in tiles. One tile is 16 pixels.
//
//   north:  a row of four shops facing the main street
//   middle: the cobbled square with the well
//   west:   the mine (ore)          south-west: the wheat field
//   east:   the river (fish)        south-east: the forest (wood)

import type { GoodId } from '../economy/goods';
import type { MerchantId } from '../economy/world';
import type { Ground } from './ground';

export const MAP_W = 46;
export const MAP_H = 30;

export interface ShopSpot {
  id: MerchantId;
  /** Left-most tile of the 5-tile-wide building. */
  left: number;
  /** Tile row the building's front wall stands on. */
  bottom: number;
}

export const SHOPS: ShopSpot[] = [
  { id: 'blacksmith', left: 4, bottom: 9 },
  { id: 'carpenter', left: 13, bottom: 9 },
  { id: 'baker', left: 23, bottom: 9 },
  { id: 'fishmonger', left: 32, bottom: 9 },
];

/** In front of each shop, left to right: a planter, the shopkeeper at the door, the market stall. */
export const planterTile = (s: ShopSpot) => ({ x: s.left + 1, y: s.bottom + 1 });
export const doorTile = (s: ShopSpot) => ({ x: s.left + 2, y: s.bottom + 1 });
export const stallTile = (s: ShopSpot) => ({ x: s.left + 3, y: s.bottom + 1 });
/** Beside the forecourt: the shop's barrel and the tools of its trade. */
export const yardTile = (s: ShopSpot) => ({ x: s.id === 'blacksmith' || s.id === 'fishmonger' ? s.left + 4 : s.left, y: s.bottom + 1 });

/** First water column of the river on each row, so the bank wanders a little. */
export const riverStart = (y: number) => (y <= 6 ? 41 : y >= 24 ? 39 : 40);

export function buildGround(): Ground[][] {
  const g: Ground[][] = Array.from({ length: MAP_H }, () => Array<Ground>(MAP_W).fill('grass'));
  const fill = (x0: number, y0: number, x1: number, y1: number, kind: Ground) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = kind;
  };

  for (let y = 0; y < MAP_H; y++) fill(riverStart(y), y, MAP_W - 1, y, 'water');

  fill(3, 11, 38, 12, 'path');                                           // main street
  for (const s of SHOPS) fill(s.left + 1, 10, s.left + 3, 10, 'cobble'); // shop forecourts
  fill(18, 13, 25, 18, 'cobble');                                        // the square
  fill(21, 19, 22, 26, 'path');                                          // south road
  fill(5, 19, 38, 20, 'path');                                           // cross road
  fill(39, 19, 42, 20, 'planks');                                        // fishing dock
  fill(7, 22, 17, 27, 'soil');                                           // wheat field
  fill(1, 13, 6, 18, 'stone');                                           // the mine yard
  return g;
}

// ── Things you can gather from ──────────────────────────────────────────────

export interface NodeSpot {
  good: GoodId;
  x: number;
  y: number;
  /** For trees: which kind to draw. */
  kind?: number;
}

export function buildNodes(): NodeSpot[] {
  const nodes: NodeSpot[] = [];
  for (const [x, y] of [[4, 14], [6, 14], [3, 16], [1, 17], [6, 17], [4, 18]]) nodes.push({ good: 'ore', x, y });
  for (const y of [23, 25, 27]) for (const x of [8, 10, 12, 14, 16]) nodes.push({ good: 'wheat', x, y });
  for (const [x, y] of [[40, 9], [40, 15], [41, 18], [43, 19], [41, 21], [39, 26]]) nodes.push({ good: 'fish', x, y });
  // the forest: a loose stand of trees you can chop
  [
    [26, 23], [29, 22], [32, 23], [35, 22], [37, 24],
    [27, 26], [30, 25], [33, 26], [36, 27], [25, 28], [29, 28], [32, 28],
  ].forEach(([x, y], i) => nodes.push({ good: 'wood', x, y, kind: [0, 1, 2, 0, 3][i % 5] }));
  return nodes;
}

// ── Scenery ─────────────────────────────────────────────────────────────────

/** Trees that are only scenery: [x, y, kind]. Kinds: 0 oak, 1 big oak, 2 pine, 3 lime, 4 apple. */
export const TREES: [number, number, number][] = [
  // the treeline behind the shops
  [0, 1, 2], [2, 3, 0], [4, 1, 1], [7, 2, 2], [9, 3, 0], [11, 1, 2], [14, 2, 0], [16, 0, 2], [19, 3, 1], [21, 1, 2],
  [24, 2, 0], [26, 0, 2], [29, 2, 1], [30, 4, 3], [33, 1, 2], [35, 3, 0], [37, 1, 1], [38, 3, 2], [39, 5, 0],
  // the western and southern edges
  [0, 7, 0], [1, 10, 3], [0, 21, 1], [2, 24, 0], [1, 28, 2], [4, 27, 0], [0, 25, 2], [19, 24, 4], [19, 28, 0], [24, 23, 3], [38, 28, 2],
  // between the street and the cross road
  [10, 15, 0], [12, 17, 3], [8, 16, 4], [14, 15, 1], [30, 15, 0], [32, 16, 4], [37, 15, 3], [36, 14, 0], [34, 17, 0],
];

export const WELL = { x: 22, y: 15 };

export const LAMPS = [
  { x: 10, y: 10 }, { x: 20, y: 10 }, { x: 30, y: 10 }, { x: 38, y: 10 },
  { x: 17, y: 13 }, { x: 26, y: 13 }, { x: 17, y: 18 }, { x: 26, y: 18 },
  { x: 38, y: 18 }, { x: 6, y: 21 },
];

/** The tunnel mouth at the top-left of the mine yard (3 tiles wide, 2 deep). */
export const MINE = { x: 0, y: 14 };

/** Fence along the top of the wheat field, with a gap for the gate. */
export const FENCE = [7, 8, 9, 10, 14, 15, 16, 17].map((x) => ({ x, y: 21 }));

export const BENCHES = [{ x: 19, y: 18 }, { x: 24, y: 18 }];

export const BUSHES = [
  { x: 11, y: 10 }, { x: 19, y: 10 }, { x: 21, y: 10 }, { x: 29, y: 10 }, { x: 31, y: 10 },
  { x: 17, y: 14 }, { x: 26, y: 14 }, { x: 17, y: 17 }, { x: 26, y: 17 },
  { x: 3, y: 21 }, { x: 37, y: 21 }, { x: 24, y: 21 },
];

/** One-off props: [texture, x, y]. Each makes its tile solid. */
export const PROPS: [string, number, number][] = [
  ['minecart', 3, 14],
  ['scarecrow', 12, 24],
  ['hay', 6, 24], ['hay', 6, 25],
  ['signpost', 20, 21],
  ['noticeboard', 26, 15],
  ['prop-carpenter', 23, 22],
];

export const BOAT = { x: 44, y: 23 };

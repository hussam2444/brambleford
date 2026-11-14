// Every item in Brambleford. On chain, each id becomes one NEP-245 token type.

export type GoodId =
  | 'ore' | 'wood' | 'wheat' | 'fish'
  | 'tools' | 'bread' | 'smoked_fish' | 'furniture';

export interface Good {
  name: string;
  plural: string;
  /** The "normal" price when stock and demand are both ordinary. */
  base: number;
  /** Raw goods are gathered; made goods come out of a merchant's workshop. */
  raw: boolean;
  /** Energy restored when the player eats it. */
  energy?: number;
}

export const GOODS: Record<GoodId, Good> = {
  ore:         { name: 'Ore',         plural: 'ore',         base: 6,  raw: true },
  wood:        { name: 'Wood',        plural: 'wood',        base: 4,  raw: true },
  wheat:       { name: 'Wheat',       plural: 'wheat',       base: 3,  raw: true },
  fish:        { name: 'Fish',        plural: 'fish',        base: 5,  raw: true },
  tools:       { name: 'Tools',       plural: 'tools',       base: 30, raw: false },
  bread:       { name: 'Bread',       plural: 'loaves',      base: 10, raw: false, energy: 12 },
  smoked_fish: { name: 'Smoked fish', plural: 'smoked fish', base: 9,  raw: false, energy: 10 },
  furniture:   { name: 'Furniture',   plural: 'furniture',   base: 22, raw: false },
};

export const GOOD_IDS = Object.keys(GOODS) as GoodId[];

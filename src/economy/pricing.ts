// ─────────────────────────────────────────────────────────────────────────────
// HOW MERCHANTS SET PRICES
//
// This is the only file that decides a price. Every merchant in Brambleford
// runs these same rules against its own stock, its own purse and its own recent
// sales. Nothing here is random and nothing is hidden: the `reasons` returned
// with each quote are exactly what the merchant says when you hover a price.
// ─────────────────────────────────────────────────────────────────────────────

import { GOODS, type GoodId } from './goods';
import type { Merchant } from './town';

export const RULES = {
  /** How sharply a price reacts to being over- or under-stocked. 0 = not at all. */
  scarcityPower: 0.7,
  /** A price never drops below this share of normal, or climbs above the max. */
  minMultiplier: 0.35,
  maxMultiplier: 3.0,

  /** How much busy (or dead) trade nudges a selling price. */
  demandPull: 0.35,
  minDemandFactor: 0.8,
  maxDemandFactor: 1.5,

  /** A merchant with less coin than this gets cautious and pays less. */
  cautiousBelowCoins: 60,
  cautiousDiscount: 0.3,
  /** A merchant never spends more than this share of its purse on one item. */
  maxSpendShare: 0.5,

  /** A merchant stops buying once it holds this many times what it likes to keep. */
  fullAtTimesTarget: 3,

  /** A merchant never sells for less than what the ingredients cost, plus this. */
  minMarkupOverCost: 0.1,
};

export interface Quote {
  price: number;
  /** False when the merchant cannot (or will not) trade at any price right now. */
  available: boolean;
  /** Plain-language reasoning, in the merchant's voice. */
  reasons: string[];
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Stock compared with what the merchant likes to keep on the shelf. */
function scarcity(stock: number, target: number): number {
  const raw = Math.pow((target + 1) / (stock + 1), RULES.scarcityPower);
  return clamp(raw, RULES.minMultiplier, RULES.maxMultiplier);
}

function stockRemark(stock: number, target: number, noun: string): string {
  if (stock === 0) return `I have no ${noun} at all.`;
  if (stock < target * 0.5) return `I'm running low: ${stock} ${noun}, and I like to keep ${target}.`;
  if (stock > target * 1.5) return `I'm overstocked: ${stock} ${noun}, and I only need ${target}.`;
  return `Stock is about right: ${stock} ${noun} against the ${target} I like to keep.`;
}

/** What this merchant will PAY for one unit of something it uses. */
export function quoteBuy(m: Merchant, good: GoodId): Quote {
  const g = GOODS[good];
  const stock = m.stock[good] ?? 0;
  const target = m.target[good] ?? 1;
  const reasons: string[] = [];

  if (!m.open) return { price: 0, available: false, reasons: ['The shop is closed.'] };

  let mult = scarcity(stock, target);
  reasons.push(stockRemark(stock, target, g.plural));

  if (m.coins < RULES.cautiousBelowCoins) {
    mult *= 1 - RULES.cautiousDiscount;
    reasons.push(`Coin is tight (${m.coins} left), so I'm paying less than I'd like.`);
  }

  const price = Math.max(1, Math.round(g.base * mult));
  if (stock >= target * RULES.fullAtTimesTarget) {
    return { price, available: false, reasons: [`I've no room for more ${g.plural}. Try someone else.`] };
  }
  const canAfford = m.coins * RULES.maxSpendShare >= price;
  if (!canAfford) reasons.push(`I can't spare ${price} coins right now.`);
  else if (price > g.base) reasons.push(`So I'll pay ${price}, above the usual ${g.base}.`);
  else if (price < g.base) reasons.push(`So I'll only pay ${price}, below the usual ${g.base}.`);
  else reasons.push(`So I'll pay the usual ${price}.`);

  return { price, available: canAfford, reasons };
}

/** What the ingredients for one unit cost this merchant at normal prices. */
export function inputCost(m: Merchant): number {
  let cost = 0;
  for (const [id, n] of Object.entries(m.recipe.inputs)) cost += GOODS[id as GoodId].base * (n ?? 0);
  return cost;
}

/** What this merchant CHARGES for one unit of what it makes. */
export function quoteSell(m: Merchant, good: GoodId): Quote {
  const g = GOODS[good];
  const stock = m.stock[good] ?? 0;
  const target = m.target[good] ?? 1;
  const reasons: string[] = [];

  if (!m.open) return { price: 0, available: false, reasons: ['The shop is closed.'] };

  let mult = scarcity(stock, target);
  reasons.push(stockRemark(stock, target, g.plural));

  const usual = m.usualSales[good] ?? 1;
  const recent = m.recentSales[good] ?? 0;
  const demand = clamp(
    1 + RULES.demandPull * (recent / usual - 1),
    RULES.minDemandFactor,
    RULES.maxDemandFactor,
  );
  mult *= demand;
  if (demand > 1.08) reasons.push('Trade has been brisk lately, so I can ask more.');
  else if (demand < 0.92) reasons.push('Trade has been slow lately, so I have to ask less.');

  let price = Math.max(1, Math.round(g.base * mult));
  const floor = Math.ceil(inputCost(m) * (1 + RULES.minMarkupOverCost));
  if (price < floor) {
    price = floor;
    reasons.push(`I won't go below ${floor}. That's what the ingredients cost me.`);
  } else if (price > g.base) reasons.push(`So I'm asking ${price}, above the usual ${g.base}.`);
  else if (price < g.base) reasons.push(`So I'm asking ${price}, below the usual ${g.base}.`);
  else reasons.push(`So I'm asking the usual ${price}.`);

  return { price, available: stock > 0, reasons };
}

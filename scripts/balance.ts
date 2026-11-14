// How often do shops go under, and how much do prices move, with nobody playing?
//   npx tsx scripts/balance.ts
import { LocalWorld, type MerchantId } from '../src/economy/world';
import { quoteSell } from '../src/economy/pricing';
import { GOODS } from '../src/economy/goods';

const runs = 40, days = 14;
let closures = 0, runsWithClosure = 0;
const spread: Record<string, number[]> = {};
for (let seed = 1; seed <= runs; seed++) {
  const w = new LocalWorld(seed);
  const lo: Record<string, number> = {}, hi: Record<string, number> = {};
  const start = w.totalCoins();
  for (let h = 0; h < days * 24; h++) {
    w.tickHour();
    for (const m of Object.values(w.town.merchants)) {
      if (!m.open) continue;
      const p = quoteSell(m, m.recipe.output).price / GOODS[m.recipe.output].base;
      lo[m.id] = Math.min(lo[m.id] ?? 9, p);
      hi[m.id] = Math.max(hi[m.id] ?? 0, p);
    }
  }
  if (w.totalCoins() !== start) throw new Error('coins not conserved');
  const shut = (Object.keys(w.town.merchants) as MerchantId[]).filter((id) => !w.town.merchants[id].open).length;
  closures += shut;
  if (shut) runsWithClosure += 1;
  for (const id of Object.keys(lo)) (spread[id] ??= []).push(hi[id] - lo[id]);
}
console.log(`${runs} two-week runs: ${runsWithClosure} had a shop go under (${closures} closures in all).`);
for (const [id, s] of Object.entries(spread)) console.log(`  ${id.padEnd(10)} price swung by ${Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100)}% of normal on average`);

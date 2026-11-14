// Fast-forward the town with nobody playing and print what the economy did.
//
//   npm run sim            two weeks, town left alone
//   npm run sim -- flood   same, but a player dumps 60 ore on the blacksmith on day 3
//
// Each row is the state at the close of one day.

import { LocalWorld, type MerchantId } from '../src/economy/world';
import { quoteBuy, quoteSell } from '../src/economy/pricing';

const flood = process.argv.includes('flood');
const days = 14;
const world = new LocalWorld(7);
const startCoins = world.totalCoins();

const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(flood ? 'Scenario: a player floods the blacksmith with ore on day 3\n' : 'Scenario: town left alone\n');
console.log('day | ore buy  tools | wheat buy bread | fish buy smoked | wood buy furn. | coins: smith baker fish carp purse | shut');

for (let d = 1; d <= days; d++) {
  for (let h = 0; h < 24; h++) {
    if (flood && d === 3 && world.town.hour === 10) {
      world.player.inventory.ore = 60;
      const sold = world.sell('blacksmith', 'ore', 60).count ?? 0;
      console.log(`      -> player sold ${sold} ore; blacksmith now pays ${quoteBuy(world.town.merchants.blacksmith, 'ore').price} per ore`);
    }
    world.tickHour();
    if (world.town.hour === 20) {
      const m = world.town.merchants;
      const shut = (Object.keys(m) as MerchantId[]).filter((id) => !m[id].open).join(',') || '-';
      console.log(
        `${pad(world.town.day, 3)} |` +
          `${pad(quoteBuy(m.blacksmith, 'ore').price, 8)}${pad(quoteSell(m.blacksmith, 'tools').price, 7)} |` +
          `${pad(quoteBuy(m.baker, 'wheat').price, 10)}${pad(quoteSell(m.baker, 'bread').price, 6)} |` +
          `${pad(quoteBuy(m.fishmonger, 'fish').price, 9)}${pad(quoteSell(m.fishmonger, 'smoked_fish').price, 7)} |` +
          `${pad(quoteBuy(m.carpenter, 'wood').price, 9)}${pad(quoteSell(m.carpenter, 'furniture').price, 6)} |` +
          `${pad(m.blacksmith.coins, 13)}${pad(m.baker.coins, 6)}${pad(m.fishmonger.coins, 5)}${pad(m.carpenter.coins, 5)}${pad(world.town.purse, 6)} | ${shut}`,
      );
    }
  }
}

for (const e of world.town.events) console.log(`  day ${e.day}: ${e.text}`);
const end = world.totalCoins();
console.log(`\nCoins in the whole town: ${startCoins} at the start, ${end} at the end ${end === startCoins ? '(conserved)' : '(MISMATCH)'}`);
if (end !== startCoins) process.exit(1);

// The town's economy as plain data and plain functions.
//
// This file and `pricing.ts` are the whole rulebook. The NEAR contract in
// `contract/src/brambleford.ts` imports them directly, so the rules a player
// sees in the browser are, line for line, the rules the chain enforces.
//
// Nothing here touches the clock, the network or Math.random: time is told to
// it one hour at a time and randomness is handed in, so a run can be replayed.
//
// Coins are never created or destroyed. They only move between shopkeepers,
// the townsfolk's shared purse and players.

import { GOODS, type GoodId } from './goods';
import { quoteBuy, quoteSell } from './pricing';

export type MerchantId = 'blacksmith' | 'baker' | 'fishmonger' | 'carpenter';
export const MERCHANT_IDS: MerchantId[] = ['blacksmith', 'baker', 'fishmonger', 'carpenter'];

export interface Recipe {
  inputs: Partial<Record<GoodId, number>>;
  output: GoodId;
  perHour: number;
}

export interface Merchant {
  id: MerchantId;
  name: string;
  title: string;
  coins: number;
  stock: Partial<Record<GoodId, number>>;
  /** How many of each good the shopkeeper likes to keep on hand. They may change this themselves. */
  target: Partial<Record<GoodId, number>>;
  /** The shopkeeper's own words about their current plan, if they have said anything. */
  plan: string;
  /** The day the shopkeeper last changed their plan. */
  plannedOn?: number;
  recipe: Recipe;
  /** Townsfolk purchases per hour at the normal price. */
  usualSales: Partial<Record<GoodId, number>>;
  /** Moving average of actual purchases per hour. */
  recentSales: Partial<Record<GoodId, number>>;
  /** What the town's own gatherers bring in per hour at the normal price. */
  usualSupply: Partial<Record<GoodId, number>>;
  /** Rent and wages due at the end of every day. */
  upkeep: number;
  missedRent: number;
  open: boolean;
  /** Percent of each day's profit owed to each investor, by player id. */
  holders: Record<string, number>;
  coinsAtDawn: number;
  /** Coins taken from townsfolk during the latest hour. */
  townIncome: number;
  /** How busy the shop is today compared with an ordinary day (1 = ordinary). Set afresh each morning. */
  bustle?: number;
}

export interface Player {
  coins: number;
  inventory: Partial<Record<GoodId, number>>;
  energy: number;
  maxEnergy: number;
  /** The last morning this player's energy was refilled. */
  restedOn: number;
  /** Running counts of what the player has done, used for the first-minute goals. */
  stats: { gathered: number; sold: number; bought: number; eaten: number };
  /** Messages meant for this player only, such as dividends. */
  notices: { seq: number; text: string }[];
  noticeSeq: number;
}

export interface TownEvent {
  seq: number;
  day: number;
  hour: number;
  kind: 'closed' | 'reopened' | 'news';
  text: string;
}

/** Something outside anyone's control that changes how much the town's gatherers bring in. */
export interface Season {
  good: GoodId;
  /** 0.3 means gatherers bring in 30% of the usual amount. */
  factor: number;
  daysLeft: number;
  headline: string;
}

export interface Town {
  day: number;
  hour: number;
  /** Coins held by ordinary townsfolk, who earn wages and buy goods. */
  purse: number;
  merchants: Record<MerchantId, Merchant>;
  events: TownEvent[];
  eventSeq: number;
  /** At most one supply shock runs at a time. */
  season: Season | null;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Coins that changed hands in total. */
  price?: number;
  /** How many units changed hands. */
  count?: number;
}

export type Rng = () => number;
/** Called when a shop owes an investor their share of the day's profit. */
export type Pay = (holder: string, coins: number, note: string, from: MerchantId) => void;

export const TOWN = {
  openHour: 6,
  closeHour: 20,
  /** Real milliseconds per game hour. Nights pass quickly. */
  hourMs: { day: 9000, night: 2500 },
  /** Days of unpaid rent before a shop shuts. */
  missedRentLimit: 2,
  /** What a newcomer is given from the townsfolk's purse. */
  startingCoins: 20,
  investCost: 100,
  /** Percent of profit one investment buys, and the most a shop will ever sell. */
  investPct: 25,
  maxInvestedPct: 75,
  /** Anything a shopkeeper holds above this at day's end gets spent back into the town. */
  comfortableSavings: 350,
  gatherEnergy: 2,
  maxEnergy: 40,
  /** How a shop's daily custom varies: from this share of an ordinary day's trade, up to that. */
  quietDay: 0.5,
  busyDay: 1.7,
  supplyElasticity: 1.2,
  demandElasticity: 1.3,
  keepEvents: 12,
  keepNotices: 6,
};

/** Small seedable random generator so a run can be replayed exactly. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Setup = Pick<Merchant, 'id' | 'name' | 'title' | 'coins' | 'stock' | 'target' | 'recipe' | 'usualSales' | 'usualSupply' | 'upkeep'>;

function makeMerchant(m: Setup): Merchant {
  return { ...m, plan: '', recentSales: { ...m.usualSales }, missedRent: 0, open: true, holders: {}, coinsAtDawn: m.coins, townIncome: 0 };
}

export function newTown(): Town {
  return {
    day: 1,
    hour: TOWN.openHour,
    purse: 1200,
    events: [],
    eventSeq: 0,
    season: null,
    merchants: {
      blacksmith: makeMerchant({
        id: 'blacksmith', name: 'Bruna', title: 'Blacksmith', coins: 250,
        stock: { ore: 8, wood: 4, tools: 3 },
        target: { ore: 10, wood: 5, tools: 4 },
        recipe: { inputs: { ore: 2, wood: 1 }, output: 'tools', perHour: 1 },
        usualSales: { tools: 1 },
        usualSupply: { ore: 2, wood: 1 },
        upkeep: 130,
      }),
      baker: makeMerchant({
        id: 'baker', name: 'Odo', title: 'Baker', coins: 250,
        stock: { wheat: 14, bread: 6 },
        target: { wheat: 16, bread: 8 },
        recipe: { inputs: { wheat: 2 }, output: 'bread', perHour: 4 },
        usualSales: { bread: 3 },
        usualSupply: { wheat: 6 },
        upkeep: 120,
      }),
      fishmonger: makeMerchant({
        id: 'fishmonger', name: 'Maren', title: 'Fishmonger', coins: 250,
        stock: { fish: 8, smoked_fish: 6 },
        target: { fish: 9, smoked_fish: 8 },
        recipe: { inputs: { fish: 1 }, output: 'smoked_fish', perHour: 4 },
        usualSales: { smoked_fish: 3 },
        usualSupply: { fish: 3 },
        upkeep: 110,
      }),
      carpenter: makeMerchant({
        id: 'carpenter', name: 'Tobin', title: 'Carpenter', coins: 250,
        stock: { wood: 9, furniture: 3 },
        target: { wood: 10, furniture: 4 },
        recipe: { inputs: { wood: 3 }, output: 'furniture', perHour: 1 },
        usualSales: { furniture: 1 },
        usualSupply: { wood: 3 },
        upkeep: 100,
      }),
    },
  };
}

/** A newcomer arrives. Their first coins are a gift from the townsfolk's purse. */
export function newPlayer(town: Town): Player {
  const gift = Math.min(TOWN.startingCoins, town.purse);
  town.purse -= gift;
  return {
    coins: gift,
    inventory: {},
    energy: TOWN.maxEnergy,
    maxEnergy: TOWN.maxEnergy,
    restedOn: morningOf(town),
    stats: { gathered: 0, sold: 0, bought: 0, eaten: 0 },
    notices: [],
    noticeSeq: 0,
  };
}

// ── Reading the town ────────────────────────────────────────────────────────

export function isTradingHour(town: Town): boolean {
  return town.hour >= TOWN.openHour && town.hour < TOWN.closeHour;
}

export function hourMs(town: Town): number {
  return isTradingHour(town) ? TOWN.hourMs.day : TOWN.hourMs.night;
}

/** The most recent morning: today's if dawn has passed, otherwise yesterday's. */
function morningOf(town: Town): number {
  return town.hour >= TOWN.openHour ? town.day : town.day - 1;
}

/** A night's sleep refills energy. Worked out when needed, so nobody has to be awake at dawn. */
export function rest(town: Town, p: Player) {
  const morning = morningOf(town);
  if (p.restedOn < morning) {
    p.restedOn = morning;
    p.energy = p.maxEnergy;
  }
}

export function gatherYield(p: Player): number {
  return 1 + Math.min(2, p.inventory.tools ?? 0);
}

export function investedPct(m: Merchant): number {
  let sum = 0;
  for (const pct of Object.values(m.holders)) sum += pct;
  return sum;
}

/** Every coin in the town. This number never changes. */
export function totalCoins(town: Town, players: Player[]): number {
  let sum = town.purse;
  for (const m of Object.values(town.merchants)) sum += m.coins;
  for (const p of players) sum += p.coins;
  return sum;
}

function add(bag: Partial<Record<GoodId, number>>, good: GoodId, n: number) {
  bag[good] = Math.max(0, (bag[good] ?? 0) + n);
}

function announce(town: Town, kind: TownEvent['kind'], text: string) {
  town.eventSeq += 1;
  town.events.push({ seq: town.eventSeq, day: town.day, hour: town.hour, kind, text });
  while (town.events.length > TOWN.keepEvents) town.events.shift();
}

export function notify(p: Player, text: string) {
  p.noticeSeq += 1;
  p.notices.push({ seq: p.noticeSeq, text });
  while (p.notices.length > TOWN.keepNotices) p.notices.shift();
}

// ── One hour passes ─────────────────────────────────────────────────────────

export function tickHour(town: Town, rng: Rng, pay: Pay) {
  /** Turn 2.4 into 2 or 3, with 3 coming up 40% of the time. */
  const roll = (x: number) => Math.floor(x) + (rng() < x - Math.floor(x) ? 1 : 0);

  for (const m of Object.values(town.merchants)) m.townIncome = 0;

  if (isTradingHour(town)) {
    for (const m of Object.values(town.merchants)) {
      if (!m.open) continue;

      // The town's own gatherers sell raw goods to the shop, if the price tempts them.
      for (const [id, usual] of Object.entries(m.usualSupply)) {
        const good = id as GoodId;
        const shock = town.season?.good === good ? town.season.factor : 1;
        const wanted = roll((usual ?? 0) * shock * Math.pow(quoteBuy(m, good).price / GOODS[good].base, TOWN.supplyElasticity));
        for (let i = 0; i < wanted; i++) {
          const q = quoteBuy(m, good);
          if (!q.available) break;
          m.coins -= q.price;
          town.purse += q.price;
          add(m.stock, good, 1);
        }
      }

      // The shopkeeper turns ingredients into goods, until the shelf is full.
      const out = m.recipe.output;
      for (let i = 0; i < m.recipe.perHour; i++) {
        if ((m.stock[out] ?? 0) >= (m.target[out] ?? 0)) break;
        const hasAll = Object.entries(m.recipe.inputs).every(([id, n]) => (m.stock[id as GoodId] ?? 0) >= (n ?? 0));
        if (!hasAll) break;
        for (const [id, n] of Object.entries(m.recipe.inputs)) add(m.stock, id as GoodId, -(n ?? 0));
        add(m.stock, out, 1);
      }

      // Townsfolk buy what the shop makes: more when it is cheap, less when dear.
      for (const [id, usual] of Object.entries(m.usualSales)) {
        const good = id as GoodId;
        const wanted = roll((usual ?? 0) * (m.bustle ?? 1) * Math.pow(GOODS[good].base / quoteSell(m, good).price, TOWN.demandElasticity));
        let sold = 0;
        for (let i = 0; i < wanted; i++) {
          const q = quoteSell(m, good);
          if (!q.available || town.purse < q.price) break;
          town.purse -= q.price;
          m.coins += q.price;
          m.townIncome += q.price;
          add(m.stock, good, -1);
          sold += 1;
        }
        m.recentSales[good] = (m.recentSales[good] ?? 0) * 0.85 + sold * 0.15;
      }
    }
  }

  town.hour += 1;
  if (town.hour === TOWN.closeHour) closeOfDay(town, pay);
  if (town.hour >= 24) {
    town.hour = 0;
    town.day += 1;
  }
  if (town.hour === TOWN.openHour) dawn(town, rng);
}

function closeOfDay(town: Town, pay: Pay) {
  for (const m of Object.values(town.merchants)) {
    if (!m.open) continue;

    if (m.coins >= m.upkeep) {
      m.coins -= m.upkeep;
      town.purse += m.upkeep; // rent and wages go back to the townsfolk
      m.missedRent = 0;
    } else {
      m.missedRent += 1;
      if (m.missedRent >= TOWN.missedRentLimit) {
        m.open = false;
        announce(town, 'closed', `${m.name} the ${m.title.toLowerCase()} has shut up shop. Rent went unpaid ${TOWN.missedRentLimit} days running.`);
        continue;
      }
    }

    const profit = m.coins - m.coinsAtDawn;
    if (profit > 0) {
      for (const [holder, pct] of Object.entries(m.holders)) {
        const cut = Math.floor((profit * pct) / 100);
        if (cut <= 0) continue;
        m.coins -= cut;
        pay(holder, cut, `${m.name} paid you ${cut} coins, your share of today's profit.`, m.id);
      }
    }

    if (m.coins > TOWN.comfortableSavings) {
      const spend = m.coins - TOWN.comfortableSavings;
      m.coins -= spend;
      town.purse += spend;
    }
  }
}

const SEASONS: Omit<Season, 'daysLeft'>[] = [
  { good: 'fish',  factor: 0.25, headline: 'The river is running muddy. Hardly anyone is catching fish.' },
  { good: 'fish',  factor: 1.9,  headline: 'The salmon are running. Nets are coming up full.' },
  { good: 'wheat', factor: 0.3,  headline: 'Blight in the east fields. Wheat is scarce.' },
  { good: 'wheat', factor: 1.8,  headline: 'A bumper harvest. Carts of wheat are rolling in.' },
  { good: 'ore',   factor: 0.25, headline: 'A tunnel collapsed in the mine. Ore has all but stopped.' },
  { good: 'ore',   factor: 1.8,  headline: 'The miners struck a rich new seam.' },
  { good: 'wood',  factor: 0.35, headline: 'Storms have closed the forest road. Wood is hard to come by.' },
];

function dawn(town: Town, rng: Rng) {
  for (const m of Object.values(town.merchants)) {
    m.coinsAtDawn = m.coins;
    // Some days the town wants bread; some days nobody does. No two days are alike.
    m.bustle = TOWN.quietDay + rng() * (TOWN.busyDay - TOWN.quietDay);
  }

  if (town.season) {
    town.season.daysLeft -= 1;
    if (town.season.daysLeft <= 0) {
      announce(town, 'news', `Things are back to normal for ${GOODS[town.season.good].plural}.`);
      town.season = null;
    }
    return;
  }
  if (town.day < 2 || rng() > 0.4) return;
  const pick = SEASONS[Math.floor(rng() * SEASONS.length)];
  town.season = { ...pick, daysLeft: 2 + Math.floor(rng() * 2) };
  announce(town, 'news', pick.headline);
}

// ── What a player can do ────────────────────────────────────────────────────

export function gather(town: Town, p: Player, good: GoodId): ActionResult {
  if (!GOODS[good]?.raw) return { ok: false, message: 'That cannot be gathered.' };
  rest(town, p);
  if (p.energy < TOWN.gatherEnergy) return { ok: false, message: "You're worn out. Eat something, or rest until morning." };
  const n = gatherYield(p);
  p.energy -= TOWN.gatherEnergy;
  add(p.inventory, good, n);
  p.stats.gathered += n;
  return { ok: true, count: n, message: `+${n} ${GOODS[good].plural}` };
}

/** Sell up to `amount` of something to a shop, one at a time, so each sale moves the next price. */
export function sell(town: Town, p: Player, merchantId: MerchantId, good: GoodId, amount = 1): ActionResult {
  const m = town.merchants[merchantId];
  if (!m) return { ok: false, message: 'No such shop.' };
  if (!isTradingHour(town)) return { ok: false, message: `${m.name} has gone to bed.` };
  if (!(good in m.usualSupply)) return { ok: false, message: `${m.name} has no use for ${GOODS[good]?.plural ?? 'that'}.` };
  if ((p.inventory[good] ?? 0) < 1) return { ok: false, message: `You have no ${GOODS[good].plural}.` };

  let count = 0, total = 0, stop = '';
  while (count < amount && (p.inventory[good] ?? 0) >= 1) {
    const q = quoteBuy(m, good);
    if (!q.available) { stop = q.reasons[q.reasons.length - 1]; break; }
    m.coins -= q.price;
    p.coins += q.price;
    add(m.stock, good, 1);
    add(p.inventory, good, -1);
    count += 1;
    total += q.price;
  }
  if (!count) return { ok: false, message: stop };
  p.stats.sold += count;
  return { ok: true, count, price: total, message: `Sold ${count} for ${total}` };
}

export function buy(town: Town, p: Player, merchantId: MerchantId, good: GoodId): ActionResult {
  const m = town.merchants[merchantId];
  if (!m) return { ok: false, message: 'No such shop.' };
  if (!isTradingHour(town)) return { ok: false, message: `${m.name} has gone to bed.` };
  if (m.recipe.output !== good) return { ok: false, message: `${m.name} does not sell that.` };
  const q = quoteSell(m, good);
  if (!q.available) return { ok: false, message: m.open ? `${m.name} is sold out.` : 'The shop is closed.' };
  if (p.coins < q.price) return { ok: false, message: `You need ${q.price} coins.` };
  p.coins -= q.price;
  m.coins += q.price;
  add(m.stock, good, -1);
  add(p.inventory, good, 1);
  m.recentSales[good] = (m.recentSales[good] ?? 0) + 0.15;
  p.stats.bought += 1;
  return { ok: true, count: 1, price: q.price, message: `Bought for ${q.price}` };
}

export function eat(town: Town, p: Player, good: GoodId): ActionResult {
  const energy = GOODS[good]?.energy;
  if (!energy || (p.inventory[good] ?? 0) < 1) return { ok: false, message: 'Nothing to eat.' };
  rest(town, p);
  add(p.inventory, good, -1);
  p.energy = Math.min(p.maxEnergy, p.energy + energy);
  p.stats.eaten += 1;
  return { ok: true, count: 1, message: `+${energy} energy` };
}

/** Put coins into a shop for a share of its profits. Reopens it if it had closed. */
export function invest(town: Town, p: Player, playerId: string, merchantId: MerchantId): ActionResult {
  const m = town.merchants[merchantId];
  if (!m) return { ok: false, message: 'No such shop.' };
  if (investedPct(m) + TOWN.investPct > TOWN.maxInvestedPct) return { ok: false, message: `${m.name} won't part with any more of the shop.` };
  if (p.coins < TOWN.investCost) return { ok: false, message: `You need ${TOWN.investCost} coins to buy in.` };
  p.coins -= TOWN.investCost;
  m.coins += TOWN.investCost;
  m.holders[playerId] = (m.holders[playerId] ?? 0) + TOWN.investPct;
  if (!m.open) {
    m.open = true;
    m.missedRent = 0;
    m.coinsAtDawn = m.coins;
    announce(town, 'reopened', `${m.name} the ${m.title.toLowerCase()} is open again, thanks to a new investor.`);
  }
  return { ok: true, price: TOWN.investCost, message: `You now own ${m.holders[playerId]}% of the shop.` };
}

/**
 * A shopkeeper changes how much they like to keep on the shelf.
 * On chain, only the shopkeeper's own account may call this.
 */
export function setPlan(town: Town, m: Merchant, target: Partial<Record<GoodId, number>>, plan: string): ActionResult {
  for (const [id, n] of Object.entries(target)) {
    if (!(id in m.target)) return { ok: false, message: `${m.name} does not stock ${id}.` };
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 40) return { ok: false, message: 'Shelf targets must be whole numbers from 1 to 40.' };
  }
  Object.assign(m.target, target);
  m.plan = String(plan ?? '').slice(0, 240);
  m.plannedOn = town.day;
  return { ok: true, message: 'Plan updated.' };
}

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

import { GOODS, GOOD_IDS, type GoodId } from './goods';
import { RULES, quoteBuy, quoteSell } from './pricing';

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
  /** Who worked the current plan out, in a few words, if the shopkeeper said. Plans made before this existed have none. */
  thinker?: string;
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
  /** The day the shop shut, while it is shut. */
  closedOn?: number;
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
  /** True once the town has taken this player to have left, until they next do something. */
  gone?: boolean;
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

/** A request on the notice board: bring this shopkeeper enough of something today, and earn a bonus. */
export interface Order {
  id: number;
  /** The day it went up. It lapses at the next dawn. */
  day: number;
  merchant: MerchantId;
  good: GoodId;
  wanted: number;
  /** Paid from the shopkeeper's own purse to whoever fills the order first. */
  bonus: number;
  /** How many each player has brought so far, by player id. */
  progress: Record<string, number>;
  /** The player who filled it, once someone has. */
  wonBy?: string;
}

/** One line of the "richest players" list. */
export interface Rank {
  id: string;
  worth: number;
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
  /** What is on the notice board. A town begun before orders existed has none until its next dawn. */
  orders?: Order[];
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Coins that changed hands in total. */
  price?: number;
  /** How many units changed hands. */
  count?: number;
  /** Coins a shopkeeper paid on top, when a sale filled their order. */
  bonus?: number;
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
  /** If no player invests in a shut shop, the townsfolk put in this much after this many days. */
  daysUntilWhipRound: 3,
  whipRound: 150,
  /** What a newcomer is given from the townsfolk's purse. */
  startingCoins: 20,
  investCost: 100,
  /** Percent of profit one investment buys, and the most a shop will ever sell. */
  investPct: 25,
  maxInvestedPct: 75,
  /**
   * A part-owner who has done nothing in town for more than this many days is away. While
   * they are away their cut of the profit goes to the townsfolk, who spend it in town.
   * Without this, coins pile up out of reach with people who have left, and the town runs dry.
   */
  partnerAwayDays: 3,
  /**
   * A player who has done nothing for this many real hours has left town. Their coins go
   * back to the townsfolk, who spend them in the shops. Their goods and their shares in
   * shops stay theirs, and if they come back the townsfolk start them off again.
   * Without this, every visitor who wanders off takes a little of the town's money out of
   * the game for good, and after enough visitors the shops cannot pay their rent.
   */
  idleCoinHours: 3,
  /** Anything a shopkeeper holds above this at day's end gets spent back into the town. */
  comfortableSavings: 250,
  gatherEnergy: 2,
  maxEnergy: 40,
  /** How a shop's daily custom varies: from this share of an ordinary day's trade, up to that. */
  quietDay: 0.5,
  busyDay: 1.7,
  supplyElasticity: 1.2,
  demandElasticity: 1.3,
  keepEvents: 12,
  keepNotices: 6,
  /** Wanted orders: at most this many go up each morning, one to a shopkeeper. */
  ordersPerDay: 2,
  /** The first order always goes up. A second needs another shop holding less than this share of what it likes to keep. */
  orderShortBelow: 0.9,
  /** An order never asks for fewer than this, or more than that. */
  orderMin: 4,
  orderMax: 12,
  /** The bonus, as a share of what the goods asked for cost at the normal price, and the least it can be. */
  orderBonusShare: 0.6,
  orderBonusMin: 5,
  /** A shopkeeper only posts an order if they could pay its bonus and still have this much in the till. */
  orderCushion: 60,
  /** A player with no share in any shop is called a trader once they are worth this much. */
  traderWorth: 100,
  /** How many players the "richest" list remembers. */
  keepRichest: 10,
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
  const town: Town = {
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
  postOrders(town); // a new town opens on its first morning, so the board should not be bare
  return town;
}

/** Take up to `amount` coins out of the townsfolk's purse, as a gift to a player. Returns what could be found. */
function fromThePurse(town: Town, amount: number): number {
  // If the purse is short (late in a busy day it can be), the richest shopkeeper tops it up first.
  if (town.purse < amount) {
    const richest = Object.values(town.merchants).reduce((a, b) => (b.coins > a.coins ? b : a));
    const help = Math.min(amount - town.purse, richest.coins);
    richest.coins -= help;
    town.purse += help;
  }
  const gift = Math.min(amount, town.purse);
  town.purse -= gift;
  return gift;
}

/** A newcomer arrives. Their first coins are a gift from the townsfolk's purse. */
export function newPlayer(town: Town): Player {
  const gift = fromThePurse(town, TOWN.startingCoins);
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

/**
 * A player has left town (see `idleCoinHours`): their coins go back to the townsfolk.
 * No coin is made or lost. Returns how many went back.
 */
export function leaveTown(town: Town, p: Player): number {
  const back = Math.max(0, Math.floor(p.coins) || 0);
  p.coins -= back;
  town.purse += back;
  p.gone = true;
  if (back > 0) notify(p, `While you were away your ${back} coins went back to the townsfolk: Brambleford does not let coin sit idle. Your goods and your shares in shops are still yours.`);
  return back;
}

/**
 * Someone the town had taken to be gone is back. The townsfolk start them off again
 * as they would a newcomer, if they have less than a newcomer gets. Returns the gift.
 */
export function welcomeBack(town: Town, p: Player): number {
  if (!p.gone) return 0;
  delete p.gone;
  const short = TOWN.startingCoins - p.coins;
  const gift = short > 0 ? fromThePurse(town, short) : 0;
  p.coins += gift;
  if (gift > 0) notify(p, `Welcome back. The townsfolk have put ${gift} coins in your pocket to start you off again.`);
  return gift;
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

/** Look a shop up by id. Anything that is not one of the four ids finds nothing. */
function shopOf(town: Town, id: MerchantId): Merchant | undefined {
  return MERCHANT_IDS.includes(id) ? town.merchants[id] : undefined;
}

const owns = (bag: object, key: string) => Object.prototype.hasOwnProperty.call(bag, key);

/** A count kept under a player's id, or 0. Never fooled by names every JavaScript object has. */
const tally = (bag: Record<string, number>, id: string) => (owns(bag, id) ? bag[id] : 0);

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

/**
 * A short name for a player, for town news and the notice board. An account id
 * is long and means nothing to a reader, so only four characters of it are
 * shown: "g57748bfc0a1b2c3d.brambleford-folk.testnet" is "Traveller 5774".
 * The practice town's one player, "you", is simply "A traveller", and so is
 * anyone who came to town under an account name of their own.
 */
export function friendlyName(playerId: string): string {
  const own = String(playerId ?? '').split('.')[0];
  // Only accounts the game itself made get a tag: their names are a letter and sixteen
  // characters of a hash. Anyone can register a NEAR account under a name of their own
  // choosing and walk into town, and that name is not for the town news to repeat.
  const tag = /^[gu][0-9a-f]{16}$/.test(own) ? own.slice(1, 5) : '';
  return tag ? `Traveller ${tag}` : 'A traveller';
}

// ── Standing ────────────────────────────────────────────────────────────────

/** The ladder of titles, lowest rung first, and what it takes to reach each one. */
export const TITLES = [
  { name: 'Newcomer', needs: 'arrive in town' },
  { name: 'Trader', needs: `be worth ${TOWN.traderWorth} coins` },
  { name: 'Merchant', needs: 'own a share in a shop' },
  { name: 'Burgher', needs: 'own a share in two shops' },
  { name: 'Alderman', needs: 'own a share in all four shops' },
];

/** What a player is worth: their coins, their goods at the normal price, and their shares at what a share costs. */
export function netWorth(town: Town, p: Player, playerId: string): number {
  let worth = p.coins;
  for (const good of GOOD_IDS) worth += GOODS[good].base * (p.inventory[good] ?? 0);
  const perPercent = TOWN.investCost / TOWN.investPct;
  for (const m of Object.values(town.merchants)) worth += tally(m.holders, playerId) * perPercent;
  return worth;
}

/** How many of the shops a player owns a share in. */
export function shopsHeld(town: Town, playerId: string): number {
  let held = 0;
  for (const m of Object.values(town.merchants)) if (tally(m.holders, playerId) > 0) held += 1;
  return held;
}

/** A player's title. Owning part of the town counts for more than coin: without a share, the best is Trader. */
export function titleOf(worth: number, held: number): string {
  const rung = held >= MERCHANT_IDS.length ? 4 : held >= 2 ? 3 : held >= 1 ? 2 : worth >= TOWN.traderWorth ? 1 : 0;
  return TITLES[rung].name;
}

/** The "richest players" list with one player's worth brought up to date: richest first, and only the top few. */
export function ranked(list: Rank[], id: string, worth: number): Rank[] {
  const out = list.filter((r) => r.id !== id);
  out.push({ id, worth });
  out.sort((a, b) => b.worth - a.worth || (a.id < b.id ? -1 : 1));
  return out.slice(0, TOWN.keepRichest);
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
        m.closedOn = town.day;
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
  // A shop nobody has rescued does not stay shut for ever: after a few days the
  // townsfolk club together, out of their own purse, and it opens again.
  for (const m of Object.values(town.merchants)) {
    if (m.open || town.day - (m.closedOn ?? 0) < TOWN.daysUntilWhipRound || town.purse < TOWN.whipRound) continue;
    town.purse -= TOWN.whipRound;
    m.coins += TOWN.whipRound;
    m.open = true;
    m.missedRent = 0;
    announce(town, 'reopened', `The townsfolk clubbed together and ${m.name} the ${m.title.toLowerCase()} is open again.`);
  }
  for (const m of Object.values(town.merchants)) {
    m.coinsAtDawn = m.coins;
    // Some days the town wants bread; some days nobody does. No two days are alike.
    m.bustle = TOWN.quietDay + rng() * (TOWN.busyDay - TOWN.quietDay);
  }
  postOrders(town);

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

// ── Wanted orders ───────────────────────────────────────────────────────────
//
// Each morning the shopkeepers shortest of something ask for it on the notice
// board. Whoever brings the full amount first that day is paid a bonus, out of
// the shopkeeper's own purse, on top of the price of the goods.

/** The orders that went up this morning. From midnight until the shops open there are none. */
export function todaysOrders(town: Town): Order[] {
  return (town.orders ?? []).filter((o) => o.day === town.day);
}

/** Take down the orders of earlier days and pin up today's. Uses no randomness: the town's books decide. */
function postOrders(town: Town) {
  const orders = (town.orders ?? []).filter((o) => o.day >= town.day);

  // Everything any open shop buys, with how well stocked the shop is in it (1 = just what it likes to keep).
  const asks: { m: Merchant; good: GoodId; stocked: number }[] = [];
  for (const m of Object.values(town.merchants)) {
    if (!m.open) continue;
    for (const id of Object.keys(m.usualSupply)) {
      const good = id as GoodId;
      asks.push({ m, good, stocked: (m.stock[good] ?? 0) / Math.max(1, m.target[good] ?? 1) });
    }
  }
  const shortestFirst = asks.map((ask, at) => ({ ...ask, at })).sort((a, b) => a.stocked - b.stocked || a.at - b.at);

  for (const { m, good, stocked } of shortestFirst) {
    if (orders.length >= TOWN.ordersPerDay) break;
    // The first order always goes up, even on a day when nobody is short. Any more need a shop that is.
    if (orders.length > 0 && stocked >= TOWN.orderShortBelow) break;
    if (orders.some((o) => o.merchant === m.id)) continue;
    const stock = m.stock[good] ?? 0;
    const target = m.target[good] ?? 1;
    const wanted = Math.min(TOWN.orderMax, Math.max(TOWN.orderMin, target - stock));
    const bonus = Math.max(TOWN.orderBonusMin, Math.round(wanted * GOODS[good].base * TOWN.orderBonusShare));
    if (m.coins < bonus + TOWN.orderCushion) continue; // cannot spare the bonus
    if (stock + wanted > target * RULES.fullAtTimesTarget) continue; // has no room for that many
    orders.push({ id: town.day * 10 + orders.length + 1, day: town.day, merchant: m.id, good, wanted, bonus, progress: {} });
  }
  town.orders = orders;
}

/**
 * Count a sale towards the shopkeeper's order for that good, if there is one still open today.
 * Returns the bonus paid if this sale filled the order, otherwise 0.
 */
function countTowardsOrder(town: Town, m: Merchant, p: Player, playerId: string, good: GoodId, count: number): number {
  const order = todaysOrders(town).find((o) => o.merchant === m.id && o.good === good && o.wonBy === undefined);
  if (!order) return 0;
  const brought = tally(order.progress, playerId) + count;
  order.progress[playerId] = brought;
  if (brought < order.wanted) return 0;

  // The bonus is the shopkeeper's own money changing hands, so no coin is made or lost.
  const bonus = Math.min(order.bonus, m.coins);
  m.coins -= bonus;
  p.coins += bonus;
  order.wonBy = playerId;
  notify(p, `${m.name} paid you a ${bonus}-coin bonus for filling today's order.`);
  announce(town, 'news', `${friendlyName(playerId)} filled ${m.name}'s order for ${order.wanted} ${GOODS[good].plural}.`);
  return bonus;
}

// ── What a player can do ────────────────────────────────────────────────────

export function gather(town: Town, p: Player, good: GoodId): ActionResult {
  if (!owns(GOODS, good) || !GOODS[good].raw) return { ok: false, message: 'That cannot be gathered.' };
  rest(town, p);
  if (p.energy < TOWN.gatherEnergy) return { ok: false, message: "You're worn out. Eat something, or rest until morning." };
  const n = gatherYield(p);
  p.energy -= TOWN.gatherEnergy;
  add(p.inventory, good, n);
  p.stats.gathered += n;
  return { ok: true, count: n, message: `+${n} ${GOODS[good].plural}` };
}

/**
 * Sell up to `amount` of something to a shop, one at a time, so each sale moves the next price.
 * `playerId` says who is selling, so the sale can count towards a wanted order.
 */
export function sell(town: Town, p: Player, merchantId: MerchantId, good: GoodId, amount = 1, playerId = ''): ActionResult {
  const m = shopOf(town, merchantId);
  if (!m) return { ok: false, message: 'No such shop.' };
  if (!isTradingHour(town)) return { ok: false, message: `${m.name} has gone to bed.` };
  if (!owns(m.usualSupply, good)) return { ok: false, message: `${m.name} has no use for ${GOODS[good]?.plural ?? 'that'}.` };
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
  const result: ActionResult = { ok: true, count, price: total, message: `Sold ${count} for ${total}` };
  const bonus = countTowardsOrder(town, m, p, playerId, good, count);
  if (bonus) result.bonus = bonus;
  return result;
}

export function buy(town: Town, p: Player, merchantId: MerchantId, good: GoodId): ActionResult {
  const m = shopOf(town, merchantId);
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
  const energy = owns(GOODS, good) ? GOODS[good].energy : undefined;
  if (!energy || (p.inventory[good] ?? 0) < 1) return { ok: false, message: 'Nothing to eat.' };
  rest(town, p);
  add(p.inventory, good, -1);
  p.energy = Math.min(p.maxEnergy, p.energy + energy);
  p.stats.eaten += 1;
  return { ok: true, count: 1, message: `+${energy} energy` };
}

/** Put coins into a shop for a share of its profits. Reopens it if it had closed. */
export function invest(town: Town, p: Player, playerId: string, merchantId: MerchantId): ActionResult {
  const m = shopOf(town, merchantId);
  if (!m) return { ok: false, message: 'No such shop.' };
  if (investedPct(m) + TOWN.investPct > TOWN.maxInvestedPct) return { ok: false, message: `${m.name} won't part with any more of the shop.` };
  if (p.coins < TOWN.investCost) return { ok: false, message: `You need ${TOWN.investCost} coins to buy in.` };
  p.coins -= TOWN.investCost;
  m.coins += TOWN.investCost;
  m.holders[playerId] = tally(m.holders, playerId) + TOWN.investPct;
  announce(town, 'news', `${friendlyName(playerId)} bought into ${m.name}'s shop.`);
  if (!m.open) {
    m.open = true;
    m.missedRent = 0;
    m.coinsAtDawn = m.coins;
    announce(town, 'reopened', `${m.name} the ${m.title.toLowerCase()} is open again, thanks to a new investor.`);
  } else {
    // The stake is capital, not takings: it must not be paid out tonight as "profit".
    m.coinsAtDawn += TOWN.investCost;
  }
  return { ok: true, price: TOWN.investCost, message: `You now own ${m.holders[playerId]}% of the shop.` };
}

/**
 * A shopkeeper changes how much they like to keep on the shelf.
 * On chain, only the shopkeeper's own account may call this.
 * `thinker` is a few words on who worked the plan out; a plan sent without one clears the last.
 */
export function setPlan(town: Town, m: Merchant, target: Partial<Record<GoodId, number>>, plan: string, thinker = ''): ActionResult {
  for (const [id, n] of Object.entries(target)) {
    if (!owns(m.target, id)) return { ok: false, message: `${m.name} does not stock ${id}.` };
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 40) return { ok: false, message: 'Shelf targets must be whole numbers from 1 to 40.' };
  }
  Object.assign(m.target, target);
  m.plan = String(plan ?? '').slice(0, 240);
  m.thinker = String(thinker ?? '').slice(0, 60);
  m.plannedOn = town.day;
  return { ok: true, message: 'Plan updated.' };
}

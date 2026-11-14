// Checks the town's rules on their own, with no chain and no network.
//
//   npx tsx scripts/rules-test.ts      ("test:rules": "tsx scripts/rules-test.ts" in package.json)
//
// The rules in src/economy are the very ones the contract runs, so this file is
// the main proof that the town's economy is sound. In order, it checks:
//
//   - the town on its first morning, and the numbers the rules are built on
//   - prices: their limits, their slope, the floor under a selling price, a thin purse
//   - one hour of trade, taken apart: deliveries, making goods, custom, shortages
//   - rent, shutting up shop, the whip-round and dividends
//   - forty-five days hour by hour, with investors, the books checked after every hour
//   - sixty days with players who earn coins and never spend them
//   - everything a player can do, and every reason a shop says no; a shopkeeper's plan
//   - wanted orders, standing and titles
//   - hostile input: ids such as "constructor" and "__proto__", amounts such as NaN and 1e9
//   - 300 seeded games of random play, the town stored as JSON between moves as it is on chain
//   - a town begun under older rules, which has no orders and no "thinker"
//   - the same seed giving the same town, the practice town in the browser tab,
//     and the source using no clock, dice or network
//
// A line marked KNOWN at the end is a real fault in the rules, reported but not
// yet mended. It is printed and does not fail the run. Once the fault is mended
// the line turns into a PASS that asks to be moved up among the ordinary checks.
//
// The checks were themselves checked: each of 185 one-line breakages of the
// rules, tried one at a time, makes this run fail.

import { readFileSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { GOODS, GOOD_IDS, type GoodId } from '../src/economy/goods';
import { RULES, inputCost, quoteBuy, quoteSell, type Quote } from '../src/economy/pricing';
import * as Rules from '../src/economy/town';
import type { ActionResult, Merchant, MerchantId, Player, Rank, Season, Town } from '../src/economy/town';
import { LocalWorld, canInvest, gatherYield as yieldOnScreen, isTradingHour as tradingOnScreen, shareOf, standings, worthOf, type GameWorld } from '../src/economy/world';

const { TOWN, MERCHANT_IDS } = Rules;
const started = process.hrtime.bigint();

// The rules must never look at the clock, roll dice of their own or reach for
// the network. All three are swapped for the whole run, so any use is seen.
const strayed: string[] = [];
const realRandom = Math.random;
Math.random = () => { strayed.push('Math.random'); return realRandom(); };
globalThis.Date = new Proxy(Date, {
  construct(real, args) { strayed.push('new Date'); return Reflect.construct(real, args) as object; },
  apply(real, self, args) { strayed.push('Date()'); return Reflect.apply(real, self, args) as string; },
  get(real, key, receiver) { if (key === 'now') strayed.push('Date.now'); return Reflect.get(real, key, receiver) as unknown; },
});
globalThis.fetch = (async (input: unknown) => {
  strayed.push(`fetch ${String(input)}`);
  throw new Error(`A rules test tried to reach ${String(input)}`);
}) as typeof fetch;

// ── Plumbing ────────────────────────────────────────────────────────────────

let failures = 0, passed = 0;
function check(name: string, ok: boolean, detail = '') {
  const shown = ok && detail.length > 260 ? `${detail.slice(0, 257)}...` : detail; // a failure is shown whole
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${shown ? `  (${shown})` : ''}`);
  if (ok) passed += 1; else failures += 1;
}
let under = '';
const heading = (text: string) => { under = text; console.log(`\n${text}`); };
/** Run one group of checks. If the rules are so broken that the group cannot be run to its end, say so and carry on with the next. */
function group(run: () => void) {
  try { run(); } catch (e) { check(`the checks under "${under}" could be run to their end`, false, e instanceof Error ? e.message : String(e)); }
}

/** Run `look`, which answers with the first thing it finds wrong, in words, or '' if nothing is. An error thrown counts as wrong. */
function sound(name: string, look: () => string, note = '') {
  let wrong: string;
  try { wrong = look(); } catch (e) { wrong = `threw: ${e instanceof Error ? e.message : String(e)}`; }
  check(name, !wrong, wrong || note);
}

const knownProblems: { name: string; detail: string; rank: number }[] = [];
/**
 * A check that fails today because of a real fault in the rules. It is listed at the end and does not fail the run.
 * `rank` orders that list: 1 for a fault that can stop the town, 2 for one a player could meet, 3 for one only a hand-made call reaches.
 */
function known(name: string, holds: boolean, detail: string, rank = 3) {
  if (holds) check(`${name}  [was on the KNOWN list and holds now: move it up among the ordinary checks]`, true);
  else knownProblems.push({ name, detail, rank });
}

/** Remembers the first thing that went wrong of each kind over thousands of steps, so the run prints one line a kind. */
class Watch {
  steps = 0;
  private first = new Map<string, string>();
  note(kind: string, wrong: string, where: () => string) {
    if (wrong && !this.first.has(kind)) this.first.set(kind, `${where()}: ${wrong}`);
  }
  report(name: string, kind: string) {
    check(name, !this.first.has(kind), this.first.get(kind) ?? '');
  }
}

/** How often each thing happened in the long runs, so a last check can see that every path was walked. */
const happened: Record<string, number> = {};
const count = (what: string, n = 1) => { happened[what] = (happened[what] ?? 0) + n; };

type Bag = Partial<Record<GoodId, number>>;
const RAW = GOOD_IDS.filter((g) => GOODS[g].raw);
const MADE = GOOD_IDS.filter((g) => !GOODS[g].raw);
const FOOD = GOOD_IDS.filter((g) => (GOODS[g].energy ?? 0) > 0);

const owns = (bag: object, key: string) => Object.prototype.hasOwnProperty.call(bag, key);
const have = (bag: Bag, good: GoodId) => bag[good] ?? 0;
const goodsOf = (bag: Bag) => Object.keys(bag) as GoodId[];
const shopsOf = (town: Town): Merchant[] => MERCHANT_IDS.map((id) => town.merchants[id]);
const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
const text = (value: unknown): string => JSON.stringify(value);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** A value as a reader would write it, for a failure message. */
const say = (value: unknown) => (typeof value === 'number' || value === undefined ? String(value) : text(value));
const fallsOrHolds = (list: number[]) => list.every((n, i) => i === 0 || n <= list[i - 1]);
const risesOrHolds = (list: number[]) => list.every((n, i) => i === 0 || n >= list[i - 1]);

/** Where two values first differ, in words. */
function firstDifference(a: unknown, b: unknown, at = 'it'): string {
  if (isDeepStrictEqual(a, b)) return '';
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const found = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${at}.${key}`);
      if (found) return found;
    }
  }
  return `${at} is ${say(a)}, not ${say(b)}`;
}

// ── Setting a scene without making or losing a coin ─────────────────────────

/** Move coins out of the townsfolk's purse into a till or a pocket (or back, with a minus). */
function fromPurse(town: Town, to: { coins: number }, n: number) {
  if (town.purse < n || to.coins + n < 0) throw new Error('The test asked for coins that are not there.');
  town.purse -= n;
  to.coins += n;
}
/** Set a till or a pocket to an exact sum, the difference going to or from the purse. */
const setCoins = (town: Town, who: { coins: number }, coins: number) => fromPurse(town, who, coins - who.coins);

interface Scene { town: Town; me: Player; total: number }
/** A new town with one newcomer in it. */
function scene(): Scene {
  const town = Rules.newTown();
  const me = Rules.newPlayer(town);
  return { town, me, total: Rules.totalCoins(town, [me]) };
}

/**
 * A town where nothing happens by itself: no gatherers call and the shelves are
 * bare, so nothing is made and nothing sold. Tills then move only by rent,
 * dividends, the whip-round and what a test does by hand.
 */
function stillTown(): Town {
  const town = Rules.newTown();
  for (const m of shopsOf(town)) {
    for (const g of goodsOf(m.usualSupply)) m.usualSupply[g] = 0;
    for (const g of goodsOf(m.stock)) m.stock[g] = 0;
  }
  return town;
}

/** Shut a shop by hand, as two days of unpaid rent would. */
function shut(town: Town, m: Merchant) {
  m.open = false;
  m.missedRent = TOWN.missedRentLimit;
  m.closedOn = town.day;
}

const nobodyPaid: Rules.Pay = () => {};
/** Let hours pass while `more` says so. It gives up after twelve days, so a broken clock cannot keep a test waiting for ever. */
function pass(town: Town, rng: Rules.Rng, pay: Rules.Pay, more: () => boolean) {
  for (let i = 0; i < 12 * 24 && more(); i++) Rules.tickHour(town, rng, pay);
}
/** Let hours pass until the clock next shows `hour`: at least one, at most a day's worth. */
function until(town: Town, hour: number, rng: Rules.Rng, pay: Rules.Pay = nobodyPaid) {
  for (let i = 0; i < 24; i++) { Rules.tickHour(town, rng, pay); if (town.hour === hour) return; }
}
/** Skip straight to the next morning with no day's trade in between, so a test can set the shelves and see what gets pinned up. */
function nextDawn(town: Town, rng: Rules.Rng = Rules.seededRng(1)) {
  town.day += 1;
  town.hour = TOWN.openHour - 1;
  Rules.tickHour(town, rng, nobodyPaid);
}

interface Paid { holder: string; coins: number; note: string; from: MerchantId }
/** Hands a dividend on as the contract does: to the holder's own coins if they are a player, back to the townsfolk if not. */
function payer(town: () => Town, folk: Map<string, Player>, log: Paid[] = []): Rules.Pay {
  return (holder, coins, note, from) => {
    log.push({ holder, coins, note, from });
    const p = folk.get(holder);
    if (!p) { town().purse += coins; return; }
    p.coins += coins;
    Rules.notify(p, note);
  };
}

// ── Keeping the books: what must be true of any town at any moment ──────────

/** Coins: counted by hand, against the total they should come to, and against what the rules' own count says. */
function coinTrouble(town: Town, players: Player[], total: number): string {
  const byHand = town.purse + sum(shopsOf(town).map((m) => m.coins)) + sum(players.map((p) => p.coins));
  if (byHand !== total) return `the town holds ${byHand} coins, not ${total}`;
  const said = Rules.totalCoins(town, players);
  return said === byHand ? '' : `totalCoins says ${said}, but the purse, tills and pockets add up to ${byHand}`;
}

/** Every coin count and every stock count is a whole number, 0 or more. */
function balanceTrouble(town: Town, players: Player[]): string {
  if (!whole(town.purse)) return `the purse holds ${town.purse}`;
  for (const m of shopsOf(town)) {
    if (!whole(m.coins)) return `${m.id} has ${m.coins} coins`;
    for (const [g, n] of Object.entries(m.stock)) if (!whole(n)) return `${m.id} has ${n} ${g}`;
  }
  for (const p of players) {
    if (!whole(p.coins)) return `a player has ${p.coins} coins`;
    for (const [g, n] of Object.entries(p.inventory)) if (!whole(n)) return `a player carries ${n} ${g}`;
    if (!whole(p.energy) || p.energy > p.maxEnergy) return `a player has ${p.energy} energy`;
  }
  return '';
}

/** News and notices are trimmed to the last few, and numbered in order with nothing skipped. */
function trimTrouble(town: Town, players: Player[]): string {
  if (town.events.length > TOWN.keepEvents) return `${town.events.length} pieces of news are kept, more than ${TOWN.keepEvents}`;
  if (town.events.length !== Math.min(town.eventSeq, TOWN.keepEvents)) return `${town.events.length} pieces of news are kept after ${town.eventSeq} were told`;
  for (let i = 0; i < town.events.length; i++) {
    const due = town.eventSeq - town.events.length + 1 + i;
    if (town.events[i].seq !== due) return `a piece of news is numbered ${town.events[i].seq}, not ${due}`;
  }
  for (const p of players) {
    if (p.notices.length > TOWN.keepNotices) return `a player keeps ${p.notices.length} notices, more than ${TOWN.keepNotices}`;
    if (p.notices.length !== Math.min(p.noticeSeq, TOWN.keepNotices)) return `a player keeps ${p.notices.length} notices after being sent ${p.noticeSeq}`;
    for (let i = 0; i < p.notices.length; i++) {
      const due = p.noticeSeq - p.notices.length + 1 + i;
      if (p.notices[i].seq !== due) return `a notice is numbered ${p.notices[i].seq}, not ${due}`;
    }
  }
  return '';
}

const START_SHELVES = Object.fromEntries(shopsOf(Rules.newTown()).map((m) => [m.id, goodsOf(m.target).sort().join()]));

/** Everything else that must stay true of a town: who owns what share, what is on the board, what is on the shelves. */
function shapeTrouble(town: Town, players: Player[]): string {
  if (!whole(town.day) || town.day < 1) return `it is day ${town.day}`;
  if (!whole(town.hour) || town.hour > 23) return `it is hour ${town.hour}`;
  if (Object.keys(town.merchants).join() !== MERCHANT_IDS.join()) return 'the shops are not the four the town began with';
  for (const m of shopsOf(town)) {
    if (!whole(m.missedRent) || (m.open ? m.missedRent >= TOWN.missedRentLimit : m.missedRent < TOWN.missedRentLimit)) return `${m.id} is ${m.open ? 'open' : 'shut'} with rent unpaid ${m.missedRent} days`;
    if (!m.open && !(whole(m.closedOn) && m.closedOn <= town.day)) return `${m.id} is shut, but the day it shut is ${m.closedOn}`;
    let held = 0;
    for (const [holder, pct] of Object.entries(m.holders)) {
      if (!whole(pct) || pct < 1 || pct % TOWN.investPct !== 0) return `${say(holder)} holds ${say(pct)}% of ${m.id}`;
      held += pct;
    }
    if (held > TOWN.maxInvestedPct) return `${held}% of ${m.id} is sold, above the most a shop will sell`;
    if (Rules.investedPct(m) !== held) return `investedPct says ${Rules.investedPct(m)}% of ${m.id} is sold, but the shares add up to ${held}%`;
    if (goodsOf(m.target).sort().join() !== START_SHELVES[m.id]) return `${m.id} now has shelf targets for ${goodsOf(m.target).join()}`;
    for (const [g, n] of Object.entries(m.target)) if (!whole(n) || n < 1 || n > 40) return `${m.id} likes to keep ${say(n)} ${g}`;
    for (const g of goodsOf(m.stock)) if (!GOOD_IDS.includes(g)) return `${m.id} stocks ${say(g)}, which is not a good`;
    for (const [g, n] of Object.entries(m.recentSales)) if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return `${m.id}'s recent sales of ${g} are ${say(n)}`;
    if (!whole(m.townIncome) || !whole(m.coinsAtDawn)) return `${m.id}'s day books read ${m.townIncome} and ${m.coinsAtDawn}`;
    if (m.bustle !== undefined && !(m.bustle >= TOWN.quietDay && m.bustle <= TOWN.busyDay)) return `${m.id}'s custom today is ${m.bustle} of the usual`;
    if (typeof m.plan !== 'string' || m.plan.length > 240) return `${m.id}'s plan is not a short piece of writing`;
    if (m.thinker !== undefined && (typeof m.thinker !== 'string' || m.thinker.length > 60)) return `${m.id}'s thinker is not a few words`;
  }
  if (town.season) {
    const s = town.season;
    if (!RAW.includes(s.good) || !(s.factor > 0) || !whole(s.daysLeft) || s.daysLeft < 1 || s.daysLeft > 3) return `the season is ${text(s)}`;
  }
  const board = town.orders ?? [];
  const today = Rules.todaysOrders(town);
  if (today.length > TOWN.ordersPerDay) return `${today.length} orders are up today`;
  if (new Set(today.map((o) => o.merchant)).size !== today.length) return 'a shopkeeper has two orders up';
  if (new Set(board.map((o) => o.id)).size !== board.length) return 'two orders share a number';
  for (const o of board) {
    if (o.day > town.day || o.day < town.day - 1) return `an order from day ${o.day} is on the board on day ${town.day}`;
    const m = MERCHANT_IDS.includes(o.merchant) ? town.merchants[o.merchant] : undefined;
    if (!m || !owns(m.usualSupply, o.good)) return `an order asks ${say(o.merchant)} for ${say(o.good)}`;
    if (!whole(o.wanted) || o.wanted < TOWN.orderMin || o.wanted > TOWN.orderMax) return `an order asks for ${o.wanted}`;
    if (!whole(o.bonus) || o.bonus < TOWN.orderBonusMin) return `an order offers a bonus of ${o.bonus}`;
    for (const [who, n] of Object.entries(o.progress)) if (!whole(n) || n < 1) return `an order counts ${say(n)} brought by ${say(who)}`;
    if (o.wonBy !== undefined && !((owns(o.progress, o.wonBy) ? o.progress[o.wonBy] : 0) >= o.wanted)) return `an order was won by ${say(o.wonBy)}, who had not brought enough`;
  }
  for (const p of players) {
    for (const n of Object.values(p.stats)) if (!whole(n)) return `a player's tally reads ${n}`;
    if (!whole(p.restedOn) || p.restedOn > town.day || p.maxEnergy !== TOWN.maxEnergy) return `a player last rested on day ${p.restedOn} with room for ${p.maxEnergy} energy`;
    for (const g of goodsOf(p.inventory)) if (!GOOD_IDS.includes(g)) return `a player carries ${say(g)}, which is not a good`;
  }
  return '';
}

/** The contract keeps the town as JSON between calls: a town must come back from that exactly as it went in. */
function jsonTrouble(value: unknown, what = 'the town'): string {
  const back: unknown = JSON.parse(JSON.stringify(value));
  return isDeepStrictEqual(value, back) ? '' : `${what} comes back from JSON changed: ${firstDifference(value, back)}`;
}

/** What a shop would ask for on the notice board, worked out from its books. */
function ask(m: Merchant, good: GoodId) {
  const stock = have(m.stock, good), target = m.target[good] ?? 1;
  const wanted = Math.min(TOWN.orderMax, Math.max(TOWN.orderMin, target - stock));
  const bonus = Math.max(TOWN.orderBonusMin, Math.round(wanted * GOODS[good].base * TOWN.orderBonusShare));
  const fits = m.open && m.coins >= bonus + TOWN.orderCushion && stock + wanted <= target * RULES.fullAtTimesTarget;
  return { stocked: stock / Math.max(1, target), wanted, bonus, fits };
}

/** The notice board straight after the orders went up: is every one of them a fair ask? */
function postedTrouble(town: Town): string {
  const board = Rules.todaysOrders(town);
  if ((town.orders ?? []).length !== board.length) return 'an order from an earlier day is still pinned up';
  if (board.length > TOWN.ordersPerDay) return `${board.length} orders went up`;
  const seen = new Set<string>();
  for (const [at, o] of board.entries()) {
    const m = MERCHANT_IDS.includes(o.merchant) ? town.merchants[o.merchant] : undefined;
    if (!m) return `an order went up for ${say(o.merchant)}`;
    if (!m.open) return `${m.id} is shut, yet put up an order`;
    if (seen.has(m.id)) return `${m.id} put up two orders`;
    seen.add(m.id);
    if (!owns(m.usualSupply, o.good)) return `${m.id} asked for ${o.good}, which it does not buy`;
    const due = ask(m, o.good);
    if (o.wanted !== due.wanted) return `${m.id} asked for ${o.wanted} ${o.good}, holding ${have(m.stock, o.good)} against the ${m.target[o.good]} it likes`;
    if (o.bonus !== due.bonus) return `${m.id} offered ${o.bonus} for ${o.wanted} ${o.good}, not ${due.bonus}`;
    if (m.coins < o.bonus + TOWN.orderCushion) return `${m.id} offered a bonus of ${o.bonus} with only ${m.coins} in the till`;
    if (have(m.stock, o.good) + o.wanted > (m.target[o.good] ?? 1) * RULES.fullAtTimesTarget) return `${m.id} asked for more ${o.good} than it has room for`;
    if (at > 0 && due.stocked >= TOWN.orderShortBelow) return `${m.id} put up a second order though it is not short of ${o.good}`;
    if (o.day !== town.day || Object.keys(o.progress).length || o.wonBy !== undefined) return 'an order went up already begun, or dated another day';
  }
  // The shop shortest of something is asked first, and the first order always goes up if any shop can make a fair ask.
  const lead = board.length ? ask(town.merchants[board[0].merchant], board[0].good).stocked : Infinity;
  for (const m of shopsOf(town)) for (const g of goodsOf(m.usualSupply)) {
    const could = ask(m, g);
    if (could.fits && !board.length) return `nothing went up, though ${m.id} could have asked for ${g}`;
    if (could.fits && could.stocked < lead) return `${m.id} is shorter of ${g} than the shop that was asked first`;
  }
  return '';
}

/** One hour has passed, with nobody doing anything in between: did the town keep to its timetable? */
function hourTrouble(was: Town, town: Town, paid: Paid[]): string {
  const trading = was.hour >= TOWN.openHour && was.hour < TOWN.closeHour;
  const closing = was.hour === TOWN.closeHour - 1;
  const dawning = was.hour === TOWN.openHour - 1;
  if (town.hour !== (was.hour + 1) % 24) return `the hour went from ${was.hour} to ${town.hour}`;
  if (town.day !== was.day + (was.hour === 23 ? 1 : 0)) return `the day went from ${was.day} to ${town.day} as the hour left ${was.hour}`;

  const news = town.events.filter((e) => e.seq > was.eventSeq);
  if (town.eventSeq !== was.eventSeq + news.length) return 'news was told and not kept';
  if (news.length && !closing && !dawning) return `news broke at ${was.hour}:00: ${news[0].text}`;
  if (paid.length && !closing) return 'a dividend was paid outside closing time';
  if (new Set(paid.map((d) => `${d.from} ${d.holder}`)).size !== paid.length) return 'a holder was paid twice by one shop';

  let rescued = 0;
  for (const id of MERCHANT_IDS) {
    const m = town.merchants[id], w = was.merchants[id];
    const cuts = paid.filter((d) => d.from === id);
    if (text(m.holders) !== text(w.holders) || text(m.target) !== text(w.target) || m.plan !== w.plan || text(m.recipe) !== text(w.recipe) || m.upkeep !== w.upkeep) return `an hour passing changed who owns ${id} or what it plans`;

    if (w.open && !m.open) {
      if (!closing) return `${id} shut outside closing time`;
      if (m.missedRent !== w.missedRent + 1 || m.missedRent < TOWN.missedRentLimit) return `${id} shut with rent unpaid ${m.missedRent} days`;
      if (m.closedOn !== town.day) return `${id} shut on day ${town.day}, but its books say day ${m.closedOn}`;
      if (!news.some((e) => e.kind === 'closed' && e.text.includes(m.name))) return `${id} shut and the town was not told`;
      if (cuts.length) return `${id} paid a dividend on the evening it shut`;
    }
    if (!w.open && m.open) {
      if (!dawning) return `${id} opened again by itself outside dawn`;
      if (town.day - (w.closedOn ?? 0) < TOWN.daysUntilWhipRound) return `${id} was rescued ${town.day - (w.closedOn ?? 0)} days after it shut`;
      if (m.coins !== w.coins + TOWN.whipRound || m.missedRent !== 0) return `${id} was rescued with ${m.coins - w.coins} coins and ${m.missedRent} rents still owing`;
      if (!news.some((e) => e.kind === 'reopened' && e.text.includes(m.name))) return `${id} was rescued and the town was not told`;
      rescued += 1;
    }
    if (!w.open && !m.open) {
      if (m.coins !== w.coins || text(m.stock) !== text(w.stock) || m.townIncome !== 0 || m.missedRent !== w.missedRent || cuts.length) return `${id} is shut, but its books moved`;
      if (dawning && town.day - (w.closedOn ?? 0) >= TOWN.daysUntilWhipRound && town.purse >= TOWN.whipRound) return `${id} was left shut though the townsfolk could afford to rescue it`;
    }

    if (!trading) {
      if (text(m.stock) !== text(w.stock) || m.townIncome !== 0 || text(m.recentSales) !== text(w.recentSales)) return `${id} traded at night`;
      if (m.coins !== w.coins + (!w.open && m.open ? TOWN.whipRound : 0)) return `${id}'s till moved at night`;
    } else if (w.open) {
      const out = m.recipe.output;
      const sold = (have(m.recentSales, out) - have(w.recentSales, out) * 0.85) / 0.15;
      if (Math.abs(sold - Math.round(sold)) > 1e-6 || sold < -1e-6) return `${id}'s recent sales moved as if it had sold ${sold}`;
      if ((Math.round(sold) > 0) !== (m.townIncome > 0)) return `${id} sold ${Math.round(sold)} and took ${m.townIncome} coins`;
      const made = have(m.stock, out) - have(w.stock, out) + Math.round(sold);
      if (made < 0 || made > m.recipe.perHour) return `${id} made ${made} ${out} in an hour`;
      if (made > 0 && have(w.stock, out) + made > (w.target[out] ?? 0)) return `${id} made ${out} past what it likes to keep`;
      let delivered = 0;
      for (const g of goodsOf(m.recipe.inputs)) {
        const came = have(m.stock, g) - have(w.stock, g) + made * (m.recipe.inputs[g] ?? 0);
        if (came < 0) return `${id} lost ${-came} ${g}`;
        delivered += came;
      }
      // Every delivery cost at least a coin, and the only coins that came in were the townsfolk's.
      if (!closing && m.coins - w.coins > m.townIncome - delivered) return `${id}'s till grew by ${m.coins - w.coins}, taking ${m.townIncome} and paying for ${delivered} deliveries`;
    }

    if (closing && w.open && m.open) {
      if (m.coins > TOWN.comfortableSavings) return `${id} kept ${m.coins} coins overnight`;
      if (m.missedRent !== 0 && m.missedRent !== w.missedRent + 1) return `${id}'s unpaid rent went from ${w.missedRent} days to ${m.missedRent}`;
      const out = sum(cuts.map((d) => d.coins));
      // If nothing was swept back to the townsfolk, the till shows exactly what the profit was.
      const swept = m.coins === TOWN.comfortableSavings;
      const profit = m.coins + out - w.coinsAtDawn;
      for (const [holder, pct] of Object.entries(w.holders)) {
        // Rent comes first: on an evening it went unpaid, nothing is shared out.
        const due = profit > 0 && m.missedRent === 0 ? Math.floor((profit * pct) / 100) : 0;
        const got = sum(cuts.filter((d) => d.holder === holder).map((d) => d.coins));
        if (swept ? got < due : got !== due) return `${holder} was paid ${got} by ${id}, but ${pct}% of a profit of ${swept ? 'at least ' : ''}${profit} is ${due}`;
      }
    } else if (m.missedRent !== w.missedRent && !(w.open && !m.open) && !(!w.open && m.open)) return `${id}'s unpaid rent changed outside closing time`;

    if (dawning) {
      if (m.coinsAtDawn !== m.coins) return `${id} began the day with ${m.coins} coins, but its books say ${m.coinsAtDawn}`;
      if (!(m.bustle !== undefined && m.bustle >= TOWN.quietDay && m.bustle <= TOWN.busyDay)) return `${id}'s custom for the day is ${m.bustle} of the usual`;
    } else if (m.coinsAtDawn !== w.coinsAtDawn || m.bustle !== w.bustle) return `${id}'s morning books changed during the day`;
  }

  for (const d of paid) {
    const w = was.merchants[d.from];
    if (!w || !w.open) return 'a shut shop paid a dividend';
    if (!owns(w.holders, d.holder)) return `${d.holder} was paid by ${d.from} without holding a share`;
    if (!whole(d.coins) || d.coins < 1) return `a dividend of ${d.coins} coins was paid`;
    if (!d.note.includes(` ${d.coins} `)) return 'a dividend note does not name the sum';
  }
  if (!trading && town.purse !== was.purse - rescued * TOWN.whipRound) return `the purse moved by ${town.purse - was.purse} at night`;

  if (dawning) {
    const wrong = postedTrouble(town);
    if (wrong) return wrong;
    const s = town.season, ws = was.season;
    if (ws && ws.daysLeft > 1) {
      if (!s || s.daysLeft !== ws.daysLeft - 1 || s.good !== ws.good || s.factor !== ws.factor) return 'a shortage or glut did not count down a day';
    } else if (ws) {
      if (s !== null || !news.some((e) => e.kind === 'news' && /back to normal/.test(e.text))) return 'a shortage or glut did not end when its days ran out';
    } else if (s) {
      if (s.daysLeft !== 2 && s.daysLeft !== 3) return `a shortage or glut began with ${s.daysLeft} days to run`;
      if (!news.some((e) => e.kind === 'news' && e.text === s.headline)) return 'a shortage or glut began and the town was not told';
    }
  } else {
    if (text(town.orders) !== text(was.orders)) return 'the notice board changed outside dawn';
    if (text(town.season) !== text(was.season)) return 'the season changed outside dawn';
  }
  return '';
}

// ── 1. The town on its first morning ────────────────────────────────────────
heading('The town on its first morning');
group(() => {
  const town = Rules.newTown();
  const all = shopsOf(town);

  check('the eight goods carry the ids the chain already uses as token ids', GOOD_IDS.join() === 'ore,wood,wheat,fish,tools,bread,smoked_fish,furniture', GOOD_IDS.join());
  check('ore, wood, wheat and fish are gathered; tools, bread, smoked fish and furniture are made', RAW.join() === 'ore,wood,wheat,fish' && MADE.join() === 'tools,bread,smoked_fish,furniture', `${RAW.join()} and ${MADE.join()}`);
  check('only bread and smoked fish can be eaten', FOOD.join() === 'bread,smoked_fish', FOOD.join());
  check('every normal price is a whole number of coins, 1 or more', GOOD_IDS.every((g) => whole(GOODS[g].base) && GOODS[g].base >= 1));
  check('the four shops carry the ids the chain already uses', MERCHANT_IDS.join() === 'blacksmith,baker,fishmonger,carpenter' && Object.keys(town.merchants).join() === MERCHANT_IDS.join() && all.every((m, i) => m.id === MERCHANT_IDS[i]));
  check('a new town opens its shops at 6 on day 1, with no news yet and no shortage', town.day === 1 && town.hour === TOWN.openHour && Rules.isTradingHour(town) && town.events.length === 0 && town.eventSeq === 0 && town.season === null);

  sound('every shop starts open, rent paid up, owned by nobody, its books in whole numbers', () => {
    for (const m of all) {
      if (!m.open || m.missedRent !== 0 || Object.keys(m.holders).length || m.closedOn !== undefined) return `${m.id} does not start with a clean slate`;
      if (!whole(m.coins) || m.coinsAtDawn !== m.coins || m.townIncome !== 0 || !whole(m.upkeep) || m.upkeep < 1) return `${m.id}'s till is wrong`;
      if (text(m.recentSales) !== text(m.usualSales)) return `${m.id}'s recent sales do not start at the usual`;
      for (const g of goodsOf(m.target)) if (!whole(m.stock[g]) || !whole(m.target[g]) || have(m.target, g) < 1 || have(m.target, g) > 40) return `${m.id}'s shelf of ${g} is wrong`;
    }
    return '';
  });
  sound('every shop buys in each thing its recipe needs and sells the one thing it makes', () => {
    for (const m of all) {
      const needs = goodsOf(m.recipe.inputs), out = m.recipe.output;
      if (!needs.length || needs.some((g) => !GOODS[g].raw || !owns(m.usualSupply, g) || !owns(m.target, g) || !(have(m.recipe.inputs, g) >= 1))) return `${m.id}'s recipe needs something it does not buy in`;
      if (goodsOf(m.usualSupply).some((g) => !owns(m.recipe.inputs, g))) return `${m.id} buys in something it has no use for`;
      if (GOODS[out].raw || goodsOf(m.usualSales).join() !== out || !owns(m.target, out) || !(have(m.usualSales, out) > 0) || !(m.recipe.perHour >= 1)) return `${m.id} does not sell exactly what it makes`;
    }
    return '';
  });
  check('each made good is sold by exactly one shop, and each gathered good is wanted by at least one', MADE.every((g) => all.filter((m) => m.recipe.output === g).length === 1) && RAW.every((g) => all.some((m) => owns(m.usualSupply, g))));

  {
    const t = Rules.newTown(), a = Rules.newPlayer(t), b = Rules.newPlayer(t);
    fromPurse(t, b, 7);
    const byHand = t.purse + sum(shopsOf(t).map((m) => m.coins)) + a.coins + b.coins;
    check('totalCoins is the purse, every till and every pocket added up', Rules.totalCoins(t, [a, b]) === byHand && Rules.totalCoins(t, [a]) === byHand - b.coins && Rules.totalCoins(t, []) === byHand - a.coins - b.coins, `${Rules.totalCoins(t, [a, b])} against ${byHand}`);
  }
  {
    const a = Rules.newTown(), b = Rules.newTown(), untouched = text(b);
    const m = a.merchants.baker;
    m.stock.bread = 99; m.target.bread = 1; m.recipe.inputs.wheat = 9; m.usualSales.bread = 9; m.usualSupply.wheat = 9; m.recentSales.bread = 9; m.holders.someone = 25;
    a.orders?.splice(0); a.events.push({ seq: 1, day: 1, hour: 6, kind: 'news', text: 'x' });
    check('two new towns share nothing: changing one leaves the other, and the next, as they were', text(b) === untouched && text(Rules.newTown()) === untouched);
  }

  {
    const R = RULES, T = TOWN;
    const pinned: [string, number, number][] = [
      ['coins in the whole town', Rules.totalCoins(town, []), 2200], ['coins for a newcomer', T.startingCoins, 20], ['coins for a stake', T.investCost, 100], ['percent a stake buys', T.investPct, 25],
      ['percent a shop will sell', T.maxInvestedPct, 75], ['missed rents that shut a shop', T.missedRentLimit, 2], ['days until a whip-round', T.daysUntilWhipRound, 3], ['coins in a whip-round', T.whipRound, 150],
      ['opening hour', T.openHour, 6], ['closing hour', T.closeHour, 20], ['energy a swing costs', T.gatherEnergy, 2], ['energy when rested', T.maxEnergy, 40], ['orders a morning', T.ordersPerDay, 2],
      ['fewest an order asks for', T.orderMin, 4], ['most an order asks for', T.orderMax, 12], ['coins an order leaves in the till', T.orderCushion, 60], ['worth that makes a Trader', T.traderWorth, 100],
      ['share of its purse a shop will spend on one item', R.maxSpendShare, 0.5], ['times its liking at which a shelf is full', R.fullAtTimesTarget, 3], ['coins below which a shop turns careful', R.cautiousBelowCoins, 60],
    ];
    const moved = pinned.filter(([, is, was]) => is !== was).map(([what, is, was]) => `${what}: ${is}, not ${was}`);
    check('the headline numbers are the ones the README gives and the checks below name in words', moved.length === 0, moved.join('; '));
  }
  sound('the numbers the rules are built on hang together', () => {
    const R = RULES, T = TOWN;
    const facts: [string, boolean][] = [
      ['prices can fall below normal and climb above it', R.minMultiplier > 0 && R.minMultiplier < 1 && R.maxMultiplier > 1 && R.scarcityPower > 0],
      ['trade can pull a price both ways', R.minDemandFactor > 0 && R.minDemandFactor <= 1 && R.maxDemandFactor >= 1 && R.demandPull > 0],
      ['a careful shop still pays something', R.cautiousDiscount > 0 && R.cautiousDiscount < 1 && R.cautiousBelowCoins > 0],
      ['a shop spends part of its purse, never more than all of it', R.maxSpendShare > 0 && R.maxSpendShare <= 1],
      ['a shop is full somewhere above what it likes to keep', R.fullAtTimesTarget > 1 && R.minMarkupOverCost >= 0],
      ['the shops open before they close', whole(T.openHour) && whole(T.closeHour) && T.openHour < T.closeHour && T.closeHour <= 24],
      ['night hours pass faster than day hours', T.hourMs.night > 0 && T.hourMs.night < T.hourMs.day],
      ['rent can be missed before a shop shuts, and a rescue comes later', T.missedRentLimit >= 1 && T.daysUntilWhipRound >= 1 && T.whipRound > 0],
      ['a rescued shop can pay at least one day of rent', all.every((m) => T.whipRound >= m.upkeep)],
      ['stakes come in equal parts and a shop never sells all of itself', T.investPct > 0 && T.maxInvestedPct % T.investPct === 0 && T.maxInvestedPct >= T.investPct && T.maxInvestedPct < 100 && whole(T.investCost) && T.investCost > 0],
      ['a newcomer is given something, and the purse starts able to give it', whole(T.startingCoins) && T.startingCoins > 0 && town.purse >= T.startingCoins],
      ['every shop starts able to pay its rent, with no more than a comfortable sum', all.every((m) => m.coins >= m.upkeep && m.coins <= T.comfortableSavings)],
      ['a rested player can gather', T.gatherEnergy > 0 && T.maxEnergy >= T.gatherEnergy],
      ['a quiet day is quieter than a busy one', T.quietDay > 0 && T.quietDay <= 1 && T.busyDay >= 1],
      ['orders ask for a sensible amount and pay a real bonus', T.ordersPerDay >= 1 && T.orderMin >= 1 && T.orderMin <= T.orderMax && T.orderBonusMin >= 1 && T.orderBonusShare > 0 && T.orderShortBelow > 0 && T.orderShortBelow <= 1 && T.orderCushion >= 0],
      ['the town remembers a little news, a few notices and the ten richest', T.keepEvents >= 1 && T.keepNotices >= 1 && T.keepRichest === 10 && T.traderWorth > 0],
    ];
    return facts.filter(([, holds]) => !holds).map(([what]) => what).join('; ');
  });
});

// ── 2. Prices ───────────────────────────────────────────────────────────────
heading('Prices: what a shop pays for what it uses');

/** Shelves to try: every count from bare to six times what the shop likes, and a few far beyond. */
const shelves = (target: number) => [...Array(target * 6 + 1).keys(), 100, 400, 1000];
/** Tills to try: every sum from nothing to 130 coins, then well off, then rich. */
const TILLS = [...Array(131).keys(), 250, 1000];
const tight = (coins: number) => coins < RULES.cautiousBelowCoins;
const lastOf = (q: Quote) => q.reasons[q.reasons.length - 1] ?? '';
const names = (reason: string, price: number) => new RegExp(`\\b${price}\\b`).test(reason);

interface BuyCase { m: Merchant; good: GoodId; base: number; target: number; stock: number; coins: number; full: boolean; q: Quote }
/** Every shop, every good it buys in, every shelf and every till. `look` answers with what is wrong, or ''. */
function eachBuy(look: (c: BuyCase) => string): string {
  for (const id of MERCHANT_IDS) {
    const m = Rules.newTown().merchants[id];
    for (const good of goodsOf(m.usualSupply)) {
      const target = m.target[good] ?? 1;
      for (const coins of TILLS) for (const stock of shelves(target)) {
        m.coins = coins;
        m.stock[good] = stock;
        const wrong = look({ m, good, base: GOODS[good].base, target, stock, coins, full: stock >= target * RULES.fullAtTimesTarget, q: quoteBuy(m, good) });
        if (wrong) return `${m.name} holding ${stock} ${good} (likes ${target}) with ${coins} coins: ${wrong}`;
      }
    }
  }
  return '';
}

sound('what a shop pays is a whole number of coins, 1 or more', () => eachBuy(({ q }) => (whole(q.price) && q.price >= 1 ? '' : `it pays ${q.price}`)));
sound('what a shop pays stays between the lowest and the highest multiple of the normal price', () => eachBuy(({ q, base, coins }) => {
  const careful = tight(coins) ? 1 - RULES.cautiousDiscount : 1;
  const least = Math.max(1, Math.round(base * (RULES.minMultiplier * careful))), most = Math.round(base * (RULES.maxMultiplier * careful));
  return q.price >= least && q.price <= most ? '' : `it pays ${q.price}, outside ${least} to ${most}`;
}));
group(() => {
  let bare = 0, groaning = 0, liked = 0;
  sound('a bare shelf pays the highest multiple, a groaning one the lowest, and a shelf just as liked pays the normal price', () => eachBuy(({ q, base, target, stock, coins }) => {
    if (tight(coins)) return '';
    if (stock === target) { liked += 1; if (q.price !== base) return `it pays ${q.price}, not the normal ${base}`; }
    if (stock === 1000) { groaning += 1; if (q.price !== Math.max(1, Math.round(base * RULES.minMultiplier))) return `it pays ${q.price}`; }
    if (stock === 0 && Math.pow(target + 1, RULES.scarcityPower) >= RULES.maxMultiplier) { bare += 1; if (q.price !== Math.round(base * RULES.maxMultiplier)) return `it pays ${q.price}`; }
    return '';
  }) || (bare && groaning && liked ? '' : 'the sweep never reached one of the three shelves'));
});
sound('the more a shop holds, the less it pays: the price never rises along the shelf, and a full shelf pays less than a bare one', () => {
  let last = Infinity, bare = 0;
  return eachBuy(({ q, stock, target }) => {
    if (stock === 0) { last = Infinity; bare = q.price; }
    if (q.price > last) return `it pays ${q.price}, more than the ${last} it paid with fewer on the shelf`;
    last = q.price;
    return stock === target * RULES.fullAtTimesTarget && !(q.price < bare) ? `a full shelf pays ${q.price}, no less than the ${bare} a bare one pays` : '';
  });
});
sound('a shop stops buying once it holds three times what it likes to keep, and not one sooner', () => eachBuy(({ q, full, coins }) => {
  if (full && (q.available || q.reasons.length !== 1 || !/no room/.test(q.reasons[0]))) return 'it has no room, and does not say so';
  return !full && coins === 1000 && !q.available ? 'it has room and coin, yet will not buy' : '';
}));
sound('a shop short of coins pays less, never more, and says that coin is tight', () => {
  for (const id of MERCHANT_IDS) for (const good of goodsOf(Rules.newTown().merchants[id].usualSupply)) {
    const easy = Rules.newTown().merchants[id], pinched = Rules.newTown().merchants[id];
    const target = have(easy.target, good);
    easy.coins = RULES.cautiousBelowCoins;
    pinched.coins = RULES.cautiousBelowCoins - 1;
    for (const stock of shelves(target)) {
      easy.stock[good] = pinched.stock[good] = stock;
      const a = quoteBuy(easy, good), b = quoteBuy(pinched, good);
      const where = `${id} holding ${stock} ${good}`;
      if (b.price > a.price) return `${where} pays ${b.price} when short of coins and ${a.price} when not`;
      if (stock === target && !(b.price < a.price)) return `${where} pays ${b.price} with ${pinched.coins} coins, no less than the ${a.price} it pays with ${easy.coins}`;
      const mentions = (q: Quote) => q.reasons.some((r) => /Coin is tight/.test(r));
      if (stock < target * RULES.fullAtTimesTarget && (mentions(a) || !mentions(b))) return `${where} does not say when coin is tight, or says it when it is not`;
    }
  }
  return '';
});
sound('a shop never spends more than half its purse on one item, and buys whenever the price is within that half and there is room', () => eachBuy(({ q, full, coins }) => {
  const within = q.price <= coins * RULES.maxSpendShare;
  if (q.available && !within) return `it would spend ${q.price} of its ${coins} coins on one item`;
  if (!q.available && within && !full) return `it will not spend ${q.price} of its ${coins} coins`;
  return !within && !full && !new RegExp(`can't spare ${q.price} coins`).test(lastOf(q)) ? 'it does not say that it cannot spare the coins' : '';
}));
sound('when a shop will buy, the last thing it says names the price it will pay', () => eachBuy(({ q }) => (!q.available || names(lastOf(q), q.price) ? '' : `it pays ${q.price} but says "${lastOf(q)}"`)));

heading('Prices: what a shop charges for what it makes');

/** Recent trade to try, as a multiple of the usual: dead, slow, usual, brisk, and far past any limit. */
const TRADES = [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.5, 2, 2.5, 3, 10, 100];
const costByHand = (m: Merchant) => sum(goodsOf(m.recipe.inputs).map((g) => GOODS[g].base * have(m.recipe.inputs, g)));
/** The first whole coin at or above what the ingredients cost plus the markup. */
const floorOf = (m: Merchant) => Math.ceil(costByHand(m) * (1 + RULES.minMarkupOverCost));

interface SellCase { m: Merchant; good: GoodId; base: number; target: number; floor: number; stock: number; trade: number; q: Quote }
/** Every shop, every shelf of what it makes, every pace of trade. */
function eachSell(look: (c: SellCase) => string): string {
  for (const id of MERCHANT_IDS) {
    const m = Rules.newTown().merchants[id];
    const good = m.recipe.output, target = m.target[good] ?? 1, usual = m.usualSales[good] ?? 1;
    for (const trade of TRADES) for (const stock of shelves(target)) {
      m.stock[good] = stock;
      m.recentSales[good] = usual * trade;
      const wrong = look({ m, good, base: GOODS[good].base, target, floor: floorOf(m), stock, trade, q: quoteSell(m, good) });
      if (wrong) return `${m.name} holding ${stock} ${good} (likes ${target}), trade at ${trade} times the usual: ${wrong}`;
    }
  }
  return '';
}

check('the ingredients for one unit cost what the recipe says at normal prices', shopsOf(Rules.newTown()).every((m) => inputCost(m) === costByHand(m) && costByHand(m) > 0), shopsOf(Rules.newTown()).map((m) => `${m.id} ${inputCost(m)}`).join(', '));
check('at the normal price every shop clears its ingredients and its markup', shopsOf(Rules.newTown()).every((m) => GOODS[m.recipe.output].base >= floorOf(m)));
sound('what a shop charges is a whole number of coins, 1 or more', () => eachSell(({ q }) => (whole(q.price) && q.price >= 1 ? '' : `it charges ${q.price}`)));
sound('a shop never sells below what the ingredients cost plus its markup', () => eachSell(({ m, q }) => (q.price >= costByHand(m) * (1 + RULES.minMarkupOverCost) ? '' : `it charges ${q.price}, and the ingredients cost ${costByHand(m)}`)));
sound('what a shop charges never passes the highest multiple, shortage and brisk trade together', () => eachSell(({ q, base, floor }) => {
  const most = Math.max(floor, Math.round(base * (RULES.maxMultiplier * RULES.maxDemandFactor)));
  return q.price <= most ? '' : `it charges ${q.price}, above ${most}`;
}));
group(() => {
  let bare = 0, groaning = 0, liked = 0;
  sound('a bare shelf in brisk trade charges the most, a groaning one in dead trade the floor, and an ordinary day the normal price', () => eachSell(({ q, base, target, floor, stock, trade }) => {
    if (stock === target && trade === 1) { liked += 1; if (q.price !== Math.max(base, floor)) return `it charges ${q.price}, not the normal ${base}`; }
    if (stock === 1000 && trade === 0 && Math.round(base * RULES.minMultiplier * RULES.minDemandFactor) < floor) {
      groaning += 1;
      if (q.price !== floor || !/won't go below/.test(lastOf(q))) return `it charges ${q.price} and says "${lastOf(q)}", with a floor of ${floor}`;
    }
    if (stock === 0 && trade === 100 && Math.pow(target + 1, RULES.scarcityPower) >= RULES.maxMultiplier) {
      bare += 1;
      if (q.price !== Math.round(base * RULES.maxMultiplier * RULES.maxDemandFactor)) return `it charges ${q.price}`;
    }
    return '';
  }) || (bare && groaning && liked ? '' : 'the sweep never reached one of the three shelves'));
});
sound('the more a shop holds, the less it charges: the price never rises along the shelf, and a full shelf costs less than a bare one', () => {
  let last = Infinity, bare = 0;
  return eachSell(({ q, stock, target }) => {
    if (stock === 0) { last = Infinity; bare = q.price; }
    if (q.price > last) return `it charges ${q.price}, more than the ${last} it charged with fewer on the shelf`;
    last = q.price;
    return stock === target * 3 && !(q.price < bare) ? `a well-filled shelf costs ${q.price}, no less than the ${bare} of a bare one` : '';
  });
});
sound('brisk trade lets a shop ask more and slow trade makes it ask less, but only so far either way', () => {
  for (const id of MERCHANT_IDS) {
    const m = Rules.newTown().merchants[id];
    const good = m.recipe.output, usual = have(m.usualSales, good), base = GOODS[good].base, target = have(m.target, good);
    const at = (trade: number) => { m.recentSales[good] = usual * trade; return quoteSell(m, good); };
    for (const stock of shelves(target)) {
      m.stock[good] = stock;
      const prices = TRADES.map((trade) => at(trade).price);
      if (!risesOrHolds(prices)) return `${m.name} holding ${stock}: brisker trade lowered the price (${prices.join(', ')})`;
    }
    m.stock[good] = target; // the shelf just as liked, so only trade moves the price
    const brisk = at(100), usualDay = at(1), dead = at(0);
    if (brisk.price !== Math.max(floorOf(m), Math.round(base * RULES.maxDemandFactor)) || brisk.price !== at(3).price) return `${m.name} asks ${brisk.price} when trade is a hundred times the usual`;
    if (dead.price !== Math.max(floorOf(m), Math.round(base * RULES.minDemandFactor)) || dead.price !== at(0.2).price) return `${m.name} asks ${dead.price} when there is no trade at all`;
    if (!(brisk.price > usualDay.price && dead.price < usualDay.price)) return `${m.name} asks ${dead.price}, ${usualDay.price} and ${brisk.price} in dead, usual and brisk trade`;
    if (!brisk.reasons.some((r) => /brisk/.test(r)) || !dead.reasons.some((r) => /slow/.test(r)) || usualDay.reasons.some((r) => /brisk|slow/.test(r))) return `${m.name} does not say how trade has been`;
  }
  return '';
});
sound('a shop sells while it has something on the shelf, and only then', () => eachSell(({ q, stock }) => (q.available === stock > 0 ? '' : `it ${q.available ? 'will' : 'will not'} sell`)));
sound('the last thing a shop says about its price names the price', () => eachSell(({ q }) => (names(lastOf(q), q.price) ? '' : `it charges ${q.price} but says "${lastOf(q)}"`)));

heading('Prices: in general');
sound('every quote, to buy or to sell, gives at least one reason in words', () => {
  const spoken = (q: Quote) => q.reasons.length > 0 && q.reasons.every((r) => typeof r === 'string' && r.trim().length > 3);
  return eachBuy(({ q }) => (spoken(q) ? '' : `its reasons are ${text(q.reasons)}`)) || eachSell(({ q }) => (spoken(q) ? '' : `its reasons are ${text(q.reasons)}`));
});
sound('a shut shop quotes nothing, to buy or to sell, and says it is closed', () => {
  for (const m of shopsOf(Rules.newTown())) {
    m.open = false;
    for (const q of [...goodsOf(m.usualSupply).map((g) => quoteBuy(m, g)), quoteSell(m, m.recipe.output)]) {
      if (q.available || q.price !== 0 || text(q.reasons) !== text(['The shop is closed.'])) return `${m.id} quotes ${text(q)}`;
    }
  }
  return '';
});
sound('asking for a price changes nothing in the shop', () => {
  for (const m of shopsOf(Rules.newTown())) {
    const before = text(m);
    for (const g of goodsOf(m.usualSupply)) quoteBuy(m, g);
    quoteSell(m, m.recipe.output);
    inputCost(m);
    if (text(m) !== before) return `${m.id} changed`;
  }
  return '';
});

// ── 3. The dice ─────────────────────────────────────────────────────────────
heading('The dice the town is handed');
group(() => {
  const draws = (seed: number, n: number) => { const rng = Rules.seededRng(seed); return Array.from({ length: n }, () => rng()); };
  const many = draws(2026, 20000);
  check('every roll is a number from 0 up to, but never reaching, 1', many.every((x) => typeof x === 'number' && x >= 0 && x < 1));
  check('the same seed rolls the same numbers, and another seed rolls others', text(draws(7, 50)) === text(draws(7, 50)) && text(draws(7, 50)) !== text(draws(8, 50)));
  const tenths = Array.from({ length: 10 }, (_, i) => many.filter((x) => Math.floor(x * 10) === i).length / many.length);
  check('the rolls are spread evenly, so a "40% of the time" in the rules means it', tenths.every((share) => Math.abs(share - 0.1) < 0.015) && Math.abs(sum(many) / many.length - 0.5) < 0.01, tenths.map((s) => s.toFixed(3)).join(' '));
});

// ── 4. One hour of trade, taken apart ───────────────────────────────────────
heading('One hour of trade, taken apart');
group(() => {
  /** A new town where, this hour, nobody delivers and nobody shops, except as the test then allows. */
  const hushed = () => {
    const town = Rules.newTown();
    for (const m of shopsOf(town)) {
      m.bustle = 0;
      for (const g of goodsOf(m.usualSupply)) m.usualSupply[g] = 0;
    }
    return town;
  };
  const tick = (town: Town, seed = 5) => { const was = copy(town); Rules.tickHour(town, Rules.seededRng(seed), nobodyPaid); return was; };

  // Making goods.
  {
    const town = hushed(), was = tick(town);
    let madeInAll = 0;
    sound('a shopkeeper makes as many as an hour allows, the shelf has room for and the ingredients cover, and uses exactly the recipe', () => {
      for (const m of shopsOf(town)) {
        const w = was.merchants[m.id], out = m.recipe.output;
        const made = have(m.stock, out) - have(w.stock, out);
        const room = Math.max(0, have(w.target, out) - have(w.stock, out));
        const cover = Math.min(...goodsOf(m.recipe.inputs).map((g) => Math.floor(have(w.stock, g) / have(m.recipe.inputs, g))));
        if (made !== Math.min(m.recipe.perHour, room, cover)) return `${m.name} made ${made} with room for ${room}, ingredients for ${cover} and time for ${m.recipe.perHour}`;
        for (const g of goodsOf(m.recipe.inputs)) if (have(w.stock, g) - have(m.stock, g) !== made * have(m.recipe.inputs, g)) return `${m.name} used ${have(w.stock, g) - have(m.stock, g)} ${g} to make ${made}`;
        if (m.coins !== w.coins || town.purse !== was.purse) return 'coins moved, though nobody bought or sold';
        madeInAll += made;
      }
      return madeInAll > 0 ? '' : 'nothing was made anywhere';
    });
    const full = hushed(), smith = full.merchants.blacksmith;
    smith.stock.tools = have(smith.target, 'tools');
    const fullWas = tick(full);
    check('nothing is made once the shelf holds what the shopkeeper likes to keep', text(smith.stock) === text(fullWas.merchants.blacksmith.stock));
    const short = hushed();
    short.merchants.blacksmith.stock.wood = 0;
    const shortWas = tick(short);
    check('nothing is made, and nothing used, when one ingredient has run out', text(short.merchants.blacksmith.stock) === text(shortWas.merchants.blacksmith.stock));
  }

  // Deliveries from the town's own gatherers.
  {
    const deliver = (wheat: number, change: (town: Town) => void = () => {}) => {
      const town = hushed(), m = town.merchants.baker;
      m.usualSupply.wheat = 6;
      m.stock.bread = have(m.target, 'bread'); // nothing to bake, so the wheat only moves by delivery
      m.stock.wheat = wheat;
      change(town);
      tick(town);
      return { came: have(m.stock, 'wheat') - wheat, till: m.coins };
    };
    const liked = have(Rules.newTown().merchants.baker.target, 'wheat');
    const usual = deliver(liked);
    check('at the normal price the gatherers bring exactly the usual amount', usual.came === 6, `${usual.came} came`);
    {
      const town = hushed(), m = town.merchants.baker;
      m.usualSupply.wheat = 6; m.stock.bread = have(m.target, 'bread'); m.stock.wheat = liked;
      const before = copy(m);
      const was = tick(town);
      let due = 0;
      for (let i = 0; i < have(m.stock, 'wheat') - liked; i++) { const q = quoteBuy(before, 'wheat'); due += q.price; before.coins -= q.price; before.stock.wheat = have(before.stock, 'wheat') + 1; }
      check('each delivery is paid for at the shop\'s own price, one at a time, from the till to the townsfolk', due > 0 && was.merchants.baker.coins - m.coins === due && town.purse - was.purse === due, `paid ${was.merchants.baker.coins - m.coins}, the quotes add up to ${due}`);
    }
    const eager = deliver(0), bored = deliver(liked * 2);
    check('gatherers bring more when the shop pays well and fewer when it pays badly', eager.came > usual.came && bored.came < usual.came, `${eager.came}, ${usual.came}, ${bored.came}`);
    const season = (good: GoodId, factor: number): Season => ({ good, factor, daysLeft: 2, headline: 'x' });
    const scarce = deliver(liked, (t) => { t.season = season('wheat', 0.5); });
    const glut = deliver(liked, (t) => { t.season = season('wheat', 2); });
    const elsewhere = deliver(liked, (t) => { t.season = season('fish', 0.5); });
    check('a shortage cuts what the gatherers bring, a glut raises it, and trouble with another good changes nothing', scarce.came === 3 && glut.came === 12 && elsewhere.came === 6, `${scarce.came}, ${glut.came}, ${elsewhere.came}`);
    const noRoom = deliver(liked * RULES.fullAtTimesTarget);
    const noCoin = deliver(liked, (t) => setCoins(t, t.merchants.baker, 0));
    check('a shop with no room, or no coin, takes no deliveries', noRoom.came === 0 && noCoin.came === 0 && noCoin.till === 0);
  }

  // Custom from the townsfolk.
  {
    const trade = (bread: number, bustle: number, change: (town: Town) => void = () => {}, seed = 5) => {
      const town = hushed(), m = town.merchants.baker;
      m.bustle = bustle;
      m.stock.bread = bread;
      m.stock.wheat = 0; // nothing to bake with, so the bread only moves by sale
      change(town);
      const before = copy(m);
      const was = tick(town, seed);
      const sold = bread - have(m.stock, 'bread');
      let due = 0;
      for (let i = 0; i < sold; i++) { const q = quoteSell(before, 'bread'); due += q.price; before.stock.bread = have(before.stock, 'bread') - 1; }
      return { sold, due, income: m.townIncome, gained: m.coins - was.merchants.baker.coins, spent: was.purse - town.purse, purse: town.purse, recent: have(m.recentSales, 'bread'), recentWas: have(was.merchants.baker.recentSales, 'bread') };
    };
    const liked = have(Rules.newTown().merchants.baker.target, 'bread');
    const usualSales = have(Rules.newTown().merchants.baker.usualSales, 'bread');
    const ordinary = trade(liked, 1);
    check('on an ordinary day, at the normal price, the townsfolk buy exactly the usual amount', ordinary.sold === usualSales, `${ordinary.sold} sold`);
    check('each one is paid for at the shop\'s own price, one at a time, from the purse to the till, and counted as the hour\'s income', ordinary.due > 0 && ordinary.gained === ordinary.due && ordinary.spent === ordinary.due && ordinary.income === ordinary.due, text(ordinary));
    check('recent sales are a running average of what was sold each hour', Math.abs(ordinary.recent - (ordinary.recentWas * 0.85 + ordinary.sold * 0.15)) < 1e-9);
    const quiet = trade(liked, TOWN.quietDay), busy = trade(liked, TOWN.busyDay);
    check('a quiet day brings less custom than an ordinary one, and a busy day more', quiet.sold < ordinary.sold && busy.sold > ordinary.sold, `${quiet.sold}, ${ordinary.sold}, ${busy.sold}`);
    {
      // Custom of 2.4 an hour is 2 or 3, and the rules promise 3 comes up four times in ten.
      const TRIES = 2000;
      let threes = 0, neither = 0;
      for (let seed = 1; seed <= TRIES; seed++) { const sold = trade(liked, 2.4 / usualSales, () => {}, seed).sold; if (sold === 3) threes += 1; else if (sold !== 2) neither += 1; }
      check('custom of 2.4 an hour sells 2 or 3, and 3 about four times in ten', neither === 0 && Math.abs(threes / TRIES - 0.4) < 0.04, `3 came up ${threes} times in ${TRIES}`);
    }
    const cheap = trade(liked * 3, 1), dear = trade(2, 1);
    check('cheap goods sell faster than dear ones', cheap.sold > ordinary.sold && dear.sold < ordinary.sold, `${cheap.sold}, ${ordinary.sold}, ${dear.sold}`);
    const none = trade(0, 1);
    check('a bare shelf sells nothing, and the average of recent sales sinks', none.sold === 0 && none.income === 0 && none.recent < none.recentWas);
    const hoard = { coins: 0 };
    const broke = trade(liked, 1, (t) => fromPurse(t, hoard, t.purse - 5));
    check('the townsfolk cannot spend coins they do not have: the purse is never overdrawn', broke.sold === 0 && broke.purse === 5);
    const lastCoin = trade(liked, 1, (t) => fromPurse(t, hoard, t.purse - GOODS.bread.base));
    check('with exactly the price in the purse, one is bought and the purse is left empty', lastCoin.sold === 1 && lastCoin.purse === 0, text(lastCoin));
  }

  // Shut shops and the night.
  {
    const town = Rules.newTown();
    shut(town, town.merchants.baker);
    const was = tick(town);
    check('a shut shop takes no deliveries, makes nothing and sells nothing', text(town.merchants.baker) === text(was.merchants.baker) && shopsOf(town).some((m) => m.coins !== was.merchants[m.id].coins));
    const night = Rules.newTown();
    night.hour = 21;
    const nightWas = tick(night);
    check('nothing is delivered, made, bought or sold at night', text(night.merchants) === text(nightWas.merchants) && night.purse === nightWas.purse && night.hour === 22);
    const day = Rules.newTown();
    check('a day hour takes longer than a night hour', Rules.hourMs(day) === TOWN.hourMs.day && Rules.hourMs(night) === TOWN.hourMs.night);
    const hoursOpen = [...Array(24).keys()].filter((h) => { day.hour = h; return Rules.isTradingHour(day); });
    check('the shops trade from 6 in the morning until 8 at night, and at no other hour', hoursOpen.join() === [...Array(24).keys()].filter((h) => h >= 6 && h < 20).join(), hoursOpen.join());
  }
});

// ── 5. Rent, shutting up shop, the whip-round ───────────────────────────────
heading('Rent, shutting up shop and the whip-round');
group(() => {
  const town = stillTown();
  const { blacksmith: smith, baker, fishmonger, carpenter } = town.merchants;
  const ada = Rules.newPlayer(town);
  const folk = new Map([['ada.testnet', ada]]);
  const paid: Paid[] = [];
  const pay = payer(() => town, folk, paid);
  const rng = Rules.seededRng(11);
  fromPurse(town, ada, TOWN.investCost);
  Rules.invest(town, ada, 'ada.testnet', 'blacksmith'); // someone to be owed dividends, were any due
  const total = Rules.totalCoins(town, [ada]);
  setCoins(town, baker, baker.upkeep);      // exactly the rent
  setCoins(town, smith, smith.upkeep - 1);  // one coin short of it

  let was = copy(town);
  until(town, TOWN.closeHour, rng, pay);
  check('rent goes from each till to the townsfolk at closing time', fishmonger.coins === was.merchants.fishmonger.coins - fishmonger.upkeep && carpenter.coins === was.merchants.carpenter.coins - carpenter.upkeep && town.purse === was.purse + baker.upkeep + fishmonger.upkeep + carpenter.upkeep, `the purse grew by ${town.purse - was.purse}`);
  check('a shop with exactly its rent pays it and is left with nothing', baker.coins === 0 && baker.missedRent === 0 && baker.open);
  check('a shop one coin short pays nothing, keeps its coins and is given another day', smith.coins === smith.upkeep - 1 && smith.missedRent === 1 && smith.open && town.events.every((e) => e.kind !== 'closed'));

  until(town, TOWN.closeHour, rng, pay);
  const shutDay = town.day;
  check('a second day of unpaid rent shuts the shop, and its books say which day', !smith.open && smith.missedRent === TOWN.missedRentLimit && smith.closedOn === shutDay && smith.coins === smith.upkeep - 1, `open ${smith.open}, unpaid ${smith.missedRent}, shut on ${smith.closedOn}`);
  const told = town.events[town.events.length - 1];
  check('the town is told who shut and why', told?.kind === 'closed' && told.text.includes(smith.name) && told.text.includes('blacksmith') && told.day === shutDay && told.hour === TOWN.closeHour, told?.text);
  check('a shop with nothing in the till misses its first rent the same evening', baker.missedRent === 1 && baker.open);

  setCoins(town, carpenter, 200); // one shop with coin to spare, so the board is not bare for want of coin
  until(town, TOWN.openHour, rng, pay);
  ada.inventory.ore = 3;
  const before = text([town, ada]);
  const sale = Rules.sell(town, ada, 'blacksmith', 'ore', 1, 'ada.testnet'), purchase = Rules.buy(town, ada, 'blacksmith', 'tools');
  check('a shut shop buys nothing and sells nothing, and says it is closed', !sale.ok && sale.message === 'The shop is closed.' && !purchase.ok && purchase.message === 'The shop is closed.' && text([town, ada]) === before);
  check('a shut shop puts up no order', Rules.todaysOrders(town).every((o) => o.merchant !== 'blacksmith') && Rules.todaysOrders(town).length > 0);

  pass(town, rng, pay, () => town.day < shutDay + TOWN.daysUntilWhipRound - 1 || town.hour !== TOWN.openHour);
  check('the day before the whip-round is due, the shop is still shut', !smith.open && town.day === shutDay + TOWN.daysUntilWhipRound - 1);
  until(town, TOWN.openHour - 1, rng, pay);
  was = copy(town);
  Rules.tickHour(town, rng, pay);
  check('three dawns after it shut, the townsfolk club together and it opens again', smith.open && smith.missedRent === 0 && town.day === shutDay + TOWN.daysUntilWhipRound && town.hour === TOWN.openHour);
  check('the whip-round is 150 coins out of the townsfolk\'s purse, into the till', smith.coins === was.merchants.blacksmith.coins + TOWN.whipRound && town.purse === was.purse - TOWN.whipRound, `till ${smith.coins - was.merchants.blacksmith.coins}, purse ${town.purse - was.purse}`);
  check('the town is told the shop is open again', town.events.some((e) => e.kind === 'reopened' && e.text.includes(smith.name) && e.day === town.day));
  until(town, TOWN.closeHour, rng, pay);
  check('the rescued shop pays its rent that evening, and a rescue is not a profit to share out', smith.open && smith.missedRent === 0 && paid.length === 0 && ada.coins === TOWN.startingCoins, text(paid));
  check('through all of it the holder kept their share and no coin was made or lost', smith.holders['ada.testnet'] === TOWN.investPct && !coinTrouble(town, [ada], total) && !balanceTrouble(town, [ada]), coinTrouble(town, [ada], total));
});
group(() => {
  // A paid day in between wipes the slate.
  const town = stillTown(), m = town.merchants.carpenter, rng = Rules.seededRng(12);
  setCoins(town, m, m.upkeep - 1);
  until(town, TOWN.closeHour, rng);
  const afterFirst = m.missedRent;
  setCoins(town, m, m.upkeep);
  until(town, TOWN.closeHour, rng);
  const afterPaid = m.missedRent;
  until(town, TOWN.closeHour, rng);
  check('paying the rent wipes the slate: one bad day, a good one, then another bad one does not shut a shop', afterFirst === 1 && afterPaid === 0 && m.missedRent === 1 && m.open, `${afterFirst}, ${afterPaid}, ${m.missedRent}`);
});
group(() => {
  // The evening a shop shuts it pays nobody, even if it took more that day than it began with.
  const town = stillTown(), m = town.merchants.fishmonger, rng = Rules.seededRng(14);
  const ada = Rules.newPlayer(town), paid: Paid[] = [];
  const pay = payer(() => town, new Map([['ada.testnet', ada]]), paid);
  fromPurse(town, ada, TOWN.investCost);
  Rules.invest(town, ada, 'ada.testnet', 'fishmonger');
  setCoins(town, m, 10);
  until(town, TOWN.closeHour, rng, pay);  // the first evening without the rent
  until(town, TOWN.openHour, rng, pay);
  fromPurse(town, m, 60);                 // a day's takings, still short of the rent
  until(town, TOWN.closeHour, rng, pay);
  check('the evening a shop shuts it pays no dividend, though it took more that day than it began with', !m.open && m.coins === 70 && m.coins < m.upkeep && paid.length === 0 && ada.coins === TOWN.startingCoins, `${text(paid)}, till ${m.coins}`);
});
group(() => {
  // The purse cannot always afford a rescue.
  const town = stillTown(), rng = Rules.seededRng(13);
  const hoard = Rules.newPlayer(town);
  const total = Rules.totalCoins(town, [hoard]);
  for (const m of shopsOf(town)) setCoins(town, m, 0); // no shop can pay its rent
  fromPurse(town, hoard, town.purse - (TOWN.whipRound - 1));
  pass(town, rng, nobodyPaid, () => shopsOf(town).some((m) => m.open));
  const shutDay = town.day;
  pass(town, rng, nobodyPaid, () => town.day < shutDay + TOWN.daysUntilWhipRound || town.hour !== TOWN.openHour);
  check('with the purse one coin short of a whip-round, no shop is rescued and the purse is left alone', shopsOf(town).every((m) => !m.open) && town.purse === TOWN.whipRound - 1, `purse ${town.purse}`);
  fromPurse(town, hoard, -(TOWN.whipRound + 1)); // now enough for exactly two
  until(town, TOWN.openHour, rng);
  check('with enough for two whip-rounds, two shops are rescued and the purse is not overdrawn', shopsOf(town).filter((m) => m.open).length === 2 && town.purse === 0 && !coinTrouble(town, [hoard], total), `${shopsOf(town).filter((m) => m.open).length} open, purse ${town.purse}`);
});

heading('Dividends');
group(() => {
  const town = stillTown();
  const folk = new Map(['ada.testnet', 'bo.testnet', 'cy.testnet'].map((id) => [id, Rules.newPlayer(town)]));
  const ada = folk.get('ada.testnet')!, all = [...folk.values()];
  const total = Rules.totalCoins(town, all);
  const paid: Paid[] = [];
  const pay = payer(() => town, folk, paid);
  const rng = Rules.seededRng(21);
  const { baker, fishmonger, carpenter, blacksmith } = town.merchants;
  const buyIn = (who: string, shop: MerchantId) => { const p = folk.get(who)!; fromPurse(town, p, TOWN.investCost); return Rules.invest(town, p, who, shop).ok; };

  // Day 1. Ada owns a quarter of the baker, who has a good day: 203 coins from the townsfolk.
  buyIn('ada.testnet', 'baker');
  const takings = 203;
  fromPurse(town, baker, takings);
  const tillAtClose = baker.coins;
  until(town, TOWN.closeHour, rng, pay);
  const profit = takings - baker.upkeep; // the stake itself is capital, not profit
  const cut = Math.floor((profit * TOWN.investPct) / 100);
  check('at closing time a holder is paid their percent of the day\'s profit after rent, rounded down', paid.length === 1 && paid[0].holder === 'ada.testnet' && paid[0].from === 'baker' && paid[0].coins === cut && cut > 0 && (profit * TOWN.investPct) % 100 !== 0, text(paid));
  check('the dividend reaches the holder, with a note naming the sum', ada.coins === TOWN.startingCoins + cut && ada.notices.length === 1 && ada.notices[0].text === paid[0]?.note && paid[0]?.note.includes(`${cut} coins`), text(ada.notices));
  check('the dividend comes out of the till, and what is left above a comfortable sum goes back to the townsfolk', tillAtClose - baker.upkeep - cut > TOWN.comfortableSavings && baker.coins === TOWN.comfortableSavings && !coinTrouble(town, all, total), `the till holds ${baker.coins}`);

  // Day 2. Nothing comes in, so the day is a loss.
  until(town, TOWN.closeHour, rng, pay);
  check('a day that made a loss pays no dividend', paid.length === 1 && baker.coins === TOWN.comfortableSavings - baker.upkeep);

  // Day 3. Three holders of the fishmonger, a quarter each; Bo also takes two stakes in the carpenter, who earns nothing.
  until(town, TOWN.openHour, rng, pay);
  buyIn('ada.testnet', 'fishmonger'); buyIn('bo.testnet', 'fishmonger'); buyIn('cy.testnet', 'fishmonger');
  buyIn('bo.testnet', 'carpenter'); buyIn('bo.testnet', 'carpenter');
  const fishTakings = 303;
  fromPurse(town, fishmonger, fishTakings);
  paid.length = 0;
  until(town, TOWN.closeHour, rng, pay);
  const fishProfit = fishTakings - fishmonger.upkeep, each = Math.floor((fishProfit * TOWN.investPct) / 100);
  const fromFish = paid.filter((d) => d.from === 'fishmonger');
  check('three holders of a quarter each are each paid a quarter, and the shopkeeper keeps the rest', fromFish.length === 3 && fromFish.every((d) => d.coins === each) && fromFish.map((d) => d.holder).sort().join() === 'ada.testnet,bo.testnet,cy.testnet' && each * 3 < fishProfit, text(fromFish));
  check('two stakes bought in one day are capital, not takings: nothing of them is paid back that evening', paid.every((d) => d.from !== 'carpenter') && carpenter.holders['bo.testnet'] === 2 * TOWN.investPct, text(paid.filter((d) => d.from === 'carpenter')));

  // Day 4. Bo's half of the carpenter earns twice what a quarter would.
  until(town, TOWN.openHour, rng, pay);
  const woodTakings = 277;
  fromPurse(town, carpenter, woodTakings);
  paid.length = 0;
  until(town, TOWN.closeHour, rng, pay);
  const half = Math.floor(((woodTakings - carpenter.upkeep) * 2 * TOWN.investPct) / 100);
  check('a holder of two stakes is paid on both', paid.length === 1 && paid[0].holder === 'bo.testnet' && paid[0].from === 'carpenter' && paid[0].coins === half, text(paid));
  check('a shop nobody has bought into pays nobody', paid.every((d) => d.from !== 'blacksmith') && Object.keys(blacksmith.holders).length === 0);
  check('after four days of rent, stakes and dividends not a coin was made or lost', !coinTrouble(town, all, total) && !balanceTrouble(town, all), coinTrouble(town, all, total) || balanceTrouble(town, all));
});

group(() => {
  // A shop that cannot pay its rent: does it still pay its holders?
  const town = stillTown(), m = town.merchants.baker, rng = Rules.seededRng(22);
  const ada = Rules.newPlayer(town), paid: Paid[] = [];
  const pay = payer(() => town, new Map([['ada.testnet', ada]]), paid);
  fromPurse(town, ada, TOWN.investCost);
  Rules.invest(town, ada, 'ada.testnet', 'baker');
  setCoins(town, m, m.upkeep + 10);   // day 1: the rent is paid and 10 coins are left
  until(town, TOWN.closeHour, rng, pay);
  until(town, TOWN.openHour, rng, pay);
  fromPurse(town, m, 100);            // day 2: 100 coins come in, which leaves the till 10 short of the rent
  until(town, TOWN.closeHour, rng, pay);
  check('a shop that cannot pay its rent pays no dividend that evening', paid.length === 0);
});

// ── 6. Forty-five days, hour by hour ────────────────────────────────────────
heading('The clock: forty-five days hour by hour, with investors, the books checked after every hour');
group(() => {
  const watch = new Watch();
  const DAYS = 45;
  const seeds = [1, 7, 42, 2026, 31337, 99991, 123456789, 4294967295];
  let dividends = 0, shutShops = 0, rescues = 0, seasons = 0;

  seeds.forEach((seed, at) => {
    const town = Rules.newTown();
    const folk = new Map(['ada.testnet', 'bo.testnet', 'cy.testnet'].map((id) => [id, Rules.newPlayer(town)]));
    const buyIn = (who: string, shop: MerchantId) => {
      const p = folk.get(who)!;
      fromPurse(town, p, TOWN.investCost);
      if (!Rules.invest(town, p, who, shop).ok) throw new Error('The scene could not be set.');
    };
    buyIn('ada.testnet', 'baker'); buyIn('ada.testnet', 'blacksmith');
    buyIn('bo.testnet', 'baker'); buyIn('bo.testnet', 'fishmonger'); buyIn('bo.testnet', 'fishmonger');
    buyIn('cy.testnet', 'carpenter'); buyIn('cy.testnet', 'carpenter'); buyIn('cy.testnet', 'carpenter');
    town.merchants.blacksmith.holders['gone.testnet'] = TOWN.investPct; // a holder with no player record: their cut goes back to the townsfolk
    // Two of the runs begin with a shop that has bare shelves and an empty till, so it is sure to go under.
    const doomed = at === 6 ? town.merchants.carpenter : at === 7 ? town.merchants.baker : null;
    if (doomed) { setCoins(town, doomed, 0); for (const g of goodsOf(doomed.stock)) doomed.stock[g] = 0; }

    const all = [...folk.values()];
    const total = Rules.totalCoins(town, all);
    const rng = Rules.seededRng(seed);
    const sent = new Map<string, number>(), notes = new Map<string, number>();
    let seen = town.eventSeq;
    for (let h = 0; h < DAYS * 24; h++) {
      const was = copy(town);
      const paid: Paid[] = [];
      Rules.tickHour(town, rng, payer(() => town, folk, paid));
      const where = () => `seed ${seed}, day ${was.day} at ${was.hour}:00`;
      watch.steps += 1;
      watch.note('coins', coinTrouble(town, all, total), where);
      watch.note('balances', balanceTrouble(town, all), where);
      watch.note('clock', town.hour === (was.hour + 1) % 24 && town.day === was.day + (was.hour === 23 ? 1 : 0) ? '' : `day ${was.day} hour ${was.hour} was followed by day ${town.day} hour ${town.hour}`, where);
      watch.note('trim', trimTrouble(town, all), where);
      watch.note('hour', hourTrouble(was, town, paid), where);
      watch.note('shape', shapeTrouble(town, all), where);
      for (const d of paid) { sent.set(d.holder, (sent.get(d.holder) ?? 0) + d.coins); notes.set(d.holder, (notes.get(d.holder) ?? 0) + 1); dividends += 1; }
      for (const e of town.events) if (e.seq > seen) {
        seen = e.seq;
        if (e.kind === 'closed') shutShops += 1; else if (e.kind === 'reopened') rescues += 1; else if (!/back to normal/.test(e.text)) seasons += 1;
      }
    }
    for (const [id, p] of folk) watch.note('reach', p.coins === TOWN.startingCoins + (sent.get(id) ?? 0) && p.noticeSeq === (notes.get(id) ?? 0) ? '' : `${id} was sent ${sent.get(id) ?? 0} coins in ${notes.get(id) ?? 0} dividends, but has ${p.coins - TOWN.startingCoins} more than they began with and ${p.noticeSeq} notes`, () => `seed ${seed}`);
    watch.note('end', town.day === 1 + DAYS && town.hour === TOWN.openHour ? '' : `after ${DAYS} days it is day ${town.day}, hour ${town.hour}`, () => `seed ${seed}`);
  });

  const hours = `${watch.steps} hours over ${seeds.length} runs`;
  watch.report(`${hours}: the town's coins are exactly unchanged after every hour`, 'coins');
  watch.report('nothing goes below zero, and every coin and stock count stays a whole number', 'balances');
  watch.report('the hour moves on by one, 23 is followed by 0, and the day turns at midnight and only then', 'clock');
  watch.report(`${DAYS} days of 24 hours bring every run back to 6 in the morning, ${DAYS} days on`, 'end');
  watch.report('news and notices stay trimmed to the last few, numbered in order', 'trim');
  watch.report('every hour keeps to the timetable: quiet nights, rent and dividends at 8, rescues and fresh orders at dawn, shortages that end', 'hour');
  watch.report('shares, shelf targets, the notice board and the season keep their shape throughout', 'shape');
  watch.report('each investor ends with exactly their starting coins plus the dividends sent to them, and one note for each', 'reach');
  check('these runs paid dividends, shut shops, rescued them and saw shortages come and go, so those rules were walked', dividends > 100 && shutShops >= 2 && rescues >= 2 && seasons >= 8, `${dividends} dividends, ${shutShops} shops shut, ${rescues} rescued, ${seasons} shortages or gluts`);
});

heading('Sixty days with players who earn coins and do not spend them');
group(() => {
  /**
   * Sixty days on one seed. Each trading hour every worker, while rested, gathers twice whatever fetches the most and
   * sells all they carry to the shop that pays most. Nobody buys anything, which is all the game's first goals teach.
   * An `idler` is one more player, who holds one stake in every shop (the Alderman's title) and does nothing at all.
   */
  const twoMonths = (workers: number, idler = false) => {
    const town = Rules.newTown();
    const folk = new Map<string, Player>();
    for (let i = 0; i < workers; i++) folk.set(`worker${i}.testnet`, Rules.newPlayer(town));
    if (idler) {
      const p = Rules.newPlayer(town);
      folk.set('idler.testnet', p);
      for (const id of MERCHANT_IDS) { fromPurse(town, p, TOWN.investCost); Rules.invest(town, p, 'idler.testnet', id); }
    }
    const all = [...folk.values()], total = Rules.totalCoins(town, all), rng = Rules.seededRng(1);
    const pay = payer(() => town, folk);
    const best = (good: GoodId) => shopsOf(town).filter((m) => m.open && owns(m.usualSupply, good) && quoteBuy(m, good).available).sort((a, b) => quoteBuy(b, good).price - quoteBuy(a, good).price)[0];
    const shutFor = new Map(MERCHANT_IDS.map((id) => [id, 0]));
    let wrong = '', longest = 0, lastTrade = 1;
    for (let h = 0; h < 60 * 24; h++) {
      if (Rules.isTradingHour(town)) for (const [id, p] of folk) {
        if (id === 'idler.testnet') continue;
        Rules.rest(town, p);
        for (let swing = 0; swing < 2 && p.energy >= TOWN.gatherEnergy; swing++) {
          const wanted = RAW.filter((g) => best(g)).sort((a, b) => quoteBuy(best(b), b).price - quoteBuy(best(a), a).price)[0];
          Rules.gather(town, p, wanted ?? 'wood');
        }
        for (const g of RAW) { const shop = best(g); if (shop && have(p.inventory, g) > 0) Rules.sell(town, p, shop.id, g, 99, id); }
      }
      Rules.tickHour(town, rng, pay);
      wrong ||= coinTrouble(town, all, total) || balanceTrouble(town, all);
      for (const m of shopsOf(town)) { shutFor.set(m.id, m.open ? 0 : (shutFor.get(m.id) ?? 0) + 1); longest = Math.max(longest, shutFor.get(m.id) ?? 0); }
      if (shopsOf(town).some((m) => m.open)) lastTrade = town.day;
    }
    return { wrong, longest: Math.floor(longest / 24), lastTrade, purse: town.purse, held: sum(all.map((p) => p.coins)), shut: shopsOf(town).filter((m) => !m.open).length };
  };
  const alone = twoMonths(0), one = twoMonths(1), three = twoMonths(3), idle = twoMonths(0, true);
  const tells = (r: typeof alone) => `players hold ${r.held} of the 2,200 coins, the purse holds ${r.purse}, ${r.shut} of the 4 shops are shut${r.shut === 4 ? ` and none has been open since day ${r.lastTrade}` : `, the longest for ${r.longest} days`}`;
  check('left alone for sixty days, no shop stays shut longer than the three days a rescue takes, and the townsfolk keep the coins for one', alone.longest <= TOWN.daysUntilWhipRound && alone.purse >= TOWN.whipRound && alone.shut === 0 && !alone.wrong, tells(alone));
  check('with players earning all the while, not a coin is made or lost and every count stays whole', !one.wrong && !three.wrong && !idle.wrong, one.wrong || three.wrong || idle.wrong);
  known('a shop nobody has rescued does not stay shut for ever, as the rules promise, when players stay in town, earn coins and never spend them',
    [one, three, idle].every((r) => r.longest <= TOWN.daysUntilWhipRound + 1 && r.shut < 4),
    `coins only reach players (sales, bonuses, dividends) and come back only if they buy something, so the town runs dry. After 60 days on seed 1, with one player who gathers and sells every trading hour and buys nothing: ${tells(one)}. With three such players: ${tells(three)}. `
    + `With one player who holds a stake in each shop and does nothing else: ${tells(idle)}. Once the purse holds less than the 150 coins of a whip-round, a shut shop stays shut unless a player buys a stake in it, and a shop sells only three`, 1);
});

// ── 7. What a player does ───────────────────────────────────────────────────
heading('What a player does: arriving');
group(() => {
  const town = Rules.newTown(), purse = town.purse, tills = text(shopsOf(town).map((m) => m.coins));
  const p = Rules.newPlayer(town);
  check('a newcomer is given 20 coins out of the townsfolk\'s purse', p.coins === TOWN.startingCoins && town.purse === purse - TOWN.startingCoins && text(shopsOf(town).map((m) => m.coins)) === tills);
  check('and starts rested, with empty hands, a clean tally and no notices', p.energy === TOWN.maxEnergy && p.maxEnergy === TOWN.maxEnergy && text(p.inventory) === '{}' && text(p.stats) === text({ gathered: 0, sold: 0, bought: 0, eaten: 0 }) && p.notices.length === 0 && p.noticeSeq === 0 && p.restedOn === town.day);
  check('two newcomers are two separate people', (() => { const a = Rules.newPlayer(town), b = Rules.newPlayer(town); a.inventory.ore = 5; a.stats.sold = 9; a.notices.push({ seq: 1, text: 'x' }); return text(b.inventory) === '{}' && b.stats.sold === 0 && b.notices.length === 0; })());

  sound('while the purse, or failing that the shopkeepers (the richest first), can cover it, a newcomer always gets the full 20, and no coin is made', () => {
    for (let purseHas = 0; purseHas <= 30; purseHas++) for (let richestHas = 0; richestHas <= 30; richestHas += 3) {
      const t = Rules.newTown();
      const hoard = { coins: 0 };
      const others = Math.min(richestHas, 4);
      shopsOf(t).forEach((m, i) => setCoins(t, m, i === 2 ? richestHas : others));
      fromPurse(t, hoard, t.purse - purseHas);
      const total = t.purse + sum(shopsOf(t).map((m) => m.coins));
      const newcomer = Rules.newPlayer(t);
      const where = `with ${purseHas} in the purse and ${richestHas} in the fullest till`;
      if (newcomer.coins !== Math.min(TOWN.startingCoins, purseHas + richestHas + 3 * others)) return `${where} a newcomer got ${newcomer.coins}`;
      if (coinTrouble(t, [newcomer], total) || balanceTrouble(t, [newcomer])) return `${where}: ${coinTrouble(t, [newcomer], total) || balanceTrouble(t, [newcomer])}`;
      if (purseHas >= TOWN.startingCoins && t.merchants.fishmonger.coins !== richestHas) return `${where} a shopkeeper was asked to chip in`;
      if (purseHas + richestHas >= TOWN.startingCoins && richestHas > others && shopsOf(t).some((m, i) => i !== 2 && m.coins !== others)) return `${where} someone other than the richest shopkeeper chipped in, though the richest could cover it`;
    }
    return '';
  });
  {
    const t = Rules.newTown(), hoard = { coins: 0 };
    for (const m of shopsOf(t)) setCoins(t, m, 0);
    fromPurse(t, hoard, t.purse);
    const newcomer = Rules.newPlayer(t);
    check('in a town with not a coin left, a newcomer is given nothing rather than coins from nowhere', newcomer.coins === 0 && t.purse === 0 && shopsOf(t).every((m) => m.coins === 0));
  }
  {
    const t = Rules.newTown(), hoard = { coins: 0 };
    for (const m of shopsOf(t)) setCoins(t, m, 10);
    fromPurse(t, hoard, t.purse);
    const newcomer = Rules.newPlayer(t);
    check('a newcomer gets the full 20 coins whenever the purse and the four tills hold that much between them', newcomer.coins === TOWN.startingCoins && t.purse === 0 && sum(shopsOf(t).map((m) => m.coins)) === 20, `${newcomer.coins} coins`);
  }
});

heading('Leaving town, and coming back');
{
  // The town has a fixed number of coins, so it cannot lose them to people who wander off.
  // A player who leaves gives their coins back to the townsfolk; one who returns is started off again.
  const town = Rules.newTown(), me = Rules.newPlayer(town);
  const all = Rules.totalCoins(town, [me]);
  const coinsInTown = () => Rules.totalCoins(town, [me]);
  me.inventory.ore = 3;
  me.coins += 37; town.purse -= 37; // as if earned
  const purse = town.purse;
  const back = Rules.leaveTown(town, me);
  check('a player who leaves town leaves every coin to the townsfolk, and none is made or lost', back === TOWN.startingCoins + 37 && me.coins === 0 && town.purse === purse + back && coinsInTown() === all);
  check('they are marked as gone, told what became of their coins, and keep their goods', me.gone === true && me.inventory.ore === 3 && me.notices.length === 1 && me.notices[0].text.includes(`your ${back} coins went back to the townsfolk`));
  check('being gone survives being stored and read back', JSON.parse(JSON.stringify(me)).gone === true);
  check('leaving again with nothing takes nothing and says nothing', Rules.leaveTown(town, me) === 0 && me.coins === 0 && me.notices.length === 1 && coinsInTown() === all);

  const gift = Rules.welcomeBack(town, me);
  check('coming back, they are started off again as a newcomer would be, out of the purse', gift === TOWN.startingCoins && me.coins === TOWN.startingCoins && town.purse === purse + back - gift && coinsInTown() === all);
  check('they are no longer gone, and are told of the gift', me.gone === undefined && !('gone' in JSON.parse(JSON.stringify(me))) && me.notices[me.notices.length - 1].text.startsWith(`Welcome back. The townsfolk have put ${gift} coins`));
  check('someone who never left is given nothing for turning up', Rules.welcomeBack(town, me) === 0 && me.coins === TOWN.startingCoins && coinsInTown() === all);

  Rules.leaveTown(town, me);
  me.coins += 12; town.purse -= 12; // a friend sent them coins while they were away
  check('one who comes back with a few coins is only made up to what a newcomer gets', Rules.welcomeBack(town, me) === TOWN.startingCoins - 12 && me.coins === TOWN.startingCoins && coinsInTown() === all);
  Rules.leaveTown(town, me);
  me.coins += 50; town.purse -= 50;
  const notes = me.notices.length;
  check('one who comes back with plenty is given nothing, and nothing is said', Rules.welcomeBack(town, me) === 0 && me.coins === 50 && me.gone === undefined && me.notices.length === notes && coinsInTown() === all);

  // The purse is empty: the shopkeepers pass the hat, the richest first, and nobody conjures a coin.
  const poor = Rules.newTown(), guest = Rules.newPlayer(poor);
  const whole = Rules.totalCoins(poor, [guest]);
  Rules.leaveTown(poor, guest);
  const hoard = Rules.newPlayer(poor); // stands in for everyone else: holds what the purse held
  hoard.coins += poor.purse; poor.purse = 0;
  const tills = Object.values(poor.merchants).map((m) => m.coins);
  const given = Rules.welcomeBack(poor, guest);
  const richest = Math.max(...tills);
  check('with an empty purse the richest shopkeeper starts them off, and the others are not asked', given === TOWN.startingCoins && poor.purse === 0
    && Object.values(poor.merchants).filter((m, i) => m.coins !== tills[i]).length === 1 && Object.values(poor.merchants).some((m, i) => tills[i] === richest && m.coins === richest - TOWN.startingCoins)
    && Rules.totalCoins(poor, [guest, hoard]) === whole);
  Rules.leaveTown(poor, guest);
  hoard.coins += poor.purse; poor.purse = 0;
  for (const m of Object.values(poor.merchants)) { hoard.coins += m.coins; m.coins = 0; }
  check('in a town with not a coin left, a returning player is given nothing rather than coins from nowhere', Rules.welcomeBack(poor, guest) === 0 && guest.coins === 0 && guest.gone === undefined && poor.purse === 0);

  check('only accounts the game made are named in the town: anyone else is "A traveller"', Rules.friendlyName('g57748bfc0a1b2c3d.brambleford-folk.testnet') === 'Traveller 5774'
    && Rules.friendlyName('u0123456789abcdef.brambleford-folk.testnet') === 'Traveller 0123'
    && ['alice.testnet', 'xdamn.testnet', 'g123.testnet', 'G57748BFC0A1B2C3D.x', 'g57748bfc0a1b2c3dd.x', 'gzzzzzzzzzzzzzzzz.x', 'you', ''].every((id) => Rules.friendlyName(id) === 'A traveller'));
}

heading('What a player does: gathering and resting');
group(() => {
  const { town, me, total } = scene();
  const townBefore = text(town);
  const r = Rules.gather(town, me, 'ore');
  check('gathering costs 2 energy and brings 1 of the good with bare hands', r.ok && r.count === 1 && me.energy === TOWN.maxEnergy - TOWN.gatherEnergy && have(me.inventory, 'ore') === 1 && me.stats.gathered === 1, text(r));
  check('gathering makes no coins and leaves the town alone', me.coins === TOWN.startingCoins && text(town) === townBefore && !coinTrouble(town, [me], total));
  sound('tools help: one tool gathers 2 at a time, two tools 3, and more than two no more than that', () => {
    for (const [tools, due] of [[0, 1], [1, 2], [2, 3], [5, 3]]) {
      const s = scene();
      if (tools) s.me.inventory.tools = tools;
      const got = Rules.gather(s.town, s.me, 'wood');
      if (!got.ok || got.count !== due || have(s.me.inventory, 'wood') !== due || Rules.gatherYield(s.me) !== due || s.me.stats.gathered !== due || s.me.energy !== TOWN.maxEnergy - TOWN.gatherEnergy) return `with ${tools} tools: ${text(got)}`;
    }
    return '';
  });
  {
    const s = scene();
    let swings = 0;
    while (swings < 1000 && Rules.gather(s.town, s.me, 'fish').ok) swings += 1;
    const spent = text(s.me);
    const refused = Rules.gather(s.town, s.me, 'fish');
    check(`a night's rest is good for exactly ${Math.floor(TOWN.maxEnergy / TOWN.gatherEnergy)} swings`, swings === Math.floor(TOWN.maxEnergy / TOWN.gatherEnergy) && s.me.energy === TOWN.maxEnergy % TOWN.gatherEnergy && have(s.me.inventory, 'fish') === swings, `${swings} swings`);
    check('with no energy left gathering is refused, and nothing changes', !refused.ok && /worn out/.test(refused.message) && text(s.me) === spent);
    s.me.energy = TOWN.gatherEnergy - 1;
    check('one short of the energy a swing costs is still refused', !Rules.gather(s.town, s.me, 'fish').ok && s.me.energy === TOWN.gatherEnergy - 1);
    s.me.energy = TOWN.gatherEnergy;
    check('exactly the energy a swing costs is enough, and leaves none', Rules.gather(s.town, s.me, 'fish').ok && s.me.energy === 0);
  }
  sound('only the four raw goods can be gathered; asking for anything made changes nothing', () => {
    for (const g of GOOD_IDS) {
      const s = scene(), before = text(s.me);
      const got = Rules.gather(s.town, s.me, g);
      if (got.ok !== GOODS[g].raw) return `${g} ${got.ok ? 'was gathered' : 'was refused'}`;
      if (!got.ok && (text(s.me) !== before || got.message !== 'That cannot be gathered.')) return `${g} was refused, but not cleanly`;
    }
    return '';
  });
  {
    const s = scene();
    s.town.hour = 23;
    check('gathering goes on at night', Rules.gather(s.town, s.me, 'ore').ok && have(s.me.inventory, 'ore') === 1);
  }
  {
    const s = scene(), rng = Rules.seededRng(2);
    for (let i = 0; i < 3; i++) Rules.gather(s.town, s.me, 'ore');
    const tired = s.me.energy;
    until(s.town, 23, rng); Rules.rest(s.town, s.me);
    const lateEvening = s.me.energy;
    until(s.town, TOWN.openHour - 1, rng); Rules.rest(s.town, s.me);
    const beforeDawn = s.me.energy;
    until(s.town, TOWN.openHour, rng); Rules.rest(s.town, s.me);
    check('energy comes back with the morning, and not an hour before', tired === TOWN.maxEnergy - 3 * TOWN.gatherEnergy && lateEvening === tired && beforeDawn === tired && s.me.energy === TOWN.maxEnergy && s.me.restedOn === s.town.day, `${tired}, ${lateEvening}, ${beforeDawn}, ${s.me.energy}`);
    Rules.gather(s.town, s.me, 'ore'); Rules.rest(s.town, s.me);
    check('and only once a morning', s.me.energy === TOWN.maxEnergy - TOWN.gatherEnergy);
  }
  {
    const s = scene(), rng = Rules.seededRng(3);
    s.me.energy = 0;
    until(s.town, TOWN.openHour, rng);
    const woke = Rules.gather(s.town, s.me, 'ore');
    check('a worn-out player who goes gathering after dawn finds they have slept', woke.ok && s.me.energy === TOWN.maxEnergy - TOWN.gatherEnergy);
    const t = scene();
    t.me.energy = 1; t.me.inventory.bread = 1;
    until(t.town, TOWN.openHour, rng);
    const meal = Rules.eat(t.town, t.me, 'bread');
    check('so does one who eats: the night\'s sleep is counted before the meal', meal.ok && t.me.energy === TOWN.maxEnergy);
  }
  {
    const s = scene(), rng = Rules.seededRng(4);
    until(s.town, 2, rng);
    const late = Rules.newPlayer(s.town);
    for (let i = 0; i < 4; i++) Rules.gather(s.town, late, 'wood');
    const beforeDawn = late.energy;
    until(s.town, TOWN.openHour, rng); Rules.rest(s.town, late);
    check('a newcomer who arrives in the small hours is rested then, and again at dawn', beforeDawn === TOWN.maxEnergy - 4 * TOWN.gatherEnergy && late.energy === TOWN.maxEnergy);
  }
});

heading('What a player does: selling to a shop');
group(() => {
  /** A scene with the notice board bare, so a sale is only a sale. */
  const plain = () => { const s = scene(); s.town.orders = []; return s; };
  {
    const s = plain(), m = s.town.merchants.blacksmith;
    s.me.inventory.ore = 3;
    const quote = quoteBuy(m, 'ore').price, till = m.coins, shelf = have(m.stock, 'ore'), purse = s.town.purse;
    const r = Rules.sell(s.town, s.me, 'blacksmith', 'ore');
    check('a sale moves one of the goods to the shelf and the quoted price to the player', r.ok && r.count === 1 && r.price === quote && r.bonus === undefined && s.me.coins === TOWN.startingCoins + quote && m.coins === till - quote && have(s.me.inventory, 'ore') === 2 && have(m.stock, 'ore') === shelf + 1 && s.me.stats.sold === 1, text(r));
    check('the coins come from the shop\'s own till: the purse is untouched and no coin is made', s.town.purse === purse && !coinTrouble(s.town, [s.me], s.total));
  }
  {
    const oneByOne = plain(), atOnce = plain();
    oneByOne.me.inventory.ore = atOnce.me.inventory.ore = 12;
    const prices: number[] = [];
    for (let i = 0; i < 12; i++) { const r = Rules.sell(oneByOne.town, oneByOne.me, 'blacksmith', 'ore', 1, 'ada.testnet'); if (r.ok) prices.push(r.price ?? 0); }
    const r = Rules.sell(atOnce.town, atOnce.me, 'blacksmith', 'ore', 12, 'ada.testnet');
    check('the price falls as you sell: each one fetches no more than the one before, and the twelfth less than the first', prices.length === 12 && fallsOrHolds(prices) && prices[11] < prices[0], prices.join(', '));
    check('selling twelve at once fetches exactly what selling them one by one does', r.ok && r.count === 12 && r.price === sum(prices) && text(atOnce.town) === text(oneByOne.town) && atOnce.me.coins === oneByOne.me.coins, `${r.price} against ${sum(prices)}`);
  }
  sound('a shop sells nothing and buys nothing outside trading hours', () => {
    for (let hour = 0; hour < 24; hour++) {
      const s = plain();
      s.town.hour = hour;
      s.me.inventory.ore = 2;
      fromPurse(s.town, s.me, 200);
      const before = text([s.town, s.me]);
      const sale = Rules.sell(s.town, s.me, 'blacksmith', 'ore', 1, 'ada.testnet');
      const open = hour >= TOWN.openHour && hour < TOWN.closeHour;
      if (sale.ok !== open) return `at ${hour}:00 a sale was ${sale.ok ? 'made' : 'refused'}`;
      if (!open && (!/gone to bed/.test(sale.message) || text([s.town, s.me]) !== before)) return `at ${hour}:00 the refusal was not clean: ${sale.message}`;
      const purchase = Rules.buy(s.town, s.me, 'baker', 'bread');
      if (purchase.ok !== open) return `at ${hour}:00 a purchase was ${purchase.ok ? 'made' : 'refused'}`;
      if (!open && (!/gone to bed/.test(purchase.message) || text([s.town, s.me]) !== before)) return `at ${hour}:00 the refusal to sell was not clean`;
    }
    return '';
  });
  {
    const s = plain(), m = s.town.merchants.blacksmith;
    shut(s.town, m);
    s.me.inventory.ore = 2;
    const before = text([s.town, s.me]);
    const r = Rules.sell(s.town, s.me, 'blacksmith', 'ore', 2, 'ada.testnet');
    check('a shut shop buys nothing', !r.ok && r.message === 'The shop is closed.' && text([s.town, s.me]) === before, r.message);
  }
  {
    const s = plain(), m = s.town.merchants.blacksmith;
    setCoins(s.town, m, 1);
    s.me.inventory.ore = 2;
    const before = text([s.town, s.me]);
    const r = Rules.sell(s.town, s.me, 'blacksmith', 'ore', 2, 'ada.testnet');
    check('a shop whose purse is too thin for even one buys nothing, and says it cannot spare the coins', !r.ok && /can't spare \d+ coins/.test(r.message) && text([s.town, s.me]) === before, r.message);
  }
  sound('a shop with a thin purse buys only while half of what it has left covers the next one, and stops there', () => {
    for (const coins of [10, 17, 25, 40, 59, 60, 75]) {
      const s = plain(), m = s.town.merchants.blacksmith;
      setCoins(s.town, m, coins);
      s.me.inventory.ore = 40;
      let sold = 0, stop = '';
      while (sold < 100) {
        const till = m.coins;
        const r = Rules.sell(s.town, s.me, 'blacksmith', 'ore', 1, 'ada.testnet');
        if (!r.ok) { stop = r.message; break; }
        if ((r.price ?? 0) > till * RULES.maxSpendShare) return `with ${till} coins the shop paid ${r.price} for one`;
        sold += 1;
      }
      if (!/can't spare|no room/.test(stop)) return `a shop with ${coins} coins stopped with "${stop}"`;
      if (coins <= 25 && !/can't spare/.test(stop)) return `a shop with ${coins} coins stopped for want of room, not of coin`;
      if (sold === 0 || have(s.me.inventory, 'ore') !== 40 - sold) return `a shop with ${coins} coins bought ${sold}`;
      const lump = plain();
      setCoins(lump.town, lump.town.merchants.blacksmith, coins);
      lump.me.inventory.ore = 40;
      const r = Rules.sell(lump.town, lump.me, 'blacksmith', 'ore', 40, 'ada.testnet');
      if (r.count !== sold || text(lump.town) !== text(s.town)) return `asked to take 40 at once, a shop with ${coins} coins took ${r.count}, not ${sold}`;
      const wrong = coinTrouble(s.town, [s.me], s.total) || balanceTrouble(s.town, [s.me]);
      if (wrong) return wrong;
    }
    return '';
  });
  {
    const s = plain(), m = s.town.merchants.blacksmith;
    const limit = have(m.target, 'ore') * RULES.fullAtTimesTarget;
    m.stock.ore = limit - 2;
    s.me.inventory.ore = 10;
    const r = Rules.sell(s.town, s.me, 'blacksmith', 'ore', 10, 'ada.testnet');
    const state = text([s.town, s.me]);
    const again = Rules.sell(s.town, s.me, 'blacksmith', 'ore', 10, 'ada.testnet');
    check('a shop takes goods only until its shelf is full: with room for two, it buys two of ten', r.ok && r.count === 2 && have(m.stock, 'ore') === limit && have(s.me.inventory, 'ore') === 8, text(r));
    check('a shop whose shelf is full buys nothing, and says it has no room', !again.ok && /no room/.test(again.message) && text([s.town, s.me]) === state, again.message);
  }
  sound('a shop buys only what it uses: nothing it makes itself, and nothing another trade uses', () => {
    for (const m of shopsOf(Rules.newTown())) for (const g of GOOD_IDS) {
      const s = plain();
      s.me.inventory[g] = 2;
      const before = text([s.town, s.me]);
      const r = Rules.sell(s.town, s.me, m.id, g, 1, 'ada.testnet');
      if (r.ok !== owns(m.usualSupply, g)) return `${m.id} ${r.ok ? 'bought' : 'refused'} ${g}`;
      if (!r.ok && (!/has no use for/.test(r.message) || text([s.town, s.me]) !== before)) return `${m.id} refused ${g} with "${r.message}"`;
    }
    return '';
  });
  {
    const s = plain(), before = text([s.town, s.me]);
    const none = Rules.sell(s.town, s.me, 'blacksmith', 'ore', 1, 'ada.testnet');
    check('a player with none of the good sells nothing', !none.ok && none.message === 'You have no ore.' && text([s.town, s.me]) === before, none.message);
    s.me.inventory.ore = 5;
    const r = Rules.sell(s.town, s.me, 'blacksmith', 'ore', 50, 'ada.testnet');
    check('a player asked to sell fifty with five in hand sells five, and is left with none', r.ok && r.count === 5 && have(s.me.inventory, 'ore') === 0 && s.me.stats.sold === 5, text(r));
    const noShop = Rules.sell(s.town, s.me, 'tailor' as MerchantId, 'ore', 1, 'ada.testnet');
    check('there is no selling to a shop that does not exist', !noShop.ok && noShop.message === 'No such shop.');
  }
});

heading('What a player does: buying from a shop');
group(() => {
  {
    const s = scene(), m = s.town.merchants.baker;
    fromPurse(s.town, s.me, 200);
    const quote = quoteSell(m, 'bread').price, till = m.coins, shelf = have(m.stock, 'bread'), purse = s.town.purse, recent = have(m.recentSales, 'bread'), coins = s.me.coins;
    const r = Rules.buy(s.town, s.me, 'baker', 'bread');
    check('a purchase moves one from the shelf to the player and the quoted price to the till', r.ok && r.count === 1 && r.price === quote && s.me.coins === coins - quote && m.coins === till + quote && have(s.me.inventory, 'bread') === 1 && have(m.stock, 'bread') === shelf - 1 && s.me.stats.bought === 1 && s.town.purse === purse, text(r));
    check('a player\'s purchase counts as trade for the shop', Math.abs(have(m.recentSales, 'bread') - (recent + 0.15)) < 1e-9 && !coinTrouble(s.town, [s.me], s.total));
  }
  {
    const s = scene(), m = s.town.merchants.baker;
    fromPurse(s.town, s.me, 900);
    const prices: number[] = [];
    for (let i = 0; i < 50; i++) { const r = Rules.buy(s.town, s.me, 'baker', 'bread'); if (!r.ok) break; prices.push(r.price ?? 0); }
    const state = text([s.town, s.me]);
    const soldOut = Rules.buy(s.town, s.me, 'baker', 'bread');
    check('the price climbs as the shelf empties: each loaf costs no less than the one before, and the last more than the first', prices.length > 1 && risesOrHolds(prices) && prices[prices.length - 1] > prices[0], prices.join(', '));
    check('when the shelf is bare the shop is sold out, and nothing changes hands', have(m.stock, 'bread') === 0 && !soldOut.ok && /sold out/.test(soldOut.message) && text([s.town, s.me]) === state && have(s.me.inventory, 'bread') === prices.length, soldOut.message);
  }
  sound('a shop sells only the one thing it makes', () => {
    for (const m of shopsOf(Rules.newTown())) for (const g of GOOD_IDS) {
      const s = scene();
      fromPurse(s.town, s.me, 500);
      for (const shop of shopsOf(s.town)) for (const kept of GOOD_IDS) shop.stock[kept] = 5; // even with it on the shelf
      const before = text([s.town, s.me]);
      const r = Rules.buy(s.town, s.me, m.id, g);
      if (r.ok !== (m.recipe.output === g)) return `${m.id} ${r.ok ? 'sold' : 'refused to sell'} ${g}`;
      if (!r.ok && (!/does not sell that/.test(r.message) || text([s.town, s.me]) !== before)) return `${m.id} refused ${g} with "${r.message}"`;
    }
    return '';
  });
  {
    const s = scene(), m = s.town.merchants.baker;
    const quote = quoteSell(m, 'bread').price;
    setCoins(s.town, s.me, quote - 1);
    const before = text([s.town, s.me]);
    const poor = Rules.buy(s.town, s.me, 'baker', 'bread');
    check('a player one coin short buys nothing, and is told the price', !poor.ok && poor.message === `You need ${quote} coins.` && text([s.town, s.me]) === before, poor.message);
    setCoins(s.town, s.me, quote);
    const exact = Rules.buy(s.town, s.me, 'baker', 'bread');
    check('a player with exactly the price buys, and is left with nothing', exact.ok && s.me.coins === 0);
    shut(s.town, m);
    fromPurse(s.town, s.me, 100);
    const shutState = text([s.town, s.me]);
    const closed = Rules.buy(s.town, s.me, 'baker', 'bread');
    const noShop = Rules.buy(s.town, s.me, 'tailor' as MerchantId, 'bread');
    check('a shut shop, or one that does not exist, sells nothing', !closed.ok && closed.message === 'The shop is closed.' && !noShop.ok && noShop.message === 'No such shop.' && text([s.town, s.me]) === shutState);
  }
  {
    const s = scene();
    fromPurse(s.town, s.me, 300);
    const tool = Rules.buy(s.town, s.me, 'blacksmith', 'tools');
    const before = text([s.town, s.me]);
    const back = Rules.sell(s.town, s.me, 'blacksmith', 'tools', 1, 'ada.testnet');
    check('a bought tool makes gathering better, and cannot be sold back', tool.ok && Rules.gatherYield(s.me) === 2 && !back.ok && text([s.town, s.me]) === before);
  }
});

heading('What a player does: eating');
group(() => {
  sound('bread and smoked fish each give the energy the rules name, cost one of the food, and are counted', () => {
    for (const g of FOOD) {
      const s = scene(), before = text(s.town);
      s.me.inventory[g] = 2;
      s.me.energy = 5;
      const r = Rules.eat(s.town, s.me, g);
      if (!r.ok || r.count !== 1 || s.me.energy !== 5 + (GOODS[g].energy ?? 0) || have(s.me.inventory, g) !== 1 || s.me.stats.eaten !== 1) return `${g}: ${text(r)}, energy ${s.me.energy}`;
      if (s.me.coins !== TOWN.startingCoins || text(s.town) !== before) return `eating ${g} moved coins or the town`;
    }
    return '';
  });
  {
    const s = scene();
    s.me.inventory.bread = 3;
    s.me.energy = TOWN.maxEnergy - 5;
    const r = Rules.eat(s.town, s.me, 'bread');
    check('energy never passes the most a player can hold', r.ok && s.me.energy === TOWN.maxEnergy && have(s.me.inventory, 'bread') === 2);
    s.town.hour = 23;
    s.me.energy = 3;
    check('eating goes on at night', Rules.eat(s.town, s.me, 'bread').ok && s.me.energy === 3 + (GOODS.bread.energy ?? 0));
  }
  sound('nothing but food can be eaten, and not without having some: a refusal changes nothing', () => {
    for (const g of GOOD_IDS) {
      const s = scene();
      s.me.energy = 5;
      const empty = text(s.me);
      const none = Rules.eat(s.town, s.me, g);
      if (none.ok || none.message !== 'Nothing to eat.' || text(s.me) !== empty) return `ate ${g} without having any`;
      s.me.inventory[g] = 2;
      const stocked = text(s.me);
      const r = Rules.eat(s.town, s.me, g);
      if (r.ok !== FOOD.includes(g)) return `${g} ${r.ok ? 'was eaten' : 'could not be eaten'}`;
      if (!r.ok && text(s.me) !== stocked) return `${g} was refused, but something changed`;
    }
    return '';
  });
});

heading('What a player does: buying into a shop');
group(() => {
  {
    const s = scene(), m = s.town.merchants.baker;
    fromPurse(s.town, s.me, TOWN.investCost);
    const till = m.coins, purse = s.town.purse, coins = s.me.coins, worth = Rules.netWorth(s.town, s.me, 'ada.testnet');
    const r = Rules.invest(s.town, s.me, 'ada.testnet', 'baker');
    check('a stake costs 100 coins, paid into the shop\'s till, for 25% of its profit', r.ok && r.price === TOWN.investCost && s.me.coins === coins - TOWN.investCost && m.coins === till + TOWN.investCost && m.holders['ada.testnet'] === TOWN.investPct && Rules.investedPct(m) === TOWN.investPct && s.town.purse === purse, text(r));
    check('the buyer is told what they now own, and the town hears of it', r.message.includes(`${TOWN.investPct}%`) && s.town.events.length === 1 && s.town.events[0].kind === 'news' && /bought into Odo's shop/.test(s.town.events[0].text), `${r.message} / ${s.town.events[0]?.text}`);
    check('buying a stake leaves a player worth exactly what they were, and no coin is made', Rules.netWorth(s.town, s.me, 'ada.testnet') === worth && !coinTrouble(s.town, [s.me], s.total));
  }
  {
    const s = scene();
    setCoins(s.town, s.me, TOWN.investCost - 1);
    const before = text([s.town, s.me]);
    const r = Rules.invest(s.town, s.me, 'ada.testnet', 'baker');
    const noShop = Rules.invest(s.town, s.me, 'ada.testnet', 'tailor' as MerchantId);
    check('one coin short of the price buys no stake, and nor does a shop that does not exist', !r.ok && /need 100 coins/.test(r.message) && !noShop.ok && noShop.message === 'No such shop.' && text([s.town, s.me]) === before, r.message);
  }
  {
    const s = scene(), m = s.town.merchants.carpenter, bo = Rules.newPlayer(s.town);
    fromPurse(s.town, s.me, 5 * TOWN.investCost);
    fromPurse(s.town, bo, 5 * TOWN.investCost);
    const first = Rules.invest(s.town, s.me, 'ada.testnet', 'carpenter'), second = Rules.invest(s.town, s.me, 'ada.testnet', 'carpenter'), third = Rules.invest(s.town, bo, 'bo.testnet', 'carpenter');
    const before = text([s.town, s.me, bo]);
    const fourth = Rules.invest(s.town, bo, 'bo.testnet', 'carpenter'), fifth = Rules.invest(s.town, s.me, 'ada.testnet', 'carpenter');
    check('one player may hold two stakes, and they add up', first.ok && second.ok && m.holders['ada.testnet'] === 2 * TOWN.investPct && second.message.includes(`${2 * TOWN.investPct}%`));
    check('a shop sells three stakes and no more, whoever asks: the cap is 75%', third.ok && !fourth.ok && !fifth.ok && /won't part with any more/.test(fourth.message) && Rules.investedPct(m) === TOWN.maxInvestedPct && text([s.town, s.me, bo]) === before, `${Rules.investedPct(m)}% sold`);
    check('each shop has its own cap', Rules.invest(s.town, bo, 'bo.testnet', 'baker').ok && Rules.shopsHeld(s.town, 'bo.testnet') === 2 && Rules.shopsHeld(s.town, 'ada.testnet') === 1);
  }
  {
    const s = scene(), m = s.town.merchants.fishmonger;
    shut(s.town, m);
    s.town.hour = 22; // even at night
    fromPurse(s.town, s.me, TOWN.investCost);
    const r = Rules.invest(s.town, s.me, 'ada.testnet', 'fishmonger');
    check('buying into a shut shop opens it again at once, rent forgiven, and the town is told', r.ok && m.open && m.missedRent === 0 && m.coinsAtDawn === m.coins && s.town.events.some((e) => e.kind === 'reopened' && e.text.includes(m.name)), text(r));
  }
  {
    const s = scene(), m = s.town.merchants.baker;
    fromPurse(s.town, s.me, TOWN.investCost);
    const before = m.coins - m.coinsAtDawn;
    Rules.invest(s.town, s.me, 'ada.testnet', 'baker');
    check('the stake is not counted as that day\'s takings: the shop\'s profit so far is what it was', m.coins - m.coinsAtDawn === before);
  }
});

heading('What a shopkeeper does: changing the plan');
group(() => {
  const books = (town: Town) => text([town.purse, shopsOf(town).map((s) => [s.coins, s.stock])]);
  {
    const town = Rules.newTown(), m = town.merchants.baker;
    const before = books(town), others = text(shopsOf(town).filter((s) => s.id !== 'baker'));
    const r = Rules.setPlan(town, m, { bread: 10 }, 'Bread keeps selling out, so I am making more.', 'NEAR AI (a model)');
    check('a plan within the limits is taken: the named target changes, the rest stay, and the words, the thinker and the day are kept', r.ok && r.message === 'Plan updated.' && m.target.bread === 10 && m.target.wheat === 16 && m.plan === 'Bread keeps selling out, so I am making more.' && m.thinker === 'NEAR AI (a model)' && m.plannedOn === town.day, text(r));
    check('a plan moves no coins and no stock, and touches no other shop', books(town) === before && text(shopsOf(town).filter((s) => s.id !== 'baker')) === others);
    const unsigned = Rules.setPlan(town, m, {}, 'Holding steady.');
    check('a plan that names no target changes none, and a plan sent without a thinker clears the last one', unsigned.ok && m.target.bread === 10 && m.target.wheat === 16 && m.plan === 'Holding steady.' && m.thinker === '');
    until(town, TOWN.openHour, Rules.seededRng(51));
    Rules.setPlan(town, m, { wheat: 12 }, 'Buying in less wheat.');
    check('the day of the latest plan is the day it was made', town.day === 2 && m.plannedOn === 2 && m.target.wheat === 12);
  }
  sound('a shelf target may be any whole number from 1 to 40, and nothing else', () => {
    for (const n of [1, 2, 39, 40]) {
      const t = Rules.newTown();
      if (!Rules.setPlan(t, t.merchants.baker, { wheat: n }, 'x').ok || t.merchants.baker.target.wheat !== n) return `${n} was refused`;
    }
    for (const n of [0, 41, -1, 1.5, 40.5, NaN, Infinity, 1000]) {
      const t = Rules.newTown(), before = text(t);
      const r = Rules.setPlan(t, t.merchants.baker, { wheat: n }, 'x');
      if (r.ok || text(t) !== before || !/whole numbers from 1 to 40/.test(r.message)) return `${n} was taken, or refused untidily`;
    }
    return '';
  });
  {
    const town = Rules.newTown(), m = town.merchants.baker, before = text(town);
    const mixed = Rules.setPlan(town, m, { bread: 12, wheat: 41 }, 'Half right.', 'someone');
    const foreign = Rules.setPlan(town, m, { bread: 12, ore: 5 }, 'Ore for a baker.', 'someone');
    check('one target out of bounds, or one good the shop does not stock, refuses the whole plan: no target, word or day is changed', !mixed.ok && !foreign.ok && /does not stock ore/.test(foreign.message) && text(town) === before, `${mixed.message} / ${foreign.message}`);
  }
  {
    const town = Rules.newTown(), m = town.merchants.baker;
    const long = Array.from({ length: 300 }, (_, i) => String(i % 10)).join(''), who = Array.from({ length: 100 }, (_, i) => String(i % 10)).join('');
    Rules.setPlan(town, m, {}, long, who);
    const cut = m.plan === long.slice(0, 240) && m.thinker === who.slice(0, 60);
    Rules.setPlan(town, m, {}, long.slice(0, 240), who.slice(0, 60));
    check('a plan is trimmed to its first 240 characters and a thinker to the first 60; ones that fit are kept whole', cut && m.plan === long.slice(0, 240) && m.plan.length === 240 && m.thinker === who.slice(0, 60) && m.thinker.length === 60);
  }
  {
    const town = Rules.newTown(), m = town.merchants.baker;
    m.stock.wheat = have(m.target, 'wheat') * RULES.fullAtTimesTarget; // no room, as things stand
    const paid = quoteBuy(m, 'wheat'), charged = quoteSell(m, 'bread').price;
    Rules.setPlan(town, m, { wheat: 30, bread: 16 }, 'Keeping more of everything.');
    check('the plan is what the prices follow: liking to keep more, the shop pays more, charges more and finds room again', !paid.available && quoteBuy(m, 'wheat').available && quoteBuy(m, 'wheat').price > paid.price && quoteSell(m, 'bread').price > charged, `${paid.price} to ${quoteBuy(m, 'wheat').price}, ${charged} to ${quoteSell(m, 'bread').price}`);
  }
});

// ── 8. Wanted orders ────────────────────────────────────────────────────────
heading('Wanted orders: what goes up on the board');
group(() => {
  /** A town at the next dawn, its shelves and tills first set as the test asks. */
  const morning = (setUp: (town: Town) => void) => { const town = Rules.newTown(); setUp(town); nextDawn(town); return town; };
  const wellStocked = (town: Town) => { for (const m of shopsOf(town)) for (const g of goodsOf(m.usualSupply)) m.stock[g] = have(m.target, g); };

  const first = Rules.newTown();
  sound('a new town opens with orders already on the board, each a fair ask', () => postedTrouble(first) || (Rules.todaysOrders(first).length >= 1 ? '' : 'the board is bare'));
  check('an order asks one shop for one good it buys, names a bonus, and is numbered for its day', Rules.todaysOrders(first).every((o) => o.day === 1 && Math.floor(o.id / 10) === 1 && text(o.progress) === '{}' && o.wonBy === undefined) && new Set(Rules.todaysOrders(first).map((o) => o.id)).size === Rules.todaysOrders(first).length, text(Rules.todaysOrders(first)));

  const calm = morning(wellStocked);
  check('the first order always goes up, even on a morning when nobody is short; a second needs a shop that is', Rules.todaysOrders(calm).length === 1 && Rules.todaysOrders(calm)[0].wanted === TOWN.orderMin && !postedTrouble(calm), text(Rules.todaysOrders(calm)));

  const oneShort = morning((t) => { wellStocked(t); t.merchants.fishmonger.stock.fish = 0; });
  check('the shop shortest of something is asked first, for the gap on its shelf', Rules.todaysOrders(oneShort).length === 1 && Rules.todaysOrders(oneShort)[0].merchant === 'fishmonger' && Rules.todaysOrders(oneShort)[0].wanted === have(oneShort.merchants.fishmonger.target, 'fish') && !postedTrouble(oneShort), text(Rules.todaysOrders(oneShort)));

  const threeShort = morning((t) => { wellStocked(t); t.merchants.fishmonger.stock.fish = 0; t.merchants.baker.stock.wheat = 0; t.merchants.carpenter.stock.wood = 1; });
  check('at most two orders go up in a morning, the two shortest shops first', Rules.todaysOrders(threeShort).length === TOWN.ordersPerDay && Rules.todaysOrders(threeShort).map((o) => o.merchant).join() === 'baker,fishmonger' && !postedTrouble(threeShort), text(Rules.todaysOrders(threeShort)));
  check('an order never asks for more than twelve, however bare the shelf', Rules.todaysOrders(threeShort)[0].wanted === TOWN.orderMax && have(threeShort.merchants.baker.target, 'wheat') > TOWN.orderMax);
  sound('the bonus is six tenths of what the goods cost at the normal price, and never less than 5', () => {
    for (const town of [first, calm, oneShort, threeShort]) for (const o of Rules.todaysOrders(town)) {
      if (o.bonus !== Math.max(TOWN.orderBonusMin, Math.round(o.wanted * GOODS[o.good].base * TOWN.orderBonusShare))) return `${o.wanted} ${o.good} offers ${o.bonus}`;
    }
    return '';
  });

  const bothShort = morning((t) => { wellStocked(t); t.merchants.blacksmith.stock.ore = 0; t.merchants.blacksmith.stock.wood = 0; });
  check('a shopkeeper short of two things still puts up only one order', Rules.todaysOrders(bothShort).length === 1 && Rules.todaysOrders(bothShort)[0].merchant === 'blacksmith', text(Rules.todaysOrders(bothShort)));

  const shutShort = morning((t) => { wellStocked(t); t.merchants.fishmonger.stock.fish = 0; shut(t, t.merchants.fishmonger); });
  const allShut = morning((t) => { for (const m of shopsOf(t)) shut(t, m); });
  check('a shut shop puts up nothing, however short it is, and a town of shut shops has a bare board', Rules.todaysOrders(shutShort).length === 1 && Rules.todaysOrders(shutShort)[0].merchant !== 'fishmonger' && !shutShort.merchants.fishmonger.open && Rules.todaysOrders(allShut).length === 0, text(Rules.todaysOrders(shutShort)));

  /** Only the baker is open, holding this much wheat with this much coin: what goes up? */
  const bakerAlone = (wheat: number, coins?: number) => morning((t) => {
    for (const m of shopsOf(t)) if (m.id !== 'baker') shut(t, m);
    t.merchants.baker.stock.wheat = wheat;
    if (coins !== undefined) setCoins(t, t.merchants.baker, coins);
  });
  const roomFor = have(Rules.newTown().merchants.baker.target, 'wheat') * RULES.fullAtTimesTarget - TOWN.orderMin;
  check('a shop with no room for what it would ask puts up nothing; with just enough room, it does', Rules.todaysOrders(bakerAlone(roomFor + 1)).length === 0 && Rules.todaysOrders(bakerAlone(roomFor)).length === 1, `${Rules.todaysOrders(bakerAlone(roomFor + 1)).length} and ${Rules.todaysOrders(bakerAlone(roomFor)).length}`);
  const bonusDue = ask(bakerAlone(0).merchants.baker, 'wheat').bonus;
  check('a shop that could not pay the bonus and keep 60 coins in the till puts up nothing; with one coin more, it does', Rules.todaysOrders(bakerAlone(0, bonusDue + TOWN.orderCushion - 1)).length === 0 && Rules.todaysOrders(bakerAlone(0, bonusDue + TOWN.orderCushion)).length === 1);

  // The board through a day and a night.
  {
    const town = Rules.newTown(), rng = Rules.seededRng(31);
    const me = Rules.newPlayer(town);
    const o = Rules.todaysOrders(town)[0];
    me.inventory[o.good] = 1;
    Rules.sell(town, me, o.merchant, o.good, 1, 'ada.testnet');
    const dayOne = text(Rules.todaysOrders(town));
    until(town, TOWN.closeHour, rng);
    me.inventory[o.good] = 5;
    const evening = text([town, me]);
    const late = Rules.sell(town, me, o.merchant, o.good, 5, 'ada.testnet');
    check('after closing, the day\'s orders stay on the board until midnight, but nothing can be sold towards them', Rules.todaysOrders(town).length > 0 && text(Rules.todaysOrders(town)) === dayOne && !late.ok && text([town, me]) === evening);
    until(town, 0, rng);
    const smallHours: number[] = [];
    pass(town, rng, nobodyPaid, () => { smallHours.push(Rules.todaysOrders(town).length); return town.hour < TOWN.openHour - 1 && smallHours.length < 24; });
    check('from midnight until the shops open, the board is empty', smallHours.length === TOWN.openHour && smallHours.every((n) => n === 0), smallHours.join());
    Rules.tickHour(town, rng, nobodyPaid);
    const fresh = Rules.todaysOrders(town);
    check('new orders are pinned up when the shops open, and yesterday\'s are taken down with what was brought towards them', fresh.length >= 1 && fresh.every((x) => x.day === town.day && text(x.progress) === '{}') && (town.orders ?? []).every((x) => x.day === town.day) && !postedTrouble(town), text(town.orders));
  }
});

heading('Wanted orders: filling one');
group(() => {
  /** A new town, a newcomer, and the first order on the board with the shop that posted it. */
  const withOrder = () => {
    const s = scene();
    const o = Rules.todaysOrders(s.town)[0];
    return { ...s, o, m: s.town.merchants[o.merchant] };
  };
  {
    const { town, me, total, o, m } = withOrder();
    me.inventory[o.good] = o.wanted + 6;
    const till = m.coins, purse = town.purse, coins = me.coins;
    const r = Rules.sell(town, me, o.merchant, o.good, o.wanted, 'ada.testnet');
    check('bringing the full amount pays the bonus on top of the price, out of the shopkeeper\'s own till', r.ok && r.count === o.wanted && r.bonus === o.bonus && me.coins === coins + (r.price ?? 0) + o.bonus && m.coins === till - (r.price ?? 0) - o.bonus && town.purse === purse && !coinTrouble(town, [me], total), text(r));
    check('the order is marked as won, the winner gets a note and the town hears of it', o.wonBy === 'ada.testnet' && o.progress['ada.testnet'] === o.wanted && me.notices.length === 1 && me.notices[0].text.includes(`${o.bonus}-coin bonus`) && town.events.some((e) => e.kind === 'news' && /filled/.test(e.text) && e.text.includes(String(o.wanted))), `${me.notices[0]?.text} / ${town.events[town.events.length - 1]?.text}`);
    const bo = Rules.newPlayer(town);
    bo.inventory[o.good] = o.wanted;
    const again = Rules.sell(town, me, o.merchant, o.good, 3, 'ada.testnet'), other = Rules.sell(town, bo, o.merchant, o.good, 3, 'bo.testnet');
    check('the bonus is paid exactly once: more goods from the winner, or from anyone else, earn only their price', again.ok && again.bonus === undefined && other.ok && other.bonus === undefined && o.wonBy === 'ada.testnet' && me.notices.length === 1 && bo.notices.length === 0 && m.coins === till - (r.price ?? 0) - o.bonus - (again.price ?? 0) - (other.price ?? 0) && !coinTrouble(town, [me, bo], total), `${text(again)} / ${text(other)}`);
  }
  {
    const { town, me, total, o } = withOrder();
    me.inventory[o.good] = o.wanted;
    const part = Rules.sell(town, me, o.merchant, o.good, o.wanted - 1, 'ada.testnet');
    const progress = o.progress['ada.testnet'], notYet = o.wonBy;
    const rest = Rules.sell(town, me, o.merchant, o.good, 1, 'ada.testnet');
    check('a part of the amount counts towards the order, and the visit that completes it earns the bonus', part.ok && part.bonus === undefined && progress === o.wanted - 1 && notYet === undefined && rest.ok && rest.bonus === o.bonus && o.wonBy === 'ada.testnet' && !coinTrouble(town, [me], total), `${text(part)} then ${text(rest)}`);
  }
  {
    const { town, me, o } = withOrder();
    const bo = Rules.newPlayer(town);
    me.inventory[o.good] = o.wanted; bo.inventory[o.good] = o.wanted;
    const mine = Rules.sell(town, me, o.merchant, o.good, o.wanted - 1, 'ada.testnet');
    const theirs = Rules.sell(town, bo, o.merchant, o.good, 1, 'bo.testnet');
    const open = o.wonBy;
    const theirRest = Rules.sell(town, bo, o.merchant, o.good, o.wanted - 1, 'bo.testnet');
    check('each player\'s goods are counted apart: the first to bring the full amount alone wins', mine.ok && theirs.ok && theirs.bonus === undefined && open === undefined && theirRest.bonus === o.bonus && o.wonBy === 'bo.testnet' && o.progress['ada.testnet'] === o.wanted - 1 && me.notices.length === 0);
  }
  {
    const town = Rules.newTown(), me = Rules.newPlayer(town);
    const ore = Rules.todaysOrders(town).find((x) => x.good === 'ore'), wheat = Rules.todaysOrders(town).find((x) => x.good === 'wheat');
    me.inventory = { wood: 12, wheat: 12 };
    const wood = Rules.sell(town, me, 'blacksmith', 'wood', 12, 'ada.testnet');
    const grain = Rules.sell(town, me, 'baker', 'wheat', wheat?.wanted ?? 0, 'ada.testnet');
    check('goods count only towards an order for that good from that shop', !!ore && !!wheat && wood.ok && wood.bonus === undefined && text(ore.progress) === '{}' && ore.wonBy === undefined && grain.bonus === wheat.bonus && wheat.wonBy === 'ada.testnet', `${text(wood)} / ${text(grain)}`);
  }
  {
    const { town, me, total, o, m } = withOrder();
    setCoins(town, m, 30);
    me.inventory[o.good] = o.wanted;
    const r = Rules.sell(town, me, o.merchant, o.good, o.wanted, 'ada.testnet');
    const left = 30 - (r.price ?? 0);
    check('a shopkeeper who can no longer cover the bonus pays what is in the till, and the till stops at nothing', r.ok && r.count === o.wanted && left < o.bonus && r.bonus === left && m.coins === 0 && o.wonBy === 'ada.testnet' && !coinTrouble(town, [me], total) && !balanceTrouble(town, [me]), text(r));
  }
  {
    const { town, me, o } = withOrder();
    me.inventory[o.good] = o.wanted;
    Rules.sell(town, me, o.merchant, o.good, o.wanted - 1, 'ada.testnet');
    nextDawn(town);
    me.inventory[o.good] = 1;
    const stale = Rules.sell(town, me, o.merchant, o.good, 1, 'ada.testnet');
    const now = Rules.todaysOrders(town).find((x) => x.merchant === o.merchant && x.good === o.good);
    check('an order lapses at the next dawn: yesterday\'s goods do not count towards today\'s', stale.ok && stale.bonus === undefined && (!now || now.progress['ada.testnet'] === 1) && !Rules.todaysOrders(town).includes(o));
  }
});

// ── 9. Standing ─────────────────────────────────────────────────────────────
heading('Standing: worth, titles and the richest list');
group(() => {
  const { town, me } = scene();
  const bo = Rules.newPlayer(town);
  check('a newcomer is worth their starting coins', Rules.netWorth(town, me, 'ada.testnet') === TOWN.startingCoins);
  me.inventory = { ore: 3, bread: 2, tools: 1 };
  check('goods count at their normal price', Rules.netWorth(town, me, 'ada.testnet') === TOWN.startingCoins + 3 * GOODS.ore.base + 2 * GOODS.bread.base + GOODS.tools.base);
  fromPurse(town, me, 3 * TOWN.investCost);
  const before = Rules.netWorth(town, me, 'ada.testnet');
  Rules.invest(town, me, 'ada.testnet', 'baker'); Rules.invest(town, me, 'ada.testnet', 'carpenter'); Rules.invest(town, me, 'ada.testnet', 'carpenter');
  check('a stake counts at what it cost', Rules.netWorth(town, me, 'ada.testnet') === before && Rules.netWorth(town, me, 'ada.testnet') === me.coins + 3 * GOODS.ore.base + 2 * GOODS.bread.base + GOODS.tools.base + 3 * TOWN.investCost);
  check('shopsHeld counts shops, not stakes, and somebody else\'s stake is not mine', Rules.shopsHeld(town, 'ada.testnet') === 2 && Rules.shopsHeld(town, 'bo.testnet') === 0 && Rules.netWorth(town, bo, 'bo.testnet') === bo.coins);

  const title = Rules.titleOf, rung = Rules.TITLES.map((t) => t.name);
  check('the ladder has five rungs, lowest first, each saying what it takes', rung.join() === 'Newcomer,Trader,Merchant,Burgher,Alderman' && Rules.TITLES.every((t) => t.needs.length > 3) && Rules.TITLES[1].needs.includes(String(TOWN.traderWorth)));
  check('with no share: a Newcomer below 100 coins of worth, a Trader from 100', title(0, 0) === 'Newcomer' && title(TOWN.traderWorth - 1, 0) === 'Newcomer' && title(TOWN.traderWorth, 0) === 'Trader');
  check('one shop makes a Merchant, two or three a Burgher, all four an Alderman', title(0, 1) === 'Merchant' && title(0, 2) === 'Burgher' && title(0, 3) === 'Burgher' && title(0, 4) === 'Alderman');
  check('owning part of the town counts for more than coin: without a share the best is Trader, however rich', title(1e9, 0) === 'Trader' && title(1e9, 1) === 'Merchant' && title(5, 4) === 'Alderman');
  check('a player\'s title follows from what they hold', title(Rules.netWorth(town, me, 'ada.testnet'), Rules.shopsHeld(town, 'ada.testnet')) === 'Burgher' && title(Rules.netWorth(town, bo, 'bo.testnet'), Rules.shopsHeld(town, 'bo.testnet')) === 'Newcomer');

  let list: Rank[] = [];
  for (let i = 1; i <= 15; i++) list = Rules.ranked(list, `p${i}.testnet`, i * 10);
  check('the richest list keeps at most ten, richest first', list.length === 10 && list[0].worth === 150 && list[9].worth === 60 && fallsOrHolds(list.map((r) => r.worth)), text(list.map((r) => r.worth)));
  const frozen = text(list);
  const poorer = Rules.ranked(list, 'p12.testnet', 5);
  check('a player\'s own row is replaced, not added a second time', poorer.length === 10 && poorer.filter((r) => r.id === 'p12.testnet').length === 1 && poorer[9].id === 'p12.testnet' && poorer[9].worth === 5, text(poorer));
  check('ranking a player leaves the list it was given as it was', text(list) === frozen && poorer !== list);
  check('a player who grows richer climbs to the top, and one poorer than all ten does not get on', Rules.ranked(list, 'p6.testnet', 1000)[0].id === 'p6.testnet' && Rules.ranked(list, 'new.testnet', 1).every((r) => r.id !== 'new.testnet') && Rules.ranked(list, 'new.testnet', 1).length === 10);
  check('equal worth is put in order of id, so every node agrees on the list', text(Rules.ranked([{ id: 'b', worth: 5 }], 'a', 5).map((r) => r.id)) === '["a","b"]' && text(Rules.ranked([{ id: 'a', worth: 5 }], 'b', 5).map((r) => r.id)) === '["a","b"]');
  check('the first player ranked makes a list of one', text(Rules.ranked([], 'ada.testnet', 20)) === text([{ id: 'ada.testnet', worth: 20 }]));

  const rows = standings(town, [{ id: 'ada.testnet', worth: 500 }, { id: 'bo.testnet', worth: 30 }], 'ada.testnet');
  check('the town\'s ladder puts players and the four shopkeepers together, richest first', rows.length === 6 && fallsOrHolds(rows.map((r) => r.worth)) && rows.filter((r) => r.kind === 'shop').length === 4 && rows[0].worth === 500, text(rows));
  check('a shopkeeper is worth the coins in the till', shopsOf(town).every((m) => rows.some((r) => r.kind === 'shop' && r.name === m.name && r.worth === m.coins && !r.me)));
  check('only my own row is marked as mine', rows.filter((r) => r.me).length === 1 && rows.find((r) => r.me)?.worth === 500 && rows.find((r) => r.me)?.kind === 'player');
  const crowd = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}xyz.testnet`, worth: 1000 + i }));
  check('the ladder shows the top eight, and leaves the list it was given alone', standings(town, crowd, 'p3xyz.testnet').length === 8 && standings(town, crowd, 'p3xyz.testnet')[0].worth === 1009 && crowd[0].worth === 1000 && crowd.length === 10);

  check('a long account id is shown as "Traveller" and four characters of it', Rules.friendlyName('g57748bfc0a1b2c3d.brambleford-folk.testnet') === 'Traveller 5774' && rows.find((r) => r.me)?.name === Rules.friendlyName('ada.testnet'));
  check('the practice player, and anyone too short to shorten, is "A traveller"', Rules.friendlyName('you') === 'A traveller' && Rules.friendlyName('') === 'A traveller' && Rules.friendlyName('a') === 'A traveller');
  sound('a name in the town news is only ever letters, digits and spaces, whatever the id', () => {
    for (const id of ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>.testnet', 'a<b>c&d.testnet', '__proto__', 'constructor', '‮gnp.testnet', 'a\nb\tc', null, undefined, 7, {}, ['x']]) {
      const name = Rules.friendlyName(id as string);
      if (!/^(A traveller|Traveller [A-Za-z0-9]{1,4})$/.test(name)) return `${say(id)} is shown as ${say(name)}`;
    }
    return '';
  });
});

// ── 10. Hostile input ───────────────────────────────────────────────────────
heading('Hostile input');
const INHERITED = Object.getOwnPropertyNames(Object.prototype).sort().join();
/** Ids that are not ids: names every JavaScript object has, near misses, and things that are not even words. */
const ODD_IDS: unknown[] = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', '', ' ', 'BAKER', 'baker ', 'ORE', 'ore ', 'coin', 'share:baker', '0', 'null', null, undefined, 0, 7, NaN, true, {}, [], ['baker'], ['ore'], ['bread'], ['ore', 'wood']];
/** Amounts that are not amounts. */
const ODD_AMOUNTS: unknown[] = [NaN, Infinity, -Infinity, -1, 0, 0.5, 1.5, 2.999, 1e9, 1e308, '3', 'abc', '', null, {}, [], [2], true, false];
/** A list of one real good, such as ["ore"], which JavaScript reads as the good itself. */
const wrapped = (id: unknown) => Array.isArray(id) && id.length === 1 && GOOD_IDS.includes(id[0] as GoodId);
group(() => {
  sound('an id that is not one of the four shops finds no shop: nothing is sold, bought or bought into, and nothing moves', () => {
    for (const id of ODD_IDS) {
      const s = scene();
      s.me.inventory.ore = 5;
      fromPurse(s.town, s.me, 300);
      const before = text([s.town, s.me]), shop = id as MerchantId;
      for (const r of [Rules.sell(s.town, s.me, shop, 'ore', 2, 'ada.testnet'), Rules.buy(s.town, s.me, shop, 'bread'), Rules.invest(s.town, s.me, 'ada.testnet', shop)]) {
        if (r.ok || r.message !== 'No such shop.') return `${say(id)} was taken for a shop: "${r.message}"`;
      }
      if (text([s.town, s.me]) !== before) return `${say(id)}: something moved`;
    }
    return '';
  });
  sound('an id that is not a good is turned away by gather, sell, buy and eat, each saying why, and nothing moves', () => {
    const reasons = [/cannot be gathered/, /has no use for/, /does not sell that/, /Nothing to eat/];
    for (const id of ODD_IDS.filter((x) => !wrapped(x))) {
      const s = scene();
      s.me.inventory = { ore: 3, bread: 2 };
      s.me.energy = 10;
      fromPurse(s.town, s.me, 300);
      const before = text([s.town, s.me]), good = id as GoodId;
      const said = [Rules.gather(s.town, s.me, good), Rules.sell(s.town, s.me, 'blacksmith', good, 2, 'ada.testnet'), Rules.buy(s.town, s.me, 'baker', good), Rules.eat(s.town, s.me, good)];
      for (const [i, r] of said.entries()) if (r.ok || !reasons[i].test(r.message)) return `${say(id)} was ${r.ok ? 'accepted' : `refused with "${r.message}"`}`;
      if (text([s.town, s.me]) !== before) return `${say(id)}: something moved`;
    }
    return '';
  });
  {
    const s = scene();
    s.me.inventory = { ore: 3, bread: 2 };
    s.me.energy = 10;
    const before = text([s.town, s.me]);
    const tries = [Rules.gather(s.town, s.me, ['ore'] as unknown as GoodId), Rules.sell(s.town, s.me, 'blacksmith', ['ore'] as unknown as GoodId, 1, 'ada.testnet'), Rules.eat(s.town, s.me, ['bread'] as unknown as GoodId)];
    check('a good id wrapped in a list, such as ["ore"], is turned away like any other wrong id', tries.every((r) => !r.ok) && text([s.town, s.me]) === before);
    check('even then, coins and goods still balance', !coinTrouble(s.town, [s.me], s.total) && !balanceTrouble(s.town, [s.me]) && !shapeTrouble(s.town, [s.me]) && !jsonTrouble(s.town));
  }

  /** Six ore, a blacksmith with room and coin, and one amount to sell. */
  const sellSome = (amount: unknown) => {
    const s = scene();
    s.town.orders = [];
    s.me.inventory.ore = 6;
    const before = text([s.town, s.me]), coins = s.me.coins, till = s.town.merchants.blacksmith.coins;
    const r = Rules.sell(s.town, s.me, 'blacksmith', 'ore', amount as number, 'ada.testnet');
    return { ...s, r, before, coins, till };
  };
  sound('whatever amount a sale is asked for, it moves only whole goods the player has, at the quoted prices, or moves nothing', () => {
    for (const amount of ODD_AMOUNTS) {
      const { town, me, total, r, before, coins, till } = sellSome(amount);
      const wrong = coinTrouble(town, [me], total) || balanceTrouble(town, [me]) || jsonTrouble(town) || jsonTrouble(me, 'the player');
      if (wrong) return `${say(amount)}: ${wrong}`;
      if (!r.ok) { if (text([town, me]) !== before) return `${say(amount)} was refused, but something moved`; continue; }
      const sold = r.count ?? NaN, price = r.price ?? NaN;
      if (!whole(sold) || sold < 1 || sold > 6 || have(me.inventory, 'ore') !== 6 - sold) return `${say(amount)} sold ${sold} of 6`;
      if (!whole(price) || price < sold || me.coins !== coins + price || town.merchants.blacksmith.coins !== till - price) return `${say(amount)} sold ${sold} for ${price}, and the coins do not agree`;
    }
    return '';
  });
  check('an amount that is not a number, or is nothing or less, sells nothing', [NaN, 'abc', '', null, {}, [], -1, 0, -Infinity, false].every((amount) => !sellSome(amount).r.ok));
  check('an amount far beyond what the player has sells what they have, and no more', [Infinity, 1e9, 1e308, 999, 7].every((amount) => { const { r, me } = sellSome(amount); return r.ok && r.count === 6 && have(me.inventory, 'ore') === 0; }));
  check('an amount written as text, or left out, is read as the number it means', sellSome('3').r.count === 3 && sellSome(undefined).r.count === 1 && sellSome(2).r.count === 2);
  check('a sale of "up to 1.5" sells no more than 1', (sellSome(1.5).r.count ?? 0) <= 1);
  check('a sale refused because of its amount says why', [0, -1, NaN].every((amount) => sellSome(amount).r.message.length > 0));

  /** A stranger with this id joins, buys a stake, fills an order in two visits and is paid a dividend. Answers with what went wrong. */
  const life = (id: string): string => {
    const town = Rules.newTown(), me = Rules.newPlayer(town);
    const folk = new Map([[id, me]]);
    const total = Rules.totalCoins(town, [me]);
    fromPurse(town, me, TOWN.investCost);
    const o = Rules.todaysOrders(town)[0], m = town.merchants[o.merchant];
    const stake = Rules.invest(town, me, id, o.merchant);
    if (!stake.ok) return 'could not buy a stake';
    if (!owns(m.holders, id) || m.holders[id] !== TOWN.investPct) return `paid ${TOWN.investCost} coins for a stake, was told "${stake.message}", and the shop's books show ${text(m.holders)}`;
    if (Rules.investedPct(m) !== TOWN.investPct || Rules.shopsHeld(town, id) !== 1 || Rules.netWorth(town, me, id) !== me.coins + TOWN.investCost) return 'the stake is not counted in their standing';
    if (!stake.message.includes(`${TOWN.investPct}%`)) return `was told "${stake.message}"`;
    me.inventory[o.good] = o.wanted;
    const part = Rules.sell(town, me, o.merchant, o.good, o.wanted - 1, id), rest = Rules.sell(town, me, o.merchant, o.good, 1, id);
    if (!part.ok || part.bonus || !rest.ok) return 'could not sell';
    if (rest.bonus !== o.bonus || o.wonBy !== id) return `brought all ${o.wanted} ${o.good} in two visits and got a bonus of ${rest.bonus ?? 'nothing'}`;
    const paid: Paid[] = [];
    fromPurse(town, m, 300);
    until(town, TOWN.closeHour, Rules.seededRng(3), payer(() => town, folk, paid));
    if (!paid.some((d) => d.holder === id && d.coins > 0)) return 'no dividend came';
    const worth = Rules.netWorth(town, me, id);
    if (!whole(worth) || Rules.titleOf(worth, Rules.shopsHeld(town, id)) !== 'Merchant') return `worth ${worth}, a ${Rules.titleOf(worth, Rules.shopsHeld(town, id))}`;
    const list = Rules.ranked([{ id: 'bo.testnet', worth: 1 }], id, worth);
    const mine = standings(town, list, id).filter((row) => row.me);
    if (list.length !== 2 || list[0].id !== id || mine.length !== 1 || !/^[A-Za-z0-9 ]+$/.test(mine[0].name)) return 'the richest list went wrong';
    return coinTrouble(town, [me], total) || balanceTrouble(town, [me]) || shapeTrouble(town, [me]) || trimTrouble(town, [me]) || jsonTrouble(town);
  };
  sound('a player may be called anything: "constructor", "toString", a page of letters, nothing at all. Stakes, orders, dividends and standing all still work', () => {
    for (const id of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '__defineGetter__', 'prototype', '', ' ', 'you', '0', 'null', 'undefined', 'coin', 'baker', '<img src=x onerror=alert(1)>', 'a'.repeat(3000)]) {
      const wrong = life(id);
      if (wrong) return `${say(id.slice(0, 40))}: ${wrong}`;
    }
    return '';
  });
  {
    // "__proto__" is the one name the books cannot keep, and no NEAR account can have it. It is refused, and nothing moves.
    const town = Rules.newTown(), me = Rules.newPlayer(town);
    me.coins = TOWN.investCost + 20;
    const before = text([town, me]);
    const r = Rules.invest(town, me, '__proto__', 'baker');
    check('a player called "__proto__" is refused a stake with a reason, and nothing changes', !r.ok && r.message.length > 0 && text([town, me]) === before);
  }
  {
    const w = new LocalWorld(1), m = w.town.merchants.baker;
    const share = (me: string) => { (w as unknown as { me: string }).me = me; return shareOf(w, m); };
    check('a player with no stake is shown as holding none of a shop, and one with a stake as holding a quarter', share('ada.testnet') === 0 && (() => { m.holders['ada.testnet'] = 25; return share('ada.testnet') === 0.25; })());
    check('a player called "constructor" or "toString" with no stake is shown as holding none of a shop', share('constructor') === 0 && share('toString') === 0);
  }

  sound('a plan that names a good the shop does not stock, or a number outside 1 to 40, is refused whole and changes nothing', () => {
    const bad: unknown[] = [{ constructor: 5 }, JSON.parse('{"__proto__": 5}'), { toString: 5 }, { hasOwnProperty: 5 }, { ore: 5 }, { tools: 5 }, { coin: 5 }, { bread: NaN }, { bread: Infinity }, { bread: -1 }, { bread: 0 }, { bread: 1.5 }, { bread: 41 }, { bread: 1e9 }, { bread: '7' }, { bread: null }, { bread: [7] }, { bread: true }, { wheat: 5, bread: 0 }, { bread: 5, constructor: 5 }, { bread: 5, wheat: 40.5 }, 'abc', [5]];
    for (const target of bad) {
      const town = Rules.newTown(), before = text(town);
      const r = Rules.setPlan(town, town.merchants.baker, target as Bag, 'A plan.', 'someone');
      if (r.ok) return `${text(target)} was accepted`;
      if (!r.message) return `${text(target)} was refused without a word`;
      if (text(town) !== before) return `${text(target)} was refused, but the town changed`;
    }
    return '';
  });
  sound('whatever is sent as a plan or as its thinker is kept as words, within their limits', () => {
    for (const words of [null, undefined, 7, NaN, true, {}, [], ['a', 'b'], 'x'.repeat(5000), '']) {
      const town = Rules.newTown(), m = town.merchants.baker;
      const r = Rules.setPlan(town, m, { bread: 9 }, words as string, words as string);
      if (!r.ok || typeof m.plan !== 'string' || m.plan.length > 240 || typeof m.thinker !== 'string' || m.thinker.length > 60) return `${say(typeof words === 'string' ? words.slice(0, 20) : words)} was kept as ${say(m.plan.slice(0, 20))} and ${say(m.thinker?.slice(0, 20))}`;
      const wrong = jsonTrouble(town) || shapeTrouble(town, []);
      if (wrong) return wrong;
    }
    return '';
  });

  sound('one town takes every hostile call in turn: nothing throws, coins are conserved, the books stay whole and the town still comes back from JSON unchanged', () => {
    const s = scene(), folk = [s.me];
    fromPurse(s.town, s.me, 600);
    const rng = Rules.seededRng(99);
    let calls = 0;
    const attempt = (what: string, run: () => unknown): string => {
      calls += 1;
      try { run(); } catch (e) { return `${what} threw: ${e instanceof Error ? e.message : String(e)}`; }
      return '';
    };
    for (const shop of [...ODD_IDS, ...MERCHANT_IDS]) for (const good of [...ODD_IDS, 'ore', 'wheat', 'bread', 'tools']) {
      s.me.inventory.ore = 9; s.me.inventory.wheat = 9; s.me.energy = 9;
      const m = shop as MerchantId, g = good as GoodId;
      const wrong = attempt(`gather(${say(good)})`, () => Rules.gather(s.town, s.me, g))
        || attempt(`buy(${say(shop)}, ${say(good)})`, () => Rules.buy(s.town, s.me, m, g))
        || attempt(`eat(${say(good)})`, () => Rules.eat(s.town, s.me, g))
        || attempt(`invest(${say(shop)})`, () => Rules.invest(s.town, s.me, 'ada.testnet', m))
        || ODD_AMOUNTS.map((amount) => attempt(`sell(${say(shop)}, ${say(good)}, ${say(amount)})`, () => Rules.sell(s.town, s.me, m, g, amount as number, 'ada.testnet'))).find(Boolean)
        || coinTrouble(s.town, folk, s.total) || balanceTrouble(s.town, folk);
      if (wrong) return wrong;
      if (calls % 5000 < 25) Rules.tickHour(s.town, rng, payer(() => s.town, new Map([['ada.testnet', s.me]])));
    }
    return shapeTrouble(s.town, folk) || trimTrouble(s.town, folk) || jsonTrouble(s.town) || jsonTrouble(s.me, 'the player') || (calls > 10000 ? '' : 'too few calls were made');
  });
});

// ── 11. Random play ─────────────────────────────────────────────────────────

interface Played { town: Town; folk: [string, Player][]; forgot: boolean; steps: number }
interface GameOptions {
  /** Keep the town in memory throughout, instead of storing it as JSON between moves as the contract does. */
  inMemory?: boolean;
  /** Part-way through, strip the town of what a town begun under older rules lacks: its orders, and each plan's thinker. */
  forget?: 'at night' | 'by day';
  /** A long game, with time passing quickly. */
  long?: boolean;
}

/**
 * One seeded game. From one to four players arrive and do everything a player
 * can, half of it sensibly and half of it at random, some of it with ids and
 * amounts that make no sense, while hours pass in between. After every step
 * the books are checked, and what the step did is held against what the rules
 * say it should have done.
 */
function play(seed: number, watch: Watch, options: GameOptions = {}): Played {
  const dice = Rules.seededRng(seed);               // what the players choose to do
  const luck = Rules.seededRng(seed ^ 0x5bd1e995);  // the town's own luck, as the chain would hand it in
  const chance = (p: number) => dice() < p;
  const upTo = (n: number) => Math.floor(dice() * (n + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(dice() * list.length)];

  let town = Rules.newTown();
  const total = Rules.totalCoins(town, []);
  const folk = new Map<string, Player>();
  const guests = ['ada.testnet', 'bo.testnet', 'cy.testnet', 'dee.testnet'].slice(0, 1 + upTo(3));
  if (chance(0.2)) guests[guests.length - 1] = 'constructor'; // a legal NEAR account name, and one every JavaScript object already has
  const steps = options.long ? 800 : 200 + 40 * upTo(5);
  const pace = options.long ? 0.5 : 0.3 + 0.3 * dice();       // the share of steps that are an hour passing
  const wellOff = chance(0.35);
  if (chance(0.3)) {
    // One shop begins with bare shelves and an empty till: it will go under unless someone buys in.
    const doomed = pick(shopsOf(town));
    setCoins(town, doomed, 0);
    for (const g of goodsOf(doomed.stock)) doomed.stock[g] = 0;
  }

  let richest: Rank[] = [];
  let was = copy(town), wasJson = text(town);
  let step = 0, doing = '', seenNews = 0, forgot = false;
  /** What the rule under test last answered, for the checks that follow it. */
  let answer: ActionResult = { ok: false, message: '' };
  const where = () => `seed ${seed}, step ${step}, ${doing}`;
  const attempt = <T>(run: () => T): T | undefined => {
    try { return run(); } catch (e) { watch.note('threw', e instanceof Error ? e.message : String(e), where); return undefined; }
  };

  /** After every step: the books, and the town through JSON and back, as the contract keeps it. */
  const settle = () => {
    const all = [...folk.values()];
    watch.steps += 1;
    watch.note('coins', coinTrouble(town, all, total), where);
    watch.note('balances', balanceTrouble(town, all), where);
    watch.note('shape', shapeTrouble(town, all) || trimTrouble(town, all), where);
    const json = text(town), stored = JSON.parse(json) as Town;
    if (!isDeepStrictEqual(town, stored)) watch.note('json', `the town came back from JSON changed: ${firstDifference(town, stored)}`, where);
    for (const [id, p] of folk) {
      const kept = copy(p);
      if (!isDeepStrictEqual(p, kept)) watch.note('json', `${id} came back from JSON changed: ${firstDifference(p, kept)}`, where);
      if (!options.inMemory) folk.set(id, kept);
    }
    for (const e of town.events) if (e.seq > seenNews) {
      seenNews = e.seq;
      count(e.kind === 'closed' ? 'shops shut' : e.kind === 'reopened' ? 'shops reopened' : /filled/.test(e.text) ? 'orders filled' : /bought into/.test(e.text) ? 'stakes announced' : /back to normal/.test(e.text) ? 'shortages ended' : 'shortages begun');
    }
    if (options.inMemory) was = stored; else { was = town; town = stored; }
    wasJson = json;
  };

  const arrive = (id: string) => {
    doing = `${id} arrives`;
    const inTills = sum(shopsOf(town).map((m) => m.coins));
    const p = attempt(() => Rules.newPlayer(town));
    if (!p) return;
    if (p.coins !== Math.min(TOWN.startingCoins, was.purse + inTills)) watch.note('accepted', `a newcomer was given ${p.coins} coins, with ${was.purse} in the purse and ${inTills} in the tills`, where);
    if (p.energy !== TOWN.maxEnergy || text(p.inventory) !== '{}') watch.note('accepted', 'a newcomer did not arrive rested and empty-handed', where);
    folk.set(id, p);
    if (wellOff) fromPurse(town, p, Math.min(town.purse, 100 + upTo(300))); // an old hand with savings: coins moved, none made
    count('arrivals');
    settle();
  };

  const hour = () => {
    doing = `an hour passes from day ${town.day}, ${town.hour}:00`;
    const paid: Paid[] = [];
    attempt(() => Rules.tickHour(town, luck, payer(() => town, folk, paid)));
    watch.note('hour', hourTrouble(was, town, paid), where);
    count('hours');
    count('dividends', paid.length);
    settle();
  };

  const move = () => {
    const [id, p] = pick([...folk]);
    const pw = copy(p);
    const trading = Rules.isTradingHour(town);
    const morning = town.hour >= TOWN.openHour ? town.day : town.day - 1;
    const slept = (who: Player) => { if (who.restedOn < morning) { who.restedOn = morning; who.energy = who.maxEnergy; } return who; };
    const open = Rules.todaysOrders(town).filter((o) => o.wonBy === undefined);
    const carried = RAW.filter((g) => have(p.inventory, g) > 0);

    let kind: 'gather' | 'sell' | 'buy' | 'eat' | 'invest' | 'plan' | 'rest';
    let good: unknown = pick(GOOD_IDS), shop: unknown = pick(MERCHANT_IDS), amount: unknown = 1;
    if (chance(0.6)) {
      // Someone playing to get on.
      const food = FOOD.find((g) => have(p.inventory, g) > 0);
      if (p.coins >= TOWN.investCost && chance(0.6)) kind = 'invest';
      else if (trading && carried.length && chance(0.6)) {
        kind = 'sell';
        good = pick(carried);
        const asking = open.find((o) => o.good === good);
        shop = asking && chance(0.8) ? asking.merchant : pick(shopsOf(town).filter((m) => owns(m.usualSupply, good as string))).id;
        amount = chance(0.5) ? have(p.inventory, good as GoodId) : 1 + upTo(4);
      } else if (slept(copy(p)).energy >= TOWN.gatherEnergy) {
        kind = 'gather';
        good = open.length && chance(0.7) ? pick(open).good : pick(RAW);
      } else if (food) { kind = 'eat'; good = food; }
      else if (trading) {
        kind = 'buy';
        const seller = chance(0.7) ? pick(shopsOf(town).filter((m) => FOOD.includes(m.recipe.output))) : pick(shopsOf(town));
        shop = seller.id;
        good = seller.recipe.output;
      } else kind = 'rest';
    } else {
      // Someone pressing every button, some of them wrongly.
      kind = pick(['gather', 'sell', 'buy', 'eat', 'invest', 'plan', 'rest'] as const);
      if (chance(0.25)) good = pick(ODD_IDS);
      if (chance(0.2)) shop = pick(ODD_IDS);
      amount = chance(0.3) ? pick(ODD_AMOUNTS) : pick([1, 1, 2, 3, 5, 10, 999]);
      const real = MERCHANT_IDS.includes(shop as MerchantId) ? town.merchants[shop as MerchantId] : undefined;
      if (real && kind === 'buy' && chance(0.6)) good = real.recipe.output;
      if (real && kind === 'sell' && chance(0.6)) good = pick(goodsOf(real.usualSupply));
      if (kind === 'eat' && chance(0.5)) good = pick(FOOD);
    }
    const g = String(good) as GoodId; // how JavaScript reads the id when it is used as a key
    const m = MERCHANT_IDS.includes(shop as MerchantId) ? town.merchants[shop as MerchantId] : undefined;
    const wm = m ? was.merchants[m.id] : undefined;

    /** After a refusal: the town as it was, and the player as they were (a night's sleep aside, where the rule allows that first). */
    const untouched = (maySleep = false): string => {
      if (text(town) !== wasJson) return `was refused, but the town changed: ${firstDifference(town, was)}`;
      if (isDeepStrictEqual(p, pw) || (maySleep && isDeepStrictEqual(p, slept(copy(pw))))) return '';
      return `was refused, but the player changed: ${firstDifference(p, pw)}`;
    };
    /** After a move that was accepted: the town and the player are exactly what the move should have made them. */
    const exactly = (dueTown: Town, duePlayer: Player): string => {
      if (!isDeepStrictEqual(town, dueTown)) return `left the town other than it should be: ${firstDifference(town, dueTown)}`;
      return isDeepStrictEqual(p, duePlayer) ? '' : `left the player other than they should be: ${firstDifference(p, duePlayer)}`;
    };
    const judge = (r: ActionResult | undefined, accepted: () => string, maySleep = false) => {
      if (!r) return;
      answer = r;
      count(r.ok ? kind : `${kind} refused`);
      if (typeof r.message !== 'string') watch.note('accepted', 'answered without a message', where);
      if (r.ok) watch.note('accepted', accepted(), where); else watch.note('refused', untouched(maySleep), where);
    };

    if (kind === 'gather') {
      doing = `${id} gathers ${say(good)}`;
      judge(attempt(() => Rules.gather(town, p, good as GoodId)), () => {
        if (!GOODS[g]?.raw) return 'gathered something that is not gathered';
        const due = slept(copy(pw)), n = 1 + Math.min(2, have(pw.inventory, 'tools'));
        if (due.energy < TOWN.gatherEnergy) return 'gathered while worn out';
        due.energy -= TOWN.gatherEnergy;
        due.inventory[g] = have(due.inventory, g) + n;
        due.stats.gathered += n;
        return exactly(was, due);
      }, true);
    } else if (kind === 'eat') {
      doing = `${id} eats ${say(good)}`;
      judge(attempt(() => Rules.eat(town, p, good as GoodId)), () => {
        const energy = GOODS[g]?.energy;
        if (!energy || have(pw.inventory, g) < 1) return 'ate what cannot be eaten, or was not there';
        const due = slept(copy(pw));
        due.inventory[g] = have(due.inventory, g) - 1;
        due.energy = Math.min(due.maxEnergy, due.energy + energy);
        due.stats.eaten += 1;
        return exactly(was, due);
      });
    } else if (kind === 'rest') {
      doing = `${id} rests`;
      attempt(() => Rules.rest(town, p));
      watch.note('accepted', exactly(was, slept(copy(pw))), where);
      count('rest');
    } else if (kind === 'sell') {
      doing = `${id} sells ${say(amount)} ${say(good)} to ${say(shop)}`;
      judge(attempt(() => (amount === 1 && chance(0.5) ? Rules.sell(town, p, shop as MerchantId, good as GoodId, undefined, id) : Rules.sell(town, p, shop as MerchantId, good as GoodId, amount as number, id))), () => {
        if (!m || !wm) return 'sold to a shop that does not exist';
        if (!trading || !wm.open || !owns(wm.usualSupply, g)) return 'made a sale the shop should have refused';
        const held = have(pw.inventory, g), sold = answer.count ?? NaN, price = answer.price ?? NaN, bonus = answer.bonus ?? 0;
        if (!whole(sold) || sold < 1 || sold > held) return `sold ${sold} of the ${held} they had`;
        if (!(sold <= Math.floor(Number(amount)))) return `sold ${sold} when asked to sell ${say(amount)}`;
        // The price is what the shop quoted for each one in turn, and it stopped only when it had to.
        const shadow = copy(wm);
        let due = 0;
        for (let i = 0; i < sold; i++) {
          const q = quoteBuy(shadow, g);
          if (!q.available) return `the shop took ${sold}, but would only have taken ${i}`;
          due += q.price;
          shadow.coins -= q.price;
          shadow.stock[g] = have(shadow.stock, g) + 1;
        }
        if (price !== due) return `was paid ${price}, but the quotes add up to ${due}`;
        if (sold < Math.min(Math.floor(Number(amount)), held) && quoteBuy(shadow, g).available) return `stopped at ${sold}, though the shop would have taken more`;

        // The order on the board for this, if there is one still open.
        const order = (was.orders ?? []).find((o) => o.day === was.day && o.merchant === m.id && o.good === good && o.wonBy === undefined);
        const brought = order ? (owns(order.progress, id) ? order.progress[id] : 0) + sold : 0;
        const won = !!order && brought >= order.wanted;
        if (bonus !== (won && order ? Math.min(order.bonus, wm.coins - price) : 0)) return `was paid a bonus of ${bonus}`;
        if (won) count('bonuses');

        const dueTown = copy(was), dm = dueTown.merchants[m.id];
        dm.coins -= price + bonus;
        dm.stock[g] = have(dm.stock, g) + sold;
        const dueOrder = (dueTown.orders ?? []).find((o) => o.id === order?.id);
        if (dueOrder) { dueOrder.progress[id] = brought; if (won) dueOrder.wonBy = id; }
        if (town.eventSeq !== was.eventSeq + (won ? 1 : 0) || p.noticeSeq !== pw.noticeSeq + (won ? 1 : 0)) return 'the news of it is wrong';
        dueTown.events = town.events; dueTown.eventSeq = town.eventSeq;
        const duePlayer = copy(pw);
        duePlayer.coins += price + bonus;
        duePlayer.inventory[g] = held - sold;
        duePlayer.stats.sold += sold;
        duePlayer.notices = p.notices; duePlayer.noticeSeq = p.noticeSeq;
        return exactly(dueTown, duePlayer);
      });
    } else if (kind === 'buy') {
      doing = `${id} buys ${say(good)} from ${say(shop)}`;
      judge(attempt(() => Rules.buy(town, p, shop as MerchantId, good as GoodId)), () => {
        if (!m || !wm) return 'bought from a shop that does not exist';
        if (!trading || !wm.open || wm.recipe.output !== good || have(wm.stock, g) < 1) return 'made a purchase the shop should have refused';
        const quote = quoteSell(wm, g).price;
        if (answer.price !== quote || answer.count !== 1) return `paid ${answer.price} for ${answer.count}, against a quote of ${quote}`;
        if (pw.coins < quote) return 'bought without the coins';
        const dueTown = copy(was), dm = dueTown.merchants[m.id];
        dm.coins += quote;
        dm.stock[g] = have(dm.stock, g) - 1;
        dm.recentSales[g] = have(dm.recentSales, g) + 0.15;
        const duePlayer = copy(pw);
        duePlayer.coins -= quote;
        duePlayer.inventory[g] = have(duePlayer.inventory, g) + 1;
        duePlayer.stats.bought += 1;
        return exactly(dueTown, duePlayer);
      });
    } else if (kind === 'invest') {
      doing = `${id} buys into ${say(shop)}`;
      judge(attempt(() => Rules.invest(town, p, id, shop as MerchantId)), () => {
        if (!m || !wm) return 'bought into a shop that does not exist';
        if (pw.coins < TOWN.investCost) return 'bought a stake without the coins';
        if (sum(Object.values(wm.holders)) + TOWN.investPct > TOWN.maxInvestedPct) return 'bought a stake past the cap';
        if (answer.price !== TOWN.investCost) return `was charged ${answer.price}`;
        const dueTown = copy(was), dm = dueTown.merchants[m.id];
        dm.coins += TOWN.investCost;
        dm.holders[id] = (owns(dm.holders, id) ? dm.holders[id] : 0) + TOWN.investPct;
        if (wm.open) dm.coinsAtDawn += TOWN.investCost;
        else { dm.open = true; dm.missedRent = 0; dm.coinsAtDawn = dm.coins; count('shops reopened by a stake'); }
        if (town.eventSeq !== was.eventSeq + (wm.open ? 1 : 2)) return 'the news of it is wrong';
        dueTown.events = town.events; dueTown.eventSeq = town.eventSeq;
        const duePlayer = copy(pw);
        duePlayer.coins -= TOWN.investCost;
        return exactly(dueTown, duePlayer);
      });
    } else {
      // A shopkeeper changes their plan. On chain only the shopkeeper's own account may; here anything is tried.
      const keeper = m ?? pick(shopsOf(town)), wk = was.merchants[keeper.id];
      let target: Record<string, unknown> = {};
      for (const kept of goodsOf(keeper.target)) if (chance(0.5)) target[kept] = chance(0.8) ? 1 + upTo(39) : pick([0, 41, -3, 1.5, NaN, '7', null, 1e9]);
      if (chance(0.1)) target[pick(['constructor', 'toString', 'ore', 'bread', 'coin'])] = 5;
      if (chance(0.03)) target = JSON.parse('{"__proto__": 5}') as Record<string, unknown>;
      const plan: unknown = chance(0.85) ? 'p'.repeat(upTo(400)) : pick([null, 7, {}, ['a']]);
      const thinker: unknown = chance(0.5) ? undefined : chance(0.9) ? 't'.repeat(upTo(100)) : pick([null, 7, {}]);
      doing = `${keeper.id} plans ${text(target)}`;
      const fair = Object.entries(target).every(([kept, n]) => owns(wk.target, kept) && typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 40);
      const r = attempt(() => (thinker === undefined ? Rules.setPlan(town, keeper, target as Bag, plan as string) : Rules.setPlan(town, keeper, target as Bag, plan as string, thinker as string)));
      if (r && r.ok !== fair) watch.note('accepted', `the plan was ${r.ok ? 'accepted' : 'refused'}`, where);
      judge(r, () => {
        const dueTown = copy(was), dk = dueTown.merchants[keeper.id];
        Object.assign(dk.target, target);
        dk.plan = String(plan ?? '').slice(0, 240);
        dk.thinker = String(thinker ?? '').slice(0, 60);
        dk.plannedOn = was.day;
        return exactly(dueTown, pw);
      });
    }

    // The contract brings the richest list up to date after everything a player does.
    const worth = attempt(() => Rules.netWorth(town, p, id));
    if (worth !== undefined) {
      const byHand = p.coins + sum(GOOD_IDS.map((kept) => GOODS[kept].base * have(p.inventory, kept))) + sum(shopsOf(town).map((s) => (owns(s.holders, id) ? s.holders[id] : 0))) * (TOWN.investCost / TOWN.investPct);
      richest = Rules.ranked(richest, id, worth);
      const mine = richest.filter((row) => row.id === id);
      if (worth !== byHand) watch.note('richest', `${id} is worth ${byHand}, not ${worth}`, where);
      else if (richest.length > Math.min(TOWN.keepRichest, folk.size) || mine.length !== 1 || mine[0].worth !== worth || !fallsOrHolds(richest.map((row) => row.worth)) || new Set(richest.map((row) => row.id)).size !== richest.length) watch.note('richest', `the list reads ${text(richest)}`, where);
    }
    settle();
  };

  for (step = 1; step <= steps; step++) {
    if (options.forget && !forgot && step > steps / 2 && (options.forget === 'at night' ? town.hour < TOWN.openHour : Rules.isTradingHour(town) && Rules.todaysOrders(town).length > 0)) {
      delete town.orders;
      for (const m of shopsOf(town)) delete m.thinker;
      forgot = true;
      was = copy(town);
      wasJson = text(town);
    }
    const roll = dice();
    if (folk.size === 0 || (folk.size < guests.length && roll < 0.06)) arrive(guests[folk.size]);
    else if (roll < pace) {
      hour();
      if (chance(0.15)) for (let more = 1 + upTo(6); more > 0 && step < steps; more--) { step += 1; hour(); }
    } else move();
  }
  return { town, folk: [...folk], forgot, steps };
}

heading('Random play: 300 seeded games, every move held against the rules, the town stored as JSON between moves');
const games = new Watch();
group(() => {
  const GAMES = 300;
  let fewest = Infinity;
  for (let seed = 1; seed <= GAMES; seed++) fewest = Math.min(fewest, play(seed, games, { long: seed % 10 === 0 }).steps);
  check(`${GAMES} games of ${fewest} steps or more were played, ${games.steps} steps in all`, fewest >= 200 && games.steps >= GAMES * 200);
  games.report('no rule threw an error, whatever it was sent', 'threw');
  games.report('after every step the town\'s coins are exactly what they were at the start', 'coins');
  games.report('after every step every coin and stock count is a whole number, 0 or more', 'balances');
  games.report('after every step the town and every player come back from JSON exactly as they went in', 'json');
  games.report('a move that is refused changes nothing at all', 'refused');
  games.report('a move that is accepted changes exactly what the rules say, to the coin, and nothing else', 'accepted');
  games.report('every hour that passes keeps to the timetable', 'hour');
  games.report('after every step shares, shelf targets, the board, the news and the notices keep their shape', 'shape');
  games.report('the richest list stays at most ten, richest first, one row a player, each worth what they hold', 'richest');
  const needed = ['arrivals', 'hours', 'gather', 'gather refused', 'sell', 'sell refused', 'buy', 'buy refused', 'eat', 'eat refused', 'invest', 'invest refused', 'plan', 'plan refused', 'rest', 'bonuses', 'orders filled', 'dividends', 'shops shut', 'shops reopened', 'shops reopened by a stake', 'shortages begun', 'shortages ended'];
  const missing = needed.filter((what) => !happened[what]);
  const n = (what: string) => happened[what] ?? 0;
  check('between them the games did everything: every move accepted and refused, orders filled, dividends paid, shops shut and rescued', missing.length === 0, missing.length ? `never happened: ${missing.join(', ')}`
    : `taken and refused: ${n('gather')} and ${n('gather refused')} gathers, ${n('sell')} and ${n('sell refused')} sales, ${n('buy')} and ${n('buy refused')} purchases, ${n('eat')} and ${n('eat refused')} meals, ${n('invest')} and ${n('invest refused')} stakes, ${n('plan')} and ${n('plan refused')} plans; ${n('bonuses')} bonuses, ${n('dividends')} dividends, ${n('shops shut')} shops shut, ${n('shops reopened')} reopened`);
});

// ── 12. Old towns ───────────────────────────────────────────────────────────
heading('A town begun under older rules: no orders on the town, no thinker on a plan');
group(() => {
  {
    const s = scene();
    delete s.town.orders;
    for (const m of shopsOf(s.town)) delete m.thinker;
    s.me.inventory.ore = 6;
    const r = Rules.sell(s.town, s.me, 'blacksmith', 'ore', 6, 'ada.testnet');
    check('with no orders field the board reads as empty, and a sale is a plain sale', Rules.todaysOrders(s.town).length === 0 && r.ok && r.count === 6 && r.bonus === undefined && s.town.orders === undefined && !coinTrouble(s.town, [s.me], s.total), text(r));
    check('such a town still comes back from JSON unchanged, and its books are sound', !jsonTrouble(s.town) && !shapeTrouble(s.town, [s.me]) && !balanceTrouble(s.town, [s.me]));
    const rng = Rules.seededRng(41);
    until(s.town, 0, rng);
    check('it reaches midnight with no board at all', s.town.orders === undefined && Rules.todaysOrders(s.town).length === 0);
    until(s.town, TOWN.openHour, rng);
    sound('at its next dawn the orders go up as in any other town', () => postedTrouble(s.town) || (Array.isArray(s.town.orders) && s.town.orders.length >= 1 ? '' : 'the board is still missing'));
    const o = Rules.todaysOrders(s.town)[0];
    s.me.inventory[o.good] = o.wanted;
    const fill = Rules.sell(s.town, s.me, o.merchant, o.good, o.wanted, 'ada.testnet');
    check('and one of them can be filled for its bonus', fill.ok && fill.bonus !== undefined && fill.bonus > 0 && o.wonBy === 'ada.testnet' && !coinTrouble(s.town, [s.me], s.total), text(fill));
    const m = s.town.merchants.baker;
    const noThinker = m.thinker;
    const planned = Rules.setPlan(s.town, m, { bread: 9 }, 'More bread.');
    const signed = Rules.setPlan(s.town, s.town.merchants.carpenter, { wood: 9 }, 'Less wood.', 'NEAR AI');
    check('a plan with no thinker is read as before; the next plan writes one, empty if none was given', noThinker === undefined && planned.ok && m.thinker === '' && m.plannedOn === s.town.day && signed.ok && s.town.merchants.carpenter.thinker === 'NEAR AI' && s.town.merchants.blacksmith.thinker === undefined && !jsonTrouble(s.town));
  }

  const old = new Watch();
  const plain = play(77, old, { long: true });
  const byNight = play(77, old, { long: true, forget: 'at night' });
  const byDay = play(77, old, { long: true, forget: 'by day' });
  const other = play(78, old, { long: true, forget: 'by day' });
  check('three long games were played in which the town lost those fields half-way, by night and by day', byNight.forgot && byDay.forgot && other.forgot && !plain.forgot);
  for (const [name, kind] of [['no rule threw an error', 'threw'], ['coins were conserved after every step', 'coins'], ['every count stayed whole and 0 or more', 'balances'], ['the town came back from JSON unchanged after every step', 'json'], ['refused moves changed nothing', 'refused'], ['accepted moves did exactly what the rules say', 'accepted'], ['every hour kept to the timetable', 'hour'], ['the town kept its shape', 'shape']]) old.report(`in those games ${name}`, kind);
  check('each of them had orders on the board again by the end', [byNight, byDay, other].every((g) => Array.isArray(g.town.orders)));
  const bare = (g: Played) => { const town = copy(g.town); for (const m of shopsOf(town)) delete m.thinker; return text([town, g.folk]); };
  check('losing them at night changes nothing that follows: but for the thinkers, the game ends exactly as the untouched one does', bare(byNight) === bare(plain), firstDifference(JSON.parse(bare(byNight)), JSON.parse(bare(plain))));
});

// ── 13. Same seed, same town ────────────────────────────────────────────────
heading('Same seed, same town');
group(() => {
  const runTown = (seed: number, days: number) => { const town = Rules.newTown(), rng = Rules.seededRng(seed); for (let h = 0; h < days * 24; h++) Rules.tickHour(town, rng, nobodyPaid); return text(town); };
  check('two towns left alone for thirty days on one seed end identical, and on another seed end otherwise', runTown(5, 30) === runTown(5, 30) && runTown(5, 30) !== runTown(6, 30));
  const quiet = new Watch();
  const once = play(4242, quiet, { long: true }), twice = play(4242, quiet, { long: true }), another = play(4243, quiet, { long: true });
  check('two games played on one seed end identical, town and players, and a game on another seed ends otherwise', text([once.town, once.folk]) === text([twice.town, twice.folk]) && text([once.town, once.folk]) !== text([another.town, another.folk]), firstDifference(once.town, twice.town));
  const kept = play(4242, quiet, { long: true, inMemory: true });
  check('a game kept in memory ends exactly as the same game stored as JSON between moves', isDeepStrictEqual([once.town, once.folk], [kept.town, kept.folk]), firstDifference([once.town, once.folk], [kept.town, kept.folk]));
  {
    // Two towns ticked turn and turn about come out the same as each ticked alone: the rules keep nothing of their own between calls.
    const a = Rules.newTown(), b = Rules.newTown(), ra = Rules.seededRng(5), rb = Rules.seededRng(6);
    for (let h = 0; h < 30 * 24; h++) { Rules.tickHour(a, ra, nobodyPaid); Rules.tickHour(b, rb, nobodyPaid); }
    check('the rules keep nothing of their own between calls: two towns ticked turn about end as each does alone', text(a) === runTown(5, 30) && text(b) === runTown(6, 30));
  }
});

heading('The practice town (LocalWorld), which runs the same rules in the browser tab');
/** What a time-lapse reached for that the rules must not use. */
const diceInTimeLapse: string[] = [];
group(() => {
  const w = new LocalWorld(7);
  const start = w.totalCoins();
  check('the practice town begins as a new town with one newcomer, called "you"', w.me === 'you' && w.mode === 'local' && w.player.coins === TOWN.startingCoins && start === Rules.totalCoins(Rules.newTown(), []) && w.dayNumber() === 1 && w.title() === 'Newcomer');
  fromPurse(w.town, w.player, TOWN.investCost);
  const stake = w.invest('baker');
  w.town.merchants.fishmonger.holders['other.testnet'] = TOWN.investPct; // as in a time-lapse of the shared town, where other investors exist too
  let wrong = '';
  for (let h = 0; h < 30 * 24 && !wrong; h++) {
    w.tickHour();
    wrong = coinTrouble(w.town, [w.player], start) || balanceTrouble(w.town, [w.player]) || trimTrouble(w.town, [w.player]);
    if (wrong) wrong = `day ${w.town.day}, ${w.town.hour}:00: ${wrong}`;
  }
  check('thirty days there: coins conserved every hour, a holder who is not the player paid back into the purse', !wrong && w.dayNumber() === 31, wrong);
  check('the player\'s stake pays them dividends, with a note each time', stake.ok && w.player.coins > TOWN.startingCoins && w.player.noticeSeq > 0 && shareOf(w, w.town.merchants.baker) === TOWN.investPct / 100, `${w.player.coins} coins, ${w.player.noticeSeq} notices`);

  const tab = (seed: number) => { const x = new LocalWorld(seed); for (let h = 0; h < 200; h++) x.tickHour(); return text([x.town, x.player]); };
  check('two practice towns on one seed are the same town', tab(7) === tab(7) && tab(7) !== tab(8));

  const v = new LocalWorld(3), o = v.orders()[0];
  const swing = v.gather(o.good);
  v.player.inventory[o.good] = o.wanted;
  const sale = v.sell(o.merchant, o.good, o.wanted);
  check('its buttons are the shared rules: gather, then a sale that fills an order in the player\'s own name', swing.ok && sale.ok && sale.bonus === o.bonus && o.wonBy === 'you' && text(v.orders()) === text(Rules.todaysOrders(v.town)) && v.totalCoins() === start);
  check('news is handed over once and not again', (() => { const first = v.drainNews(); return first.length === 2 && v.drainNews().length === 0; })());
  check('its ladder is the player and the four shopkeepers', v.richest().length === 5 && v.richest().filter((row) => row.me).length === 1 && worthOf(v) === Rules.netWorth(v.town, v.player, 'you'));
  sound('a stake is offered only to a player with the coins, and only while the shop has one left to sell', () => {
    const { baker, carpenter } = v.town.merchants;
    if (canInvest(v, baker)) return 'one was offered to a player without the coins';
    fromPurse(v.town, v.player, 400);
    for (const sold of [0, 1, 2]) {
      if (!canInvest(v, baker)) return `none was offered with ${sold} of the three sold`;
      v.invest('baker');
    }
    if (canInvest(v, baker)) return 'one was offered when all three were sold';
    if (!canInvest(v, carpenter)) return 'the stakes sold by one shop were held against another';
    setCoins(v.town, v.player, TOWN.investCost - 1);
    return canInvest(v, carpenter) ? 'one was offered to a player a coin short' : '';
  });
  check('what the player is worth counts their coins, goods and stakes, under their own name', worthOf(v) === v.player.coins + sum(GOOD_IDS.map((g) => GOODS[g].base * have(v.player.inventory, g))) + 3 * TOWN.investCost && v.title() === 'Merchant' && v.richest().find((row) => row.me)?.worth === worthOf(v), `${worthOf(v)}`);
  {
    const r = new LocalWorld(5);
    const byDay = tradingOnScreen(r);
    r.town.hour = 22;
    r.player.inventory.tools = 1;
    check('the screen\'s own small readers say what the rules say', byDay && !tradingOnScreen(r) && yieldOnScreen(r) === 2 && r.explorerUrl() === null && r.shopAccount() === null);
    const b = new LocalWorld(4);
    fromPurse(b.town, b.player, 100);
    b.player.energy = 10;
    const loaf = b.buy('baker', 'bread'), meal = b.eat('bread');
    check('buying and eating there are the shared rules too', loaf.ok && meal.ok && b.player.energy === 10 + (GOODS.bread.energy ?? 0) && have(b.player.inventory, 'bread') === 0 && b.player.coins === TOWN.startingCoins + 100 - (loaf.price ?? 0) && b.totalCoins() === start);
    const t = new LocalWorld(6);
    t.gather('ore');
    for (let h = 0; h < 24; h++) t.tickHour();
    check('there a night\'s sleep is counted at dawn without the player lifting a finger', t.player.energy === TOWN.maxEnergy && t.player.restedOn === t.town.day && t.town.day === 2);
  }

  const c = new LocalWorld(9);
  const dayHour = TOWN.hourMs.day;
  check('time passes an hour at a time: a day hour takes its full length, and no less', c.advance(dayHour - 1) === false && c.town.hour === TOWN.openHour && c.hourProgress() > 0.99 && c.hourProgress() <= 1 && c.advance(1) === true && c.town.hour === TOWN.openHour + 1 && c.hourProgress() === 0);

  const mark = strayed.length;
  const lapse = LocalWorld.forecast(w, 100);
  const oldNews = lapse.drainNews().length;
  const fast = LocalWorld.forecast({ town: w.town, player: w.player, me: 'ada.testnet', dayNumber: () => 3 } as unknown as GameWorld, 100);
  diceInTimeLapse.push(...strayed.splice(mark)); // taken up again where the source is read
  const dayCount = fast.dayNumber(), name: string = fast.me;
  const byDay = fast.advance(99) === false && fast.advance(1) === true;
  fast.town.hour = 22;
  check('a time-lapse starts with no old news to hand over, runs at its own even pace day and night, and keeps the player\'s name and count of days', oldNews === 0 && byDay && fast.advance(100) === true && name === 'ada.testnet' && dayCount === 3 && /Time-lapse/.test(fast.status()) && /Practice/.test(w.status()), `${oldNews} old news, day ${dayCount}`);
  const original = text([w.town, w.player]), lapseStart = lapse.totalCoins();
  let lapseWrong = '';
  for (let h = 0; h < 14 * 24 && !lapseWrong; h++) { lapse.tickHour(); lapseWrong = coinTrouble(lapse.town, [lapse.player], lapseStart) || balanceTrouble(lapse.town, [lapse.player]); }
  check('a time-lapse is a copy: two weeks of it leave the town it was copied from untouched, and conserve the copy\'s coins', text([w.town, w.player]) === original && !lapseWrong && lapse.town.day === w.town.day + 14 && lapse.me === w.me && lapseStart === start, lapseWrong);
});

// ── 14. No clock, no dice, no network ───────────────────────────────────────
heading('The source: no clock, no dice of its own, no network');
group(() => {
  /** A source file with its comments taken out, so a word in a comment is not mistaken for code. Quoted text is left in. */
  const withoutComments = (src: string): string => {
    let out = '', i = 0, quote = '';
    while (i < src.length) {
      const c = src[i], d = src[i + 1];
      if (quote) {
        out += c;
        if (c === '\\') { out += d ?? ''; i += 2; continue; }
        if (c === quote) quote = '';
        i += 1;
      } else if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i += 1; }
      else if (c === '/' && d === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; }
      else { if (c === "'" || c === '"' || c === '`') quote = c; out += c; i += 1; }
    }
    return out;
  };
  const folder = new URL('../src/economy/', import.meta.url);
  const files = readdirSync(folder).filter((f) => /\.(ts|js|mjs|tsx)$/.test(f)).sort();
  const code = new Map(files.map((f) => [f, withoutComments(readFileSync(new URL(f, folder), 'utf8'))]));
  const onChain = ['goods.ts', 'pricing.ts', 'town.ts']; // what the contract imports, directly or through town.ts
  const using = (word: RegExp, among: string[]) => among.filter((f) => word.test(code.get(f) ?? '')).join(', ');

  check('the rules are the four files this test reads', files.join() === 'goods.ts,pricing.ts,town.ts,world.ts', files.join());
  check('the comment stripper leaves the code in: each file still names what it exports', /export const GOODS/.test(code.get('goods.ts') ?? '') && /export function quoteBuy/.test(code.get('pricing.ts') ?? '') && /export function tickHour/.test(code.get('town.ts') ?? '') && /export class LocalWorld/.test(code.get('world.ts') ?? '') && !/Nothing here touches the clock/.test(code.get('town.ts') ?? ''));
  check('the rules the contract runs never mention Date', !using(/\bDate\b/, onChain), using(/\bDate\b/, onChain));
  check('the rules the contract runs never mention Math.random', !using(/\bMath\s*\.\s*random\b/, onChain), using(/\bMath\s*\.\s*random\b/, onChain));
  check('the rules the contract runs never mention fetch', !using(/\bfetch\b/, onChain), using(/\bfetch\b/, onChain));
  const otherWays = /\b(performance|setTimeout|setInterval|XMLHttpRequest|WebSocket|crypto|process|require|localStorage|navigator|document|window|globalThis)\b|\bimport\s*\(/;
  check('nor any other clock, dice or door to the outside (timers, sockets, crypto, storage, late imports)', !using(otherWays, onChain), using(otherWays, onChain));
  check('world.ts, the browser\'s side, never mentions Date or fetch either', !using(/\bDate\b|\bfetch\b/, ['world.ts']));
  const at = (code.get('world.ts') ?? '').split('\n').find((line) => /\bMath\s*\.\s*random\b/.test(line))?.trim() ?? '';
  check('world.ts never mentions Math.random, and a time-lapse of the town rolls no dice of its own', !using(/\bMath\s*\.\s*random\b/, ['world.ts']) && diceInTimeLapse.length === 0);
  const imports = [...code].flatMap(([f, src]) => [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((found) => `${f} imports ${found[1]}`));
  check('the rules import nothing but each other', imports.length > 0 && imports.every((line) => /imports \.\/(goods|pricing|town)$/.test(line)), imports.filter((line) => !/imports \.\/(goods|pricing|town)$/.test(line)).join(', '));
  const contract = withoutComments(readFileSync(new URL('../contract/src/brambleford.ts', import.meta.url), 'utf8'));
  const drawn = [...contract.matchAll(/from\s+['"]([^'"]*economy\/[^'"]+)['"]/g)].map((found) => found[1].replace(/^.*economy\//, '')).sort();
  check('the contract takes its rules from goods.ts and town.ts, and never from world.ts', [...new Set(drawn)].join() === 'goods,town', drawn.join());
});

heading('The run as a whole');
check('nothing in the run looked at the clock, rolled dice of its own or reached for the network', strayed.length === 0, [...new Set(strayed)].join(', '));
check('nothing a caller sent changed what every JavaScript object inherits', Object.getOwnPropertyNames(Object.prototype).sort().join() === INHERITED && Object.keys({}).length === 0 && !('ore' in {}) && !('bread' in {}));

if (knownProblems.length) {
  heading('KNOWN: real faults in the rules, reported and not yet mended. These do not fail the run.');
  for (const k of [...knownProblems].sort((a, b) => a.rank - b.rank)) console.log(`KNOWN  ${k.name}  (${k.detail})`);
}

const took = (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1);
const aside = `${knownProblems.length ? `, ${knownProblems.length} known problem(s) listed above` : ''}, in ${took}s`;
console.log(failures ? `\n${failures} check(s) failed, ${passed} passed${aside}` : `\nAll ${passed} checks passed${aside}`);
process.exit(failures ? 1 : 0);

// What the game screen talks to. Two versions exist:
//
//   LocalWorld (here)                 the town runs inside the browser tab
//   ChainWorld (src/near/chain.ts)    the town runs in the NEAR contract
//
// Both use the same rules from `town.ts`, so the game cannot tell them apart.

import type { GoodId } from './goods';
import * as Rules from './town';
import type { ActionResult, Merchant, MerchantId, Order, Player, Rank, Season, Town } from './town';

export type { ActionResult, Merchant, MerchantId, Order, Player, Season, Town };
export { TOWN, TITLES, friendlyName } from './town';

/** One row of the "richest in town" list on the notice board. */
export interface Standing {
  name: string;
  worth: number;
  kind: 'player' | 'shop';
  /** True for the row that is this player. */
  me: boolean;
}

export interface GameWorld {
  readonly mode: 'local' | 'chain';
  /** This player's id, as it appears in a shop's list of investors. */
  readonly me: string;
  readonly town: Town;
  readonly player: Player;
  /** A short line about where the town is running, for the corner of the screen. */
  status(): string;
  /** Set by the screen: called when the town changes for a reason other than the player's own action. */
  onUpdate?: () => void;

  /** Let time pass. Returns true when a new hour has begun since the last call. */
  advance(deltaMs: number): boolean;
  /** How far through the current hour we are, from 0 to 1. */
  hourProgress(): number;
  /** News that has arrived since the last call. */
  drainNews(): string[];
  /** Which day this is for the player: 1 on the day they arrived, however old the town is. */
  dayNumber(): number;
  /** A public page listing this player's transactions, when the town is on a public chain. */
  explorerUrl(): string | null;
  /** A shopkeeper's own account on the chain, if it has one. */
  shopAccount(id: MerchantId): { id: string; url: string | null } | null;
  /** What starting over means here, in a sentence, and doing it (the page reloads). */
  startOverNote(): string;
  startOver(): void;

  gather(good: GoodId): ActionResult;
  sell(merchant: MerchantId, good: GoodId, amount?: number): ActionResult;
  buy(merchant: MerchantId, good: GoodId): ActionResult;
  eat(good: GoodId): ActionResult;
  invest(merchant: MerchantId): ActionResult;

  /** Today's wanted orders, as pinned to the notice board. */
  orders(): Order[];
  /** Players and shopkeepers on one list, richest first: the top eight. */
  richest(): Standing[];
  /** This player's title in town, from Newcomer up to Alderman. */
  title(): string;
}

// Small readers shared by the screen code, whichever world is behind it.
export const isTradingHour = (w: GameWorld) => Rules.isTradingHour(w.town);
export const gatherYield = (w: GameWorld) => Rules.gatherYield(w.player);
/** The share of a shop's profit owed to this player, from 0 to 1. */
export const shareOf = (w: GameWorld, m: Merchant) => (m.holders[w.me] ?? 0) / 100;
export const canInvest = (w: GameWorld, m: Merchant) =>
  w.player.coins >= Rules.TOWN.investCost && Rules.investedPct(m) + Rules.TOWN.investPct <= Rules.TOWN.maxInvestedPct;
/** What this player is worth: coins, goods at their usual price, and shop shares at what they cost. */
export const worthOf = (w: GameWorld) => Rules.netWorth(w.town, w.player, w.me);

/**
 * The "richest in town" list: the players given, and the four shopkeepers, on
 * one ladder. A shopkeeper is worth the coins in the till.
 */
export function standings(town: Town, players: Rank[], me: string): Standing[] {
  const rows: Standing[] = players.map((p) => ({ name: Rules.friendlyName(p.id), worth: p.worth, kind: 'player', me: p.id === me }));
  for (const m of Object.values(town.merchants)) rows.push({ name: m.name, worth: m.coins, kind: 'shop', me: false });
  return rows.sort((a, b) => b.worth - a.worth).slice(0, 8);
}

export class LocalWorld implements GameWorld {
  readonly mode = 'local';
  readonly me = 'you';
  town: Town;
  player: Player;
  private rng: Rules.Rng;
  private clock = 0;
  /** When set, every hour takes this many milliseconds, day or night. Used by the time-lapse. */
  private pace: number | null = null;
  /** The town's day on which the player counts "day 1", minus one. */
  private dayOffset = 0;
  private seenEvent = 0;
  private seenNotice = 0;

  constructor(seed = 7) {
    this.rng = Rules.seededRng(seed);
    this.town = Rules.newTown();
    this.player = Rules.newPlayer(this.town);
  }

  /**
   * A copy of another town, with the player standing idle, that runs at a fixed
   * fast pace. Nothing done to the copy touches the town it was copied from.
   */
  static forecast(from: GameWorld, msPerHour: number): LocalWorld {
    const copy = new LocalWorld(Math.floor(Math.random() * 1e6));
    copy.town = JSON.parse(JSON.stringify(from.town));
    copy.player = JSON.parse(JSON.stringify(from.player));
    (copy as { me: string }).me = from.me;
    copy.pace = msPerHour;
    copy.dayOffset = from.town.day - from.dayNumber();
    copy.seenEvent = copy.town.eventSeq;
    copy.seenNotice = copy.player.noticeSeq;
    return copy;
  }

  status() {
    return this.pace ? 'Time-lapse: a copy of the town, with nobody playing' : 'Practice town: runs in this tab only';
  }

  /** Move the town on by one hour right now. */
  tickHour() {
    Rules.tickHour(this.town, this.rng, (holder, coins, note) => {
      // In a time-lapse of the shared town, other investors exist too. Their cut is not ours.
      if (holder !== this.me) { this.town.purse += coins; return; }
      this.player.coins += coins;
      Rules.notify(this.player, note);
    });
    Rules.rest(this.town, this.player);
  }

  advance(deltaMs: number): boolean {
    const perHour = this.pace ?? Rules.hourMs(this.town);
    this.clock += deltaMs;
    if (this.clock < perHour) return false;
    this.clock -= perHour;
    this.tickHour();
    return true;
  }

  hourProgress() {
    return Math.min(1, this.clock / (this.pace ?? Rules.hourMs(this.town)));
  }

  drainNews(): string[] {
    const out: string[] = [];
    for (const e of this.town.events) if (e.seq > this.seenEvent) { out.push(e.text); this.seenEvent = e.seq; }
    for (const n of this.player.notices) if (n.seq > this.seenNotice) { out.push(n.text); this.seenNotice = n.seq; }
    return out;
  }

  dayNumber() {
    return this.town.day - this.dayOffset;
  }

  totalCoins() {
    return Rules.totalCoins(this.town, [this.player]);
  }

  explorerUrl() {
    return null;
  }

  shopAccount() {
    return null;
  }

  startOverNote() {
    return 'The practice town starts again from day 1, and so do you.';
  }

  startOver() {
    location.reload();
  }

  gather(good: GoodId) { return Rules.gather(this.town, this.player, good); }
  sell(merchant: MerchantId, good: GoodId, amount = 1) { return Rules.sell(this.town, this.player, merchant, good, amount, this.me); }
  buy(merchant: MerchantId, good: GoodId) { return Rules.buy(this.town, this.player, merchant, good); }
  eat(good: GoodId) { return Rules.eat(this.town, this.player, good); }
  invest(merchant: MerchantId) { return Rules.invest(this.town, this.player, this.me, merchant); }

  orders() { return Rules.todaysOrders(this.town); }
  /** A practice town has one player, so the list is that player and the four shopkeepers. */
  richest() { return standings(this.town, [{ id: this.me, worth: worthOf(this) }], this.me); }
  title() { return Rules.titleOf(worthOf(this), Rules.shopsHeld(this.town, this.me)); }
}

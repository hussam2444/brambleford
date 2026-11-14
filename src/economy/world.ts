// What the game screen talks to. Two versions exist:
//
//   LocalWorld (here)                 the town runs inside the browser tab
//   ChainWorld (src/near/chain.ts)    the town runs in the NEAR contract
//
// Both use the same rules from `town.ts`, so the game cannot tell them apart.

import type { GoodId } from './goods';
import * as Rules from './town';
import type { ActionResult, Merchant, MerchantId, Player, Season, Town } from './town';

export type { ActionResult, Merchant, MerchantId, Player, Season, Town };
export { TOWN } from './town';

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
  /** What starting over means here, in a sentence, and doing it (the page reloads). */
  startOverNote(): string;
  startOver(): void;

  gather(good: GoodId): ActionResult;
  sell(merchant: MerchantId, good: GoodId, amount?: number): ActionResult;
  buy(merchant: MerchantId, good: GoodId): ActionResult;
  eat(good: GoodId): ActionResult;
  invest(merchant: MerchantId): ActionResult;
}

// Small readers shared by the screen code, whichever world is behind it.
export const isTradingHour = (w: GameWorld) => Rules.isTradingHour(w.town);
export const gatherYield = (w: GameWorld) => Rules.gatherYield(w.player);
/** The share of a shop's profit owed to this player, from 0 to 1. */
export const shareOf = (w: GameWorld, m: Merchant) => (m.holders[w.me] ?? 0) / 100;
export const canInvest = (w: GameWorld, m: Merchant) =>
  w.player.coins >= Rules.TOWN.investCost && Rules.investedPct(m) + Rules.TOWN.investPct <= Rules.TOWN.maxInvestedPct;

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

  startOverNote() {
    return 'The practice town starts again from day 1, and so do you.';
  }

  startOver() {
    location.reload();
  }

  gather(good: GoodId) { return Rules.gather(this.town, this.player, good); }
  sell(merchant: MerchantId, good: GoodId, amount = 1) { return Rules.sell(this.town, this.player, merchant, good, amount); }
  buy(merchant: MerchantId, good: GoodId) { return Rules.buy(this.town, this.player, merchant, good); }
  eat(good: GoodId) { return Rules.eat(this.town, this.player, good); }
  invest(merchant: MerchantId) { return Rules.invest(this.town, this.player, this.me, merchant); }
}

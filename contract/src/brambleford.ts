// Brambleford's town, on NEAR.
//
// One contract holds everything: every coin, every item and every share of a
// shop is a token in the NEP-245 multi-token standard, and the town's economy
// runs here hour by hour.
//
// The economic rules are NOT in this file. They are imported from
// `src/economy/town.ts` and `src/economy/pricing.ts`, the same two files the
// browser uses, so what a player sees and what the chain enforces cannot drift
// apart. This file only adds what a chain needs: who is calling, where each
// balance is stored, when the next hour is due, and the standard's own methods.
//
// Who holds what:
//   - each shopkeeper is a NEAR account; its coins and stock are its balances
//   - the townsfolk's purse is a NEAR account
//   - each player is a NEAR account with a key that can only call this contract

import { NearBindgen, near, call, view, initialize } from 'near-sdk-js';
import { GOODS, GOOD_IDS, type GoodId } from '../../src/economy/goods';
import * as Rules from '../../src/economy/town';
import type { ActionResult, MerchantId, Player, Town } from '../../src/economy/town';

const COIN = 'coin';
const SHARE = 'share:';
/** How many overdue hours one call will work through. */
const CATCH_UP = { duringAction: 8, onTick: 36 };

type Transfer = { old_owner_id: string; new_owner_id: string; token_ids: string[]; amounts: string[]; memo?: string };
type MintOrBurn = { owner_id: string; token_ids: string[]; amounts: string[]; memo?: string };

function emit(event: 'mt_mint' | 'mt_burn' | 'mt_transfer', data: (Transfer | MintOrBurn)[]) {
  if (data.length) near.log(`EVENT_JSON:${JSON.stringify({ standard: 'nep245', version: '1.0.0', event, data })}`);
}

function fail(message: string): never {
  throw new Error(message);
}

@NearBindgen({ requireInit: true })
export class Brambleford {
  owner = '';
  town = {} as Town;
  /** When the next game hour is due, in milliseconds since 1970. */
  nextTickAt = 0;
  playerCount = 0;
  /** The NEAR account that stands for the townsfolk's purse. */
  townAccount = '';
  /** The NEAR account of each shopkeeper. */
  merchantAccounts = {} as Record<MerchantId, string>;
  /** How much of each item exists. Coins are fixed for ever at `coinSupply`. */
  supply = {} as Record<string, number>;
  coinSupply = 0;
  /**
   * The ten richest players, brought up to date whenever one of them does something.
   * A town that was started before this list existed has no such field in its stored
   * state, so it is always read as `this.richest ?? []`.
   */
  richest: Rules.Rank[] | undefined = [];
  private nonce = 0;

  @initialize({})
  init({ town_account, merchant_accounts }: { town_account: string; merchant_accounts: Record<MerchantId, string> }) {
    for (const id of Rules.MERCHANT_IDS) if (!merchant_accounts?.[id]) fail(`Missing an account for the ${id}.`);
    this.owner = near.predecessorAccountId();
    this.town = Rules.newTown();
    this.townAccount = town_account;
    this.merchantAccounts = merchant_accounts;
    this.nextTickAt = this.now() + Rules.hourMs(this.town);
    this.coinSupply = Rules.totalCoins(this.town, []);
    this.supply = this.stockTotals();

    const minted: MintOrBurn[] = [{ owner_id: town_account, token_ids: [COIN], amounts: [String(this.town.purse)] }];
    for (const m of Object.values(this.town.merchants)) {
      const goods = Object.keys(m.stock).filter((g) => (m.stock[g as GoodId] ?? 0) > 0);
      minted.push({
        owner_id: merchant_accounts[m.id],
        token_ids: [COIN, ...goods],
        amounts: [String(m.coins), ...goods.map((g) => String(m.stock[g as GoodId]))],
      });
    }
    emit('mt_mint', minted);
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  private now(): number {
    return Number(near.blockTimestamp() / 1000000n);
  }

  private rng(): Rules.Rng {
    const s = near.randomSeed();
    this.nonce += 1;
    return Rules.seededRng(((s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] << 24)) ^ Math.imul(this.nonce, 2654435761)) >>> 0);
  }

  private stockTotals(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const m of Object.values(this.town.merchants)) {
      for (const [g, n] of Object.entries(m.stock)) totals[g] = (totals[g] ?? 0) + (n ?? 0);
    }
    return totals;
  }

  private loadPlayer(id: string): Player | null {
    const raw = near.storageRead(`p:${id}`);
    return raw ? (JSON.parse(raw) as Player) : null;
  }

  private savePlayer(id: string, p: Player) {
    near.storageWrite(`p:${id}`, JSON.stringify(p));
  }

  /** The caller's player record, created on their first visit. */
  private welcome(id: string): Player {
    const existing = this.loadPlayer(id);
    if (existing) return existing;
    if (id === this.townAccount || this.merchantOf(id)) fail('Shopkeepers and the town purse cannot play.');
    const p = Rules.newPlayer(this.town);
    this.playerCount += 1;
    emit('mt_transfer', [{ old_owner_id: this.townAccount, new_owner_id: id, token_ids: [COIN], amounts: [String(p.coins)], memo: 'a welcome from the town' }]);
    return p;
  }

  private merchantOf(account: string): MerchantId | null {
    for (const id of Rules.MERCHANT_IDS) if (this.merchantAccounts[id] === account) return id;
    return null;
  }

  /** Run any game hours that have come due since the last call. */
  private catchUp(maxHours: number): number {
    const now = this.now();
    if (now < this.nextTickAt) return 0;

    const before = this.stockTotals();
    const rng = this.rng();
    const dividends: Transfer[] = [];
    let hours = 0;
    while (now >= this.nextTickAt && hours < maxHours) {
      Rules.tickHour(this.town, rng, (holder, coins, note, from) => {
        const p = this.loadPlayer(holder);
        if (!p) { this.town.purse += coins; return; }
        p.coins += coins;
        Rules.notify(p, note);
        this.savePlayer(holder, p);
        this.rank(holder, p);
        dividends.push({ old_owner_id: this.merchantAccounts[from], new_owner_id: holder, token_ids: [COIN], amounts: [String(coins)], memo: 'dividend' });
      });
      this.nextTickAt += Rules.hourMs(this.town);
      hours += 1;
    }
    // If the town was left alone for a long while, it slept: carry on from now.
    if (now >= this.nextTickAt && hours >= CATCH_UP.onTick) this.nextTickAt = now + Rules.hourMs(this.town);

    const after = this.stockTotals();
    for (const g of GOOD_IDS) this.supply[g] = (this.supply[g] ?? 0) + (after[g] ?? 0) - (before[g] ?? 0);
    emit('mt_transfer', dividends);
    const income: Record<string, number> = {};
    for (const m of Object.values(this.town.merchants)) income[m.id] = m.townIncome;
    near.log(`EVENT_JSON:${JSON.stringify({ standard: 'brambleford', version: '1.0.0', event: 'hours_passed', data: [{ hours, day: this.town.day, hour: this.town.hour, purse: this.town.purse, last_hour_income: income }] })}`);
    return hours;
  }

  /** Shared opening for everything a player does. */
  private act(run: (me: string, p: Player) => ActionResult): ActionResult {
    const me = near.predecessorAccountId();
    this.catchUp(CATCH_UP.duringAction);
    const p = this.welcome(me);
    const result = run(me, p);
    this.savePlayer(me, p);
    this.rank(me, p);
    return result;
  }

  /** Put what this player is now worth into the list of the richest players. */
  private rank(id: string, p: Player) {
    this.richest = Rules.ranked(this.richest ?? [], id, Rules.netWorth(this.town, p, id));
  }

  // ── The game ──────────────────────────────────────────────────────────────

  /** Anyone may nudge the clock. Does nothing if no hour is due yet. */
  @call({})
  tick(): { hours: number; day: number; hour: number } {
    const hours = this.catchUp(CATCH_UP.onTick);
    return { hours, day: this.town.day, hour: this.town.hour };
  }

  @call({})
  join(): Player {
    this.act(() => ({ ok: true, message: 'Welcome to Brambleford.' }));
    return this.loadPlayer(near.predecessorAccountId())!;
  }

  /** Gather once, or several swings in a row (`times`), stopping when energy runs out. */
  @call({})
  gather({ good, times }: { good: GoodId; times?: number }): ActionResult {
    return this.act((me, p) => {
      const swings = Math.max(1, Math.min(20, Math.floor(times ?? 1)));
      let count = 0;
      let last: ActionResult = { ok: false, message: '' };
      for (let i = 0; i < swings; i++) {
        last = Rules.gather(this.town, p, good);
        if (!last.ok) break;
        count += last.count ?? 0;
      }
      if (!count) return last;
      this.supply[good] = (this.supply[good] ?? 0) + count;
      emit('mt_mint', [{ owner_id: me, token_ids: [good], amounts: [String(count)] }]);
      return { ok: true, count, message: `+${count} ${GOODS[good].plural}` };
    });
  }

  @call({})
  sell({ merchant, good, amount }: { merchant: MerchantId; good: GoodId; amount?: number }): ActionResult {
    return this.act((me, p) => {
      const r = Rules.sell(this.town, p, merchant, good, Math.max(1, Math.min(999, Math.floor(amount ?? 1))), me);
      if (r.ok) {
        const shop = this.merchantAccounts[merchant];
        emit('mt_transfer', [
          { old_owner_id: me, new_owner_id: shop, token_ids: [good], amounts: [String(r.count)] },
          { old_owner_id: shop, new_owner_id: me, token_ids: [COIN], amounts: [String(r.price)] },
        ]);
        // The sale filled the shopkeeper's wanted order: the bonus is the shopkeeper's coins too.
        if (r.bonus) emit('mt_transfer', [{ old_owner_id: shop, new_owner_id: me, token_ids: [COIN], amounts: [String(r.bonus)], memo: 'bonus for filling an order' }]);
      }
      return r;
    });
  }

  @call({})
  buy({ merchant, good }: { merchant: MerchantId; good: GoodId }): ActionResult {
    return this.act((me, p) => {
      const r = Rules.buy(this.town, p, merchant, good);
      if (r.ok) {
        const shop = this.merchantAccounts[merchant];
        emit('mt_transfer', [
          { old_owner_id: me, new_owner_id: shop, token_ids: [COIN], amounts: [String(r.price)] },
          { old_owner_id: shop, new_owner_id: me, token_ids: [good], amounts: ['1'] },
        ]);
      }
      return r;
    });
  }

  @call({})
  eat({ good }: { good: GoodId }): ActionResult {
    return this.act((me, p) => {
      const r = Rules.eat(this.town, p, good);
      if (r.ok) {
        this.supply[good] = Math.max(0, (this.supply[good] ?? 0) - 1);
        emit('mt_burn', [{ owner_id: me, token_ids: [good], amounts: ['1'] }]);
      }
      return r;
    });
  }

  @call({})
  invest({ merchant }: { merchant: MerchantId }): ActionResult {
    return this.act((me, p) => {
      const r = Rules.invest(this.town, p, me, merchant);
      if (r.ok) {
        emit('mt_transfer', [{ old_owner_id: me, new_owner_id: this.merchantAccounts[merchant], token_ids: [COIN], amounts: [String(r.price)], memo: 'investment' }]);
        emit('mt_mint', [{ owner_id: me, token_ids: [SHARE + merchant], amounts: [String(Rules.TOWN.investPct)] }]);
      }
      return r;
    });
  }

  /**
   * A shopkeeper changes how much they like to keep on the shelf, and says why.
   * Only that shopkeeper's own NEAR account may call this.
   * `thinker` is optional: a few words on who worked the plan out.
   */
  @call({})
  set_plan({ target, plan, thinker }: { target: Partial<Record<GoodId, number>>; plan: string; thinker?: string }): ActionResult {
    const id = this.merchantOf(near.predecessorAccountId());
    if (!id) fail('Only a shopkeeper can change their own plan.');
    this.catchUp(CATCH_UP.duringAction);
    return Rules.setPlan(this.town, this.town.merchants[id], target ?? {}, plan, thinker ?? '');
  }

  // ── Reading the town ──────────────────────────────────────────────────────

  @view({})
  get_town() {
    return {
      town: this.town,
      next_tick_at: this.nextTickAt,
      now: this.now(),
      players: this.playerCount,
      coin_supply: this.coinSupply,
      town_account: this.townAccount,
      merchant_accounts: this.merchantAccounts,
      richest: this.richest ?? [],
    };
  }

  /** The town and one player in a single read, which is what the game polls. */
  @view({})
  get_state({ account_id }: { account_id: string }) {
    return { ...this.get_town(), player: this.get_player({ account_id }) };
  }

  @view({})
  get_player({ account_id }: { account_id: string }): Player | null {
    const p = this.loadPlayer(account_id);
    if (p) Rules.rest(this.town, p);
    return p;
  }

  // ── NEP-245 multi-token standard ──────────────────────────────────────────
  // Core views and plain transfers are implemented. `mt_transfer_call` and
  // `mt_batch_transfer_call` are not.

  private balance(account: string, token: string): number {
    if (!this.tokenExists(token)) return 0;
    if (token.startsWith(SHARE)) {
      const m = this.town.merchants[token.slice(SHARE.length) as MerchantId];
      return m?.holders[account] ?? 0;
    }
    if (account === this.townAccount) return token === COIN ? this.town.purse : 0;
    const shop = this.merchantOf(account);
    if (shop) {
      const m = this.town.merchants[shop];
      return token === COIN ? m.coins : m.stock[token as GoodId] ?? 0;
    }
    const p = this.loadPlayer(account);
    if (!p) return 0;
    return token === COIN ? p.coins : p.inventory[token as GoodId] ?? 0;
  }

  private tokenExists(token: string): boolean {
    // Checked against the lists of real ids, never with `in`, so names every
    // JavaScript object has (such as "constructor") are not mistaken for tokens.
    return (
      token === COIN ||
      GOOD_IDS.includes(token as GoodId) ||
      (token.startsWith(SHARE) && Rules.MERCHANT_IDS.includes(token.slice(SHARE.length) as MerchantId))
    );
  }

  @view({})
  mt_balance_of({ account_id, token_id }: { account_id: string; token_id: string }): string {
    return String(this.balance(account_id, token_id));
  }

  @view({})
  mt_batch_balance_of({ account_id, token_ids }: { account_id: string; token_ids: string[] }): string[] {
    return token_ids.map((t) => String(this.balance(account_id, t)));
  }

  @view({})
  mt_supply({ token_id }: { token_id: string }): string | null {
    if (!this.tokenExists(token_id)) return null;
    if (token_id === COIN) return String(this.coinSupply);
    if (token_id.startsWith(SHARE)) return String(Rules.investedPct(this.town.merchants[token_id.slice(SHARE.length) as MerchantId]));
    return String(this.supply[token_id] ?? 0);
  }

  @view({})
  mt_batch_supply({ token_ids }: { token_ids: string[] }): (string | null)[] {
    return token_ids.map((t) => this.mt_supply({ token_id: t }));
  }

  @view({})
  mt_token({ token_ids }: { token_ids: string[] }): ({ token_id: string; owner_id: string | null } | null)[] {
    return token_ids.map((t) => (this.tokenExists(t) ? { token_id: t, owner_id: null } : null));
  }

  @view({})
  mt_metadata_contract(): { spec: string; name: string } {
    return { spec: 'mt-1.0.0', name: 'Brambleford' };
  }

  @view({})
  mt_tokens(): { token_id: string; name: string; kind: string }[] {
    return [
      { token_id: COIN, name: 'Coin', kind: 'currency' },
      ...GOOD_IDS.map((g) => ({ token_id: g as string, name: GOODS[g].name, kind: GOODS[g].raw ? 'raw good' : 'made good' })),
      ...Rules.MERCHANT_IDS.map((m) => ({ token_id: SHARE + m, name: `Share of ${this.town.merchants[m].name}'s shop (1 = 1% of daily profit)`, kind: 'share' })),
    ];
  }

  /** Move tokens between two players. Shops and the purse only trade through the game. */
  private move(from: string, to: string, tokens: string[], amounts: string[], memo?: string | null) {
    if (near.attachedDeposit() !== 1n) fail('Attach exactly 1 yoctoNEAR to transfer.');
    if (tokens.length !== amounts.length) fail('token_ids and amounts must be the same length.');
    if (from === to) fail('Sender and receiver are the same.');
    if (this.merchantOf(to) || to === this.townAccount) fail('Shopkeepers only trade through the game.');
    this.catchUp(CATCH_UP.duringAction);
    const sender = this.loadPlayer(from) ?? fail('Sender is not a player.');
    const receiver = this.loadPlayer(to) ?? fail('Receiver has not joined the town yet.');

    tokens.forEach((token, i) => {
      const n = Number(amounts[i]);
      if (!this.tokenExists(token)) fail(`Unknown token ${token}.`);
      if (!Number.isInteger(n) || n <= 0) fail('Amounts must be positive whole numbers.');
      if (token.startsWith(SHARE)) {
        const m = this.town.merchants[token.slice(SHARE.length) as MerchantId];
        if ((m.holders[from] ?? 0) < n) fail('Not enough of that share.');
        m.holders[from] -= n;
        if (m.holders[from] === 0) delete m.holders[from];
        m.holders[to] = (m.holders[to] ?? 0) + n;
      } else if (token === COIN) {
        if (sender.coins < n) fail('Not enough coins.');
        sender.coins -= n;
        receiver.coins += n;
      } else {
        const good = token as GoodId;
        if ((sender.inventory[good] ?? 0) < n) fail(`Not enough ${GOODS[good].plural}.`);
        sender.inventory[good] = (sender.inventory[good] ?? 0) - n;
        receiver.inventory[good] = (receiver.inventory[good] ?? 0) + n;
      }
    });
    this.savePlayer(from, sender);
    this.savePlayer(to, receiver);
    this.rank(from, sender);
    this.rank(to, receiver);
    emit('mt_transfer', [{ old_owner_id: from, new_owner_id: to, token_ids: tokens, amounts, ...(memo ? { memo } : {}) }]);
  }

  @call({ payableFunction: true })
  mt_transfer({ receiver_id, token_id, amount, memo }: { receiver_id: string; token_id: string; amount: string; approval?: unknown; memo?: string | null }) {
    this.move(near.predecessorAccountId(), receiver_id, [token_id], [amount], memo);
  }

  @call({ payableFunction: true })
  mt_batch_transfer({ receiver_id, token_ids, amounts, memo }: { receiver_id: string; token_ids: string[]; amounts: string[]; approvals?: unknown; memo?: string | null }) {
    this.move(near.predecessorAccountId(), receiver_id, token_ids, amounts, memo);
  }
}

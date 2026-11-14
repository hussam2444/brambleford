// The town on NEAR, seen from the browser.
//
// The game screen talks to this exactly as it talks to the practice town in
// `economy/world.ts`. The differences are all in here:
//
//   - the town's state is read from the contract every second or so
//   - each thing the player does is applied on screen at once (using the same
//     rules the contract runs), then signed with the browser's own key and
//     sent to the relayer, which pays the gas
//   - there is no wallet, no popup and no seed phrase: the key is made on the
//     first visit and can only call this one contract

import { Account, JsonRpcProvider, KeyPair, actions, encodeSignedDelegate, teraToGas, type KeyPairString } from 'near-api-js';
import type { GoodId } from '../economy/goods';
import * as Rules from '../economy/town';
import type { ActionResult, GameWorld, MerchantId, Player, Town } from '../economy/world';

const CONTRACT = import.meta.env.VITE_NEAR_CONTRACT_ID as string | undefined;
const RPC = (import.meta.env.VITE_NEAR_RPC_URL as string | undefined) ?? 'https://test.rpc.fastnear.com';
const NETWORK = (import.meta.env.VITE_NEAR_NETWORK as string | undefined) ?? 'testnet';
const POLL_MS = 1500;

interface Snapshot {
  town: Town;
  next_tick_at: number;
  now: number;
  player: Player | null;
}

interface Job {
  method: string;
  args: Record<string, unknown>;
}

async function post<T>(route: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ?? `The server answered ${res.status}.`);
  return json as T;
}

/** This browser's key for this town. Made on the first visit and kept in the browser. */
function browserKey(): KeyPairString {
  const slot = `brambleford:key:${CONTRACT}`;
  try {
    const saved = localStorage.getItem(slot);
    if (saved) return saved as KeyPairString;
  } catch { /* storage is unavailable: play with a key that lasts for this visit */ }
  const fresh = KeyPair.fromRandom('ed25519').toString();
  try { localStorage.setItem(slot, fresh); } catch { /* see above */ }
  return fresh;
}

/** Returns the town on NEAR, or null if this build is not pointed at one. */
export async function connectToChain(): Promise<GameWorld | null> {
  if (!CONTRACT) return null;
  const secret = browserKey();
  const publicKey = KeyPair.fromString(secret).getPublicKey().toString();
  const { accountId } = await post<{ accountId: string }>('join', { publicKey });
  const provider = new JsonRpcProvider({ url: RPC });
  const world = new ChainWorld(new Account(accountId, provider, secret), provider, CONTRACT);
  await world.begin();
  return world;
}

export class ChainWorld implements GameWorld {
  readonly mode = 'chain';
  readonly me: string;
  town!: Town;
  player!: Player;
  /** Called whenever fresh state arrives from the chain. */
  onUpdate: () => void = () => {};

  private nextTickAt = 0;
  /** Chain clock minus this computer's clock, in milliseconds. */
  private skew = 0;
  private queue: Job[] = [];
  private busy = false;
  private ticking = false;
  private lastTickTry = 0;
  /** Counts the player's own actions, so a read that started before one is not applied after it. */
  private version = 0;
  private pollIn = POLL_MS;
  private lastHour = -1;
  private lastSeen = '';
  private seenEvent = 0;
  private seenNotice = 0;
  private extraNews: string[] = [];

  constructor(private account: Account, private provider: JsonRpcProvider, private contractId: string) {
    this.me = account.accountId;
  }

  async begin() {
    let snap = await this.read();
    if (!snap.player) {
      await this.send({ method: 'join', args: {} });
      for (let i = 0; i < 8 && !snap.player; i++) snap = await this.read();
      if (!snap.player) throw new Error('Joined the town, but could not find the new player.');
    }
    this.apply(snap);
    // old news is old: only report what happens from now on
    this.seenEvent = this.town.eventSeq;
    this.seenNotice = this.player.noticeSeq;
    this.lastHour = this.town.day * 24 + this.town.hour;
  }

  status() {
    const where = NETWORK === 'sandbox' ? 'Local NEAR sandbox' : `NEAR ${NETWORK}`;
    const name = this.me.length > 30 ? `${this.me.slice(0, 9)}…${this.me.slice(-14)}` : this.me;
    return `${where} · ${name} · ${this.busy || this.queue.length ? 'saving…' : 'saved'}`;
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  private async read(): Promise<Snapshot> {
    const snap = await this.provider.callFunction<Snapshot>({ contractId: this.contractId, method: 'get_state', args: { account_id: this.me } });
    if (!snap) throw new Error('The contract returned nothing.');
    return snap;
  }

  private apply(snap: Snapshot) {
    this.town = snap.town;
    this.player = snap.player!;
    this.nextTickAt = snap.next_tick_at;
    this.skew = snap.now - Date.now();
    const seen = JSON.stringify([snap.town, snap.player]);
    if (seen !== this.lastSeen) {
      this.lastSeen = seen;
      this.onUpdate();
    }
  }

  private async refresh() {
    const version = this.version;
    try {
      const snap = await this.read();
      // If the player did something while we were reading, what we read is already out of date.
      if (version === this.version && !this.busy && !this.queue.length && snap.player) this.apply(snap);
    } catch { /* a missed read is fine: the next one is a moment away */ }
  }

  // ── Time ──────────────────────────────────────────────────────────────────

  private chainNow() {
    return Date.now() + this.skew;
  }

  advance(deltaMs: number): boolean {
    const idle = !this.busy && !this.queue.length;
    this.pollIn -= deltaMs;
    if (this.pollIn <= 0 && idle) {
      this.pollIn = POLL_MS;
      void this.refresh();
    }
    // When an hour is due, ask the relayer to nudge the town's clock.
    if (idle && !this.ticking && this.chainNow() >= this.nextTickAt && Date.now() - this.lastTickTry > 1500) {
      this.ticking = true;
      this.lastTickTry = Date.now();
      post('tick').catch(() => {}).then(() => this.refresh()).finally(() => (this.ticking = false));
    }
    const hour = this.town.day * 24 + this.town.hour;
    const changed = hour !== this.lastHour;
    this.lastHour = hour;
    return changed;
  }

  hourProgress() {
    const left = this.nextTickAt - this.chainNow();
    return Math.max(0, Math.min(1, 1 - left / Rules.hourMs(this.town)));
  }

  drainNews(): string[] {
    const out = this.extraNews.splice(0);
    for (const e of this.town.events) if (e.seq > this.seenEvent) { out.push(e.text); this.seenEvent = e.seq; }
    for (const n of this.player.notices) if (n.seq > this.seenNotice) { out.push(n.text); this.seenNotice = n.seq; }
    return out;
  }

  // ── Doing ─────────────────────────────────────────────────────────────────

  /** Sign an action with the browser's key and hand it to the relayer, which pays the gas. */
  private async send(job: Job): Promise<ActionResult | null> {
    const { signedDelegate } = await this.account.createSignedMetaTransaction({
      receiverId: this.contractId,
      actions: [actions.functionCall(job.method, job.args, teraToGas(120), 0n)],
      blockHeightTtl: 120,
    });
    const bytes = encodeSignedDelegate(signedDelegate);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const { result } = await post<{ result: ActionResult | null }>('relay', { signedDelegate: btoa(binary) });
    return result;
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      try {
        const result = await this.send(job);
        if (result && result.ok === false) this.extraNews.push(`The town saw that differently: ${result.message}`);
      } catch {
        this.queue.length = 0;
        this.extraNews.push('Lost touch with the town for a moment. Catching up.');
      }
    }
    this.busy = false;
    await this.refresh();
  }

  /** Show the result at once using the shared rules, then send the real thing. */
  private act(method: string, args: Record<string, unknown>, locally: () => ActionResult): ActionResult {
    const result = locally();
    if (!result.ok) return result;
    this.version += 1;
    const last = this.queue[this.queue.length - 1];
    if (method === 'gather' && last?.method === 'gather' && last.args.good === args.good && (last.args.times as number) < 20) {
      last.args.times = (last.args.times as number) + 1; // several swings travel as one transaction
    } else {
      this.queue.push({ method, args });
    }
    void this.pump();
    return result;
  }

  gather(good: GoodId) {
    return this.act('gather', { good, times: 1 }, () => Rules.gather(this.town, this.player, good));
  }
  sell(merchant: MerchantId, good: GoodId, amount = 1) {
    return this.act('sell', { merchant, good, amount }, () => Rules.sell(this.town, this.player, merchant, good, amount));
  }
  buy(merchant: MerchantId, good: GoodId) {
    return this.act('buy', { merchant, good }, () => Rules.buy(this.town, this.player, merchant, good));
  }
  eat(good: GoodId) {
    return this.act('eat', { good }, () => Rules.eat(this.town, this.player, good));
  }
  invest(merchant: MerchantId) {
    return this.act('invest', { merchant }, () => Rules.invest(this.town, this.player, this.me, merchant));
  }
}

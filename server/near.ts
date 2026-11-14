// The game's small back end. It does three things, all with one NEAR account
// (the "relayer"), so that players never need NEAR of their own:
//
//   join   creates a player's account, with a key that can only call the game
//   relay  pays the gas for an action the player has signed (a meta transaction)
//   tick   nudges the town's clock when an hour is due, and gives one
//          shopkeeper a chance to revise their plan (see "Shopkeepers" below)
//
// It never sees a player's private key. That stays in the player's browser.

import { createHash } from 'node:crypto';
import {
  Account, JsonRpcProvider, PublicKey, actions, decodeSignedDelegate, teraToGas,
  type KeyPairString,
} from 'near-api-js';
import { checkGoogleCredential } from './google.js';

/** What a player's key is allowed to call on the contract. */
export const PLAYER_METHODS = ['join', 'gather', 'sell', 'buy', 'eat', 'invest', 'tick'];

export interface ServerEnv {
  /** Optional. With it, shopkeepers put their plans in their own words using NEAR AI Cloud. */
  NEAR_AI_API_KEY?: string;
  NEAR_AI_MODEL?: string;
  /** Each shopkeeper's own key: NEAR_KEY_BLACKSMITH, NEAR_KEY_BAKER, and so on. */
  [key: `NEAR_KEY_${string}`]: string | undefined;
  NEAR_RPC_URL?: string;
  NEAR_CONTRACT_ID?: string;
  NEAR_RELAYER_ID?: string;
  NEAR_RELAYER_KEY?: string;
  /** Optional. With it, players may sign in with Google. The same value the browser gets as VITE_GOOGLE_CLIENT_ID. */
  GOOGLE_CLIENT_ID?: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function setup(env: ServerEnv) {
  const { NEAR_RPC_URL, NEAR_CONTRACT_ID, NEAR_RELAYER_ID, NEAR_RELAYER_KEY } = env;
  if (!NEAR_RPC_URL || !NEAR_CONTRACT_ID || !NEAR_RELAYER_ID || !NEAR_RELAYER_KEY) {
    throw new HttpError(503, 'The NEAR side of this server is not configured.');
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const relayer = new Account(NEAR_RELAYER_ID, provider, NEAR_RELAYER_KEY as KeyPairString);
  return { provider, relayer, contractId: NEAR_CONTRACT_ID, relayerId: NEAR_RELAYER_ID };
}

/** Create (or find) the NEAR account for a browser's key. The account name is derived from the key. */
export async function join(env: ServerEnv, body: { publicKey?: string; googleCredential?: string }, who = 'local') {
  // A request that carries a Google credential is a sign-in. Everything below this line is the guest's way in, unchanged.
  if (body.googleCredential != null) return joinWithGoogle(env, body, who);
  const { provider, relayer, contractId, relayerId } = setup(env);
  let key: PublicKey;
  try {
    key = PublicKey.fromString(String(body.publicKey));
  } catch {
    throw new HttpError(400, 'A valid public key is required.');
  }
  const name = createHash('sha256').update(key.toString()).digest('hex').slice(0, 16);
  const accountId = `g${name}.${relayerId}`;

  try {
    await provider.viewAccount({ accountId });
    return { accountId, created: false };
  } catch {
    // not there yet: create it below
  }
  // Only creating an account counts against the limit: returning visitors cost nothing.
  if (!allow('join', who)) throw new HttpError(429, 'Too many new players from this address. Try again later.');
  await relayer.signAndSendTransaction({
    receiverId: accountId,
    actions: [actions.createAccount(), actions.addFunctionCallAccessKey(key, contractId, PLAYER_METHODS)],
  });
  return { accountId, created: true };
}

// ── Sign in with Google ─────────────────────────────────────────────────────
//
// A guest's account is named after their browser's key, so it lasts only as
// long as that browser's storage does. A player who signs in with Google gets
// an account named after their Google identity instead, and every browser they
// sign in on has its own key added to that one account. Same account, same
// player, on any device.
//
// Adding a key to an account takes a key that is allowed to change the
// account. A browser's key is not (it may only call the game), and the player
// has no wallet. So when the relayer makes one of these accounts it also puts
// its own key on it, with full access. That key is what lets a second device
// be added later. It also means that whoever holds NEAR_RELAYER_KEY can act
// for any Google-linked player. Guest accounts carry no such key.

/** Check a Google credential from the browser, then find or make that person's account. */
async function joinWithGoogle(env: ServerEnv, body: { publicKey?: string; googleCredential?: string }, who: string) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) throw new HttpError(503, 'Signing in with Google is not set up on this server.');
  const check = await checkGoogleCredential(String(body.googleCredential), clientId);
  if (!check.ok) throw new HttpError(401, check.reason);
  return joinWithIdentity(env, String(body.publicKey), check.sub, who);
}

/**
 * How many browsers one signed-in player can use at the same time.
 *
 * NEAR lets an account that holds no NEAR keep up to 770 bytes on chain for
 * free (NEP-448), and a player's account holds none. The account itself takes
 * 100 of those bytes and the relayer's key 82. Each browser's key takes 83,
 * plus the name of the contract and the names of the methods it may call.
 * With today's names that leaves room for three browsers.
 */
export function browserLimit(contractId: string): number {
  const methodNames = PLAYER_METHODS.reduce((bytes, name) => bytes + 4 + name.length, 4);
  const perBrowser = 83 + 4 + contractId.length + methodNames;
  return Math.max(1, Math.floor((770 - 100 - 82) / perBrowser));
}

/** True if any step of a relayed change failed. The outer transaction can succeed while the change inside it does not. */
function anyStepFailed(outcome: { receipts_outcome?: { outcome: { status: unknown } }[] }): boolean {
  return (outcome.receipts_outcome ?? []).some(({ outcome: { status } }) => typeof status === 'object' && status !== null && 'Failure' in status);
}

/**
 * Find or make the account that belongs to one signed-in person, and make sure
 * this browser's key is on it. `sub` is the id the sign-in provider gives that
 * person, which never changes. This does not talk to Google, so it can be
 * tested against a chain on this machine.
 */
export async function joinWithIdentity(env: ServerEnv, publicKey: string, sub: string, who = 'local') {
  const { provider, relayer, contractId, relayerId } = setup(env);
  let key: PublicKey;
  try {
    key = PublicKey.fromString(publicKey);
  } catch {
    throw new HttpError(400, 'A valid public key is required.');
  }
  // The game only ever makes this kind of key, and the sums in `browserLimit` count on its size.
  if (!key.toString().startsWith('ed25519:')) throw new HttpError(400, 'A valid public key is required.');
  if (!sub) throw new HttpError(400, 'A signed-in identity is required.');
  // The relayer's id is part of the name, so one person is a different account in a different town.
  const name = createHash('sha256').update(`${sub}:${relayerId}`).digest('hex').slice(0, 16);
  const accountId = `u${name}.${relayerId}`;

  const exists = await provider.viewAccount({ accountId }).then(() => true, () => false);
  if (!exists) {
    // Making an account costs the relayer NEAR, so it counts against the limit, as it does for a guest.
    if (!allow('join', who)) throw new HttpError(429, 'Too many new players from this address. Try again later.');
    const relayerKey = await relayer.getSigner()!.getPublicKey();
    await relayer.signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.createAccount(), actions.addFullAccessKey(relayerKey), actions.addFunctionCallAccessKey(key, contractId, PLAYER_METHODS)],
    });
    return { accountId, created: true, google: true };
  }

  // This browser has signed in before: nothing to change, and nothing for the relayer to pay.
  const { keys } = await provider.viewAccessKeyList({ accountId });
  if (keys.some((k) => k.public_key === key.toString())) return { accountId, created: false, google: true };

  // A browser this player has not used before. Adding its key costs the relayer a transaction, so it counts too.
  if (!allow('join', who)) throw new HttpError(429, 'Too many sign-ins from this address. Try again later.');
  // When the account is full, the browser added longest ago makes way. A key's counter starts
  // from the block it was added in, so the lowest counter belongs to the oldest key. That
  // browser is not locked out: it plays as a guest until its player signs in there again.
  const browsers = keys.filter((k) => k.access_key.permission !== 'FullAccess').sort((a, b) => a.access_key.nonce - b.access_key.nonce);
  const makeWay = browsers.slice(0, Math.max(0, browsers.length + 1 - browserLimit(contractId)));
  // The account holds no NEAR, so it cannot pay to change itself. The relayer's key on the
  // account signs the change as a meta transaction, and the relayer's own account pays for it.
  const player = new Account(accountId, provider, env.NEAR_RELAYER_KEY as KeyPairString);
  const { signedDelegate } = await player.createSignedMetaTransaction({
    receiverId: accountId,
    actions: [
      ...makeWay.map((k) => actions.deleteKey(PublicKey.fromString(k.public_key))),
      actions.addFunctionCallAccessKey(key, contractId, PLAYER_METHODS),
    ],
    blockHeightTtl: 120,
  });
  const outcome = await relayer.relayMetaTransaction(signedDelegate);
  if (anyStepFailed(outcome)) throw new HttpError(500, 'Could not add this browser to your player. Try again in a moment.');
  return { accountId, created: false, google: true };
}

/** Submit an action a player signed, paying its gas. Only calls to the game, from accounts made here, are accepted. */
export async function relay(env: ServerEnv, body: { signedDelegate?: string }) {
  const { relayer, contractId, relayerId } = setup(env);
  if (String(body.signedDelegate ?? '').length > 2000) throw new HttpError(413, 'That action is too large.');
  let signed;
  try {
    signed = decodeSignedDelegate(Buffer.from(String(body.signedDelegate), 'base64'));
  } catch {
    throw new HttpError(400, 'Could not read the signed action.');
  }
  const { senderId, receiverId } = signed.delegateAction;
  if (receiverId !== contractId) throw new HttpError(403, 'This relayer only serves the Brambleford contract.');
  if (!senderId.endsWith(`.${relayerId}`)) throw new HttpError(403, 'This relayer only serves accounts it created.');
  // Pay only for one ordinary game action: no deposits, no oversized calls, no other methods.
  const inner = signed.delegateAction.actions;
  const call = inner.length === 1 ? inner[0].functionCall : undefined;
  if (!call || !PLAYER_METHODS.includes(call.methodName) || BigInt(call.deposit) !== 0n || BigInt(call.gas) > teraToGas(120) || call.args.length > 512) {
    throw new HttpError(403, 'This relayer only pays for ordinary game actions.');
  }

  const outcome = await relayer.relayMetaTransaction(signed);
  return { result: innerResult(outcome), transaction: outcome.transaction.hash };
}

/**
 * What the player's own call returned. A relayed action runs in a receipt of
 * its own, so its return value is in the receipts, not in the outer result.
 */
function innerResult(outcome: { receipts_outcome?: { outcome: { status: unknown } }[] }): unknown {
  let value: unknown = null;
  for (const receipt of outcome.receipts_outcome ?? []) {
    const status = receipt.outcome.status as { SuccessValue?: string; Failure?: unknown } | string;
    if (typeof status !== 'object' || !status) continue;
    if (status.Failure) {
      const text = JSON.stringify(status.Failure);
      const panic = /Smart contract panicked: ([^\\"]+)/.exec(text);
      throw new HttpError(422, panic ? panic[1] : 'The contract refused that action.');
    }
    if (status.SuccessValue) {
      try { value = JSON.parse(Buffer.from(status.SuccessValue, 'base64').toString()); } catch { /* not JSON: ignore */ }
    }
  }
  return value;
}

/** Run any game hours that have come due. Cheap to call early: it checks first. */
export async function tick(env: ServerEnv) {
  const { provider, relayer, contractId } = setup(env);
  const state = await provider.callFunction<{ now: number; next_tick_at: number }>({ contractId, method: 'get_town', args: {} });
  if (state && state.now + 1500 < state.next_tick_at) return { hours: 0, skipped: true };
  const result = await relayer.callFunction<{ hours: number }>({ contractId, methodName: 'tick', args: {}, gas: teraToGas(300) });
  const planned = await planOne(env).catch(() => null); // a shopkeeper's plan must never hold up the clock
  return { ...result, skipped: false, planned };
}

// ── Shopkeepers ─────────────────────────────────────────────────────────────
//
// Each shopkeeper is a NEAR account with its own key. Once a day, in the
// morning, a shopkeeper looks at its own books and may change how much it
// likes to keep on the shelf. It signs that change itself (`set_plan` on the
// contract refuses anyone else), and the relayer pays the gas.
//
// The decision is a few plain rules, below. If a NEAR AI Cloud key is set, the
// shopkeeper also puts the reason in its own words; the numbers still come
// from the rules, so a model can never set a wild target.

interface Shop {
  id: string;
  name: string;
  title: string;
  coins: number;
  open: boolean;
  plannedOn?: number;
  stock: Record<string, number>;
  target: Record<string, number>;
  recipe: { output: string };
  usualSales: Record<string, number>;
  recentSales: Record<string, number>;
  usualSupply: Record<string, number>;
}
interface TownView {
  town: { day: number; hour: number; season: { good: string; factor: number } | null; merchants: Record<string, Shop> };
}

const WORD: Record<string, string> = { ore: 'ore', wood: 'wood', wheat: 'wheat', fish: 'fish', tools: 'tools', bread: 'bread', smoked_fish: 'smoked fish', furniture: 'furniture' };
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What a shopkeeper would change today, and why. Null if they are content. */
export function decide(m: Shop, season: TownView['town']['season']): { target: Record<string, number>; plan: string } | null {
  const target: Record<string, number> = {};
  const why: string[] = [];

  const out = m.recipe.output;
  const want = m.target[out] ?? 1, have = m.stock[out] ?? 0;
  const usual = m.usualSales[out] ?? 1, recent = m.recentSales[out] ?? 0;
  if (recent > usual * 1.2 && have < want && want < 16) {
    target[out] = want + 2;
    why.push(`${sentence(WORD[out])} keeps selling out, so I am making more.`);
  } else if (recent < usual * 0.6 && have >= want && want > 2) {
    target[out] = want - 1;
    why.push('Trade has been slow, so I am keeping less on the shelf.');
  }

  for (const input of Object.keys(m.usualSupply)) {
    const cur = m.target[input] ?? 1;
    if (season?.good === input && season.factor < 1 && cur < 30) {
      target[input] = cur + 3;
      why.push(`${sentence(WORD[input])} is scarce, so I am stocking up while I can.`);
    } else if (m.coins < 100 && cur > 3) {
      target[input] = cur - 2;
      why.push(`Coin is tight, so I am buying in less ${WORD[input]}.`);
    } else if (m.coins > 300 && (m.stock[input] ?? 0) < cur * 0.5 && cur < 30) {
      target[input] = cur + 1;
      why.push(`I keep running short of ${WORD[input]}, so I am buying more.`);
    }
  }
  return why.length ? { target, plan: why.join(' ') } : null;
}

/** Ask NEAR AI Cloud to put a plan in the shopkeeper's own voice. Falls back to the plain wording on any problem. */
async function inTheirWords(env: ServerEnv, m: Shop, plain: string): Promise<string> {
  if (!env.NEAR_AI_API_KEY) return plain;
  try {
    const res = await fetch('https://cloud-api.near.ai/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(6000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.NEAR_AI_API_KEY}` },
      body: JSON.stringify({
        model: env.NEAR_AI_MODEL ?? 'deepseek-ai/DeepSeek-V3.1',
        max_tokens: 90,
        messages: [
          { role: 'system', content: `You are ${m.name}, the ${m.title.toLowerCase()} in a small, cozy market town. Say the following plan in your own voice, in one or two short plain sentences, under 200 characters. Keep every fact. No quotation marks.` },
          { role: 'user', content: `${plain} (You have ${m.coins} coins in the till.)` },
        ],
      }),
    });
    const text: unknown = (await res.json())?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim().length > 8 ? text.trim().slice(0, 240) : plain;
  } catch {
    return plain;
  }
}

/** Have a shopkeeper sign a change of plan with its own key. The relayer pays the gas. */
export async function submitPlan(env: ServerEnv, id: string, target: Record<string, number>, plan: string) {
  const { provider, relayer, contractId } = setup(env);
  const key = env[`NEAR_KEY_${id.toUpperCase()}`];
  if (!key) throw new HttpError(503, `No key for the ${id}.`);
  const shopkeeper = new Account(`${id}.${contractId}`, provider, key as KeyPairString);
  const { signedDelegate } = await shopkeeper.createSignedMetaTransaction({
    receiverId: contractId,
    actions: [actions.functionCall('set_plan', { target, plan }, teraToGas(100), 0n)],
    blockHeightTtl: 120,
  });
  const outcome = await relayer.relayMetaTransaction(signedDelegate);
  return { result: innerResult(outcome), transaction: outcome.transaction.hash };
}

/** In the morning, let one shopkeeper who has not planned today do so. One per call keeps each call short. */
async function planOne(env: ServerEnv) {
  const { provider, contractId } = setup(env);
  const view = await provider.callFunction<TownView>({ contractId, method: 'get_town', args: {} });
  if (!view || view.town.hour < 6 || view.town.hour > 10) return null;
  for (const m of Object.values(view.town.merchants)) {
    if (!m.open || (m.plannedOn ?? 0) >= view.town.day || !env[`NEAR_KEY_${m.id.toUpperCase()}`]) continue;
    const change = decide(m, view.town.season);
    if (!change) continue;
    const plan = await inTheirWords(env, m, change.plan);
    await submitPlan(env, m.id, change.target, plan);
    return { shop: m.id, plan };
  }
  return null;
}

// ── Fair use ────────────────────────────────────────────────────────────────
// A simple per-address limit so one visitor cannot spend the relayer's NEAR in
// a loop. It lives in memory, so on a host that runs several copies of this
// code it is a speed bump, not a wall.

const LIMITS: Record<string, { max: number; perMs: number }> = {
  join: { max: 20, perMs: 60 * 60 * 1000 },
  relay: { max: 90, perMs: 60 * 1000 },
  tick: { max: 90, perMs: 60 * 1000 },
};
const seen = new Map<string, { count: number; since: number }>();

function allow(route: string, who: string): boolean {
  const limit = LIMITS[route];
  if (!limit) return true;
  const now = Date.now();
  const key = `${route}:${who}`;
  const entry = seen.get(key);
  if (!entry || now - entry.since > limit.perMs) {
    if (seen.size > 5000) seen.clear();
    seen.set(key, { count: 1, since: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit.max;
}

/** One entry point for every route, used by both the dev server and the hosted functions. */
export async function handle(route: string, body: unknown, env: ServerEnv, who = 'local'): Promise<{ status: number; json: unknown }> {
  if (route !== 'join' && !allow(route, who)) return { status: 429, json: { error: 'Too many requests. Try again in a moment.' } };
  try {
    const data = (body ?? {}) as Record<string, string>;
    if (route === 'join') return { status: 200, json: await join(env, data, who) };
    if (route === 'relay') return { status: 200, json: await relay(env, data) };
    if (route === 'tick') return { status: 200, json: await tick(env) };
    return { status: 404, json: { error: 'No such route.' } };
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return { status, json: { error: err instanceof Error ? err.message : String(err) } };
  }
}

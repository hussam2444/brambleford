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
  /** Optional. With it, a model on NEAR AI Cloud decides each shopkeeper's plan, inside hard limits. Without it, fixed rules do. */
  NEAR_AI_API_KEY?: string;
  /** Optional. Which model to ask. Left empty, it is deepseek-ai/DeepSeek-V3.1. */
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

/**
 * Run any game hours that have come due. Cheap to call early: it checks first.
 * A player's tab calls this while they play. The host's timer calls it every
 * few minutes as well (the schedule is in `vercel.json`), so the town keeps
 * its hours with nobody there.
 */
export async function tick(env: ServerEnv) {
  const { provider, relayer, contractId } = setup(env);
  const state = await provider.callFunction<{ now: number; next_tick_at: number }>({ contractId, method: 'get_town', args: {} });
  if (state && state.now + 1500 < state.next_tick_at) return { hours: 0, skipped: true };
  const result = await relayer.callFunction<{ hours: number }>({ contractId, methodName: 'tick', args: {}, gas: teraToGas(300) });
  const planned = await planOne(env).catch(() => null); // a shopkeeper's plan must never hold up the clock
  return { ...result, skipped: false, planned };
}

/**
 * Whether a route answers to an HTTP method. Everything is POST. The clock may
 * also be nudged with a GET, because that is what the host's timer sends.
 */
export function methodAllowed(route: string, method?: string): boolean {
  return method === 'POST' || (method === 'GET' && route === 'tick');
}

// ── Shopkeepers ─────────────────────────────────────────────────────────────
//
// Each shopkeeper is a NEAR account with its own key. Once a day, while the
// shops are open, a shopkeeper looks at its own books and may change how much
// it likes to keep on the shelf. It signs that change itself (`set_plan` on the
// contract refuses anyone else), and the relayer pays the gas.
//
// Who decides? With a NEAR AI Cloud key set, a language model does, speaking
// as the shopkeeper. It is shown that shopkeeper's own books and nothing else,
// and its answer is never trusted: only small steps, on goods the shop already
// stocks, get through (`readReply`). When the model is slow, out of reach or
// says something unusable, the plain rules in `decide` step in. With no key,
// the rules decide every time.

export interface Shop {
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
  /** Rent and wages due each evening. */
  upkeep?: number;
}
interface TownView {
  town: { day: number; hour: number; season: { good: string; factor: number } | null; merchants: Record<string, Shop> };
}
type Season = TownView['town']['season'];

const WORD: Record<string, string> = { ore: 'ore', wood: 'wood', wheat: 'wheat', fish: 'fish', tools: 'tools', bread: 'bread', smoked_fish: 'smoked fish', furniture: 'furniture' };
/** A good's everyday name. One this file has not heard of is still named, from its id. */
const word = (good: string) => WORD[good] ?? good.replace(/_/g, ' ');
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const owns = (bag: object, key: string) => Object.prototype.hasOwnProperty.call(bag, key);

/** What a shopkeeper would change today by the house rules, and why. Null if they are content. */
export function decide(m: Shop, season: Season): { target: Record<string, number>; plan: string } | null {
  const target: Record<string, number> = {};
  const why: string[] = [];

  const out = m.recipe.output;
  const want = m.target[out] ?? 1, have = m.stock[out] ?? 0;
  const usual = m.usualSales[out] ?? 1, recent = m.recentSales[out] ?? 0;
  if (recent > usual * 1.2 && have < want && want < 16) {
    target[out] = want + 2;
    why.push(`${sentence(word(out))} keeps selling out, so I am making more.`);
  } else if (recent < usual * 0.6 && have >= want && want > 2) {
    target[out] = want - 1;
    why.push('Trade has been slow, so I am keeping less on the shelf.');
  }

  for (const input of Object.keys(m.usualSupply)) {
    const cur = m.target[input] ?? 1;
    if (season?.good === input && season.factor < 1 && cur < 30) {
      target[input] = cur + 3;
      why.push(`${sentence(word(input))} is scarce, so I am stocking up while I can.`);
    } else if (m.coins < 100 && cur > 3) {
      target[input] = cur - 2;
      why.push(`Coin is tight, so I am buying in less ${word(input)}.`);
    } else if (m.coins > 300 && (m.stock[input] ?? 0) < cur * 0.5 && cur < 30) {
      target[input] = cur + 1;
      why.push(`I keep running short of ${word(input)}, so I am buying more.`);
    }
  }
  return why.length ? { target, plan: why.join(' ') } : null;
}

// ── Asking the model ────────────────────────────────────────────────────────

const NEAR_AI_URL = 'https://cloud-api.near.ai/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3.1';
/** How long the model gets to answer. The clock waits on it, so not long. */
export const MODEL_TIMEOUT_MS = 7000;
/**
 * What a model may do to a plan, whatever it says. A shelf target moves at most
 * `step` a day and stays between `min` and `max` (the contract holds it to the
 * same range), and the reason is cut to `planChars`.
 */
export const PLAN_LIMITS = { step: 3, min: 1, max: 40, planChars: 200 };
/** Recorded with a plan that the rules in `decide` made. */
export const HOUSE_RULES = 'house rules';

export interface Change {
  /** The shelf targets that move, by good. */
  target: Record<string, number>;
  /** The reason, in the shopkeeper's words. */
  plan: string;
  /** Who decided: the model by name, or the house rules. Recorded with the plan. */
  thinker: string;
}

const modelName = (env: ServerEnv) => (env.NEAR_AI_MODEL ?? '').trim() || DEFAULT_MODEL;
/** How a plan the model made is signed off, for example "NEAR AI (deepseek-ai/DeepSeek-V3.1)". */
export const thinkerName = (env: ServerEnv) => `NEAR AI (${tidy(modelName(env), 60)})`;

/**
 * Words from outside, made safe to store and to show: one line, no control or
 * invisible characters, no angle brackets, and no longer than `max`.
 */
export function tidy(text: string, max: number): string {
  const line = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ') // control characters and every kind of line break
    .replace(/[\p{Cf}\p{Cs}<>]/gu, '') // invisible marks, broken halves of a character, angle brackets
    .replace(/\s+/g, ' ')
    .trim();
  let kept = '';
  for (const ch of line) { // one whole character at a time, so the cut never splits one
    if (kept.length + ch.length > max) break;
    kept += ch;
  }
  return kept.trim();
}

const whole = (n: unknown) => Math.round(Number(n) || 0);
const tenths = (n: unknown) => Math.round((Number(n) || 0) * 10) / 10;
const lettersOnly = (s: unknown) => String(s ?? '').replace(/[^A-Za-z]/g, '').slice(0, 20);
const isPlainId = (id: string) => /^[a-z][a-z_]{0,23}$/.test(id);

/**
 * What the model is shown: this one shopkeeper's own books, and nothing else.
 *
 * Every word in it comes from this file, and everything taken from the town is
 * a number, a good's id or a name cut down to its letters. Nothing a player
 * could have written, such as an investor's account name, is passed on, so
 * nobody can talk to the model through the town.
 */
export function booksFor(m: Shop, season: Season): { role: 'system' | 'user'; content: string }[] {
  const name = lettersOnly(m.name) || 'a shopkeeper';
  const trade = lettersOnly(m.title).toLowerCase() || 'shopkeeper';
  const goods = Object.keys(m.target).filter(isPlainId);
  const made = m.recipe.output;

  const books = [`Coins in the till: ${whole(m.coins)}`];
  if (typeof m.upkeep === 'number') books.push(`Rent due each evening: ${whole(m.upkeep)}`);
  books.push(`The shop is ${m.open ? 'open' : 'shut'}.`, 'On the shelf:');
  for (const g of goods) {
    books.push(`- ${g}: ${whole(m.stock[g])} in stock, target ${whole(m.target[g])} (${g === made ? 'you make this' : 'you buy this in'})`);
  }
  if (goods.includes(made)) {
    books.push(`Sales of ${made}: usually ${tenths(m.usualSales[made])} an hour, lately ${tenths(m.recentSales[made])} an hour.`);
  }
  if (season && goods.includes(season.good)) {
    const share = whole(Number(season.factor) * 100);
    books.push(`News: ${season.good} is ${share < 100 ? 'scarce' : 'plentiful'} in town. Gatherers are bringing in about ${share}% of the usual.`);
  }

  const brief = [
    `You are ${name}, the ${trade} of Brambleford, a small market town. Once a day you look over your own books and decide how many of each good you like to keep on the shelf. That number is your target for the good.`,
    '',
    'How targets work:',
    '- For what you make: you keep making it until the shelf holds your target, and the emptier the shelf is against the target, the more you charge.',
    "- For what you buy in: the further your stock falls below the target, the more you pay the town's gatherers. More comes in, and more coin goes out.",
    '- Rent is due every evening. Miss it two evenings running and the shop shuts.',
    '',
    'Answer with JSON only, nothing before or after it, in this shape:',
    '{"target": {"<good>": <whole number>}, "plan": "<your reason>"}',
    '- "target" lists every good on your shelf, by the exact name used in your books. To leave one as it is, repeat its target.',
    `- Each number is a whole number from ${PLAN_LIMITS.min} to ${PLAN_LIMITS.max}, and at most ${PLAN_LIMITS.step} away from the target it has now.`,
    `- "plan" is one or two short, plain sentences in your own voice, under ${PLAN_LIMITS.planChars} characters, saying what you are changing and why. No exclamation marks, no emoji, no line breaks.`,
  ];
  return [
    { role: 'system', content: brief.join('\n') },
    { role: 'user', content: `Your books today:\n${books.join('\n')}` },
  ];
}

/** Where the `{` at `start` is closed, minding braces inside quoted text. -1 if it never is. */
function closingBrace(text: string, start: number): number {
  let depth = 0, quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i += 1;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth += 1;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The first JSON object in a model's reply. Models like to wrap JSON in a code
 * fence, or to talk before and after it. None of that matters here.
 */
function firstObject(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = closingBrace(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* not JSON from this brace: try the next one */ }
  }
  return null;
}

/**
 * Turn a model's reply into a change of plan, trusting none of it.
 *
 * Only goods this shop already keeps a target for survive, and only as whole
 * numbers inside `PLAN_LIMITS`. Everything else is dropped. The reason is
 * tidied and cut to length. Null if nothing usable is left.
 *
 * `target` holds only the goods that actually move. If it comes back empty,
 * the model looked and chose to leave the shop as it is.
 */
export function readReply(reply: string, m: Shop): { target: Record<string, number>; plan: string } | null {
  const said = firstObject(reply.slice(0, 4000));
  const asked = said?.target;
  if (!said || typeof said.plan !== 'string' || !asked || typeof asked !== 'object' || Array.isArray(asked)) return null;

  const target: Record<string, number> = {};
  let usable = 0;
  for (const [good, n] of Object.entries(asked)) {
    const now = m.target[good];
    if (!owns(m.target, good) || typeof now !== 'number') continue; // not something this shop stocks
    if (typeof n !== 'number' || !Number.isInteger(n)) continue; // "12", 7.5, null
    if (n < PLAN_LIMITS.min || n > PLAN_LIMITS.max || Math.abs(n - now) > PLAN_LIMITS.step) continue; // too far
    usable += 1;
    if (n !== now) target[good] = n;
  }
  const plan = tidy(said.plan, PLAN_LIMITS.planChars);
  if (!usable || plan.length < 8) return null;
  return { target, plan };
}

/** Ask the model what this shopkeeper should do. Null on any problem at all: no answer, a slow answer, a bad answer. */
async function askModel(env: ServerEnv, m: Shop, season: Season, timeoutMs: number) {
  try {
    const res = await fetch(NEAR_AI_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.NEAR_AI_API_KEY}` },
      body: JSON.stringify({ model: modelName(env), messages: booksFor(m, season), max_tokens: 300, temperature: 0.6 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text: unknown = (await res.json())?.choices?.[0]?.message?.content;
    const decision = typeof text === 'string' ? readReply(text, m) : null;
    if (!decision) throw new Error('an answer that could not be used');
    return decision;
  } catch (err) {
    // Say why in the server's log, so a wrong key or model name is easy to spot. The key itself is never logged.
    const why = err instanceof Error ? (err.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : tidy(err.message, 80)) : 'an unknown problem';
    console.warn(`NEAR AI did not decide for the ${tidy(m.id, 24)}: ${why}. The house rules stand in.`);
    return null;
  }
}

/**
 * What a shopkeeper changes today, why, and who decided. Null if nothing changes.
 * With a NEAR AI key the model decides. If it cannot, the rules do.
 */
export async function think(env: ServerEnv, m: Shop, season: Season, timeoutMs = MODEL_TIMEOUT_MS): Promise<Change | null> {
  if (env.NEAR_AI_API_KEY) {
    const theirs = await askModel(env, m, season, timeoutMs);
    // A usable answer that moves nothing is a decision too: the shop stays as it is.
    if (theirs) return Object.keys(theirs.target).length ? { ...theirs, thinker: thinkerName(env) } : null;
  }
  const ours = decide(m, season);
  return ours && { ...ours, thinker: HOUSE_RULES };
}

/**
 * Have a shopkeeper sign a change of plan with its own key. The relayer pays the gas.
 * `thinker` says who decided, and is recorded with the plan.
 */
export async function submitPlan(env: ServerEnv, id: string, target: Record<string, number>, plan: string, thinker = HOUSE_RULES) {
  const { provider, relayer, contractId } = setup(env);
  const key = env[`NEAR_KEY_${id.toUpperCase()}`];
  if (!key) throw new HttpError(503, `No key for the ${id}.`);
  const shopkeeper = new Account(`${id}.${contractId}`, provider, key as KeyPairString);
  const { signedDelegate } = await shopkeeper.createSignedMetaTransaction({
    receiverId: contractId,
    actions: [actions.functionCall('set_plan', { target, plan, thinker }, teraToGas(100), 0n)],
    blockHeightTtl: 120,
  });
  const outcome = await relayer.relayMetaTransaction(signedDelegate);
  return { result: innerResult(outcome), transaction: outcome.transaction.hash };
}

/**
 * The game day on which the model was last asked about each shopkeeper. An
 * answer of "no change" leaves no mark on the chain, so without this the same
 * shopkeeper would be asked again every hour. Kept in memory only: after a
 * restart, a shopkeeper who was content may be asked once more.
 */
const askedOn = new Map<string, number>();

/** The shopkeepers, with a different one first each day, so that at one plan per call nobody is always last. */
function inTurn<T>(shops: T[], day: number): T[] {
  const first = shops.length ? Math.abs(Math.floor(day) || 0) % shops.length : 0;
  return [...shops.slice(first), ...shops.slice(0, first)];
}

/**
 * While the shops are open (6 to 19), let one shopkeeper who has not planned
 * today do so. One per call keeps each call short: the model may take a few
 * seconds, and whoever nudged the clock is waiting.
 */
async function planOne(env: ServerEnv) {
  const { provider, contractId } = setup(env);
  const view = await provider.callFunction<TownView>({ contractId, method: 'get_town', args: {} });
  if (!view || view.town.hour < 6 || view.town.hour > 19) return null;
  const { day, season } = view.town;
  const byModel = !!env.NEAR_AI_API_KEY;
  for (const m of inTurn(Object.values(view.town.merchants), day)) {
    if (!m.open || (m.plannedOn ?? 0) >= day || !env[`NEAR_KEY_${m.id.toUpperCase()}`]) continue;
    if (byModel && askedOn.get(m.id) === day) continue;
    if (byModel) askedOn.set(m.id, day);
    const change = await think(env, m, season);
    if (change) {
      const sent = await submitPlan(env, m.id, change.target, change.plan, change.thinker);
      const refused = (sent.result as { ok?: boolean } | null)?.ok === false;
      return refused ? null : { shop: m.id, plan: change.plan, thinker: change.thinker, transaction: sent.transaction };
    }
    if (byModel) return null; // the model has had its one question for this call
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

export function allow(route: string, who: string): boolean {
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

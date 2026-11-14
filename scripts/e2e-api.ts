// Checks the back end against a running sandbox and dev server:
// join -> sign an action in "the browser" -> relay -> read it back from the chain.
//   npm run sandbox   and   npm run dev   must both be running.
//   Against testnet:  ENV_FILE=.env.testnet npm run test:api -- http://localhost:5184   (with `npm run dev:testnet -- --port 5184` running)
import { Account, JsonRpcProvider, KeyPair, actions, encodeSignedDelegate, teraToGas } from 'near-api-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(process.env.ENV_FILE ?? '.env.local', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const base = process.argv[2] ?? 'http://localhost:5183';
const post = async (route: string, body: unknown = {}) => {
  const res = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

const key = KeyPair.fromRandom('ed25519');
const joined = await post('join', { publicKey: key.getPublicKey().toString() });
console.log('join  ', joined.status, JSON.stringify(joined.json));
const provider = new JsonRpcProvider({ url: env.NEAR_RPC_URL });
const me = new Account(joined.json.accountId, provider, key.toString());

async function act(method: string, args: Record<string, unknown>) {
  const { signedDelegate } = await me.createSignedMetaTransaction({ receiverId: env.NEAR_CONTRACT_ID, actions: [actions.functionCall(method, args, teraToGas(120), 0n)], blockHeightTtl: 120 });
  const t = Date.now();
  const out = await post('relay', { signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64') });
  console.log(method.padEnd(6), out.status, JSON.stringify(out.json).slice(0, 200), `${Date.now() - t} ms`);
}
await act('join', {});
await act('gather', { good: 'ore', times: 4 });
await act('sell', { merchant: 'blacksmith', good: 'ore', amount: 99 });
const state = await provider.callFunction<any>({ contractId: env.NEAR_CONTRACT_ID, method: 'get_state', args: { account_id: me.accountId } });
console.log('player', JSON.stringify({ coins: state.player.coins, inventory: state.player.inventory, energy: state.player.energy }));
console.log('town  ', `day ${state.town.day} ${state.town.hour}:00, next hour in ${state.next_tick_at - state.now} ms`);
const bal = await provider.viewAccount({ accountId: me.accountId });
console.log('player account holds', bal.amount.toString(), 'yoctoNEAR (the relayer paid for everything)');
console.log('tick  ', JSON.stringify((await post('tick')).json));
// the relayer must refuse to pay for anything that is not an ordinary game action
const { signedDelegate: sneaky } = await me.createSignedMetaTransaction({ receiverId: env.NEAR_CONTRACT_ID, actions: [actions.functionCall('set_plan', { target: {}, plan: 'x' }, teraToGas(120), 0n)], blockHeightTtl: 120 });
const refused = await post('relay', { signedDelegate: Buffer.from(encodeSignedDelegate(sneaky)).toString('base64') });
console.log('other method', refused.status, JSON.stringify(refused.json));

// a shopkeeper signs a change of plan with its own key (sandbox only: this writes a made-up plan)
if (env.VITE_NEAR_NETWORK !== 'sandbox') process.exit(0);
const { decide, submitPlan } = await import('../server/near');
const baker = { ...state.town.merchants.baker, coins: 60 };
const change = decide(baker, null);
console.log('decide', JSON.stringify(change));
const planned = await submitPlan(env, 'baker', change!.target, change!.plan);
console.log('plan  ', JSON.stringify(planned).slice(0, 160));
const after = await provider.callFunction<any>({ contractId: env.NEAR_CONTRACT_ID, method: 'get_town', args: {} });
console.log('baker now', JSON.stringify({ target: after.town.merchants.baker.target, plan: after.town.merchants.baker.plan, plannedOn: after.town.merchants.baker.plannedOn }));

const bad = await post('relay', { signedDelegate: 'nonsense' });
console.log('bad relay', bad.status, JSON.stringify(bad.json));

// ── Sign in with Google (sandbox only, like the plan above) ─────────────────
// Google is not asked anything here. `joinWithIdentity` is the part that runs
// once Google has said who the person is: it finds or makes that person's
// account and puts a browser's key on it. Below, two browsers sign in as the
// same person, and the second must be able to play as the very same account.
// The braces keep these names to this part of the file.
{
  const { joinWithIdentity, browserLimit } = await import('../server/near');
  let wrong = 0;
  function check(name: string, ok: boolean, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) wrong += 1;
  }
  const person = `e2e-${Date.now()}`; // stands in for the id Google gives a person
  const laptop = KeyPair.fromRandom('ed25519');
  const phone = KeyPair.fromRandom('ed25519');
  const signIn = (browser: KeyPair) => joinWithIdentity(env, browser.getPublicKey().toString(), person);
  const keysOn = async (accountId: string) => (await provider.viewAccessKeyList({ accountId })).keys.map((k) => k.public_key);

  const first = await signIn(laptop);
  console.log('google first browser ', JSON.stringify(first));
  const second = await signIn(phone);
  console.log('google second browser', JSON.stringify(second));
  const player = first.accountId;
  check('the first sign-in makes an account named after the person, not the key', first.created && first.google && /^u[0-9a-f]{16}$/.test(player.slice(0, 17)) && player.slice(17) === `.${env.NEAR_RELAYER_ID}`, player);
  check('a second browser gets the same account, and no new one is made', !second.created && second.accountId === player);

  /** Sign one action with a browser's key and send it through the relay, as the game does. */
  async function actAs(browser: KeyPair, method: string, args: Record<string, unknown>) {
    try {
      const account = new Account(player, provider, browser.toString());
      const { signedDelegate } = await account.createSignedMetaTransaction({ receiverId: env.NEAR_CONTRACT_ID, actions: [actions.functionCall(method, args, teraToGas(120), 0n)], blockHeightTtl: 120 });
      const out = await post('relay', { signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64') });
      console.log(`google ${method.padEnd(6)}`, out.status, JSON.stringify(out.json).slice(0, 160));
      return { ok: out.status === 200 && out.json.result?.ok !== false, count: Number(out.json.result?.count ?? 0) };
    } catch (err) {
      console.log(`google ${method.padEnd(6)} could not be signed:`, String(err instanceof Error ? err.message : err).slice(0, 120));
      return { ok: false, count: 0 }; // a key that is not on the account cannot even sign
    }
  }
  const arrived = await actAs(phone, 'join', {});
  const onPhone = await actAs(phone, 'gather', { good: 'wood', times: 3 });
  check("the second browser's key can join the town and gather, through the relay", arrived.ok && onPhone.ok && onPhone.count > 0);
  const onLaptop = await actAs(laptop, 'gather', { good: 'wood', times: 2 });
  const shared = await provider.callFunction<any>({ contractId: env.NEAR_CONTRACT_ID, method: 'get_player', args: { account_id: player } });
  check('both browsers play the one player', onLaptop.ok && shared?.inventory.wood === onPhone.count + onLaptop.count, `${shared?.inventory.wood} wood, gathered ${onPhone.count} on one and ${onLaptop.count} on the other`);

  const before = await keysOn(player);
  const again = await signIn(phone);
  check('signing in again on a browser that is already known changes nothing', !again.created && again.accountId === player && (await keysOn(player)).join() === before.join());

  // Only so many browsers fit on an account that holds no NEAR. One more than that, and the oldest makes way.
  const limit = browserLimit(env.NEAR_CONTRACT_ID);
  const others = Array.from({ length: limit - 1 }, () => KeyPair.fromRandom('ed25519'));
  for (const browser of others) await signIn(browser);
  const now = await keysOn(player);
  const has = (browser: KeyPair) => now.includes(browser.getPublicKey().toString());
  check(`one browser more than the ${limit} that fit, and the oldest makes way`, !has(laptop) && has(phone) && others.every(has) && now.length === limit + 1, `${now.length} keys: the relayer's and ${limit} browsers`);
  const newest = await actAs(others[others.length - 1], 'gather', { good: 'wood', times: 1 });
  const oldest = await actAs(laptop, 'gather', { good: 'wood', times: 1 });
  check('the newest browser can play and the one that made way cannot', newest.ok && !oldest.ok);
  const funds = await provider.viewAccount({ accountId: player });
  check('the signed-in account still holds no NEAR', funds.amount === 0n, `${funds.amount} yoctoNEAR, ${funds.storage_usage} bytes of the 770 that are free`);

  // A sign-in with nothing in it is turned away at the door, over HTTP: 503 while the server has no Google
  // client id, 401 when it has one. An empty credential is refused before Google is ever asked.
  const empty = await post('join', { publicKey: phone.getPublicKey().toString(), googleCredential: '' });
  console.log('google empty credential', empty.status, JSON.stringify(empty.json));
  check('a sign-in with no credential in it gets no account', (empty.status === 503 || empty.status === 401) && !empty.json.accountId);

  console.log(wrong ? `\n${wrong} sign-in check(s) failed` : '\nAll sign-in checks passed');
  if (wrong) process.exitCode = 1;
}

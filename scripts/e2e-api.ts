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

// A guest with no screen, who runs one errand through the game's public API
// exactly as a browser does: join, read the notice board, gather what a
// shopkeeper has asked for, sell it, and collect the bonus.
//
//   npm run play:order                                      the local sandbox (`npm run sandbox` and `npm run dev` running)
//   npm run play:order -- https://brambleford.vercel.app    the hosted game on testnet
//
// It needs no keys and no NEAR. It makes a guest key as a browser would, signs
// each action itself, and the game's relayer pays the gas.

import { Account, JsonRpcProvider, KeyPair, actions, encodeSignedDelegate, teraToGas } from 'near-api-js';
import { existsSync, readFileSync } from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:5183').replace(/\/$/, '');
const local = /\/\/(localhost|127\.0\.0\.1)/.test(base);
const env: Record<string, string> = local && existsSync('.env.local')
  ? Object.fromEntries(readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  : {};
const rpc = env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com';
const contractId = env.NEAR_CONTRACT_ID ?? 'brambleford.testnet';

interface Order { day: number; merchant: string; good: string; wanted: number; bonus: number; progress: Record<string, number>; wonBy?: string }
interface State {
  town: { day: number; hour: number; orders?: Order[]; merchants: Record<string, { name: string }> };
  player: { coins: number; energy: number; inventory: Record<string, number> } | null;
}
interface Sent { status: number; json: { result?: { ok?: boolean; message?: string; bonus?: number; price?: number; count?: number } | null; transaction?: string; error?: string } }

const post = async (route: string, body: unknown = {}) => {
  const res = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

const key = KeyPair.fromRandom('ed25519');
const joined = await post('join', { publicKey: key.getPublicKey().toString() });
if (joined.status !== 200) throw new Error(`Could not join: ${JSON.stringify(joined.json)}`);
const provider = new JsonRpcProvider({ url: rpc });
const me = new Account(joined.json.accountId, provider, key.toString());
console.log(`A new guest: ${me.accountId}`);

/** Sign one action with the guest's own key and hand it to the relayer, which pays for it. */
async function act(method: string, args: Record<string, unknown>): Promise<Sent> {
  const { signedDelegate } = await me.createSignedMetaTransaction({ receiverId: contractId, actions: [actions.functionCall(method, args, teraToGas(120), 0n)], blockHeightTtl: 120 });
  const sent: Sent = await post('relay', { signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64') });
  console.log(`  ${method} ${JSON.stringify(args)} -> ${sent.json.result?.message ?? sent.json.error ?? sent.status}`);
  return sent;
}
const look = () => provider.callFunction<State>({ contractId, method: 'get_state', args: { account_id: me.accountId } }) as Promise<State>;

await act('join', {});
let won: { order: Order; sent: Sent } | null = null;
for (let turn = 0; turn < 80 && !won; turn++) {
  const { town, player } = await look();
  if (!player) { await wait(1500); continue; }
  const open = town.hour >= 6 && town.hour < 20;
  const order = (town.orders ?? []).find((o) => o.day === town.day && o.wonBy === undefined);
  if (!open || !order) {
    console.log(`Day ${town.day}, ${town.hour}:00. ${open ? 'Nothing is wanted that is still open' : 'The shops are shut'}. Waiting for the town's clock.`);
    await post('tick');
    await wait(4000);
    continue;
  }
  const brought = order.progress[me.accountId] ?? 0;
  const short = order.wanted - brought - (player.inventory[order.good] ?? 0);
  if (short > 0) {
    if (player.energy < 2) { console.log('  Out of energy. Waiting for morning.'); await post('tick'); await wait(4000); continue; }
    console.log(`Day ${town.day}, ${town.hour}:00. ${town.merchants[order.merchant].name} wants ${order.wanted} ${order.good} and will pay a ${order.bonus}-coin bonus.`);
    await act('gather', { good: order.good, times: Math.min(20, short) });
    continue;
  }
  const sent = await act('sell', { merchant: order.merchant, good: order.good, amount: order.wanted - brought });
  if (sent.json.result?.bonus) won = { order, sent };
  else await wait(2000);
}

if (!won) {
  console.log('\nNo order could be filled this time. The town may be short of coin, or another player was quicker.');
  process.exit(1);
}
const after = await look();
const account = await provider.viewAccount({ accountId: me.accountId });
console.log(`\nFilled the order: sold for ${won.sent.json.result?.price} coins and was paid a ${won.sent.json.result?.bonus}-coin bonus from the shopkeeper's own purse.`);
console.log(`The guest now has ${after.player?.coins} coins, and their NEAR account holds ${account.amount} yoctoNEAR (the relayer paid for everything).`);
console.log(`The sale: ${local ? won.sent.json.transaction : `https://testnet.nearblocks.io/txns/${won.sent.json.transaction}`}`);

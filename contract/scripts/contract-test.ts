// End-to-end test of the built contract on a local NEAR sandbox.
//
//   npm run setup:contract   (once)
//   npm run build:contract && npm run test:contract
//
// Deploys the contract, creates the shopkeepers' accounts and two players, then
// plays a short game and checks the things that must always hold: coins are
// conserved, only a shopkeeper can change their own plan, and transfers follow
// the multi-token standard.

import { Worker, type NearAccount } from 'near-workspaces';

const TGAS = 1_000_000_000_000n;
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const town = await root.createSubAccount('brambleford');
  await town.deploy('build/brambleford.wasm');

  const ids = ['blacksmith', 'baker', 'fishmonger', 'carpenter'] as const;
  const shop: Record<string, NearAccount> = {};
  const oneNear = { initialBalance: 10n ** 24n };
  for (const id of ids) shop[id] = await town.createSubAccount(id, oneNear);
  const purse = await town.createSubAccount('townsfolk', oneNear);
  const merchant_accounts = Object.fromEntries(ids.map((id) => [id, shop[id].accountId]));
  await town.call(town, 'init', { town_account: purse.accountId, merchant_accounts });

  const alice = await root.createSubAccount('alice');
  const bob = await root.createSubAccount('bob');

  /** Call a method and report its result and the gas it burnt. */
  async function play(who: NearAccount, method: string, args: Record<string, unknown> = {}, deposit = '0') {
    const out = await who.callRaw(town, method, args, { gas: 300n * TGAS, attachedDeposit: BigInt(deposit) });
    const gas = Number(BigInt(out.gas_burnt.toString()) / (TGAS / 10n)) / 10;
    let value: any = null;
    try { value = out.parseResult(); } catch { /* no return value */ }
    return { ok: out.succeeded, value, gas, error: out.succeeded ? '' : JSON.stringify(out.receiptFailureMessages).slice(0, 160) };
  }
  const view = (method: string, args: Record<string, unknown> = {}) => town.view<any>(method, args);
  async function coinsEverywhere(players: NearAccount[]) {
    const t = await view('get_town');
    let sum = t.town.purse;
    for (const m of Object.values<any>(t.town.merchants)) sum += m.coins;
    for (const p of players) sum += (await view('get_player', { account_id: p.accountId }))?.coins ?? 0;
    return { sum, supply: t.coin_supply };
  }

  const start = await view('get_town');
  check('town starts with its coins counted', start.coin_supply === 2200 && start.town.purse === 1200, `supply ${start.coin_supply}`);

  let r = await play(alice, 'join');
  check('a newcomer gets 20 coins from the purse', r.ok && r.value.coins === 20, `gas ${r.gas} TGas`);
  check('standard balance view agrees', (await view('mt_balance_of', { account_id: alice.accountId, token_id: 'coin' })) === '20');
  check('the purse paid for it', (await view('mt_balance_of', { account_id: purse.accountId, token_id: 'coin' })) === '1180');

  const oreBefore = Number(await view('mt_supply', { token_id: 'ore' }));
  for (let i = 0; i < 3; i++) r = await play(alice, 'gather', { good: 'ore' });
  const me = await view('get_player', { account_id: alice.accountId });
  check('gathering mints ore to the player', me.inventory.ore === 3 && me.energy === 34, `gas ${r.gas} TGas`);
  check('ore supply grew by what was gathered', Number(await view('mt_supply', { token_id: 'ore' })) - oreBefore >= 3);

  const priceBefore = (await view('get_town')).town.merchants.blacksmith.stock.ore;
  r = await play(alice, 'sell', { merchant: 'blacksmith', good: 'ore', amount: 99 });
  check('selling pays coins and moves the ore', r.ok && r.value.ok && r.value.count === 3, `sold for ${r.value?.price}, gas ${r.gas} TGas`);
  check("the blacksmith's stock went up", (await view('get_town')).town.merchants.blacksmith.stock.ore >= priceBefore + 3);

  r = await play(alice, 'sell', { merchant: 'baker', good: 'ore' });
  check('a shop refuses what it does not use', r.ok && r.value.ok === false, r.value?.message);

  r = await play(alice, 'buy', { merchant: 'baker', good: 'bread' });
  check('buying bread works', r.ok && r.value.ok, `paid ${r.value?.price}`);
  r = await play(alice, 'eat', { good: 'bread' });
  check('eating burns the bread', r.ok && r.value.ok && (await view('mt_balance_of', { account_id: alice.accountId, token_id: 'bread' })) === '0');

  let c = await coinsEverywhere([alice]);
  check('coins are conserved after trading', c.sum === c.supply, `${c.sum} of ${c.supply}`);

  r = await play(alice, 'set_plan', { target: { bread: 12 }, plan: 'I am not the baker' });
  check('a player cannot change a shop plan', !r.ok);
  r = await play(shop.baker, 'set_plan', { target: { bread: 12 }, plan: 'Bread keeps selling out, so I am baking more.' });
  const baker = (await view('get_town')).town.merchants.baker;
  check('the baker can change his own plan', r.ok && r.value.ok && baker.target.bread === 12 && baker.plan.startsWith('Bread'), `gas ${r.gas} TGas`);

  await play(bob, 'join');
  r = await play(alice, 'mt_transfer', { receiver_id: bob.accountId, token_id: 'coin', amount: '5' });
  check('a transfer without 1 yoctoNEAR is refused', !r.ok);
  r = await play(alice, 'mt_transfer', { receiver_id: bob.accountId, token_id: 'coin', amount: '5' }, '1');
  check('a standard transfer moves coins between players', r.ok && (await view('mt_balance_of', { account_id: bob.accountId, token_id: 'coin' })) === '25', r.error);
  r = await play(alice, 'mt_transfer', { receiver_id: bob.accountId, token_id: 'constructor', amount: '5' }, '1');
  check('a made-up token id is refused', !r.ok && (await view('mt_balance_of', { account_id: bob.accountId, token_id: 'constructor' })) === '0' && (await view('mt_supply', { token_id: 'constructor' })) === null);
  r = await play(alice, 'sell', { merchant: '__proto__', good: 'ore' });
  check('a made-up shop id is refused without breaking anything', r.ok ? r.value.ok === false : true, r.value?.message ?? 'refused');
  r = await play(alice, 'mt_transfer', { receiver_id: shop.baker.accountId, token_id: 'coin', amount: '1' }, '1');
  check('players cannot push coins into a shop', !r.ok);

  // let time pass and run the town's hours
  const before = await view('get_town');
  await worker.provider.fastForward(400);
  r = await play(bob, 'tick');
  const after = await view('get_town');
  check('hours pass when the clock is nudged', r.ok && r.value.hours > 0, `${r.value?.hours} hours, now day ${after.town.day} ${after.town.hour}:00, gas ${r.gas} TGas`);
  check('the town traded on its own', after.town.purse !== before.town.purse);
  c = await coinsEverywhere([alice, bob]);
  check('coins are still conserved after the town ran', c.sum === c.supply, `${c.sum} of ${c.supply}`);
  r = await play(bob, 'tick');
  check('a second nudge straight away does nothing', r.ok && r.value.hours <= 1, `gas ${r.gas} TGas`);
} finally {
  await worker.tearDown();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

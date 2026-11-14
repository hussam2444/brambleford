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
import { GOODS, GOOD_IDS } from '../../src/economy/goods';

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

  // The host's timer asks for a few hours only, so an empty town ambles instead of racing.
  await worker.provider.fastForward(400);
  r = await play(bob, 'tick', { hours: 2 });
  check('a nudge can ask for a few hours only', r.ok && r.value.hours === 2, `${r.value?.hours} hours, gas ${r.gas} TGas`);
  r = await play(bob, 'tick');
  check('and the hours it left behind are let go: the town carries on from now', r.ok && r.value.hours <= 1, `${r.value?.hours} hours`);
  r = await play(bob, 'tick', { hours: 'lots' });
  const odd = await play(bob, 'tick', { hours: -5 });
  check('a nonsense number of hours is no trouble', r.ok && odd.ok && r.value.hours <= 1 && odd.value.hours <= 1);

  // ── Wanted orders, standing, and who thought a plan through ───────────────

  /** Let a town run on until its shops have just opened, on a day after `after`, when the day's orders are fresh on the board. */
  async function untilMorning(read: () => Promise<any>, nudge: () => Promise<unknown>, after = 0) {
    for (let i = 0; i < 80; i++) {
      const t = (await read()).town;
      if (t.day > after && t.hour >= 6 && t.hour <= 8 && (t.orders ?? []).some((o: any) => o.day === t.day)) return t;
      // Small steps by night, when an hour is short, so the morning is not slept through.
      await worker.provider.fastForward(t.hour >= 9 && t.hour < 20 ? 30 : 6);
      await nudge();
    }
    throw new Error('Waited a long while, and no morning with an order on the board came.');
  }
  const coinsOf = async (who: NearAccount) => (await view('get_player', { account_id: who.accountId })).coins as number;
  const onBoard = async (id: number) => (await view('get_town')).town.orders.find((o: any) => o.id === id);

  // Alice brings a shopkeeper all but one of what their order asks for, then the last one.
  // A shop that is nearly out of coin can stop buying part-way. If that happens, she tries
  // again the next morning: the order is the shopkeeper's to honour, not the test's.
  let order: any = null;
  let part: any = null;
  let last: any = null;
  let paid = 0;
  let day = 0;
  for (let morning = 1; morning <= 4 && !last?.value?.bonus; morning++) {
    const t = await untilMorning(() => view('get_town'), () => play(bob, 'tick'), day);
    day = t.day;
    const today = t.orders.filter((o: any) => o.day === t.day).sort((a: any, b: any) => a.wanted - b.wanted);
    order = today[0];
    if (morning === 1) {
      check('an order appears after a dawn', order.wanted >= 4 && order.wanted <= 12 && order.bonus >= 5 && order.wonBy === undefined && Object.keys(order.progress).length === 0,
        `day ${t.day}: ${order.merchant} wants ${order.wanted} ${order.good}, bonus ${order.bonus}${today.length > 1 ? `, and ${today.length - 1} more` : ''}`);
    }
    const have = (await view('get_player', { account_id: alice.accountId })).inventory[order.good] ?? 0;
    if (have < order.wanted) await play(alice, 'gather', { good: order.good, times: order.wanted - have });
    part = await play(alice, 'sell', { merchant: order.merchant, good: order.good, amount: order.wanted - 1 });
    if (part.value?.count !== order.wanted - 1) continue;
    const had = await coinsOf(alice);
    last = await play(alice, 'sell', { merchant: order.merchant, good: order.good, amount: 1 });
    paid = (await coinsOf(alice)) - had;
  }
  let pinned = await onBoard(order.id);
  check('part of an order earns no bonus', part.ok && part.value.ok && part.value.bonus === undefined, `${order.wanted - 1} of ${order.wanted} brought`);
  check('filling the order pays the bonus', last?.ok && last.value.ok && last.value.bonus > 0 && last.value.bonus <= order.bonus && paid === last.value.price + last.value.bonus,
    `sold for ${last?.value?.price} and a bonus of ${last?.value?.bonus}, gas ${last?.gas} TGas`);
  check('the board says who filled it', pinned.wonBy === alice.accountId && pinned.progress[alice.accountId] === order.wanted);
  c = await coinsEverywhere([alice, bob]);
  check('coins are still conserved after the bonus', c.sum === c.supply, `${c.sum} of ${c.supply}`);

  // Bob brings the same shopkeeper just as much. The order is already filled, so he is paid for the goods and no more.
  await play(bob, 'gather', { good: order.good, times: order.wanted });
  const bobHad = await coinsOf(bob);
  r = await play(bob, 'sell', { merchant: order.merchant, good: order.good, amount: order.wanted });
  pinned = await onBoard(order.id);
  check('a second fill does not pay twice', r.ok && r.value.bonus === undefined && (await coinsOf(bob)) - bobHad === (r.value.price ?? 0) && pinned.wonBy === alice.accountId,
    r.value.ok ? `sold ${r.value.count} for ${r.value.price}, no bonus` : r.value.message);

  // What a player is worth: coins, goods at the normal price, and 4 coins for each 1% of a shop.
  const worthOf = async (who: NearAccount, shares = 0) => {
    const p = await view('get_player', { account_id: who.accountId });
    return GOOD_IDS.reduce((sum, g) => sum + GOODS[g].base * (p.inventory[g] ?? 0), p.coins + shares * 4);
  };
  let top: { id: string; worth: number }[] = (await view('get_town')).richest;
  check('"richest" lists a player after they act', top.find((x) => x.id === alice.accountId)?.worth === (await worthOf(alice)) && top.some((x) => x.id === bob.accountId),
    top.map((x) => `${x.id.split('.')[0]} ${x.worth}`).join(', '));
  check('"richest" is sorted, and get_state carries it too', top.every((x, i) => i === 0 || top[i - 1].worth >= x.worth) && top.length <= 10
    && JSON.stringify((await view('get_state', { account_id: alice.accountId })).richest) === JSON.stringify(top));

  // Buying into a shop costs 100 coins. Newcomers pass Alice their welcome coins until she has enough.
  const friends: NearAccount[] = [];
  for (let i = 0; i < 6 && (await coinsOf(alice)) < 100; i++) {
    const friend = await root.createSubAccount(`friend${i}`);
    friends.push(friend);
    await play(friend, 'join');
    await play(friend, 'mt_transfer', { receiver_id: alice.accountId, token_id: 'coin', amount: '20' }, '1');
  }
  const worthBefore = await worthOf(alice);
  r = await play(alice, 'invest', { merchant: 'carpenter' });
  const news: string[] = (await view('get_town')).town.events.map((e: any) => e.text);
  check('buying into a shop is announced with a friendly name, not an account id',
    r.ok && r.value.ok && news.includes("Traveller lice bought into Tobin's shop.") && !news.some((text) => text.includes(alice.accountId) || text.includes('test.near')), r.value?.message);
  const listed = async () => ((await view('get_town')).richest as { id: string; worth: number }[]).find((x) => x.id === alice.accountId)?.worth;
  check('a share counts towards what a player is worth', (await view('mt_balance_of', { account_id: alice.accountId, token_id: 'share:carpenter' })) === '25'
    && (await listed()) === worthBefore && (await worthOf(alice, 25)) === worthBefore, `worth ${worthBefore} before and after`);
  c = await coinsEverywhere([alice, bob, ...friends]);
  check('coins are still conserved after buying in', c.sum === c.supply, `${c.sum} of ${c.supply}`);

  r = await play(shop.baker, 'set_plan', { target: {}, plan: 'Wheat is dear, so I am baking a little less.', thinker: `NEAR AI (a test model) ${'x'.repeat(80)}` });
  let odo = (await view('get_town')).town.merchants.baker;
  check('set_plan stores who thought the plan through, cut to 60 characters', r.ok && r.value.ok && odo.thinker.startsWith('NEAR AI (a test model) xxx') && odo.thinker.length === 60, `gas ${r.gas} TGas`);
  r = await play(shop.baker, 'set_plan', { target: {}, plan: 'Back to my usual ways.' });
  odo = (await view('get_town')).town.merchants.baker;
  check('a plan sent without a thinker clears the last one', r.ok && r.value.ok && odo.thinker === '' && odo.plan.startsWith('Back'));

  // The days roll on. When the carpenter ends one in profit, Alice is paid her share without lifting a finger, and the list keeps up.
  let dividend: any;
  for (let i = 0; i < 16 && !dividend; i++) {
    await worker.provider.fastForward(30);
    await play(bob, 'tick');
    dividend = (await view('get_player', { account_id: alice.accountId })).notices.find((n: any) => n.text.startsWith('Tobin paid you'));
  }
  check('"richest" keeps up when a shop pays an investor', (await listed()) === (await worthOf(alice, 25)), dividend ? dividend.text : 'the carpenter made no profit to share in that time');

  // A part-owner who goes away. Dora buys in too and comes by every day; Alice does nothing more.
  // Once Alice has been gone more than three days her cut goes to the townsfolk, not to her.
  const dora = await root.createSubAccount('dora');
  await play(dora, 'join');
  for (let i = 0; i < 6 && (await coinsOf(dora)) < 100; i++) {
    const friend = await root.createSubAccount(`pal${i}`);
    friends.push(friend);
    await play(friend, 'join');
    await play(friend, 'mt_transfer', { receiver_id: dora.accountId, token_id: 'coin', amount: '20' }, '1');
  }
  r = await play(dora, 'invest', { merchant: 'carpenter' });
  const person = async (who: NearAccount) => (await view('get_player', { account_id: who.accountId })) as { coins: number; noticeSeq: number; restedOn: number };
  const aliceLastSeen = (await person(alice)).restedOn;
  const dayNow = async () => (await view('get_town')).town.day as number;
  /** One more day or so of town life, with Dora dropping by. */
  const aDayWithDora = async () => {
    await worker.provider.fastForward(150);
    await play(bob, 'tick');
    await play(dora, 'gather', { good: 'wood', times: 1 });
  };
  for (let i = 0; i < 12 && (await dayNow()) - aliceLastSeen <= 4; i++) await aDayWithDora();
  const aliceAway = await person(alice);
  const doraThen = await person(dora);
  for (let i = 0; i < 4; i++) await aDayWithDora();
  const aliceStill = await person(alice);
  const doraPaid = (await person(dora)).noticeSeq - doraThen.noticeSeq;
  check('a part-owner who has been away for days is paid nothing more', r.ok && r.value.ok && (await dayNow()) - aliceLastSeen > 7 && aliceStill.coins === aliceAway.coins && aliceStill.noticeSeq === aliceAway.noticeSeq,
    doraPaid > 0 ? `while Dora, who came by each day, was paid ${doraPaid} time(s)` : 'the carpenter made no profit in those days, so this could not be told apart');
  check('she still owns her share', (await view('mt_balance_of', { account_id: alice.accountId, token_id: 'share:carpenter' })) === '25');
  c = await coinsEverywhere([alice, bob, dora, ...friends]);
  check('her cut went to the townsfolk: every coin is still accounted for', c.sum === c.supply, `${c.sum} of ${c.supply}`);
  // Alice comes back, and both of them drop by each day. A day that pays Dora must now pay Alice too.
  await play(alice, 'gather', { good: 'wood', times: 1 });
  const doraAtReturn = await person(dora);
  let alicePaidAgain = 0, doraPaidAgain = 0;
  for (let i = 0; i < 8 && !doraPaidAgain; i++) {
    await worker.provider.fastForward(60);
    await play(bob, 'tick');
    await play(alice, 'gather', { good: 'wood', times: 1 });
    await play(dora, 'gather', { good: 'wood', times: 1 });
    alicePaidAgain = (await person(alice)).noticeSeq - aliceStill.noticeSeq;
    doraPaidAgain = (await person(dora)).noticeSeq - doraAtReturn.noticeSeq;
  }
  check('and is paid again once she is back', alicePaidAgain >= doraPaidAgain,
    doraPaidAgain ? `Alice was paid ${alicePaidAgain} time(s) and Dora ${doraPaidAgain}` : 'the carpenter made no profit after her return, so this could not be told');
  c = await coinsEverywhere([alice, bob, dora, ...friends]);
  check('coins are still conserved at the end of it all', c.sum === c.supply, `${c.sum} of ${c.supply}`);

  // ── Rehearsing an upgrade of a town that is already live ──────────────────
  // The town on testnet cannot be started again: new code runs over what an older
  // build stored. To rehearse that, build the contract from an older commit and run
  //   OLD_WASM=/path/to/old.wasm npm run test:contract
  // The old build starts a second town and plays a little; this build is then
  // deployed over it and has to carry on from that stored state.
  if (process.env.OLD_WASM) {
    const old = await root.createSubAccount('oldtown');
    await old.deploy(process.env.OLD_WASM);
    const keeper: Record<string, NearAccount> = {};
    for (const id of ids) keeper[id] = await old.createSubAccount(id, oneNear);
    const oldPurse = await old.createSubAccount('townsfolk', oneNear);
    await old.call(old, 'init', { town_account: oldPurse.accountId, merchant_accounts: Object.fromEntries(ids.map((id) => [id, keeper[id].accountId])) });
    const carol = await root.createSubAccount('carol');
    const on = async (who: NearAccount, method: string, args: Record<string, unknown> = {}) => {
      const out = await who.callRaw(old, method, args, { gas: 300n * TGAS });
      let value: any = null;
      try { value = out.parseResult(); } catch { /* no return value */ }
      return { ok: out.succeeded, value };
    };
    const look = (method: string, args: Record<string, unknown> = {}) => old.view<any>(method, args);
    await on(carol, 'join');
    await on(carol, 'gather', { good: 'wood', times: 12 });
    await on(carol, 'sell', { merchant: 'carpenter', good: 'wood', amount: 2 });
    await on(keeper.baker, 'set_plan', { target: { bread: 9 }, plan: 'A plan from before the upgrade.' });
    const was = await look('get_state', { account_id: carol.accountId });

    await old.deploy('build/brambleford.wasm');
    const now = await look('get_state', { account_id: carol.accountId });
    check('upgrade: the town and its players read back unchanged', JSON.stringify([now.town, now.player, now.coin_supply]) === JSON.stringify([was.town, was.player, was.coin_supply]));
    check('upgrade: what the old town never stored reads as empty', now.town.orders === undefined && now.richest.length === 0 && now.town.merchants.baker.thinker === undefined);
    let did = await on(carol, 'sell', { merchant: 'carpenter', good: 'wood', amount: 1 });
    check('upgrade: a player from before can still trade, and is counted among the richest', did.ok && did.value.ok && (await look('get_town')).richest[0]?.id === carol.accountId);
    did = await on(keeper.baker, 'set_plan', { target: {}, plan: 'A plan from after the upgrade.', thinker: 'Shop rules' });
    check('upgrade: a shopkeeper from before can still plan', did.ok && did.value.ok && (await look('get_town')).town.merchants.baker.thinker === 'Shop rules');
    const t = await untilMorning(() => look('get_town'), () => on(carol, 'tick'));
    const first = t.orders.find((o: any) => o.day === t.day);
    check('upgrade: orders go up at the first dawn after it', !!first, `day ${t.day}: ${first?.merchant} wants ${first?.wanted} ${first?.good}`);
    did = await on(carol, 'sell', { merchant: 'carpenter', good: 'wood', amount: 1 });
    const end = await look('get_state', { account_id: carol.accountId });
    let sum = end.town.purse + end.player.coins;
    for (const m of Object.values<any>(end.town.merchants)) sum += m.coins;
    check('upgrade: coins are conserved across it', did.ok && sum === end.coin_supply && end.coin_supply === was.coin_supply, `${sum} of ${end.coin_supply}`);
  }
} finally {
  await worker.tearDown();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

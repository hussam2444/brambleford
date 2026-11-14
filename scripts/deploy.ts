// Put the town on NEAR testnet.
//
//   npm run setup:contract && npm run build:contract
//   npm run deploy -- <name>          e.g. `npm run deploy -- brambleford-demo`
//
// Creates two free testnet accounts from the faucet:
//   <name>.testnet        holds the contract; the shopkeepers and the purse are its sub-accounts
//   <name>-folk.testnet   the relayer: creates player accounts and pays their gas
// then deploys the contract, starts the town, and writes every id and key to
// `.env.testnet` (which git ignores). Run the game against it with `npm run dev:testnet`.
//
// Safe to run again with the same name: it reuses the accounts in `.env.testnet`
// and redeploys the code without restarting the town.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';

const RPC = 'https://test.rpc.fastnear.com';
const FAUCETS = ['https://helper.nearprotocol.com/account', 'https://helper.testnet.near.org/account'];
const ENV_FILE = '.env.testnet';
const WASM = 'contract/build/brambleford.wasm';
const SHOPS = ['blacksmith', 'baker', 'fishmonger', 'carpenter'] as const;

const name = process.argv[2];
if (!name || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) {
  console.error('Give the town a name made of lowercase letters, digits and dashes:  npm run deploy -- my-town');
  process.exit(1);
}
if (!existsSync(WASM)) {
  console.error('Build the contract first:  npm run setup:contract && npm run build:contract');
  process.exit(1);
}

const saved: Record<string, string> = existsSync(ENV_FILE)
  ? Object.fromEntries(readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  : {};
const provider = new JsonRpcProvider({ url: RPC });
const exists = (accountId: string) => provider.viewAccount({ accountId }).then(() => true, () => false);

/** Ask the testnet faucet for a new, funded account. */
async function fromFaucet(accountId: string, key: KeyPair) {
  let last = '';
  for (const url of FAUCETS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: key.getPublicKey().toString() }) });
      if (res.ok) return;
      last = `${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
    } catch (err) {
      last = `${url}: ${err}`;
    }
  }
  throw new Error(`The testnet faucet would not create ${accountId}. ${last}`);
}

async function topLevel(accountId: string, savedKey?: string): Promise<{ account: Account; key: string }> {
  if (savedKey) return { account: new Account(accountId, provider, savedKey as KeyPairString), key: savedKey };
  if (await exists(accountId)) throw new Error(`${accountId} already exists and its key is not in ${ENV_FILE}. Pick another name.`);
  const key = KeyPair.fromRandom('ed25519');
  console.log(`Creating ${accountId} from the faucet...`);
  await fromFaucet(accountId, key);
  return { account: new Account(accountId, provider, key.toString()), key: key.toString() };
}

const contractId = `${name}.testnet`;
const relayerId = `${name}-folk.testnet`;
const sameTown = saved.NEAR_CONTRACT_ID === contractId;
const contract = await topLevel(contractId, sameTown ? saved.NEAR_CONTRACT_KEY : undefined);
const relayer = await topLevel(relayerId, sameTown ? saved.NEAR_RELAYER_KEY : undefined);

// the shopkeepers and the townsfolk's purse: real accounts, each with its own key
const keys: Record<string, string> = {};
const merchant_accounts: Record<string, string> = {};
for (const who of [...SHOPS, 'townsfolk']) {
  const accountId = `${who}.${contractId}`;
  const slot = `NEAR_KEY_${who.toUpperCase()}`;
  if (who !== 'townsfolk') merchant_accounts[who] = accountId;
  if (await exists(accountId)) {
    keys[slot] = saved[slot] ?? '';
    continue;
  }
  const key = KeyPair.fromRandom('ed25519');
  console.log(`Creating ${accountId}...`);
  await contract.account.createSubAccount({ accountOrPrefix: who, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto('0.1') });
  keys[slot] = key.toString();
}

console.log(`Deploying the contract to ${contractId}...`);
await contract.account.deployContract(readFileSync(WASM));

let started = false;
try {
  await provider.callFunction({ contractId, method: 'get_town', args: {} });
  started = true;
} catch { /* not started yet */ }
if (!started) {
  console.log('Starting the town...');
  await contract.account.callFunction({ contractId, methodName: 'init', args: { town_account: `townsfolk.${contractId}`, merchant_accounts }, gas: teraToGas(100) });
}

writeFileSync(
  ENV_FILE,
  [
    '# Written by `npm run deploy`. Holds private keys: never commit this file.',
    'VITE_NEAR_NETWORK=testnet',
    `VITE_NEAR_RPC_URL=${RPC}`,
    `VITE_NEAR_CONTRACT_ID=${contractId}`,
    `NEAR_RPC_URL=${RPC}`,
    `NEAR_CONTRACT_ID=${contractId}`,
    `NEAR_CONTRACT_KEY=${contract.key}`,
    `NEAR_RELAYER_ID=${relayerId}`,
    `NEAR_RELAYER_KEY=${relayer.key}`,
    ...Object.entries(keys).map(([slot, key]) => `${slot}=${key}`),
    '',
  ].join('\n'),
);

const town = await provider.callFunction<{ town: { day: number; hour: number }; coin_supply: number }>({ contractId, method: 'get_town', args: {} });
console.log(`\nThe town is ${started ? 'still running' : 'live'} at ${contractId}: day ${town?.town.day}, ${town?.town.hour}:00, ${town?.coin_supply} coins in existence.`);
console.log(`Explorer: https://testnet.nearblocks.io/address/${contractId}`);
console.log(`Ids and keys are in ${ENV_FILE}. Play against it with:  npm run dev:testnet`);

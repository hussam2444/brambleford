// A private NEAR chain on this machine, with the town already deployed.
//
//   npm run setup:contract   (once)
//   npm run build:contract
//   npm run sandbox        (leave it running)
//   npm run dev            (in another terminal)
//
// Writes `.env.local` so the game and its back end point at the sandbox, and
// removes it again on exit. Nothing here touches testnet or mainnet.

import { rmSync, writeFileSync } from 'node:fs';

const ENV_FILE = '../.env.local'; // this script runs from the contract folder
import { Worker } from 'near-workspaces';

const worker = await Worker.init();
const root = worker.rootAccount;

const contract = await root.createSubAccount('brambleford');
await contract.deploy('build/brambleford.wasm');

const ids = ['blacksmith', 'baker', 'fishmonger', 'carpenter'] as const;
const one = { initialBalance: 10n ** 24n };
const merchant_accounts: Record<string, string> = {};
const merchantKeys: string[] = [];
for (const id of ids) {
  const shop = await contract.createSubAccount(id, one);
  merchant_accounts[id] = shop.accountId;
  merchantKeys.push(`NEAR_KEY_${id.toUpperCase()}=${(await shop.getKey())!.toString()}`);
}
const purse = await contract.createSubAccount('townsfolk', one);
await contract.call(contract, 'init', { town_account: purse.accountId, merchant_accounts });

// the account that creates player accounts and pays their gas
const relayer = await root.createSubAccount('folk', { initialBalance: 50n * 10n ** 24n });
const relayerKey = (await relayer.getKey())!.toString();
const rpc = (worker as unknown as { provider: { connection: { url: string } } }).provider.connection.url;

writeFileSync(
  ENV_FILE,
  [
    '# Written by `npm run sandbox`. Deleted when the sandbox stops.',
    `VITE_NEAR_NETWORK=sandbox`,
    `VITE_NEAR_RPC_URL=${rpc}`,
    `VITE_NEAR_CONTRACT_ID=${contract.accountId}`,
    `NEAR_RPC_URL=${rpc}`,
    `NEAR_CONTRACT_ID=${contract.accountId}`,
    `NEAR_RELAYER_ID=${relayer.accountId}`,
    `NEAR_RELAYER_KEY=${relayerKey}`,
    ...merchantKeys,
    '',
  ].join('\n'),
);

console.log(`Sandbox chain running at ${rpc}`);
console.log(`Town contract: ${contract.accountId}`);
console.log(`Relayer:       ${relayer.accountId}`);
console.log('Wrote .env.local. Start the game with `npm run dev`. Press Ctrl+C to stop.');

const stop = async () => {
  rmSync(ENV_FILE, { force: true });
  await worker.tearDown();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});

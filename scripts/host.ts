// Put the game online with Vercel, pointed at the testnet town.
//
//   vercel login            (once, in your own terminal)
//   npm run host
//
// Reads `.env.testnet` (written by `npm run deploy`) and passes the settings
// the hosted game needs. The contract account's own key is deliberately left
// out: the hosted back end only needs the relayer and the shopkeepers.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.testnet', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
delete env.NEAR_CONTRACT_KEY;

const args = ['deploy', '--prod', '--yes'];
for (const [key, value] of Object.entries(env)) {
  if (!value) continue;
  args.push(key.startsWith('VITE_') ? '--build-env' : '--env', `${key}=${value}`);
}
const run = spawnSync('vercel', args, { stdio: 'inherit' });
process.exit(run.status ?? 1);

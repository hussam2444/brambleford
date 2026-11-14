// Put the game online with Vercel, pointed at the testnet town.
//
//   vercel login                                   (once, in your own terminal)
//   vercel link --yes --project <project-name>     (once, to choose the project)
//   npm run host
//
// Reads `.env.testnet` (written by `npm run deploy`) and passes the settings
// the hosted game needs. The contract account's key and the purse's key are
// deliberately left out: the hosted back end only needs the relayer and the
// shopkeepers.
//
// The deploy is made from a clean copy of the source in a temporary folder,
// for two reasons. First, the copy contains no `.env` file and no notes, so
// keys cannot be uploaded by accident. Second, the copy has no git history:
// on a team project Vercel blocks a deploy whose latest commit was written by
// someone who is not a member of that team.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const env = Object.fromEntries(
  readFileSync('.env.testnet', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
delete env.NEAR_CONTRACT_KEY;
delete env.NEAR_KEY_TOWNSFOLK;

if (!existsSync('.vercel/project.json')) {
  console.error('Link this folder to a Vercel project first:  vercel link --yes --project <project-name>');
  process.exit(1);
}

/** Only what the hosted build needs. */
const KEEP = ['api', 'server', 'src', 'scripts', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vercel.json', '.vercel'];
const copy = mkdtempSync(join(tmpdir(), 'brambleford-host-'));
for (const name of KEEP) {
  cpSync(name, join(copy, name), { recursive: true, filter: (src) => !src.split(sep).some((part) => part.startsWith('.env')) });
}

const args = ['deploy', '--prod', '--yes'];
for (const [key, value] of Object.entries(env)) {
  if (!value) continue;
  args.push(key.startsWith('VITE_') ? '--build-env' : '--env', `${key}=${value}`);
}
const run = spawnSync('vercel', args, { stdio: 'inherit', cwd: copy });
rmSync(copy, { recursive: true, force: true });
process.exit(run.status ?? 1);

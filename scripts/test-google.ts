// Checks how the back end treats a Google sign-in, with Google itself played
// by a stand-in. Nothing here uses the network or a chain.
//
//   npx tsx scripts/test-google.ts
//
// A real Google credential cannot be made here, so these checks cover our side
// only: what we ask Google, and what we do with each kind of answer.

import { checkGoogleCredential, type GoogleCheck } from '../server/google';
import { browserLimit, handle, type ServerEnv } from '../server/near';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

const CLIENT = '1234-brambleford.apps.googleusercontent.com';
const NOW = Date.parse('2026-11-14T12:00:00Z');
/** What Google's tokeninfo address reports for a good credential. It sends times as text, in seconds. */
const good = {
  iss: 'https://accounts.google.com',
  aud: CLIENT,
  azp: CLIENT,
  sub: '110169484474386276334',
  email: 'player@example.com',
  email_verified: 'true',
  iat: String(NOW / 1000 - 60),
  exp: String(NOW / 1000 + 3540),
};

/** A stand-in for Google that gives one fixed answer and notes what it was asked. */
function google(status: number, body: unknown) {
  const asked: string[] = [];
  const ask = (async (url: RequestInfo | URL) => {
    asked.push(String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { ask, asked };
}
const verdict = (status: number, body: unknown, credential = 'aaa.bbb.ccc') => checkGoogleCredential(credential, CLIENT, google(status, body).ask, NOW);
const why = (r: GoogleCheck) => (r.ok ? `accepted as ${r.sub}` : r.reason);

// ── The checks themselves ───────────────────────────────────────────────────

let r = await verdict(200, good);
check('a good credential is accepted, and names the person', r.ok && r.sub === good.sub, why(r));
r = await verdict(200, { ...good, iss: 'accounts.google.com' });
check('both ways Google writes its own name are accepted', r.ok, why(r));

r = await verdict(200, { ...good, aud: 'some-other-site.apps.googleusercontent.com' });
check('a credential made for another site is refused', !r.ok, why(r));
r = await verdict(200, { ...good, aud: [CLIENT] });
check('an audience that is not plain text is refused', !r.ok, why(r));
r = await verdict(200, { ...good, iss: 'https://accounts.example.com' });
check('a credential from anyone but Google is refused', !r.ok, why(r));
r = await verdict(200, { ...good, exp: String(NOW / 1000 - 1) });
check('an expired credential is refused', !r.ok, why(r));
const { exp: _exp, ...noExpiry } = good;
r = await verdict(200, noExpiry);
check('a credential with no expiry is refused', !r.ok, why(r));
const { sub: _sub, ...nobody } = good;
r = await verdict(200, nobody);
check('a credential that names nobody is refused', !r.ok, why(r));
r = await verdict(200, { ...good, sub: '' });
check('an empty name is refused', !r.ok, why(r));
r = await verdict(400, { error: 'invalid_token', error_description: 'Invalid Value' });
check('a credential Google does not recognise (400) is refused', !r.ok, why(r));
r = await verdict(500, good);
check('any answer other than 200 is refused, whatever it says', !r.ok, why(r));
r = await verdict(200, '<html>not json</html>');
check('an answer that is not JSON is refused', !r.ok, why(r));
r = await verdict(200, 'null');
check('an empty answer is refused', !r.ok, why(r));

r = await checkGoogleCredential('aaa.bbb.ccc', CLIENT, (async () => { throw new Error('offline'); }) as typeof fetch, NOW);
check('if Google cannot be reached, nobody is let in', !r.ok, why(r));
r = await checkGoogleCredential('aaa.bbb.ccc', '', google(200, { ...good, aud: '' }).ask, NOW);
check('with no client id of our own, nothing matches', !r.ok, why(r));

const quiet = google(200, good);
r = await checkGoogleCredential('', CLIENT, quiet.ask, NOW);
check('an empty credential is refused without asking Google', !r.ok && quiet.asked.length === 0, why(r));
r = await checkGoogleCredential('x'.repeat(5000), CLIENT, quiet.ask, NOW);
check('an oversized credential is refused without asking Google', !r.ok && quiet.asked.length === 0, why(r));

const asked = google(200, good);
await checkGoogleCredential('aaa.bbb+ccc/ddd=', CLIENT, asked.ask, NOW);
check(
  'Google is asked once, at its tokeninfo address, with the credential safely encoded',
  asked.asked.length === 1 && asked.asked[0] === 'https://oauth2.googleapis.com/tokeninfo?id_token=aaa.bbb%2Bccc%2Fddd%3D',
  asked.asked[0],
);

// ── The same, through the back end's front door ─────────────────────────────
// `handle` is what both the dev server and the hosted function call. The NEAR
// settings are left out on purpose, so a sign-in that passes Google's check
// stops at "NEAR is not configured" rather than reaching for a chain.

const realFetch = globalThis.fetch;
const KEY = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
async function frontDoor(env: ServerEnv, body: Record<string, unknown>, status: number, answer: unknown) {
  const stand = google(status, answer);
  globalThis.fetch = stand.ask;
  try {
    const out = await handle('join', body, env, 'test');
    return { ...out, error: (out.json as { error?: string }).error ?? '', asked: stand.asked };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const signIn = { publicKey: KEY, googleCredential: 'aaa.bbb.ccc' };
const future = { ...good, exp: String(Math.floor(Date.now() / 1000) + 3540) };

let out = await frontDoor({}, signIn, 200, future);
check('with no GOOGLE_CLIENT_ID the server answers 503 and never asks Google', out.status === 503 && out.asked.length === 0, `${out.status} ${out.error}`);
out = await frontDoor({ GOOGLE_CLIENT_ID: CLIENT }, signIn, 400, { error: 'invalid_token' });
check('a credential Google does not recognise gets a 401', out.status === 401 && out.asked.length === 1, `${out.status} ${out.error}`);
out = await frontDoor({ GOOGLE_CLIENT_ID: CLIENT }, signIn, 200, { ...future, aud: 'someone-else' });
check('a credential for another site gets a 401', out.status === 401, `${out.status} ${out.error}`);
out = await frontDoor({ GOOGLE_CLIENT_ID: CLIENT }, signIn, 200, { ...future, exp: '1' });
check('an expired credential gets a 401', out.status === 401, `${out.status} ${out.error}`);
out = await frontDoor({ GOOGLE_CLIENT_ID: CLIENT }, signIn, 200, future);
check('a good credential passes Google and moves on to NEAR', out.status === 503 && /NEAR/.test(out.error) && out.asked.length === 1, `${out.status} ${out.error}`);
out = await frontDoor({ GOOGLE_CLIENT_ID: CLIENT }, { publicKey: KEY }, 200, future);
check('a guest joining is never sent to Google', out.status === 503 && /NEAR/.test(out.error) && out.asked.length === 0, `${out.status} ${out.error}`);

// ── How many browsers one signed-in player can use ──────────────────────────
// Each browser's key takes room on the player's account, and an account that
// holds no NEAR only has so much. "Any device" needs room for at least two.
const fit = browserLimit('brambleford.testnet');
check('at least two browsers fit on one signed-in account in the live town', fit >= 2, `${fit} fit`);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

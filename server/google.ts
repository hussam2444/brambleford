// Sign in with Google, on the server's side: is this credential really from
// Google, and was it meant for this game?
//
// The browser hands over an "ID token": a short note, signed by Google, that
// says who has just signed in. We do not check the signature ourselves. We ask
// Google's own tokeninfo address, which answers 200 only for a note it signed.
// The rest is ours to check: the note must be addressed to this game, issued
// by Google, still in date, and it must name a person.
//
// Nothing here touches NEAR. `server/near.ts` turns the answer into an account.

const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/** Who Google says signed in, or a plain reason for turning the credential away. */
export type GoogleCheck = { ok: true; sub: string } | { ok: false; reason: string };

const refuse = (reason: string): GoogleCheck => ({ ok: false, reason });

/**
 * Our own checks on what Google reports about a credential. `clientId` is this
 * game's Google client id. The time is passed in so a test can choose it.
 */
export function checkClaims(claims: unknown, clientId: string, nowMs: number): GoogleCheck {
  if (typeof claims !== 'object' || claims === null) return refuse('Google did not recognise that sign-in. Try signing in again.');
  const { aud, iss, exp, sub } = claims as Record<string, unknown>;
  // A credential made for some other site is real, and still not ours to accept.
  if (!clientId || aud !== clientId) return refuse('That sign-in was made for a different site.');
  if (typeof iss !== 'string' || !ISSUERS.includes(iss)) return refuse('That sign-in did not come from Google.');
  // Google reports the expiry in seconds, as text.
  const expires = typeof exp === 'string' || typeof exp === 'number' ? Number(exp) * 1000 : NaN;
  if (!(expires > nowMs)) return refuse('That sign-in has expired. Try signing in again.');
  // `sub` is Google's own id for the person. It never changes, unlike a name or an email address.
  if (typeof sub !== 'string' || !sub) return refuse('Google did not say who signed in.');
  return { ok: true, sub };
}

/**
 * Ask Google about a credential from the browser, then apply our checks.
 * `ask` is the function used to reach Google: `fetch`, or a stand-in in tests.
 */
export async function checkGoogleCredential(credential: string, clientId: string, ask: typeof fetch = fetch, nowMs = Date.now()): Promise<GoogleCheck> {
  // A real credential is about a thousand characters. Anything empty or huge is not worth a question to Google.
  if (!credential || credential.length > 4096) return refuse('Google did not recognise that sign-in. Try signing in again.');
  let res: Response;
  try {
    res = await ask(`${TOKENINFO}?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(6000) });
  } catch {
    return refuse('Could not reach Google to check that sign-in. Try again in a moment.');
  }
  // Only a plain 200 means Google signed this credential.
  if (res.status !== 200) return refuse('Google did not recognise that sign-in. Try signing in again.');
  let claims: unknown;
  try {
    claims = await res.json();
  } catch {
    return refuse('Google did not recognise that sign-in. Try signing in again.');
  }
  return checkClaims(claims, clientId, nowMs);
}

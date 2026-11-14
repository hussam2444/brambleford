// Sign in with Google, from the browser's side.
//
// A guest's player belongs to this browser's key, so it is lost when the
// browser's storage is cleared and cannot be reached from another device. A
// player who signs in with Google belongs to their Google identity instead:
// the back end finds (or makes) one NEAR account for that identity and adds
// this browser's key to it. The key never leaves the browser, and playing
// works exactly as it does for a guest.
//
// All of this is switched off unless the game was built with a Google client
// id (VITE_GOOGLE_CLIENT_ID). Without one nothing here is shown, nothing is
// remembered and Google's script is never loaded.

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim();
const CONTRACT = import.meta.env.VITE_NEAR_CONTRACT_ID as string | undefined;
const SCRIPT = 'https://accounts.google.com/gsi/client';

const INVITE = 'Sign in to keep one player on every device. The first sign-in starts a new player, and your guest player waits in this browser.';
const SIGNED_IN = 'Signed in with Google. Sign in the same way on another device to carry on there.';
const LAPSED = 'This browser was signed out, so you are playing as a guest. Sign in again to carry on as your player.';
const TRY_AGAIN = 'Could not sign you in just now. Try again in a moment.';
const NO_SCRIPT = 'Could not load Google sign-in. Check your connection, or an ad blocker, then open this menu again.';

/** True when this build offers sign-in with Google at all. */
const googleConfigured = () => !!CLIENT_ID && !!CONTRACT;

/** Where this browser remembers the account it is signed in as, for this town. */
const slot = () => `brambleford:account:${CONTRACT}`;

/** The account this browser is signed in as, or null for a guest. */
export function googleAccount(): string | null {
  if (!googleConfigured()) return null;
  try {
    return localStorage.getItem(slot()) || null;
  } catch {
    return null; // storage is unavailable: everyone is a guest
  }
}

/** Forget the sign-in on this browser. The account itself, and everything the player owns, is untouched. */
export function forgetGoogleAccount() {
  try { localStorage.removeItem(slot()); } catch { /* nothing was stored */ }
}

// ── Google's own script ─────────────────────────────────────────────────────

/** The two calls we use from Google Identity Services. */
interface GoogleId {
  initialize(config: { client_id: string; callback: (reply: { credential?: string }) => void }): void;
  renderButton(parent: HTMLElement, options: Record<string, string>): void;
}

const googleId = () => (window as unknown as { google?: { accounts?: { id?: GoogleId } } }).google?.accounts?.id;

let loading: Promise<GoogleId> | null = null;

/** Load Google's script the first time the menu needs it, and tell it which game this is. */
function loadGoogle(): Promise<GoogleId> {
  loading ??= new Promise<GoogleId>((resolve, reject) => {
    const ready = () => {
      const id = googleId();
      if (!id) return reject(new Error('Google sign-in did not start.'));
      id.initialize({ client_id: CLIENT_ID!, callback: (reply) => void signIn(reply.credential) });
      resolve(id);
    };
    if (googleId()) return ready();
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = ready;
    script.onerror = () => { script.remove(); reject(new Error('Could not load Google sign-in.')); };
    document.head.append(script);
  }).catch((err) => {
    loading = null; // so the next time the menu opens, it tries again
    throw err;
  });
  return loading;
}

// ── Signing in and out ──────────────────────────────────────────────────────

/** This browser's public key, as last given by the menu. Sign-in adds it to the player's account. */
let publicKey = '';
/** What the line under the button says right now. Kept here so it survives the menu being redrawn. */
let status = INVITE;
let busy = false;

function say(text: string) {
  status = text;
  const note = document.querySelector('[data-google-note]');
  if (note) note.textContent = text;
}

/** Google has said who this is. Ask the back end for that person's account, with this browser's key on it. */
async function signIn(credential: string | undefined) {
  if (!credential || busy) return;
  // Without storage this browser makes a new key on every load, and the game could not
  // remember the sign-in anyway. Say so before the back end is asked to add a key nobody keeps.
  try {
    localStorage.setItem(`${slot()}:check`, '1');
    localStorage.removeItem(`${slot()}:check`);
  } catch {
    say('This browser will not let the game remember you, so signing in cannot work here.');
    return;
  }
  busy = true;
  say('Signing you in…');
  try {
    const res = await fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey, googleCredential: credential }) });
    const json = (await res.json().catch(() => null)) as { accountId?: string; error?: string } | null;
    if (!res.ok || typeof json?.accountId !== 'string') {
      // The back end words its own refusals for the player to read. A 500 is a fault they can do nothing about.
      const readable = res.status !== 500 && typeof json?.error === 'string';
      if (!readable) console.warn('Sign-in with Google failed on the server.', res.status, json?.error);
      say(readable ? json.error! : TRY_AGAIN);
      return;
    }
    try {
      localStorage.setItem(slot(), json.accountId);
    } catch {
      say('This browser will not let the game remember you, so signing in cannot work here.');
      return;
    }
    location.reload(); // start again, this time as the signed-in player
  } catch {
    say(TRY_AGAIN);
  } finally {
    busy = false;
  }
}

/** Go back to this browser's guest player. Signing in again returns to the Google player. */
function signOut() {
  forgetGoogleAccount();
  location.reload();
}

/**
 * The chain says this browser's key is no longer on the player's account, which
 * happens when the player has since signed in on newer browsers. Forget the
 * sign-in, and let the menu say what happened.
 */
export function googleSignInLapsed() {
  forgetGoogleAccount();
  status = LAPSED;
}

// ── The Esc menu ────────────────────────────────────────────────────────────

function element(tag: string, className: string, text = ''): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * Add the sign-in part to the Esc menu, just under its buttons. Call this
 * each time the menu has been drawn. `inTown` says whether the player is in
 * the town on NEAR, and `browserKey` gives this browser's public key when
 * asked. Does nothing at all when sign-in is switched off.
 */
export function addGoogleToMenu(menu: HTMLElement, inTown: boolean, browserKey: () => string) {
  if (!googleConfigured()) return;
  const signedIn = !!googleAccount();
  // Signing in only means something in the town on NEAR. Signing out is offered wherever a
  // sign-in is remembered, so there is always a way back to being a guest.
  if (!signedIn && !inTown) return;
  // The menu is taller with this part in it. In a short window, let it scroll rather than run off the screen.
  menu.style.maxHeight = 'calc(100vh - 40px)';
  menu.style.overflowY = 'auto';
  const part = document.createElement('div');
  const buttons = menu.querySelector('.menu-buttons');
  buttons ? buttons.after(part) : menu.append(part);

  if (signedIn) {
    const out = element('button', 'act', 'Sign out');
    out.addEventListener('click', signOut);
    const row = element('div', 'menu-buttons');
    row.append(out);
    part.append(element('p', 'menu-note', SIGNED_IN), row);
    return;
  }

  publicKey = browserKey();
  const holder = element('div', '');
  holder.style.cssText = 'display: grid; justify-items: center; min-height: 44px; margin-top: 14px;';
  const note = element('p', 'menu-note', status);
  note.style.margin = '8px 0 0';
  note.setAttribute('data-google-note', '');
  part.append(holder, note);
  loadGoogle().then(
    (id) => {
      if (status === NO_SCRIPT) say(INVITE); // an earlier try failed and this one did not
      // The menu may have been redrawn while the script was loading. Only draw into a holder that is still on screen.
      if (holder.isConnected) id.renderButton(holder, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', locale: 'en' });
    },
    () => say(NO_SCRIPT),
  );
}

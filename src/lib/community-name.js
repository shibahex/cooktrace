// ourfamily fork: a visitor's name (server/lib/community.js).
//
// Visitors without an account share one guest account, so the first time
// they do something that records a name (add or import a recipe, comment,
// log a cook) the server answers 428 { need_name }. This asks for a name,
// saves it (a cookie on the server side), and sends the request again.
// Done by wrapping fetch once, so upstream's components need no changes.
import { writable, get } from 'svelte/store';
import { communityGuest, currentUser } from '../stores/auth.js';
import { apiUrl } from './platform.js';
import { newRecipeHousehold } from '../stores/households.js';

/** The prompt's state: null when closed, else { reason } while open. */
export const namePrompt = writable(null);

let _pending = null;
let _resolve = null;

/** Opens the name prompt; resolves true once a name is saved. One prompt
 *  at a time: callers that ask while it's open share the answer. */
export function askGuestName(reason = 'needed') {
  if (_pending) return _pending;
  _pending = new Promise(resolve => { _resolve = resolve; });
  namePrompt.set({ reason });
  return _pending;
}

/** Called by the prompt. Throws with the server's message on a bad name. */
export async function saveGuestName(name) {
  const res = await _origFetch(apiUrl('/api/community/name'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not save that name');
  currentUser.update(u => (u ? { ...u, full_name: body.name, guest_name: body.name } : u));
  _finish(true);
  return body.name;
}

export function cancelGuestName() { _finish(false); }

function _finish(ok) {
  namePrompt.set(null);
  const r = _resolve;
  _pending = null; _resolve = null;
  r?.(ok);
}

let _origFetch = (...a) => fetch(...a);
let _installed = false;

// Same list as NEEDS_NAME in server/lib/community.js: asking before the
// request goes out means the visitor just sees the name box, never an
// error. The 428 retry below catches anything this list misses.
const NEEDS_NAME = [
  /^\/api\/recipes\/?$/,
  /^\/api\/recipes\/(scrape|batch-scrape|import|import-zip\/scan|import-zip\/commit|extract-and-parse|bulk-scan|bulk-commit)$/,
  /^\/api\/recipes\/\d+\/(comments|cooked)$/,
  /^\/api\/cook-diary\/?$/,
];

// Requests that create recipes: they carry the household picked in the
// editor (stores/households.js), and the server files the new recipe there.
const CREATES_RECIPES = /^\/api\/recipes(\/(scrape|import|import-zip\/commit|extract-and-parse|bulk-commit))?\/?$/;
function _householdFor(method, url) {
  if (String(method || 'GET').toUpperCase() !== 'POST') return null;
  const kid = get(newRecipeHousehold);
  if (!kid) return null;
  try { return CREATES_RECIPES.test(new URL(String(url), window.location.href).pathname) ? kid : null; }
  catch { return null; }
}

function _needsName(method, url) {
  if (String(method || 'GET').toUpperCase() !== 'POST') return false;
  if (!get(communityGuest) || get(currentUser)?.guest_name) return false;
  let path;
  try { path = new URL(String(url), window.location.href).pathname; } catch { return false; }
  return NEEDS_NAME.some(re => re.test(path));
}

/** Ask for a name before requests that record one (fetch and
 *  XMLHttpRequest), and retry a fetch the server still answers with
 *  need_name. */
export function installGuestNameFetch() {
  if (_installed || typeof window === 'undefined') return;
  _installed = true;
  const orig = window.fetch.bind(window);
  _origFetch = orig;

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ofMethod = method; this._ofUrl = url;
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const kid = _householdFor(this._ofMethod, this._ofUrl);
    if (kid) this.setRequestHeader('X-Ourfamily-Household', String(kid));
    if (!_needsName(this._ofMethod, this._ofUrl)) return xhrSend.call(this, body);
    askGuestName().then(() => xhrSend.call(this, body));
  };

  window.fetch = async (input, init) => {
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    const url = input instanceof Request ? input.url : input;
    if (_needsName(method, url)) await askGuestName();
    const kid = _householdFor(method, url);
    if (kid) {
      if (input instanceof Request) input.headers.set('X-Ourfamily-Household', String(kid));
      else {
        const headers = new Headers(init?.headers || {});
        headers.set('X-Ourfamily-Household', String(kid));
        init = { ...(init || {}), headers };
      }
    }
    // A Request's body can only be read once; keep a copy for the retry.
    const retryInput = input instanceof Request ? input.clone() : input;
    const res = await orig(input, init);
    if (res.status !== 428 || !get(communityGuest)) return res;
    let body = null;
    try { body = await res.clone().json(); } catch { return res; }
    if (!body?.need_name) return res;
    if (!(await askGuestName())) return res;
    return orig(retryInput, init);
  };
}

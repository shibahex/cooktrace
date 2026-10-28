// ourfamily fork: community mode.
//
// An open family recipe box:
//   - nobody has to sign in. A visitor without an account is signed in
//     as one shared "Guest" account and can use the whole app (add
//     recipes, pantry, shopping, diary). Everything a guest adds is
//     shared by every guest.
//   - every recipe is visible to everyone by default. A signed-in person
//     can hide a recipe of their own (visibility back to 'private').
//   - accounts are optional: they give you your own pantry, diary and
//     shopping list, and recipes you can hide.
//   - Kitchens (households) are a side tab on the Recipes page that
//     filters to a household's recipes.
//
// On by default in this fork. COMMUNITY_MODE=false gives back upstream
// behaviour (recipes made public while it was on stay public).
//
// Kept in its own files so `git merge upstream/main` rarely conflicts.
import db from '../db.js';

export function communityMode() {
  const v = String(process.env.COMMUNITY_MODE ?? 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(v);
}

// ── The shared guest account ───────────────────────────────────────────
// A normal 'user' row with no password, so nobody can sign in to it; the
// server signs visitors in as it. Its id is kept in app_config so a real
// account named "guest" is never mistaken for it.
const GUEST_KEY = 'ourfamily_guest_user_id';
let _guestId = null;

function _configuredGuestId() {
  const v = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(GUEST_KEY)?.value;
  const id = v != null ? Number(v) : null;
  return id != null && db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(id) ? id : null;
}

/** The guest account's id, made on first use. Null until a real account
 *  exists: a fresh install needs its admin set up first. */
export function guestUserId() {
  if (_guestId != null && db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(_guestId)) return _guestId;
  _guestId = _configuredGuestId();
  const realAccount = db.prepare(`SELECT 1 FROM users WHERE id IS NOT ? LIMIT 1`).get(_guestId);
  if (!realAccount) return null;
  if (_guestId != null) {
    _seedGuestCategories(_guestId);
    // No account-wide name: each visitor's own name shows instead.
    db.prepare(`UPDATE users SET full_name = NULL WHERE id = ? AND full_name IS NOT NULL`).run(_guestId);
    return _guestId;
  }

  let name = 'guest';
  for (let n = 2; db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(name); n++) name = `guest${n}`;
  const info = db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role) VALUES (?, NULL, NULL, 'user')`
  ).run(name);
  _guestId = Number(info.lastInsertRowid);
  db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(GUEST_KEY, String(_guestId));
  _seedGuestCategories(_guestId);
  return _guestId;
}

// Categories are per account, and the guest is made outside upstream's
// sign-up, so it starts with none: give it the first admin's set, the
// way the family already uses them.
function _seedGuestCategories(id) {
  if (db.prepare(`SELECT 1 FROM recipe_categories WHERE user_id = ? LIMIT 1`).get(id)) return;
  const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' AND id != ? ORDER BY id LIMIT 1`).get(id);
  if (!admin) return;
  db.prepare(
    `INSERT OR IGNORE INTO recipe_categories (user_id, name, slug, color, sort_order)
     SELECT ?, name, slug, color, sort_order FROM recipe_categories
      WHERE user_id = ? ORDER BY sort_order`
  ).run(id, admin.id);
}

// Under /api/auth the guest is only "who am I". Sign-in, single sign-on,
// profile and password act as if nobody were signed in, so the guest
// account can never be linked to, renamed or locked.
const GUEST_AUTH_PATHS = new Set(['/api/auth/me', '/api/auth/status', '/api/auth/users/list']);

// Kitchens need real people in them.
const GUEST_BLOCKED = [
  ['POST',   /^\/api\/kitchens/],
  ['PUT',    /^\/api\/kitchens/],
  ['PATCH',  /^\/api\/kitchens/],
  ['DELETE', /^\/api\/kitchens/],
];

// ── A visitor's name ───────────────────────────────────────────────────
// Everyone without an account shares the guest account, so who did what
// comes from a name the visitor gives the first time they do something
// that records one. It lives in a cookie in their browser and stands in
// for the username on everything they add (recipes, comments, cook log).
export const GUEST_NAME_COOKIE = 'ct_guest_name';
const _insecureCookies = process.env.INSECURE_COOKIES === '1' || process.env.INSECURE_COOKIES === 'true';
export const GUEST_NAME_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure:   !_insecureCookies,
  maxAge:   365 * 24 * 60 * 60 * 1000,
};

/** A usable name, or null: 1 to 40 characters, no control characters. */
export function cleanGuestName(raw) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return s.length >= 1 && s.length <= 40 ? s : null;
}

/** True when the name is an account's (name, nickname or username), so a
 *  visitor can't sign things as someone who has an account here. */
export function nameBelongsToAccount(name) {
  const n = name.toLowerCase();
  return db.prepare(
    `SELECT 1 FROM users
      WHERE id IS NOT ?
        AND (lower(full_name) = ? OR lower(nickname) = ? OR lower(username) = ?
             OR lower(substr(username, 1, instr(username || '@', '@') - 1)) = ?)
      LIMIT 1`
  ).get(_guestId, n, n, n, n) != null;
}

function _guestName(req) {
  const name = cleanGuestName(req.cookies?.[GUEST_NAME_COOKIE]);
  return name && !nameBelongsToAccount(name) ? name : null;
}

// Requests that record who did them. A visitor with no name yet gets a
// 428 with need_name, and the web app asks for one and sends it again.
const NEEDS_NAME = [
  /^\/api\/recipes\/?$/,
  /^\/api\/recipes\/(scrape|batch-scrape|import|import-zip\/scan|import-zip\/commit|extract-and-parse|bulk-scan|bulk-commit)$/,
  /^\/api\/recipes\/\d+\/(comments|cooked)$/,
  /^\/api\/cook-diary\/?$/,
];

/** Middleware, after authenticate: a request with no session (and no
 *  Authorization header, so the Android app and API tokens are left
 *  alone) is signed in as the guest account, under the visitor's name. */
export function communityGuest(req, res, next) {
  if (!communityMode() || req.user || req.authVia || req.headers.authorization) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/api/auth/') && !GUEST_AUTH_PATHS.has(req.path)) return next();
  const id = guestUserId();
  if (id == null) return next();
  if (GUEST_BLOCKED.some(([m, re]) => m === req.method && re.test(req.path))) {
    return res.status(403).json({ error: 'Sign in to do that' });
  }
  const name = _guestName(req);
  if (!name && req.method === 'POST' && NEEDS_NAME.some(re => re.test(req.path))) {
    return res.status(428).json({ error: 'Please enter your name to continue.', need_name: true });
  }
  req.user = { id, username: name || 'guest', role: 'user', ourfamilyGuest: true, guestName: name };

  // Who am I: the visitor, not the shared account's row.
  if (req.method === 'GET' && req.path === '/api/auth/me') {
    return res.json({
      user: {
        id, username: 'guest', full_name: name, nickname: null, avatar_url: null,
        role: 'user', email: null, has_password: false, guest: true, guest_name: name,
      },
      csrf: null,
    });
  }
  next();
}

// ── Recipes are public by default ──────────────────────────────────────
// Upstream already treats visibility = 'group' as "everyone on the
// instance can read it" (GET /recipes/:id, comments, cook log, cookbooks,
// card images). A new recipe starts at 'group' however it's written
// (editor, import, Android sync, backup restore); its owner can hide it
// later. The guest account's recipes always stay public: every guest is
// the same account, so hiding one would only hide it from members.
export function applyCommunitySchema() {
  // Who logged a cook under the guest account (the cook log reads names
  // from the account, which is the same for every visitor).
  db.exec(`
    CREATE TABLE IF NOT EXISTS ourfamily_cook_names (
      cook_id INTEGER PRIMARY KEY REFERENCES cook_diary(id) ON DELETE CASCADE,
      name    TEXT NOT NULL
    );
  `);
  db.exec(`
    DROP TRIGGER IF EXISTS ourfamily_recipes_public_ins;
    DROP TRIGGER IF EXISTS ourfamily_recipes_public_upd;
    DROP TRIGGER IF EXISTS ourfamily_recipes_guest_public;
  `);
  if (!communityMode()) return;
  db.exec(`
    CREATE TRIGGER ourfamily_recipes_public_ins
      AFTER INSERT ON recipes WHEN NEW.visibility IS NOT 'group'
    BEGIN
      UPDATE recipes SET visibility = 'group' WHERE id = NEW.id;
    END;
    CREATE TRIGGER ourfamily_recipes_guest_public
      AFTER UPDATE OF visibility ON recipes
      WHEN NEW.visibility IS NOT 'group'
       AND NEW.user_id = (SELECT CAST(value AS INTEGER) FROM app_config WHERE key = '${GUEST_KEY}')
    BEGIN
      UPDATE recipes SET visibility = 'group' WHERE id = NEW.id;
    END;
  `);
  // Recipes from before community mode become public once. After that a
  // hidden recipe stays hidden across restarts.
  const done = db.prepare(`SELECT 1 FROM app_config WHERE key = 'ourfamily_made_public'`).get();
  if (!done) {
    db.prepare(`UPDATE recipes SET visibility = 'group' WHERE visibility IS NOT 'group'`).run();
    db.prepare(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('ourfamily_made_public', '1')`).run();
  }
}

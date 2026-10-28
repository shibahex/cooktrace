// ourfamily fork: community-mode routes (see lib/community.js).
//
// Mounted on /api ahead of the upstream routers. Each handler either
// answers or calls next(), so with COMMUNITY_MODE off this router does
// nothing and upstream behaviour is untouched.
//
// Visitors without an account arrive here already signed in as the
// shared guest account (lib/community.js communityGuest), so upstream's
// routes serve them like anyone else.
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { userMgmtActive } from '../middleware/auth.js';
import {
  communityMode, cleanGuestName, nameBelongsToAccount,
  GUEST_NAME_COOKIE, GUEST_NAME_COOKIE_OPTS,
} from '../lib/community.js';
import {
  hydrateRecipe,
  matchSummary,
  buildStockSet,
} from '../lib/recipe-hydrate.js';

const router = Router();

// Skip everything unless community mode is on and accounts exist (with no
// accounts the instance is single-user and already open).
router.use((req, res, next) => {
  if (!communityMode() || !userMgmtActive()) return next('router');
  next();
});

function authorNames() {
  const map = new Map();
  for (const u of db.prepare(`SELECT id, full_name FROM users`).all()) map.set(u.id, u);
  return map;
}

// The author badge: full name, or the username up to any '@' (usernames
// are email addresses on many installs).
function displayName(row, authors) {
  const a = row.user_id != null ? authors.get(row.user_id) : null;
  if (a?.full_name) return a.full_name;
  const handle = (row.created_by_username || '').split('@')[0];
  return handle || null;
}

// ── Everyone else's recipes, merged into the main list ─────────────────
// The client mixes /shared-with-me into the Recipes tab, so returning
// every other account's public recipes here is what merges "Recipes" and
// "Shared". A hidden recipe still reaches people it was shared with
// directly.
router.get('/recipes/shared-with-me', wrap((req, res, next) => {
  if (!req.user) return next();
  const u = req.user.id;
  const rows = db.prepare(
    `SELECT * FROM recipes r
      WHERE r.deleted_at IS NULL AND (r.user_id IS NULL OR r.user_id != ?)
        AND (r.visibility = 'group'
             OR EXISTS (SELECT 1 FROM recipe_shares s WHERE s.recipe_id = r.id AND s.grantee_id = ?))
      ORDER BY r.updated_at DESC`
  ).all(u, u);
  const authors = authorNames();
  const catMap = new Map();
  for (const c of db.prepare(`SELECT id, name, slug, color FROM recipe_categories`).all()) catMap.set(c.id, c);
  const stockSet = buildStockSet(u);
  res.json(rows.map(row => {
    const r = hydrateRecipe(row, catMap);
    delete r.share_token;
    const name = displayName(row, authors);
    return {
      ...r,
      created_by_username: name,
      pantry_match: matchSummary(r.ingredients, stockSet),
      shared_with_me: true,
      shared_by: name,
      via_kitchen_id: null,
      via_kitchen_name: null,
    };
  }));
}));

// ── A visitor's name (lib/community.js) ────────────────────────────────
// Body: { name }. Kept in a cookie in this browser; DELETE forgets it.
router.post('/community/name', wrap((req, res) => {
  if (!req.user?.ourfamilyGuest) return res.status(400).json({ error: 'Signed in: your account name is used' });
  const name = cleanGuestName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Enter a name (up to 40 characters)' });
  if (nameBelongsToAccount(name)) {
    return res.status(409).json({ error: 'Someone here has an account with that name. Sign in, or use a different name.' });
  }
  res.cookie(GUEST_NAME_COOKIE, name, GUEST_NAME_COOKIE_OPTS);
  res.json({ name });
}));

router.delete('/community/name', (req, res) => {
  res.clearCookie(GUEST_NAME_COOKIE, { ...GUEST_NAME_COOKIE_OPTS, maxAge: undefined });
  res.json({ name: null });
});

// ── Merge a visitor's name into an account ─────────────────────────────
// Everything a visitor added under a name (recipes, comments, cooks)
// lives in the guest account. Merging moves it to a real account, e.g.
// once "Alice" has made one. Open to anyone, like the rest of the app.
// 'guest' stands for things added before visitors gave names.
function _guestId() {
  const v = db.prepare(`SELECT value FROM app_config WHERE key = 'ourfamily_guest_user_id'`).get()?.value;
  return v != null ? Number(v) : null;
}

router.get('/community/names', wrap((req, res) => {
  const g = _guestId();
  const counts = new Map();
  const add = (rows, field) => {
    for (const { name, n } of rows) {
      if (!name) continue;
      const c = counts.get(name) || { name, recipes: 0, comments: 0, cooks: 0 };
      c[field] += n;
      counts.set(name, c);
    }
  };
  if (g != null) {
    add(db.prepare(
      `SELECT created_by_username AS name, COUNT(*) AS n FROM recipes
        WHERE user_id = ? AND deleted_at IS NULL GROUP BY created_by_username`).all(g), 'recipes');
    add(db.prepare(
      `SELECT created_by_username AS name, COUNT(*) AS n FROM recipe_comments
        WHERE user_id = ? AND deleted_at IS NULL GROUP BY created_by_username`).all(g), 'comments');
    add(db.prepare(
      `SELECT COALESCE(n.name, 'guest') AS name, COUNT(*) AS n FROM cook_diary cd
         LEFT JOIN ourfamily_cook_names n ON n.cook_id = cd.id
        WHERE cd.user_id = ? AND cd.deleted_at IS NULL GROUP BY COALESCE(n.name, 'guest')`).all(g), 'cooks');
  }
  const accounts = db.prepare(
    `SELECT id, COALESCE(full_name, username) AS name FROM users
      WHERE id IS NOT ? ORDER BY name COLLATE NOCASE`
  ).all(g);
  const names = [...counts.values()].sort((a, b) =>
    (a.name === 'guest') - (b.name === 'guest') || a.name.localeCompare(b.name));
  res.json({ names, accounts });
}));

router.post('/community/names/merge', wrap((req, res) => {
  const g = _guestId();
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  const to = Number(req.body?.user_id);
  if (g == null || !name) return res.status(400).json({ error: 'Pick a name' });
  const target = db.prepare(`SELECT id, username FROM users WHERE id = ?`).get(to);
  if (!target || target.id === g) return res.status(400).json({ error: 'Pick an account' });

  const moved = db.transaction(() => {
    // Categories are per account: point each recipe at the account's
    // category with the same slug, adding it to the account if missing.
    const recipes = db.prepare(
      `SELECT r.id, c.name AS cat_name, c.slug, c.color FROM recipes r
         LEFT JOIN recipe_categories c ON c.id = r.category_id
        WHERE r.user_id = ? AND r.created_by_username = ?`
    ).all(g, name);
    const catFor = db.prepare(`SELECT id FROM recipe_categories WHERE user_id = ? AND slug = ?`);
    const addCat = db.prepare(
      `INSERT INTO recipe_categories (user_id, name, slug, color, sort_order)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM recipe_categories WHERE user_id = ?))`);
    const moveRecipe = db.prepare(
      `UPDATE recipes SET user_id = ?, created_by_username = ?, category_id = ? WHERE id = ?`);
    for (const r of recipes) {
      let cat = null;
      if (r.slug) {
        cat = catFor.get(target.id, r.slug)?.id
          ?? Number(addCat.run(target.id, r.cat_name, r.slug, r.color, target.id).lastInsertRowid);
      }
      moveRecipe.run(target.id, target.username, cat, r.id);
    }
    const comments = db.prepare(
      `UPDATE recipe_comments SET user_id = ?, created_by_username = ?
        WHERE user_id = ? AND created_by_username = ?`
    ).run(target.id, target.username, g, name).changes;
    const cookIds = name === 'guest'
      ? db.prepare(`SELECT id FROM cook_diary WHERE user_id = ?
                      AND id NOT IN (SELECT cook_id FROM ourfamily_cook_names)`).all(g)
      : db.prepare(`SELECT cd.id FROM cook_diary cd JOIN ourfamily_cook_names n ON n.cook_id = cd.id
                     WHERE cd.user_id = ? AND n.name = ?`).all(g, name);
    const moveCook = db.prepare(`UPDATE cook_diary SET user_id = ? WHERE id = ?`);
    const forget = db.prepare(`DELETE FROM ourfamily_cook_names WHERE cook_id = ?`);
    for (const { id } of cookIds) { moveCook.run(target.id, id); forget.run(id); }
    return { recipes: recipes.length, comments, cooks: cookIds.length };
  })();
  res.json({ name, user_id: target.id, ...moved });
}));

// ── Names on the guest account's cook log ──────────────────────────────
// Upstream's cook log shows the account's name; for the guest account
// that's the visitor's, kept in ourfamily_cook_names.
function _rememberNewCooks(req, res, next) {
  if (!req.user?.ourfamilyGuest || !req.user.guestName) return next();
  const before = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM cook_diary`).get().m;
  const json = res.json.bind(res);
  res.json = body => {
    if (res.statusCode < 300) {
      db.prepare(
        `INSERT OR REPLACE INTO ourfamily_cook_names (cook_id, name)
         SELECT id, ? FROM cook_diary WHERE id > ? AND user_id = ?`
      ).run(req.user.guestName, before, req.user.id);
    }
    return json(body);
  };
  next();
}
router.post('/recipes/:id/cooked', _rememberNewCooks);
router.post('/cook-diary', _rememberNewCooks);

function _nameCooks(req, res, next) {
  const json = res.json.bind(res);
  res.json = body => {
    if (Array.isArray(body) && body.length) {
      const get = db.prepare(`SELECT name FROM ourfamily_cook_names WHERE cook_id = ?`);
      for (const row of body) {
        if (row?.id == null) continue;
        const n = get.get(row.id)?.name;
        if (n) { row.cooked_by_username = n; row.cooked_by_full_name = n; }
      }
    }
    return json(body);
  };
  next();
}
router.get('/recipes/:id/cooks', _nameCooks);
router.get('/cook-diary', _nameCooks);

// ── Hide / unhide a recipe ─────────────────────────────────────────────
// Body: { hidden: true | false }. Only the recipe's owner, signed in to a
// real account. Hidden = upstream's 'private': the owner (and anyone it
// was shared with directly) still sees it, nobody else does.
router.put('/community/recipes/:id/hidden', wrap((req, res) => {
  if (!req.user || req.user.ourfamilyGuest) return res.status(403).json({ error: 'Sign in to hide your recipes' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const row = db.prepare(`SELECT user_id FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: 'Only the owner can hide a recipe' });
  const visibility = req.body?.hidden ? 'private' : 'group';
  db.prepare(`UPDATE recipes SET visibility = ?, updated_at = datetime('now') WHERE id = ?`).run(visibility, id);
  res.json({ id, visibility, hidden: visibility !== 'group' });
}));

// ── Kitchens (households) as a side tab ────────────────────────────────
// Kitchens stay as upstream has them (Settings → Kitchens, roles, Sous
// Chef editing). Since every recipe is already visible, the Recipes page
// uses them as a filter: its Kitchens tab shows recipes by the members of
// a kitchen you're in. One call with the member ids, instead of one
// /kitchens/:id/members call per kitchen.
router.get('/community/kitchens', wrap((req, res) => {
  if (!req.user || req.user.ourfamilyGuest) return res.json([]);
  const kitchens = db.prepare(
    `SELECT k.id, k.name, m.role
       FROM kitchens k
       JOIN kitchen_members m ON m.kitchen_id = k.id
      WHERE m.user_id = ?
      ORDER BY k.name COLLATE NOCASE ASC`
  ).all(req.user.id);
  const members = db.prepare(
    `SELECT km.user_id, COALESCE(u.full_name, u.username) AS name
       FROM kitchen_members km JOIN users u ON u.id = km.user_id
      WHERE km.kitchen_id = ?`
  );
  res.json(kitchens.map(k => ({ ...k, members: members.all(k.id) })));
}));

export default router;

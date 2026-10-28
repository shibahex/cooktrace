// ourfamily fork: households (see lib/households.js).
//
// Mounted inside routes/community.js, so only in community mode.
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import {
  activeHousehold, canUseHousehold, canManageHousehold, memberRole,
  householdAccountId, householdSettings, saveHouseholdSettings,
  guestHouseholdAccess, setGuestHouseholdAccess, systemAccountIds,
  householdStockNames, matchByName,
} from '../lib/households.js';

const router = Router();

const isGuest = req => !!req.user?.ourfamilyGuest;
const isAdmin = req => req.user?.role === 'admin' && !isGuest(req);
const personName = u => u?.full_name || (u?.username || '').split('@')[0] || null;

function _kitchen(id) {
  return Number.isInteger(id) ? db.prepare(`SELECT * FROM kitchens WHERE id = ?`).get(id) : null;
}

// ── Pantry and shopping belong to the household ────────────────────────
// Served as the picked household's account. With no household picked
// (or one this person can't use), reads come back empty and writes ask
// for a household.
function asHousehold(req, res, next) {
  // The Android app (signed in by bearer token) keeps upstream's
  // per-account pantry and syncs it; households are a web-app thing.
  if (!req.user || req.authVia === 'bearer') return next();
  const kid = activeHousehold(req);
  if (kid == null) {
    if (req.method === 'GET') return res.json([]);
    return res.status(409).json({ error: 'Pick a household first (top of the Pantry or Shopping page).', need_household: true });
  }
  const acct = householdAccountId(kid);
  const row = db.prepare(`SELECT username FROM users WHERE id = ?`).get(acct);
  req.ourfamilyRealUser = req.user;
  req.user = { id: acct, username: row?.username, role: 'user', ourfamilyHousehold: kid };
  next();
}
router.use(['/pantry', '/shopping'], asHousehold);

// "N of M in stock" on recipe lists, against the picked household's pantry.
function householdMatch(req, res, next) {
  const kid = activeHousehold(req);
  if (kid == null) return next();
  const json = res.json.bind(res);
  res.json = body => {
    if (Array.isArray(body) && res.statusCode < 300) {
      const names = householdStockNames(kid);
      for (const r of body) if (r && Array.isArray(r.ingredients)) r.pantry_match = matchByName(r.ingredients, names);
    }
    return json(body);
  };
  next();
}
router.get(['/recipes', '/recipes/shared-with-me'], householdMatch);

// ── New recipes straight into a household ──────────────────────────────
// The web app sends X-Ourfamily-Household on a create when the person
// picked one in the editor (lib/community-name.js).
function assignNewRecipes(req, res, next) {
  const kid = Number(req.get('x-ourfamily-household'));
  if (!kid || !req.user || !canUseHousehold(req.user, kid)) return next();
  const before = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM recipes`).get().m;
  const json = res.json.bind(res);
  res.json = body => {
    if (res.statusCode < 300) {
      db.prepare(
        `INSERT OR REPLACE INTO ourfamily_recipe_households (recipe_id, kitchen_id)
         SELECT id, ? FROM recipes WHERE id > ? AND user_id = ?`
      ).run(kid, before, req.user.id);
    }
    return json(body);
  };
  next();
}
router.post([
  '/recipes', '/recipes/scrape', '/recipes/import', '/recipes/import-zip/commit',
  '/recipes/extract-and-parse', '/recipes/bulk-commit',
], assignNewRecipes);

// ── Households ──────────────────────────────────────────────────────────
router.get('/community/households', wrap((req, res) => {
  const me = req.user;
  const kitchens = db.prepare(
    `SELECT k.id, k.name, k.owner_user_id, u.full_name, u.username
       FROM kitchens k LEFT JOIN users u ON u.id = k.owner_user_id
      ORDER BY k.name COLLATE NOCASE`
  ).all();
  const membersQ = db.prepare(
    `SELECT km.user_id, km.role, u.full_name, u.username
       FROM kitchen_members km JOIN users u ON u.id = km.user_id
      WHERE km.kitchen_id = ? ORDER BY (km.role = 'owner') DESC, COALESCE(u.full_name, u.username) COLLATE NOCASE`
  );
  const recipesQ = db.prepare(
    `SELECT h.recipe_id FROM ourfamily_recipe_households h JOIN recipes r ON r.id = h.recipe_id
      WHERE h.kitchen_id = ? AND r.deleted_at IS NULL`
  );
  const households = kitchens.map(k => {
    const s = householdSettings(k.id);
    const myRole = me && !isGuest(req) ? memberRole(k.id, me.id) : null;
    return {
      id: k.id,
      name: k.name,
      owner_name: personName(k),
      members: membersQ.all(k.id).map(m => ({ user_id: m.user_id, name: personName(m), role: m.role })),
      join_policy: s.join_policy,
      guests: s.guests,
      my_role: myRole,
      can_use: canUseHousehold(me, k.id),
      can_join: !!me && !isGuest(req) && !myRole && (s.join_policy === 'open' || isAdmin(req)),
      can_manage: canManageHousehold(me, k.id),
      recipe_ids: recipesQ.all(k.id).map(r => r.recipe_id),
    };
  });
  // What this person has in their own (pre-household) pantry and list,
  // so the app can offer to move it into a household.
  const personal = me ? {
    pantry:   db.prepare(`SELECT COUNT(*) AS n FROM pantry_items WHERE user_id = ? AND deleted_at IS NULL AND in_stock = 1`).get(me.id).n,
    shopping: db.prepare(`SELECT COUNT(*) AS n FROM shopping_list WHERE user_id = ? AND deleted_at IS NULL`).get(me.id).n,
  } : { pantry: 0, shopping: 0 };
  res.json({
    households,
    guest_access: guestHouseholdAccess(),
    is_admin: isAdmin(req),
    is_guest: isGuest(req),
    active_id: activeHousehold(req),
    personal,
  });
}));

function _slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'household';
}

router.post('/community/households', wrap((req, res) => {
  if (!req.user || isGuest(req)) return res.status(403).json({ error: 'Sign in to start a household' });
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 80) return res.status(400).json({ error: 'Name required (up to 80 characters)' });
  const base = _slugify(name);
  let slug = base;
  for (let i = 2; db.prepare(`SELECT 1 FROM kitchens WHERE slug = ?`).get(slug); i++) slug = `${base}-${i}`;
  const id = db.transaction(() => {
    const kid = Number(db.prepare(`INSERT INTO kitchens (name, slug, owner_user_id) VALUES (?, ?, ?)`)
      .run(name, slug, req.user.id).lastInsertRowid);
    db.prepare(`INSERT INTO kitchen_members (kitchen_id, user_id, role) VALUES (?, ?, 'owner')`).run(kid, req.user.id);
    saveHouseholdSettings(kid, {
      join_policy: req.body?.join_policy,
      guests: req.body?.guests === undefined ? true : !!req.body.guests,
    });
    return kid;
  })();
  householdAccountId(id);
  res.status(201).json({ id, name });
}));

router.put('/community/households/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const k = _kitchen(id);
  if (!k) return res.status(404).json({ error: 'Not found' });
  if (!canManageHousehold(req.user, id)) return res.status(403).json({ error: 'Only its owner or an admin can change it' });
  const { name, join_policy, guests } = req.body || {};
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n || n.length > 80) return res.status(400).json({ error: 'Name required (up to 80 characters)' });
    db.prepare(`UPDATE kitchens SET name = ? WHERE id = ?`).run(n, id);
    const acct = householdAccountId(id);
    db.prepare(`UPDATE users SET full_name = ? WHERE id = ?`).run(n, acct);
  }
  saveHouseholdSettings(id, { join_policy, guests: guests === undefined ? undefined : !!guests });
  res.json({ ok: true });
}));

router.delete('/community/households/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!_kitchen(id)) return res.status(404).json({ error: 'Not found' });
  if (!canManageHousehold(req.user, id)) return res.status(403).json({ error: 'Only its owner or an admin can delete it' });
  db.prepare(`DELETE FROM kitchens WHERE id = ?`).run(id);
  res.json({ ok: true });
}));

router.post('/community/households/:id/join', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!_kitchen(id)) return res.status(404).json({ error: 'Not found' });
  if (!req.user || isGuest(req)) return res.status(403).json({ error: 'Sign in to join a household' });
  if (memberRole(id, req.user.id)) return res.json({ ok: true });
  if (householdSettings(id).join_policy !== 'open' && !isAdmin(req)) {
    return res.status(403).json({ error: 'This household is invite only. Ask its owner to add you.' });
  }
  db.prepare(`INSERT OR IGNORE INTO kitchen_members (kitchen_id, user_id, role) VALUES (?, ?, 'member')`).run(id, req.user.id);
  res.json({ ok: true });
}));

router.post('/community/households/:id/leave', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!req.user || isGuest(req)) return res.status(403).json({ error: 'Not a member' });
  if (memberRole(id, req.user.id) === 'owner') {
    return res.status(400).json({ error: 'The owner can\'t leave. Make someone else the owner, or delete the household.' });
  }
  db.prepare(`DELETE FROM kitchen_members WHERE kitchen_id = ? AND user_id = ?`).run(id, req.user.id);
  res.json({ ok: true });
}));

// People who could be added (accounts, not the guest or household ones).
router.get('/community/people', wrap((req, res) => {
  if (!req.user || isGuest(req)) return res.json([]);
  const system = systemAccountIds();
  res.json(db.prepare(`SELECT id, full_name, username FROM users ORDER BY COALESCE(full_name, username) COLLATE NOCASE`)
    .all().filter(u => !system.has(u.id)).map(u => ({ id: u.id, name: personName(u) })));
}));

router.post('/community/households/:id/members', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!_kitchen(id)) return res.status(404).json({ error: 'Not found' });
  if (!canManageHousehold(req.user, id)) return res.status(403).json({ error: 'Only its owner or an admin can add people' });
  const uid = Number(req.body?.user_id);
  if (!db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(uid) || systemAccountIds().has(uid)) {
    return res.status(400).json({ error: 'Pick a person' });
  }
  db.prepare(`INSERT OR IGNORE INTO kitchen_members (kitchen_id, user_id, role) VALUES (?, ?, 'member')`).run(id, uid);
  res.json({ ok: true });
}));

router.delete('/community/households/:id/members/:uid', wrap((req, res) => {
  const id = Number(req.params.id);
  const uid = Number(req.params.uid);
  if (!canManageHousehold(req.user, id) && req.user?.id !== uid) return res.status(403).json({ error: 'Forbidden' });
  if (memberRole(id, uid) === 'owner') return res.status(400).json({ error: 'The owner can\'t be removed' });
  db.prepare(`DELETE FROM kitchen_members WHERE kitchen_id = ? AND user_id = ?`).run(id, uid);
  res.json({ ok: true });
}));

router.put('/community/households/:id/owner', wrap((req, res) => {
  const id = Number(req.params.id);
  const uid = Number(req.body?.user_id);
  if (!canManageHousehold(req.user, id)) return res.status(403).json({ error: 'Only its owner or an admin can do that' });
  if (!memberRole(id, uid)) return res.status(400).json({ error: 'Add them to the household first' });
  db.transaction(() => {
    db.prepare(`UPDATE kitchen_members SET role = 'member' WHERE kitchen_id = ? AND role = 'owner'`).run(id);
    db.prepare(`UPDATE kitchen_members SET role = 'owner' WHERE kitchen_id = ? AND user_id = ?`).run(id, uid);
    db.prepare(`UPDATE kitchens SET owner_user_id = ? WHERE id = ?`).run(uid, id);
  })();
  res.json({ ok: true });
}));

// Move this person's own pantry and shopping list into a household
// (for what was there before households, or a visitor's shared stash).
router.post('/community/households/:id/move-personal', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!req.user || !canUseHousehold(req.user, id)) return res.status(403).json({ error: 'Not your household' });
  const acct = householdAccountId(id);
  const me = req.user.id;
  const moved = db.transaction(() => {
    // Pantry categories are per account: point items at the household's
    // category with the same slug, adding it if missing.
    const cats = db.prepare(`SELECT * FROM pantry_categories WHERE user_id = ?`).all(me);
    const catMap = new Map();
    for (const c of cats) {
      let target = db.prepare(`SELECT id FROM pantry_categories WHERE user_id = ? AND slug = ?`).get(acct, c.slug)?.id;
      if (!target) {
        target = Number(db.prepare(
          `INSERT INTO pantry_categories (user_id, name, slug, icon, color, sort_order, default_aisle)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(acct, c.name, c.slug, c.icon, c.color, c.sort_order, c.default_aisle).lastInsertRowid);
      }
      catMap.set(c.id, target);
    }
    const items = db.prepare(`SELECT id, category_id FROM pantry_items WHERE user_id = ?`).all(me);
    const moveItem = db.prepare(`UPDATE pantry_items SET user_id = ?, category_id = ? WHERE id = ?`);
    for (const it of items) moveItem.run(acct, it.category_id != null ? catMap.get(it.category_id) ?? null : null, it.id);
    const shopping = db.prepare(`UPDATE shopping_list SET user_id = ? WHERE user_id = ?`).run(acct, me).changes;
    return { pantry: items.length, shopping };
  })();
  res.json(moved);
}));

// ── Admin: who can get into households ─────────────────────────────────
router.get('/community/permissions', wrap((req, res) => {
  res.json({ guest_access: guestHouseholdAccess() });
}));
router.put('/community/permissions', wrap((req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only' });
  if (req.body?.guest_access !== undefined) setGuestHouseholdAccess(req.body.guest_access);
  res.json({ guest_access: guestHouseholdAccess() });
}));

// ── A recipe's household ───────────────────────────────────────────────
router.get('/community/recipes/:id/household', wrap((req, res) => {
  const row = db.prepare(
    `SELECT k.id, k.name FROM ourfamily_recipe_households h JOIN kitchens k ON k.id = h.kitchen_id WHERE h.recipe_id = ?`
  ).get(Number(req.params.id));
  res.json({ household_id: row?.id ?? null, household_name: row?.name ?? null });
}));

router.put('/community/recipes/:id/household', wrap((req, res) => {
  const id = Number(req.params.id);
  const recipe = db.prepare(`SELECT user_id FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  if (!req.user || (recipe.user_id !== req.user.id && !isAdmin(req))) {
    return res.status(403).json({ error: 'Only the recipe\'s owner can change its household' });
  }
  const kid = req.body?.household_id == null || req.body.household_id === '' ? null : Number(req.body.household_id);
  if (kid == null) {
    db.prepare(`DELETE FROM ourfamily_recipe_households WHERE recipe_id = ?`).run(id);
    return res.json({ household_id: null, household_name: null });
  }
  if (!canUseHousehold(req.user, kid)) return res.status(403).json({ error: 'You\'re not in that household' });
  db.prepare(`INSERT OR REPLACE INTO ourfamily_recipe_households (recipe_id, kitchen_id) VALUES (?, ?)`).run(id, kid);
  res.json({ household_id: kid, household_name: _kitchen(kid)?.name ?? null });
}));

export default router;

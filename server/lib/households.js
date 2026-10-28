// ourfamily fork: households.
//
// A household is upstream's Kitchen (kitchens + kitchen_members) with a
// few things of its own:
//   - it owns a pantry and a shopping list. Each household has a hidden
//     account (a users row nobody can sign in to) that holds them, and
//     requests to /api/pantry and /api/shopping are served as that
//     account (routes/households.js), so upstream's pantry and shopping
//     code runs unchanged;
//   - recipes can be assigned to a household (ourfamily_recipe_households);
//   - join policy: 'open' (anyone with an account can join) or 'invite'
//     (the owner or an admin adds people);
//   - guest access: with the admin setting 'all', visitors without an
//     account can use every household; with 'invited', only households
//     whose owner ticked "Guests welcome".
// Diary stays per account.
import db from '../db.js';

export function applyHouseholdSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ourfamily_households (
      kitchen_id  INTEGER PRIMARY KEY REFERENCES kitchens(id) ON DELETE CASCADE,
      account_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      join_policy TEXT NOT NULL DEFAULT 'open',
      guests      INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ourfamily_recipe_households (
      recipe_id  INTEGER PRIMARY KEY REFERENCES recipes(id) ON DELETE CASCADE,
      kitchen_id INTEGER NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ourfamily_recipe_households_kitchen
      ON ourfamily_recipe_households(kitchen_id);
    -- A deleted household takes its pantry and shopping list with it.
    CREATE TRIGGER IF NOT EXISTS ourfamily_household_account_cleanup
      BEFORE DELETE ON kitchens
    BEGIN
      DELETE FROM users WHERE id = (SELECT account_id FROM ourfamily_households WHERE kitchen_id = OLD.id);
    END;
  `);
}

// ── Settings ───────────────────────────────────────────────────────────
const GUEST_ACCESS_KEY = 'ourfamily_guest_household_access';

/** 'all' (default): visitors can use every household. 'invited': only
 *  households that welcome guests. */
export function guestHouseholdAccess() {
  const v = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(GUEST_ACCESS_KEY)?.value;
  return v === 'invited' ? 'invited' : 'all';
}
export function setGuestHouseholdAccess(v) {
  db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(GUEST_ACCESS_KEY, v === 'invited' ? 'invited' : 'all');
}

export function householdSettings(kid) {
  const row = db.prepare(`SELECT join_policy, guests FROM ourfamily_households WHERE kitchen_id = ?`).get(kid);
  return { join_policy: row?.join_policy === 'invite' ? 'invite' : 'open', guests: row ? !!row.guests : true };
}
export function saveHouseholdSettings(kid, { join_policy, guests }) {
  db.prepare(`INSERT OR IGNORE INTO ourfamily_households (kitchen_id) VALUES (?)`).run(kid);
  if (join_policy !== undefined) {
    db.prepare(`UPDATE ourfamily_households SET join_policy = ? WHERE kitchen_id = ?`)
      .run(join_policy === 'invite' ? 'invite' : 'open', kid);
  }
  if (guests !== undefined) {
    db.prepare(`UPDATE ourfamily_households SET guests = ? WHERE kitchen_id = ?`).run(guests ? 1 : 0, kid);
  }
}

// ── Who may do what ────────────────────────────────────────────────────
export function memberRole(kid, userId) {
  return db.prepare(`SELECT role FROM kitchen_members WHERE kitchen_id = ? AND user_id = ?`).get(kid, userId)?.role || null;
}

/** Use the household's pantry and shopping list, and assign recipes to it. */
export function canUseHousehold(user, kid) {
  if (!user || !db.prepare(`SELECT 1 FROM kitchens WHERE id = ?`).get(kid)) return false;
  if (user.ourfamilyGuest) {
    return guestHouseholdAccess() === 'all' || householdSettings(kid).guests;
  }
  return user.role === 'admin' || memberRole(kid, user.id) != null;
}

/** Change its settings, members, or delete it. */
export function canManageHousehold(user, kid) {
  if (!user || user.ourfamilyGuest) return false;
  return user.role === 'admin' || memberRole(kid, user.id) === 'owner';
}

// ── The household's own account (holds pantry + shopping) ──────────────
export function householdAccountId(kid) {
  const row = db.prepare(`SELECT account_id FROM ourfamily_households WHERE kitchen_id = ?`).get(kid);
  if (row?.account_id && db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(row.account_id)) return row.account_id;
  const k = db.prepare(`SELECT name FROM kitchens WHERE id = ?`).get(kid);
  if (!k) return null;
  let username = `household-${kid}`;
  for (let n = 2; db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(username); n++) username = `household-${kid}-${n}`;
  const id = Number(db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role) VALUES (?, NULL, ?, 'user')`
  ).run(username, k.name).lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO ourfamily_households (kitchen_id) VALUES (?)`).run(kid);
  db.prepare(`UPDATE ourfamily_households SET account_id = ? WHERE kitchen_id = ?`).run(id, kid);
  // Pantry categories are per account and seeded only at startup: copy
  // the first admin's set.
  const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();
  if (admin) {
    db.prepare(
      `INSERT OR IGNORE INTO pantry_categories (user_id, name, slug, icon, color, sort_order, default_aisle)
       SELECT ?, name, slug, icon, color, sort_order, default_aisle FROM pantry_categories WHERE user_id = ?`
    ).run(id, admin.id);
  }
  return id;
}

/** Accounts that aren't people: the guest account and household accounts. */
export function systemAccountIds() {
  const ids = new Set(db.prepare(`SELECT account_id FROM ourfamily_households WHERE account_id IS NOT NULL`)
    .all().map(r => r.account_id));
  const g = db.prepare(`SELECT value FROM app_config WHERE key = 'ourfamily_guest_user_id'`).get()?.value;
  if (g != null) ids.add(Number(g));
  return ids;
}

// ── The household being used ───────────────────────────────────────────
// The web app keeps the picked household in this cookie (stores/households.js).
export const HOUSEHOLD_COOKIE = 'ct_household';

/** The picked household's id, if the user may use it. */
export function activeHousehold(req) {
  const kid = Number(req.cookies?.[HOUSEHOLD_COOKIE]);
  if (!Number.isInteger(kid) || kid <= 0) return null;
  const user = req.ourfamilyRealUser || req.user;
  return canUseHousehold(user, kid) ? kid : null;
}

// ── "N of M ingredients in stock" against a household's pantry ─────────
// Upstream matches by pantry item id, and those ids belong to whoever
// wrote the recipe. A household pantry is someone else's ids, so match
// on names instead: an ingredient counts when an in-stock item's name is
// the ingredient's name or a whole word in it ("flour" in "bread flour").
export function householdStockNames(kid) {
  const acct = householdAccountId(kid);
  const rows = db.prepare(
    `SELECT id, name, generic_parent_id, in_stock FROM pantry_items WHERE user_id = ? AND deleted_at IS NULL`
  ).all(acct);
  const names = new Set();
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const r of rows) {
    if (!r.in_stock) continue;
    names.add(r.name.trim().toLowerCase());
    const parent = r.generic_parent_id != null ? byId.get(r.generic_parent_id) : null;
    if (parent) names.add(parent.name.trim().toLowerCase());
  }
  return [...names].filter(Boolean);
}

const _escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function matchByName(grouped, stockNames) {
  if (!Array.isArray(grouped)) return { have: 0, need: 0 };
  const res = stockNames.map(n => new RegExp(`(^|[^a-z])${_escape(n)}([^a-z]|$)`));
  let have = 0, need = 0;
  for (const g of grouped) {
    for (const it of (g.items || [])) {
      const name = String(it?.name || '').toLowerCase();
      if (!name.trim()) continue;
      need++;
      if (res.some(re => re.test(name))) have++;
    }
  }
  return { have, need };
}

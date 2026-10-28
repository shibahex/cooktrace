// ourfamily fork: households on the client (server/lib/households.js).
//
// The picked household lives in the ct_household cookie, which the
// server reads to serve /api/pantry and /api/shopping as that household.
import { writable, derived, get } from 'svelte/store';
import { NtApi } from '../lib/api.js';

const COOKIE = 'ct_household';

function _readCookie() {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)ct_household=(\d+)/);
  return m ? Number(m[1]) : null;
}

export const householdsState = writable({
  loaded: false, households: [], guest_access: 'all', is_admin: false, is_guest: false,
  personal: { pantry: 0, shopping: 0 },
});
export const activeHouseholdId = writable(_readCookie());

/** Households this person can use (pantry, shopping, assigning recipes). */
export const usableHouseholds = derived(householdsState, s => s.households.filter(h => h.can_use));
export const activeHousehold = derived([usableHouseholds, activeHouseholdId],
  ([list, id]) => list.find(h => h.id === id) || null);

export function setActiveHousehold(id) {
  const v = id ? Number(id) : null;
  document.cookie = v
    ? `${COOKIE}=${v}; path=/; max-age=31536000; samesite=lax`
    : `${COOKIE}=; path=/; max-age=0; samesite=lax`;
  activeHouseholdId.set(v);
}

let _loading = null;
export function loadHouseholds() {
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const r = await NtApi.get('/api/community/households');
      householdsState.set({ ...r, loaded: true });
      // Keep the pick only while it's usable. With exactly one household
      // to use, pick it.
      const usable = r.households.filter(h => h.can_use);
      const cur = get(activeHouseholdId);
      if (!usable.some(h => h.id === cur)) {
        const mine = usable.filter(h => h.my_role);
        const only = mine.length === 1 ? mine[0] : usable.length === 1 ? usable[0] : null;
        setActiveHousehold(only?.id ?? null);
      }
    } catch {
      householdsState.update(s => ({ ...s, loaded: true }));
    } finally {
      _loading = null;
    }
  })();
  return _loading;
}

/** New recipes made while this is set go into that household (the editor
 *  sets it; lib/community-name.js sends it with the create request). */
export const newRecipeHousehold = writable(null);

// ourfamily fork: keeping the open recipe box from reaching the server's
// own network.
//
// Community mode signs everyone without a session in as one shared guest
// account, so an address saved on that account (a push server, a
// NutriTrace link) is one the whole internet chose. The server must never
// fetch those on the home network.
import { systemAccountIds } from './households.js';
import { envOn } from './outbound-policy.js';

/** True for the shared guest account and the household accounts: not people. */
export function isSystemAccount(userId) {
  if (userId == null) return false;
  try { return systemAccountIds().has(Number(userId)); } catch { return false; }
}

/** May this account's own settings point the server at the home network
 *  (push services, NutriTrace)? A real account yes; the guest and household
 *  accounts never, unless the owner opts in with `envVar`. */
export function lanAllowedFor(userId, envVar) {
  if (envVar && envOn(process.env[envVar])) return true;
  return !isSystemAccount(userId);
}

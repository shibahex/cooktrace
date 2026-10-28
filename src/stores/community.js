// ourfamily fork: community mode on the client (server/lib/community.js).
// The flags live in auth.js, set from /api/auth/status, web only: the
// Android app keeps its own sign-in flow and local copy.
//
// A visitor without an account is signed in as the shared guest account
// by the server, so $currentUser is set for them and the whole app works.
// isGuest marks the few places that differ (sign in instead of sign out,
// no Kitchens, no hiding recipes).
import { derived } from 'svelte/store';
import { communityMode, communityGuest } from './auth.js';

export { communityMode };

/** Using the app as the shared guest account. */
export const isGuest = derived(communityGuest, $g => $g);

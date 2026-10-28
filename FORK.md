# ourfamily fork

This branch (`ourfamily-feats`) is upstream [traceapps/cooktrace](https://github.com/traceapps/cooktrace)
plus a "community mode" for a single family recipe box.

## What community mode changes

- **No sign-in needed.** A visitor without an account is signed in by the
  server as one shared guest account and can use the whole app: add
  and import recipes, pantry, diary, shopping, cookbooks. Everything the
  guest account holds (its recipes, pantry, shopping list, settings) is
  shared by every visitor who hasn't signed in. "Sign in" sits in the
  sidebar (and at `#/login`); signing out drops you back to the guest
  account.
- **Visitors give a name when it matters.** The first time a visitor does
  something that records who did it (add or import a recipe, comment,
  log a cook), the app asks "What's your name?" and then carries on. The
  name is kept in a cookie in that browser (`ct_guest_name`, one year)
  and shows on what they add instead of "guest". They can change it from
  the sidebar. The box offers the names visitors have already used, so
  regulars tap theirs. A name that matches an account's name, nickname or
  username is refused, so nobody can post as someone who has an account.
- **Merge names into accounts.** The **Names** page (sidebar, `#/names`, and Settings → Names)
  lists every name visitors have used, with how many recipes, comments
  and cooks each has. Pick an account and press Merge to move all of it
  to that account (recipes keep their category; it's added to the
  account if it's missing). "No name" covers things added before
  visitors gave names. Like the rest of the app, the page is open to
  anyone, signed in or not.
- **Accounts are optional.** Signing in gives you your own pantry, diary
  and shopping list, and recipes you can hide.
- **Every recipe is public by default, and its owner can hide it.** A
  recipe anyone adds or imports shows up for everyone. On a recipe you
  own, the eye button in its header hides it from everyone but you (and
  anyone you share it with directly); your hidden recipes carry a
  "Hidden" badge in the list. The guest account's recipes can't be
  hidden, since every visitor is the same account. Only a recipe's owner
  (or an admin) can edit or delete it.
- **What Guest can't do:** change its name or password, delete itself,
  link single sign-on, or create or join kitchens.
- **One list.** The separate "Shared" tab is gone; other people's recipes
  sit in the main Recipes list with a badge showing who added them.
- **Kitchens (households) are a side tab.** They work as upstream has
  them (Settings → Kitchens, members, Sous Chef editing), but they're no
  longer how recipes reach people. The Recipes page has a Kitchens tab
  after Cookbooks that filters the full list down to recipes added by the
  members of a kitchen you're in (with a picker if you're in several).

On by default. Set `COMMUNITY_MODE=false` to get upstream behaviour back
(recipes that were made public stay public; the Guest account stays in
the user list but nobody is signed in as it any more).

The author badge uses the person's full name, or the part of the
username before the `@`, so the list doesn't show email addresses.

The Guest account is a normal `user` row with no password (nobody can
sign in to it). Its id is kept in `app_config` (`ourfamily_guest_user_id`).
It's made the first time someone visits after the admin account exists,
and gets a copy of the admin's recipe categories. If an admin deletes it,
a fresh one is made on the next visit (the old one's recipes go with it).

The Android app is unchanged: it still signs in as before. Requests that
carry an `Authorization` header (the app, API tokens) are never treated
as Guest.

## How it's built

Most of the code lives in new files, so upstream merges rarely conflict:

| File | What it does |
| --- | --- |
| `server/lib/community.js` | The `COMMUNITY_MODE` flag; the Guest account and the middleware that signs visitors in as it; SQLite triggers that start every new recipe at `visibility = 'group'` (upstream's existing "everyone can read" value) however it's written, and keep Guest's recipes there. Hidden = upstream's `'private'`. |
| `server/routes/community.js` | Mounted on `/api` ahead of upstream routes: the merged list (everyone else's public recipes), `PUT /api/community/recipes/:id/hidden`, and `/api/community/kitchens` (your kitchens with member ids, for the tab). Calls `next()` for anything it doesn't handle. |
| `src/stores/community.js` | `isGuest` store. |
| `src/lib/community-name.js` | Wraps `fetch` (web only): a 428 `need_name` answer opens the name prompt, saves the name, and sends the request again, so upstream's components need no changes. |
| `src/components/community/GuestNamePrompt.svelte` | The "What's your name?" box. |
| `src/components/community/NamesMerge.svelte` | The list of names and the merge buttons (`GET /api/community/names`, `POST /api/community/names/merge`). Also registers the "Names" title for Settings. |
| `src/routes/CommunityNames.svelte` | The Names page around it (sidebar → Names). |

How the name gets onto things: the server sets `req.user.username` to
the visitor's name for the guest account, and upstream already copies
that into `created_by_username` on recipes and comments. The guest
account has no `full_name`, so the UI falls back to that copy. The cook
log reads names live from the account, so `ourfamily_cook_names` keeps
the name per cook entry and `server/routes/community.js` fills it into
`/api/recipes/:id/cooks` and `/api/cook-diary`. Requests that need a
name are listed in `NEEDS_NAME` in `server/lib/community.js`.

Small edits to upstream files, each marked with an `ourfamily fork` comment:
`server/index.js`, `server/routes/auth.js`, `src/stores/auth.js`,
`src/App.svelte`, `src/components/layout/Sidebar.svelte`, `src/routes/Settings.svelte` (Names section), `src/routes/Wizard.svelte`, `src/stores/settings.js` (header gradient off by default),
`src/routes/{Login,Recipes,RecipeView}.svelte`.

To list them: `git grep -n "ourfamily fork"`.

## Pulling upstream updates

```sh
git remote add upstream https://github.com/traceapps/cooktrace.git   # once
git checkout ourfamily-feats
git fetch upstream
git merge upstream/main
```

If a merge conflicts, it will be in one of the marked lines above: keep
upstream's change and re-apply the one-line fork tweak.

## Running it (Docker)

`.github/workflows/ourfamily-docker.yml` builds this branch on every push
and publishes `ghcr.io/shibahex/cooktrace:ourfamily` (amd64 + arm64).
Each build is also tagged `:ourfamily-<commit>` for rolling back.

```yaml
services:
  cooktrace:
    image: ghcr.io/shibahex/cooktrace:ourfamily
    container_name: cooktrace
    ports:
      - "3003:3003"
    volumes:
      - /opt/cooktrace/db:/data/db
      - /opt/cooktrace/uploads:/data/uploads
    environment:
      JWT_SECRET: <openssl rand -base64 48>
      DB_PATH: /data/db/cooktrace.db
      UPLOADS_PATH: /data/uploads
      # Only if people open it over plain http:// (no HTTPS in front):
      # INSECURE_COOKIES: "1"
    restart: unless-stopped
```

The first time: in the fork's GitHub settings enable Actions, and after
the first build make the package public (GitHub → your profile →
Packages → cooktrace → Package settings → Change visibility), or log the
server in with `docker login ghcr.io`.

Switching an existing upstream install over is just the `image:` line;
the database is upgraded in place on start (recipes become public once).

## Test instance (Docker)

`docker-compose.test.yml` builds an image from this checkout and runs it on
http://localhost:3004, with its own Docker volumes so it never touches a
real install. Not for production (fixed JWT secret, cookies over plain HTTP).

```sh
docker compose -f docker-compose.test.yml up -d --build   # build + start (rebuild after code changes)
docker compose -f docker-compose.test.yml logs -f         # logs
docker compose -f docker-compose.test.yml down            # stop, keep data
docker compose -f docker-compose.test.yml down -v         # stop and wipe data
```

`.dockerignore` skips `node_modules` at every level (upstream only skipped
the root one), so a local `server/node_modules` built for your machine
doesn't get copied into the Alpine image.

## Tests

One upstream test (`scripts/android-sync.test.js`) expects new recipes to
be private, which community mode deliberately changes.

`scripts/public-url.test.js` reads `server/index.js` as text and expects
the admin-address middleware right after `authenticate`, so the
`communityGuest` line sits after it, just before `csrfProtect`. Run the suite with
the mode off:

```sh
COMMUNITY_MODE=false npm test
```

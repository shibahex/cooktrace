# ourfamily fork

This branch (`ourfamily-feats`) is upstream [traceapps/cooktrace](https://github.com/traceapps/cooktrace)
plus a "community mode" for a single family recipe box.

## What community mode changes

- **No sign-in needed.** A visitor without an account is signed in by the
  server as one shared guest account and can use the whole app: add
  and import recipes, pantry, diary, shopping, cookbooks. Everything the
  guest account holds (its recipes, diary, settings) is shared by every
  visitor who hasn't signed in. "Sign in" sits in the
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
- **Each guest has their own Trace chat.** Guests share one account, so
  their Trace chat history is kept per browser instead (a random id in the
  `ct_guest_chat` cookie, table `ourfamily_guest_ai_history`), handled in
  `server/routes/community.js` ahead of upstream's `/api/ai/history`.
  Signed-in accounts keep their own history as before.
- **Merge names into accounts.** The **Names** page (sidebar, `#/names`, and Settings → Names)
  lists every name visitors have used, with how many recipes, comments
  and cooks each has. Pick an account and press Merge to move all of it
  to that account (recipes keep their category; it's added to the
  account if it's missing). "No name" covers things added before
  visitors gave names. Like the rest of the app, the page is open to
  anyone, signed in or not.
- **Accounts are optional.** Signing in gives you your own diary,
  recipes you can hide, and households you can join or start.
- **Every recipe is public by default, and its owner can hide it.** A
  recipe anyone adds or imports shows up for everyone. On a recipe you
  own, the eye button in its header hides it from everyone but you (and
  anyone you share it with directly); your hidden recipes carry a
  "Hidden" badge in the list. The guest account's recipes can't be
  hidden, since every visitor is the same account.
- **Anyone can edit or delete any recipe**, guests included: edit, delete
  (it goes to the trash), rate, favorite, version history, cook log
  entries, share links. Its owner keeps its category and whether it's
  hidden. Ratings and favorites are shared, one per recipe.
- **What Guest can't do:** change its name or password, delete itself,
  link single sign-on, or start or join households (it can still use
  them, see below).
- **One list.** The separate "Shared" tab is gone; other people's recipes
  sit in the main Recipes list with a badge showing who added them.
- **Households own the pantry and the shopping list.** A family has
  several households; each has one pantry and one shopping list shared by
  its members. The diary stays per person. Pantry and Shopping show which
  household you're in (tap it to switch); with none picked they show the
  households to pick, join or start. "Move" offers to bring what you had
  in your own pantry and list from before into the household.
- **Anyone can arrange households.** By default everyone, guests
  included, can start households and manage any of them in Settings →
  Households: add or remove people, make someone the owner, who can join
  by themselves, "Guests welcome", rename, delete. People with an account
  can also join open households themselves, and leave. An admin can limit
  managing to each household's owner (and admins) in Settings →
  Permissions. A household a guest starts has no owner.
- **Guests and households.** Settings → Permissions (admins) also sets
  whether guests can
  use every household (default, as open as possible), or only households
  that tick "Guests welcome". Guests pick a household the same way.
- **Recipes can belong to a household.** The editor has a Household
  field (it starts on the household you're in), and a recipe's byline
  shows its household; anyone can change it there. The Recipes page
  has a Households tab after Cookbooks: an "All households" card (every
  household's recipes, grouped by household), a card per household, and a
  Manage card. Every card in the lists carries its household's badge. The
  Recipes tab always lists every recipe. Recipes stay visible to everyone.
- **"In stock" counts use the household's pantry**, matching ingredient
  names ("flour" covers "bread flour").
- **Backups can go to a network share (SMB).** Settings → Backup → Full
  Backup → "Copy to network share" (admins). Enter the share
  (`\\nas\backups`), an optional folder in it, username and password
  (blank username = guest). Then, all optional:
  - **Back up to the share every N days at a time** (0 = off). Makes a
    full backup and copies it there. If the share can't be reached, the
    same backup is retried every hour (saving the settings retries on
    the next check). Backups on the server's own disk then follow Auto
    Backup's "Keep last".
  - **Keep the newest N backups on the share** (0 = all); older ones on
    the share are deleted after each copy.
  - **Also copy backups made by hand or by Auto Backup.**
  "Test connection" makes the folder if needed and writes and deletes a
  small file. Each row in the backup list has a "copy to share" button;
  the last copy, any error and the next scheduled run show under the
  heading. The password is stored encrypted. Needs `smbclient`, which the
  Docker image installs.

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

The Android app is unchanged: it still signs in as before, and keeps
upstream's per-account pantry and shopping list (households are a
web-app thing). Requests that
carry an `Authorization` header (the app, API tokens) are never treated
as Guest.

## How it's built

Most of the code lives in new files, so upstream merges rarely conflict:

| File | What it does |
| --- | --- |
| `server/lib/community.js` | The `COMMUNITY_MODE` flag; the Guest account and the middleware that signs visitors in as it; SQLite triggers that start every new recipe at `visibility = 'group'` (upstream's existing "everyone can read" value) however it's written, and keep Guest's recipes there. Hidden = upstream's `'private'`. |
| `server/routes/community.js` | Mounted on `/api` ahead of upstream routes: the merged list (everyone else's public recipes), `PUT /api/community/recipes/:id/hidden`, visitor names and the Names merge. Calls `next()` for anything it doesn't handle. |
| `server/lib/households.js` | Households: tables (`ourfamily_households`: join policy, guests, the household's hidden account; `ourfamily_recipe_households`), who may use or manage one, the guest-access setting, name-based stock matching. |
| `server/routes/households.js` | Serves `/api/pantry` and `/api/shopping` as the picked household's account (cookie `ct_household`, web only), files new recipes under the household sent in `X-Ourfamily-Household`, and `/api/community/households…`, `/people`, `/permissions`, `/recipes/:id/household`. |
| `src/stores/community.js` | `isGuest` store. |
| `src/lib/community-name.js` | Wraps `fetch` (web only): a 428 `need_name` answer opens the name prompt, saves the name, and sends the request again, so upstream's components need no changes. |
| `src/components/community/GuestNamePrompt.svelte` | The "What's your name?" box. |
| `src/components/community/NamesMerge.svelte` | The list of names and the merge buttons (`GET /api/community/names`, `POST /api/community/names/merge`). Also registers the "Names" title for Settings. |
| `src/routes/CommunityNames.svelte` | The Names page around it (sidebar → Names). |
| `src/stores/households.js` | Households list, the picked household (cookie), and the household for a new recipe. |
| `src/components/community/HouseholdScope.svelte` | Wraps the Pantry and Shopping routes: the household switcher, or the picker when none is picked. |
| `src/components/community/HouseholdList.svelte` | Pick, join, start; with `manage`, members and settings. |
| `src/components/community/HouseholdCards.svelte` | The household cards on the Recipes page's Households tab. |
| `src/components/community/{HouseholdField,RecipeHousehold}.svelte` | Household in the recipe editor, and in a recipe's byline. |
| `src/components/community/{SettingsHouseholds,SettingsPermissions}.svelte` | Settings → Households (instead of Kitchens) and Settings → Permissions. |
| `server/lib/smb-backup.js`, `server/routes/smb-backup.js` | Copying full backups to an SMB share with `smbclient` (password via a private `-A` file, never the command line). Settings in `app_config` (`ourfamily_smb_*`), served at `/api/backup-smb` (admin). |
| `src/components/community/SmbBackupSettings.svelte` | The SMB section in Settings → Backup. |

Each household's pantry and list live under a hidden `users` row (`household-<id>`, no password), so upstream's pantry and shopping code needs no change. These rows and the guest account are left out of every list of people. Deleting a household deletes its row, and so its pantry and list.

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
`src/App.svelte`, `src/components/layout/Sidebar.svelte`, `src/routes/Settings.svelte` (Names, Households, Permissions), `src/routes/RecipeEditor.svelte` (Household field), `src/routes/Wizard.svelte`, `src/stores/settings.js` (header gradient off by default),
`src/routes/{Login,Recipes,RecipeView}.svelte`, `server/routes/full-backup.js`, `server/lib/scheduler.js` and `src/components/settings/SettingsBackup.svelte` (SMB copies), `Dockerfile` (`samba-client`), `src/lib/aiChat.js` and `src/components/ai/Trace.svelte` (Trace: no tool-round cap; `get_recipes` covers everyone's recipes with owner/household filters and no 100-row cap; new `list_households` and `set_recipe_household` tools).

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

Two upstream tests in `scripts/android-sync.test.js` fail with the mode on, by design: one expects new recipes to be private, one posts to the web shopping list with no household picked.

`scripts/public-url.test.js` reads `server/index.js` as text and expects
the admin-address middleware right after `authenticate`, so the
`communityGuest` line sits after it, just before `csrfProtect`. Run the suite with
the mode off:

```sh
COMMUNITY_MODE=false npm test
```

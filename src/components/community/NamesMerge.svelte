<!-- ourfamily fork: merge the names visitors used into accounts
     (server/routes/community.js). Used by the Names page and by
     Settings → Names. Open to anyone, like the rest of the app. -->
<script context="module">
  import { addMessages } from 'svelte-i18n';
  // Settings looks section titles up by key; this one is the fork's own.
  addMessages('en', { settings: { names: { section: 'Names' } } });
  addMessages('es', { settings: { names: { section: 'Nombres' } } });
</script>

<script>
  import { onMount } from 'svelte';
  import { NtApi } from '../../lib/api.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';

  let names = [];
  let accounts = [];
  let loading = true;
  let picks = {};      // name -> account id
  let busy = null;     // name being merged

  async function load() {
    try {
      const r = await NtApi.get('/api/community/names');
      names = r.names || [];
      accounts = r.accounts || [];
      // Preselect an account whose name matches, when there is one.
      for (const n of names) {
        if (picks[n.name] != null) continue;
        const match = accounts.find(a => a.name.toLowerCase() === n.name.toLowerCase()
          || a.name.toLowerCase().split(' ')[0] === n.name.toLowerCase());
        picks[n.name] = match ? match.id : '';
      }
    } catch (e) {
      showError(e.message || 'Could not load names');
    } finally {
      loading = false;
    }
  }

  const label = n => (n === 'guest' ? 'No name' : n);
  const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  function summary(n) {
    return [n.recipes && plural(n.recipes, 'recipe'), n.comments && plural(n.comments, 'comment'),
            n.cooks && plural(n.cooks, 'cook')].filter(Boolean).join(' · ') || 'Nothing';
  }

  async function merge(n) {
    const to = accounts.find(a => a.id === Number(picks[n.name]));
    if (!to) return;
    const ok = await confirmDialog({
      title: `Merge "${label(n.name)}" into ${to.name}?`,
      message: `${summary(n)} will belong to ${to.name}'s account. This can't be undone from here.`,
      confirmText: 'Merge',
    });
    if (!ok) return;
    busy = n.name;
    try {
      const r = await NtApi.post('/api/community/names/merge', { name: n.name, user_id: to.id });
      showSuccess(`Moved ${summary(r)} to ${to.name}`);
      delete picks[n.name];
      await load();
    } catch (e) {
      showError(e.message || 'Could not merge');
    } finally {
      busy = null;
    }
  }

  onMount(load);
</script>

<div class="names-merge">
  <p class="intro">
    People who use the app without an account add things under the name they typed.
    Merge a name into an account to move everything added under it (recipes, comments,
    cooks) to that account.
  </p>

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if names.length === 0}
    <div class="empty">
      <span class="material-symbols-rounded">badge</span>
      <p>Nothing has been added without an account yet.</p>
    </div>
  {:else}
    <ul class="names">
      {#each names as n (n.name)}
        <li class="name-row card">
          <div class="who">
            <span class="name" class:unnamed={n.name === 'guest'}>{label(n.name)}</span>
            <span class="muted">{summary(n)}</span>
          </div>
          <div class="merge">
            <select class="input" bind:value={picks[n.name]} aria-label={`Account for ${label(n.name)}`}>
              <option value="">Pick an account…</option>
              {#each accounts as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
            </select>
            <button class="btn btn-primary" disabled={!picks[n.name] || busy != null} on:click={() => merge(n)}>
              {busy === n.name ? 'Merging…' : 'Merge'}
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .intro { color: var(--text-2); font-size: 14px; line-height: 1.5; margin: 0 0 16px; }
  .muted { color: var(--text-3); font-size: 13px; }
  .names { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .name-row {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
    padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-md, 12px);
    background: var(--surface-1);
  }
  .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .name { font-weight: 600; font-size: 16px; overflow-wrap: anywhere; }
  .name.unnamed { font-style: italic; color: var(--text-2); }
  .merge { display: flex; gap: 8px; flex: 1 1 260px; justify-content: flex-end; }
  .merge select { flex: 1; min-width: 0; max-width: 260px; }
  .empty { text-align: center; color: var(--text-3); padding: 48px 0; }
  .empty .material-symbols-rounded { font-size: 40px; }
</style>

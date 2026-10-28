<!-- ourfamily fork: asks a visitor without an account for their name
     (lib/community-name.js). -->
<script>
  import { tick } from 'svelte';
  import { closeOnBack } from '../../lib/back-stack.js';
  import { portal } from '../../lib/portal.js';
  import { push } from 'svelte-spa-router';
  import { namePrompt, saveGuestName, cancelGuestName } from '../../lib/community-name.js';
  import { currentUser } from '../../stores/auth.js';
  import { apiUrl } from '../../lib/platform.js';

  let name = '';
  let error = '';
  let busy = false;
  let input;
  let known = [];   // names visitors have already used, to pick from

  // Narrowed by what is typed; the exact name already typed drops out.
  $: q = name.trim().toLowerCase();
  $: suggestions = known
    .filter(n => n.toLowerCase() !== q && (!q || n.toLowerCase().includes(q)))
    .slice(0, 8);

  async function _loadKnown() {
    try {
      const r = await fetch(apiUrl('/api/community/names'), { credentials: 'include' });
      const body = await r.json();
      known = (body.names || []).map(n => n.name).filter(n => n && n !== 'guest');
    } catch { known = []; }
  }

  function pick(n) { name = n; save(); }

  $: open = !!$namePrompt;
  $: if (open) _onOpen();

  async function _onOpen() {
    name = $currentUser?.guest_name || '';
    error = '';
    _loadKnown();
    await tick();
    input?.focus();
  }

  async function save() {
    if (busy) return;
    busy = true; error = '';
    try { await saveGuestName(name); }
    catch (e) { error = e.message; }
    finally { busy = false; }
  }

  function signIn() { cancelGuestName(); push('/login'); }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="gn-backdrop" on:click={cancelGuestName} use:closeOnBack={cancelGuestName}
    role="dialog" aria-modal="true" aria-labelledby="gn-title">
    <div class="gn-box" on:click|stopPropagation>
      <h3 id="gn-title">{$namePrompt?.reason === 'change' ? 'Change your name' : "What's your name?"}</h3>
      <p class="gn-hint">It goes on the recipes, comments and cooks you add, so the family knows who they're from. It's remembered in this browser.</p>
      <form on:submit|preventDefault={save}>
        <input class="input" bind:this={input} bind:value={name} maxlength="40"
          placeholder="Your name" autocomplete="name" aria-label="Your name" />
        {#if suggestions.length}
          <div class="gn-known" aria-label="Names already used">
            {#each suggestions as n (n)}
              <button type="button" class="gn-chip" on:click={() => pick(n)} disabled={busy}>{n}</button>
            {/each}
          </div>
        {/if}
        {#if error}<p class="gn-error">{error}</p>{/if}
        <div class="gn-actions">
          <button type="button" class="btn btn-secondary" on:click={cancelGuestName}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Continue'}</button>
        </div>
      </form>
      <button type="button" class="gn-signin" on:click={signIn}>Have an account? Sign in</button>
    </div>
  </div>
{/if}

<style>
  .gn-backdrop {
    /* Above everything, import dialogs (1200) and pickers (9999) included:
       it can open while one of them shows "Fetching recipe…". */
    position: fixed; inset: 0; z-index: 10000;
    background: var(--overlay, rgba(0, 0, 0, 0.55));
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .gn-box {
    width: 100%; max-width: 380px;
    background: var(--surface-1, var(--bg));
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 16px);
    box-shadow: var(--shadow-lg);
    padding: 20px;
  }
  h3 { margin: 0 0 6px; font-size: 18px; }
  .gn-hint { margin: 0 0 14px; font-size: 13px; color: var(--text-2); line-height: 1.4; }
  .gn-known { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .gn-chip {
    border: 1px solid var(--border); background: var(--surface-2, transparent); color: var(--text-1);
    border-radius: var(--radius-full, 999px); padding: 5px 12px; font-size: 13px; cursor: pointer;
  }
  .gn-chip:hover { border-color: var(--accent); }
  .gn-error { margin: 8px 0 0; font-size: 13px; color: var(--danger); }
  .gn-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .gn-signin {
    display: block; margin: 14px auto 0; background: none; border: 0;
    color: var(--accent); font-size: 13px; cursor: pointer;
  }
</style>

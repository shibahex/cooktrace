<!-- ourfamily fork: Pantry and Shopping belong to a household. Shows which
     one (with a switcher) above the page, or a picker when none is picked.
     Wraps upstream's page via the route in App.svelte, so the page itself
     is unchanged. -->
<script>
  import { onMount } from 'svelte';
  import Sheet from '../ui/Sheet.svelte';
  import HouseholdList from './HouseholdList.svelte';
  import { NtApi } from '../../lib/api.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { communityMode } from '../../stores/community.js';
  import {
    householdsState, activeHousehold, loadHouseholds,
  } from '../../stores/households.js';

  export let component;
  export let what = 'pantry';     // 'pantry' | 'shopping'

  let pickerOpen = false;
  let moving = false;
  let moveDismissed = false;

  onMount(() => { if ($communityMode) loadHouseholds(); });
  $: if ($communityMode && !s.loaded) loadHouseholds();

  $: s = $householdsState;
  $: personalCount = (s.personal?.pantry || 0) + (s.personal?.shopping || 0);
  $: offerMove = !!$activeHousehold && personalCount > 0 && !moveDismissed;

  async function moveIn() {
    moving = true;
    try {
      const r = await NtApi.post(`/api/community/households/${$activeHousehold.id}/move-personal`, {});
      showSuccess(`Moved ${r.pantry} pantry item${r.pantry === 1 ? '' : 's'} and ${r.shopping} shopping item${r.shopping === 1 ? '' : 's'}`);
      // Reload so the page under it shows what moved.
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      showError(e.message || 'Could not move them');
    } finally {
      moving = false;
    }
  }
</script>

{#if !$communityMode}
  <svelte:component this={component} />
{:else if !s.loaded}
  <div class="hh-wait"><p class="muted">Loading…</p></div>
{:else if $activeHousehold}
  <div class="hh-bar">
    <button class="hh-switch" on:click={() => (pickerOpen = true)} title="Switch household">
      <span class="material-symbols-rounded">home</span>
      <span class="hh-switch-name">{$activeHousehold.name}</span>
      <span class="material-symbols-rounded hh-caret">expand_more</span>
    </button>
    <span class="hh-what">Shared {what === 'pantry' ? 'pantry' : 'shopping list'}</span>
  </div>
  {#if offerMove}
    <div class="hh-move">
      <span>You have things in your own {s.personal.pantry ? 'pantry' : 'shopping list'} from before households. Move them into {$activeHousehold.name}?</span>
      <span class="hh-move-actions">
        <button class="btn btn-secondary btn-sm" on:click={() => (moveDismissed = true)}>Not now</button>
        <button class="btn btn-primary btn-sm" on:click={moveIn} disabled={moving}>{moving ? 'Moving…' : 'Move'}</button>
      </span>
    </div>
  {/if}
  {#key $activeHousehold.id}
    <div class="hh-page"><svelte:component this={component} /></div>
  {/key}
{:else}
  <div class="hh-gate">
    <span class="material-symbols-rounded hh-gate-icon">home</span>
    <h2>Pick a household</h2>
    <p class="muted">
      {what === 'pantry' ? 'The pantry' : 'The shopping list'} belongs to a household, shared by everyone in it.
      {s.is_guest ? 'Pick one to use.' : 'Pick one you\'re in, join one, or start your own.'}
    </p>
    <HouseholdList />
  </div>
{/if}

<Sheet bind:open={pickerOpen} title="Households">
  <div class="hh-sheet"><HouseholdList on:picked={() => (pickerOpen = false)} /></div>
</Sheet>

<style>
  /* The switcher row sits on top of the page's own header and wears the
     same glass background, so the two read as one header. */
  .hh-bar {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    /* Clear the floating menu button the way page headers do. */
    padding: calc(var(--page-top, var(--safe-top, 0px)) + 10px) var(--page-px, 16px) 0
             max(var(--page-px, 16px), var(--hamburger-clearance, 0px));
    min-height: 44px;
    background: var(--glass-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
  }
  /* Its top padding already cleared the status bar; the header under it
     only needs a little (more once it sticks to the top on scroll). */
  .hh-page :global(.page-header) { padding-top: max(6px, var(--safe-top, 0px)); }
  .hh-switch {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--border); background: var(--surface-2, var(--surface-1)); color: var(--text-1);
    border-radius: var(--radius-full, 999px); padding: 6px 12px; font-weight: 600; cursor: pointer;
  }
  .hh-switch .material-symbols-rounded { font-size: 18px; color: var(--accent); }
  .hh-switch .hh-caret { color: var(--text-3); }
  .hh-switch-name { max-width: 50vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hh-what {
    font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
    color: var(--text-3);
  }
  .hh-move {
    display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between;
    margin: 10px var(--page-px, 16px) 0; padding: 10px 12px;
    border: 1px solid var(--border); border-radius: var(--radius-md, 12px); background: var(--surface-1);
    font-size: 13px;
  }
  .hh-move-actions { display: flex; gap: 8px; }
  .hh-gate { max-width: 560px; margin: 0 auto; padding: 48px 16px 120px; text-align: center; }
  .hh-gate :global(.hh-list) { text-align: left; margin-top: 16px; }
  .hh-gate-icon { font-size: 44px; color: var(--accent); }
  .hh-gate h2 { margin: 8px 0; }
  .hh-wait { padding: 48px 16px; text-align: center; }
  .hh-sheet { padding: 0 16px 24px; }
  .muted { color: var(--text-3); font-size: 13px; }
  .btn-sm { padding: 6px 12px; font-size: 13px; }
</style>

<!-- ourfamily fork: the household picker on the Recipes page's Households
     tab. Big cards rather than chips, so they don't read as filters. -->
<script>
  import { createEventDispatcher } from 'svelte';
  import { push } from 'svelte-spa-router';

  export let households = [];
  export let selectedId = null;
  const dispatch = createEventDispatcher();

  const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
</script>

<div class="hc-row" role="radiogroup" aria-label="Household">
  <button class="hc-card" class:active={selectedId === 'all'} role="radio" aria-checked={selectedId === 'all'}
    on:click={() => dispatch('select', 'all')}>
    <span class="hc-icon material-symbols-rounded">holiday_village</span>
    <span class="hc-text">
      <span class="hc-name">All households</span>
      <span class="hc-meta">{count(households.reduce((n, h) => n + h.recipe_ids.length, 0), 'recipe')} · {count(households.length, 'household')}</span>
    </span>
  </button>
  {#each households as h (h.id)}
    <button class="hc-card" class:active={h.id === selectedId} role="radio" aria-checked={h.id === selectedId}
      on:click={() => dispatch('select', h.id)}>
      <span class="hc-icon material-symbols-rounded">home</span>
      <span class="hc-text">
        <span class="hc-name">{h.name}</span>
        <span class="hc-meta">{count(h.recipe_ids.length, 'recipe')} · {count(h.members.length, 'person', 'people')}</span>
      </span>
      {#if h.my_role}<span class="hc-badge">Yours</span>{/if}
    </button>
  {/each}
  <button class="hc-card hc-manage" on:click={() => push('/settings/households')}>
    <span class="hc-icon material-symbols-rounded">manage_accounts</span>
    <span class="hc-text">
      <span class="hc-name">Manage</span>
      <span class="hc-meta">People, new households</span>
    </span>
  </button>
</div>

<style>
  .hc-row {
    display: flex; gap: 10px; overflow-x: auto; padding: 2px 2px 10px; margin-bottom: 8px;
    scrollbar-width: thin; -webkit-overflow-scrolling: touch;
  }
  .hc-card {
    position: relative; flex: 0 0 auto; min-width: 170px; max-width: 240px;
    display: flex; align-items: center; gap: 12px; padding: 12px 14px;
    border: 2px solid var(--border); border-radius: var(--radius-lg, 16px);
    background: var(--surface-1); color: var(--text-1); text-align: left; cursor: pointer;
    transition: border-color .15s, background .15s, transform .15s;
  }
  .hc-card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .hc-card.active {
    border-color: var(--accent);
    background: linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)));
    color: #fff;
  }
  .hc-icon {
    flex: 0 0 auto; width: 40px; height: 40px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center; font-size: 22px;
    background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent);
  }
  .hc-card.active .hc-icon { background: rgba(255, 255, 255, .25); color: #fff; }
  .hc-text { display: flex; flex-direction: column; min-width: 0; }
  .hc-name { font-weight: 700; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hc-meta { font-size: 12px; opacity: .75; white-space: nowrap; }
  .hc-badge {
    position: absolute; top: 6px; right: 8px; font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .05em; opacity: .8;
  }
  .hc-manage { border-style: dashed; min-width: 150px; }
  .hc-manage .hc-icon { background: transparent; border: 1px dashed var(--border); color: var(--text-2); }
</style>

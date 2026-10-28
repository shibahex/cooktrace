<!-- ourfamily fork: the recipe's household, in its byline. Its owner (or an
     admin) can change it right there. -->
<script>
  import { NtApi } from '../../lib/api.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { communityMode } from '../../stores/community.js';
  import { currentUser } from '../../stores/auth.js';
  import { usableHouseholds, loadHouseholds } from '../../stores/households.js';

  export let recipe;

  let current = null;     // { household_id, household_name }
  let loadedFor = null;

  $: if ($communityMode && recipe?.id && loadedFor !== recipe.id) _load(recipe.id);
  $: canChange = !!recipe && !!$currentUser
    && (recipe.user_id === $currentUser.id || $currentUser.role === 'admin');

  async function _load(id) {
    loadedFor = id;
    loadHouseholds();
    try { current = await NtApi.get(`/api/community/recipes/${id}/household`); }
    catch { current = null; }
  }

  async function change(e) {
    const value = e.target.value;
    try {
      current = await NtApi.put(`/api/community/recipes/${recipe.id}/household`, { household_id: value || null });
      showSuccess(current.household_name ? `In ${current.household_name}` : 'Not in a household');
      loadHouseholds();
    } catch (err) { showError(err.message || 'Could not change its household'); }
  }
</script>

{#if $communityMode && current}
  {#if canChange && $usableHouseholds.length}
    <span class="rh">
      <span class="rh-dot">·</span>
      <span class="material-symbols-rounded rh-icon" aria-hidden="true">home</span>
      <select class="rh-select" value={current.household_id ?? ''} on:change={change} aria-label="Household">
        <option value="">No household</option>
        {#each $usableHouseholds as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
      </select>
    </span>
  {:else if current.household_name}
    <span class="rh">
      <span class="rh-dot">·</span>
      <span class="material-symbols-rounded rh-icon" aria-hidden="true">home</span>
      <span>{current.household_name}</span>
    </span>
  {/if}
{/if}

<style>
  .rh { display: inline-flex; align-items: center; gap: 4px; }
  .rh-dot { margin: 0 2px; opacity: .6; }
  .rh-icon { font-size: 15px; color: var(--accent); }
  .rh-select {
    background: none; border: 0; color: inherit; font: inherit; cursor: pointer;
    padding: 0 2px; text-decoration: underline dotted; text-underline-offset: 3px;
  }
</style>

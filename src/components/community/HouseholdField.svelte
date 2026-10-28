<!-- ourfamily fork: which household a recipe belongs to, in the editor.
     New recipe: the pick rides along with the create request
     (stores/households.js newRecipeHousehold). Existing recipe: saved
     straight away. -->
<script>
  import { onMount, onDestroy } from 'svelte';
  import { NtApi } from '../../lib/api.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { communityMode } from '../../stores/community.js';
  import {
    usableHouseholds, activeHousehold, loadHouseholds, newRecipeHousehold,
  } from '../../stores/households.js';

  export let recipeId = null;

  let value = '';
  let ready = false;

  onMount(async () => {
    if (!$communityMode) return;
    await loadHouseholds();
    if (recipeId != null) {
      try {
        const r = await NtApi.get(`/api/community/recipes/${recipeId}/household`);
        value = r.household_id ?? '';
      } catch { value = ''; }
    } else {
      value = $activeHousehold?.id ?? '';
      newRecipeHousehold.set(value || null);
    }
    ready = true;
  });
  onDestroy(() => newRecipeHousehold.set(null));

  async function changed() {
    if (recipeId == null) { newRecipeHousehold.set(value ? Number(value) : null); return; }
    try {
      const r = await NtApi.put(`/api/community/recipes/${recipeId}/household`, { household_id: value || null });
      showSuccess(r.household_name ? `In ${r.household_name}` : 'Not in a household');
    } catch (e) { showError(e.message || 'Could not change its household'); }
  }
</script>

{#if $communityMode && ready && $usableHouseholds.length}
  <label class="field">
    <span class="field-label">Household</span>
    <select class="input" bind:value on:change={changed}>
      <option value="">None</option>
      {#each $usableHouseholds as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
    </select>
  </label>
{/if}

<style>
  /* Same look as the editor's own fields (its styles are scoped to it). */
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
</style>

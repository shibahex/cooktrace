<!-- ourfamily fork: Settings → Households (in place of upstream's Kitchens
     section in community mode). -->
<script context="module">
  import { addMessages } from 'svelte-i18n';
  addMessages('en', { settings: { households: { section: 'Households' }, permissions: { section: 'Permissions' } } });
  addMessages('es', { settings: { households: { section: 'Hogares' }, permissions: { section: 'Permisos' } } });
</script>

<script>
  import HouseholdList from './HouseholdList.svelte';
</script>

<div class="sh">
  <p class="sh-intro">
    A household shares one pantry and one shopping list, and recipes can be filed under it.
    Your diary stays your own. Tap a household to see its members and settings.
  </p>
  <HouseholdList manage />
</div>

<style>
  .sh { padding: 4px 0 24px; display: flex; flex-direction: column; gap: 12px; }
  .sh-intro { margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.5; }
</style>

<!-- ourfamily fork: the Names page (sidebar → Names). The list itself is
     components/community/NamesMerge.svelte, also shown in Settings → Names. -->
<script>
  import { bannerStyle } from '../stores/settings.js';
  import NamesMerge from '../components/community/NamesMerge.svelte';
</script>

<div class="page-shell">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>Names</h1>
  </header>
  <div class="names-page"><NamesMerge /></div>
</div>

<style>
  .names-page { padding: 16px var(--page-px, 16px) 96px; max-width: 720px; margin: 0 auto; }
</style>

<!-- ourfamily fork: copy full backups to an SMB (Windows / Samba / NAS)
     share. Sits inside the Full Backup card in Settings → Backup. -->
<script context="module">
  import { writable } from 'svelte/store';
  /** True once a share is saved, so backup rows can offer "copy to share". */
  export const smbReady = writable(false);
</script>

<script>
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import TimePicker from '../ui/TimePicker.svelte';
  import { NtApi } from '../../lib/api.js';
  import { showSuccess, showError } from '../../stores/toast.js';

  let cfg = null;          // saved settings from the server
  let form = null;         // what's being edited
  let password = '';       // blank = keep the saved one
  let clearPassword = false;
  let open = false;
  let saving = false;
  let testing = false;

  export async function load() {
    try {
      cfg = await NtApi.get('/api/backup-smb');
      form = { ...cfg };
      password = '';
      clearPassword = false;
      smbReady.set(!!cfg.share);
    } catch { cfg = null; }
  }
  onMount(load);

  function _body() {
    const b = {
      enabled: !!form.enabled, share: form.share, folder: form.folder,
      username: form.username, domain: form.domain, keep: form.keep,
      everyDays: form.everyDays || 0, time: form.time,
    };
    if (password) b.password = password;
    else if (clearPassword) b.password = '';
    return b;
  }

  async function save() {
    saving = true;
    try {
      cfg = await NtApi.put('/api/backup-smb', _body());
      form = { ...cfg };
      password = '';
      clearPassword = false;
      smbReady.set(!!cfg.share);
      showSuccess('SMB backup settings saved');
    } catch (e) { showError(e.message || 'Save failed'); }
    finally { saving = false; }
  }

  async function test() {
    testing = true;
    try {
      const r = await NtApi.post('/api/backup-smb/test', _body());
      showSuccess(`Connected and wrote to ${r.where}`);
    } catch (e) { showError(e.message || 'Test failed'); }
    finally { testing = false; }
  }

  // Called by the backup list's "copy to share" buttons and after a manual
  // backup, so the status line here stays current.
  export async function refreshStatus() {
    try {
      const s = await NtApi.get('/api/backup-smb');
      cfg = { ...cfg, lastUploadAt: s.lastUploadAt, lastUploadFile: s.lastUploadFile, lastError: s.lastError };
    } catch {}
  }

  $: dirty = !!(cfg && form) && (password !== '' || clearPassword
    || ['enabled', 'share', 'folder', 'username', 'domain', 'keep', 'everyDays', 'time'].some(k => String(form[k] ?? '') !== String(cfg[k] ?? '')));

  function _when(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
</script>

{#if cfg && form}
  <div class="smb">
    <button type="button" class="smb-head" on:click={() => (open = !open)} aria-expanded={open}>
      <span class="smb-title">Copy to network share (SMB)</span>
      <span class="smb-pill" class:on={cfg.share && (cfg.everyDays || cfg.enabled)}>
        {!cfg.share ? 'Not set up'
          : cfg.everyDays ? (cfg.everyDays === 1 ? 'Daily' : `Every ${cfg.everyDays} days`)
          : cfg.enabled ? 'On' : 'Manual only'}
      </span>
      <span class="material-symbols-rounded smb-chev" class:open>expand_more</span>
    </button>

    {#if cfg.share && (cfg.lastError || cfg.lastUploadAt || cfg.nextRun)}
      <div class="smb-status">
        {#if cfg.lastError}
          <div class="row error">
            <span class="material-symbols-rounded" style="font-size:16px">error</span>
            <span>Last copy failed: {cfg.lastError}</span>
          </div>
        {/if}
        {#if cfg.lastUploadAt}
          <div class="row">
            <span class="material-symbols-rounded" style="font-size:16px">cloud_done</span>
            <span>Last copied {cfg.lastUploadFile} · {_when(cfg.lastUploadAt)}</span>
          </div>
        {/if}
        {#if cfg.nextRun}
          <div class="row">
            <span class="material-symbols-rounded" style="font-size:16px">schedule</span>
            <span>Next backup to the share: {_when(cfg.nextRun)}</span>
          </div>
        {/if}
      </div>
    {/if}

    {#if open}
      <div class="smb-body" transition:slide={{ duration: 160 }}>
        <p class="setting-desc" style="margin:0">
          Puts a copy of each backup on a Windows, Samba or NAS share, so a dead server
          doesn't take your recipes with it.
        </p>

        <div class="smb-grid">
          <label class="f wide">
            <span class="l">Share</span>
            <input class="input" type="text" placeholder={'\\\\nas\\backups'} bind:value={form.share}
              autocomplete="off" spellcheck="false" />
          </label>
          <label class="f wide">
            <span class="l">Folder on the share (optional)</span>
            <input class="input" type="text" placeholder="CookTrace" bind:value={form.folder}
              autocomplete="off" spellcheck="false" />
          </label>
          <label class="f">
            <span class="l">Username</span>
            <input class="input" type="text" placeholder="blank = guest" bind:value={form.username}
              autocomplete="off" spellcheck="false" />
          </label>
          <label class="f">
            <span class="l">Password</span>
            <input class="input" type="password" bind:value={password} autocomplete="new-password"
              placeholder={cfg.has_password && !clearPassword ? 'Saved (type to change)' : ''}
              on:input={() => (clearPassword = false)} />
            {#if cfg.has_password && !password}
              <button type="button" class="link-btn" on:click={() => (clearPassword = !clearPassword)}>
                {clearPassword ? 'Keep saved password' : 'Remove saved password'}
              </button>
            {/if}
          </label>
          <label class="f">
            <span class="l">Domain / workgroup (optional)</span>
            <input class="input" type="text" placeholder="WORKGROUP" bind:value={form.domain}
              autocomplete="off" spellcheck="false" />
          </label>
        </div>

        <div class="smb-sched">
          <div class="smb-sched-row">
            <span>Back up to the share every</span>
            <input class="input num" type="number" min="0" max="365" bind:value={form.everyDays}
              aria-label="Days between backups (0 = off)" />
            <span>{+form.everyDays === 1 ? 'day' : 'days'}</span>
            {#if +form.everyDays > 0}
              <span>at</span>
              <span class="time"><TimePicker value={form.time} on:change={e => (form.time = e.detail)} /></span>
            {/if}
          </div>
          <div class="smb-sched-row">
            <span>Keep the newest</span>
            <input class="input num" type="number" min="0" max="999" bind:value={form.keep}
              aria-label="Backups to keep on the share (0 = all)" />
            <span>backups on the share</span>
          </div>
          <p class="smb-hint">0 days turns the schedule off. Keep 0 keeps every backup.</p>
          <label class="smb-check">
            <input type="checkbox" bind:checked={form.enabled} />
            <span>Also copy backups made by hand or by Auto Backup</span>
          </label>
        </div>

        <div class="smb-actions">
          <button class="btn btn-primary" style="height:36px;font-size:13px" on:click={save} disabled={saving || !dirty}>
            <span class="material-symbols-rounded" style="font-size:16px">save</span>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button class="btn btn-secondary" style="height:36px;font-size:13px" on:click={test} disabled={testing || !form.share}>
            {#if testing}
              <span class="material-symbols-rounded spin" style="font-size:16px">autorenew</span> Testing…
            {:else}
              <span class="material-symbols-rounded" style="font-size:16px">lan</span> Test connection
            {/if}
          </button>
        </div>
        <p class="smb-hint">
          The test connects, makes the folder if needed, and writes and deletes a small file.
          The password is stored encrypted on the server.
        </p>
      </div>
    {/if}
  </div>
{/if}

<style>
  .smb { display: flex; flex-direction: column; gap: 8px; padding: 4px 0 14px; }
  .smb-head {
    display: flex; align-items: center; gap: 8px; width: 100%;
    background: none; border: 0; padding: 0; cursor: pointer; color: inherit; text-align: left;
  }
  .smb-title {
    font-size: 13px; font-weight: 600; color: var(--text-1);
    text-transform: uppercase; letter-spacing: 0.04em; flex: 1; min-width: 0;
  }
  .smb-pill {
    font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
    background: var(--surface-2); color: var(--text-3); border: 1px solid var(--border);
  }
  .smb-pill.on { color: var(--success, var(--accent)); border-color: currentColor; }
  .smb-chev { font-size: 20px; color: var(--text-3); transition: transform 0.15s; }
  .smb-chev.open { transform: rotate(180deg); }
  .smb-status {
    display: flex; flex-direction: column; gap: 4px; padding: 8px 12px;
    background: var(--surface-2); border-radius: var(--radius-md);
    font-size: 12px; color: var(--text-2);
  }
  .smb-status .row { display: flex; align-items: flex-start; gap: 6px; overflow-wrap: anywhere; }
  .smb-status .row.error { color: var(--danger); }
  .smb-body { display: flex; flex-direction: column; gap: 12px; }
  .smb-check { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-1); cursor: pointer; }
  .smb-check input { flex-shrink: 0; width: 18px; height: 18px; accent-color: var(--accent); margin: 0; }
  .smb-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .f { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .f.wide { grid-column: 1 / -1; }
  .f .input { width: 100%; }
  .l { font-size: 11px; color: var(--text-3); font-weight: 500; }
  .link-btn {
    align-self: flex-start; background: none; border: 0; padding: 0; cursor: pointer;
    font-size: 11.5px; color: var(--accent);
  }
  .smb-sched {
    display: flex; flex-direction: column; gap: 10px; padding: 10px 12px;
    background: var(--surface-2); border-radius: var(--radius-md);
  }
  .smb-sched-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; color: var(--text-1); }
  .smb-sched-row .num { width: 72px; height: 34px; text-align: center; }
  .smb-sched-row .time :global(.tp-trigger) { height: 34px; }
  .smb-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .smb-hint { margin: 0; font-size: 11.5px; color: var(--text-3); }
  @media (max-width: 520px) {
    .smb-grid { grid-template-columns: 1fr; }
  }
</style>

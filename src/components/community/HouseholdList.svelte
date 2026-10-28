<!-- ourfamily fork: households to pick, join or start; with `manage`, also
     members and settings (Settings → Households). -->
<script>
  import { onMount, createEventDispatcher } from 'svelte';
  import { NtApi } from '../../lib/api.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { push } from 'svelte-spa-router';
  import {
    householdsState, activeHouseholdId, setActiveHousehold, loadHouseholds,
  } from '../../stores/households.js';

  export let manage = false;
  const dispatch = createEventDispatcher();

  let newName = '';
  let creating = false;
  let open = {};          // household id -> expanded (manage mode)
  let people = [];        // accounts that can be added
  let addPick = {};       // household id -> user id to add
  let renames = {};       // household id -> name being edited

  $: s = $householdsState;
  $: mine = s.households.filter(h => h.my_role || (s.is_guest && h.can_use));
  $: others = s.households.filter(h => !mine.includes(h) && (!s.is_guest || h.can_use));

  onMount(async () => {
    await loadHouseholds();
    if (manage && !s.is_guest) {
      try { people = await NtApi.get('/api/community/people'); } catch { people = []; }
    }
  });

  async function act(fn, ok) {
    try { await fn(); if (ok) showSuccess(ok); await loadHouseholds(); }
    catch (e) { showError(e.message || 'Something went wrong'); }
  }

  function pick(h) {
    if (!h.can_use) return;
    setActiveHousehold(h.id);
    dispatch('picked', h);
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    creating = true;
    await act(async () => {
      const r = await NtApi.post('/api/community/households', { name });
      setActiveHousehold(r.id);
      newName = '';
      dispatch('picked', r);
    }, `Started ${name}`);
    creating = false;
  }

  const join = h => act(() => NtApi.post(`/api/community/households/${h.id}/join`, {}), `You're in ${h.name}`);
  const save = (h, body, msg) => act(() => NtApi.put(`/api/community/households/${h.id}`, body), msg);

  async function leave(h) {
    if (!(await confirmDialog({ title: `Leave ${h.name}?`, message: 'You lose its pantry and shopping list until you join again.', confirmText: 'Leave' }))) return;
    await act(() => NtApi.post(`/api/community/households/${h.id}/leave`, {}), `Left ${h.name}`);
  }
  async function remove(h) {
    if (!(await confirmDialog({ title: `Delete ${h.name}?`, message: 'Its pantry and shopping list are deleted. Recipes stay, they just lose this household.', confirmText: 'Delete', dangerous: true }))) return;
    await act(() => NtApi.del(`/api/community/households/${h.id}`), `Deleted ${h.name}`);
  }
  async function addMember(h) {
    const uid = Number(addPick[h.id]);
    if (!uid) return;
    await act(() => NtApi.post(`/api/community/households/${h.id}/members`, { user_id: uid }), 'Added');
    addPick[h.id] = '';
  }
  async function removeMember(h, m) {
    if (!(await confirmDialog({ title: `Remove ${m.name}?`, message: `${m.name} loses ${h.name}'s pantry and shopping list.`, confirmText: 'Remove' }))) return;
    await act(() => NtApi.del(`/api/community/households/${h.id}/members/${m.user_id}`), 'Removed');
  }
  async function makeOwner(h, m) {
    if (!(await confirmDialog({ title: `Make ${m.name} the owner?`, message: `${m.name} will manage ${h.name}.`, confirmText: 'Make owner' }))) return;
    await act(() => NtApi.put(`/api/community/households/${h.id}/owner`, { user_id: m.user_id }), `${m.name} owns ${h.name} now`);
  }

  const memberLine = h => h.members.length
    ? h.members.map(m => m.name).join(', ')
    : 'No members yet';
</script>

<div class="hh-list">
  {#if !s.loaded}
    <p class="muted">Loading…</p>
  {:else}
    {#if mine.length}
      <h4 class="hh-head">{s.is_guest ? 'Households' : 'Your households'}</h4>
      {#each mine as h (h.id)}
        <div class="hh-row" class:active={$activeHouseholdId === h.id}>
          <button class="hh-main" on:click={() => (manage ? (open[h.id] = !open[h.id]) : pick(h))}>
            <span class="material-symbols-rounded hh-icon">{$activeHouseholdId === h.id ? 'check_circle' : 'home'}</span>
            <span class="hh-info">
              <span class="hh-name">{h.name}{#if h.my_role === 'owner'} <span class="hh-tag">Owner</span>{/if}</span>
              <span class="muted">{memberLine(h)}</span>
            </span>
            {#if manage}<span class="material-symbols-rounded muted">{open[h.id] ? 'expand_less' : 'expand_more'}</span>{/if}
          </button>
          {#if manage && open[h.id]}
            {@const canManage = h.can_manage}
            <div class="hh-body">
              {#if !s.is_guest && $activeHouseholdId !== h.id}
                <button class="btn btn-secondary btn-sm" on:click={() => pick(h)}>Use for pantry & shopping</button>
              {/if}
              <ul class="hh-members">
                {#each h.members as m (m.user_id)}
                  <li>
                    <span>{m.name}{#if m.role === 'owner'} <span class="hh-tag">Owner</span>{/if}</span>
                    {#if canManage && m.role !== 'owner'}
                      <span class="hh-member-actions">
                        <button class="link" on:click={() => makeOwner(h, m)}>Make owner</button>
                        <button class="link danger" on:click={() => removeMember(h, m)}>Remove</button>
                      </span>
                    {/if}
                  </li>
                {/each}
              </ul>
              {#if canManage}
                <div class="hh-inline">
                  <select class="input" bind:value={addPick[h.id]} aria-label="Add a person">
                    <option value="">Add a person…</option>
                    {#each people.filter(p => !h.members.some(m => m.user_id === p.id)) as p (p.id)}
                      <option value={p.id}>{p.name}</option>
                    {/each}
                  </select>
                  <button class="btn btn-secondary" disabled={!addPick[h.id]} on:click={() => addMember(h)}>Add</button>
                </div>
                <label class="hh-field">
                  <span>Who can join</span>
                  <select class="input" value={h.join_policy} on:change={e => save(h, { join_policy: e.target.value }, 'Saved')}>
                    <option value="open">Anyone with an account</option>
                    <option value="invite">Invite only (you add people)</option>
                  </select>
                </label>
                <label class="hh-check">
                  <input type="checkbox" checked={h.guests} on:change={e => save(h, { guests: e.target.checked }, 'Saved')} />
                  <span>Guests welcome
                    <span class="muted">{s.guest_access === 'all' ? '(an admin lets guests into every household right now)' : '(people without an account can use it)'}</span>
                  </span>
                </label>
                <div class="hh-inline">
                  <input class="input" placeholder="Rename" bind:value={renames[h.id]} maxlength="80" />
                  <button class="btn btn-secondary" disabled={!renames[h.id]?.trim()} on:click={() => { save(h, { name: renames[h.id] }, 'Renamed'); renames[h.id] = ''; }}>Rename</button>
                </div>
              {/if}
              <div class="hh-actions">
                {#if h.my_role && h.my_role !== 'owner'}<button class="btn btn-secondary" on:click={() => leave(h)}>Leave</button>{/if}
                {#if canManage}<button class="btn btn-danger" on:click={() => remove(h)}>Delete household</button>{/if}
              </div>
            </div>
          {/if}
        </div>
      {/each}
    {/if}

    {#if others.length}
      <h4 class="hh-head">{mine.length ? 'Other households' : 'Households'}</h4>
      {#each others as h (h.id)}
        <div class="hh-row">
          <div class="hh-main static">
            <span class="material-symbols-rounded hh-icon">{h.join_policy === 'invite' ? 'lock' : 'home'}</span>
            <span class="hh-info">
              <span class="hh-name">{h.name}</span>
              <span class="muted">
                {h.join_policy === 'invite' ? `Invite only · ask ${h.owner_name || 'its owner'}` : memberLine(h)}
              </span>
            </span>
            {#if s.is_guest && h.can_use && !manage}
              <button class="btn btn-secondary btn-sm" on:click={() => pick(h)}>Use</button>
            {:else if h.can_join}
              <button class="btn btn-primary btn-sm" on:click={() => join(h)}>Join</button>
            {/if}
            {#if manage && h.can_manage}
              <button class="btn btn-secondary btn-sm" on:click={() => (open[h.id] = !open[h.id])}>Manage</button>
            {/if}
          </div>
          {#if manage && open[h.id] && h.can_manage}
            <div class="hh-body">
              <label class="hh-field">
                <span>Who can join</span>
                <select class="input" value={h.join_policy} on:change={e => save(h, { join_policy: e.target.value }, 'Saved')}>
                  <option value="open">Anyone with an account</option>
                  <option value="invite">Invite only</option>
                </select>
              </label>
              <label class="hh-check">
                <input type="checkbox" checked={h.guests} on:change={e => save(h, { guests: e.target.checked }, 'Saved')} />
                <span>Guests welcome</span>
              </label>
              <div class="hh-actions"><button class="btn btn-danger" on:click={() => remove(h)}>Delete household</button></div>
            </div>
          {/if}
        </div>
      {/each}
    {/if}

    {#if !s.households.length}
      <p class="muted">No households yet.</p>
    {/if}

    {#if s.is_guest}
      <p class="muted hh-note">
        {#if !mine.length && s.households.length}None of these let guests in. {/if}
        Want your own household? <button class="link" on:click={() => { dispatch('picked'); push('/login'); }}>Sign in</button>
      </p>
    {:else}
      <form class="hh-inline hh-create" on:submit|preventDefault={create}>
        <input class="input" placeholder="New household name" bind:value={newName} maxlength="80" aria-label="New household name" />
        <button class="btn btn-primary" type="submit" disabled={creating || !newName.trim()}>Start</button>
      </form>
    {/if}
  {/if}
</div>

<style>
  .hh-list { display: flex; flex-direction: column; gap: 8px; }
  .hh-head { margin: 8px 0 0; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); }
  .hh-row { border: 1px solid var(--border); border-radius: var(--radius-md, 12px); background: var(--surface-1); }
  .hh-row.active { border-color: var(--accent); }
  .hh-main {
    display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 14px;
    background: none; border: 0; color: inherit; text-align: left; cursor: pointer;
  }
  .hh-main.static { cursor: default; }
  .hh-icon { color: var(--accent); }
  .hh-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .hh-name { font-weight: 600; }
  .hh-tag { font-size: 11px; font-weight: 600; color: var(--accent); margin-left: 4px; }
  .muted { color: var(--text-3); font-size: 13px; }
  .hh-body { padding: 0 14px 14px 50px; display: flex; flex-direction: column; gap: 10px; }
  .hh-members { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .hh-members li { display: flex; justify-content: space-between; gap: 8px; font-size: 14px; }
  .hh-member-actions { display: flex; gap: 10px; }
  .hh-inline { display: flex; gap: 8px; }
  .hh-inline .input { flex: 1; min-width: 0; }
  .hh-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-2); }
  .hh-check { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; }
  .hh-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .hh-create { margin-top: 8px; }
  .hh-note { margin-top: 4px; }
  .link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font-size: 13px; }
  .link.danger { color: var(--danger); }
  .btn-sm { padding: 6px 12px; font-size: 13px; }
</style>

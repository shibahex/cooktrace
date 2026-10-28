<!-- ourfamily fork: Settings → Permissions (admins). Who can get into
     households without an account. -->
<script>
  import { onMount } from 'svelte';
  import { NtApi } from '../../lib/api.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { householdsState, loadHouseholds } from '../../stores/households.js';

  let guestAccess = 'all';
  let managers = 'anyone';
  let saving = false;

  onMount(async () => {
    await loadHouseholds();
    guestAccess = $householdsState.guest_access || 'all';
    managers = $householdsState.managers || 'anyone';
  });

  async function setAccess(v) { return savePerms({ guest_access: v }); }
  async function setManagers(v) { return savePerms({ managers: v }); }
  async function savePerms(body) {
    saving = true;
    try {
      const r = await NtApi.put('/api/community/permissions', body);
      guestAccess = r.guest_access;
      managers = r.managers;
      showSuccess('Saved');
      await loadHouseholds();
    } catch (e) { showError(e.message || 'Could not save'); }
    finally { saving = false; }
  }

  async function setGuests(h, on) {
    try {
      await NtApi.put(`/api/community/households/${h.id}`, { guests: on });
      await loadHouseholds();
    } catch (e) { showError(e.message || 'Could not save'); }
  }
  async function setPolicy(h, v) {
    try {
      await NtApi.put(`/api/community/households/${h.id}`, { join_policy: v });
      await loadHouseholds();
    } catch (e) { showError(e.message || 'Could not save'); }
  }
</script>

<div class="perm">
  <section>
    <h4>Who can manage households</h4>
    <p class="muted">Managing means adding and removing people, changing settings, renaming, deleting, and starting new households.</p>
    <label class="opt">
      <input type="radio" name="managers" value="anyone" checked={managers === 'anyone'} disabled={saving}
        on:change={() => setManagers('anyone')} />
      <span><strong>Anyone</strong><br />
        <span class="muted">Everyone, guests included, can arrange any household.</span></span>
    </label>
    <label class="opt">
      <input type="radio" name="managers" value="owners" checked={managers === 'owners'} disabled={saving}
        on:change={() => setManagers('owners')} />
      <span><strong>Owners and admins</strong><br />
        <span class="muted">Each household's owner manages it; admins manage all. People with an account can still start their own.</span></span>
    </label>
  </section>

  <section>
    <h4>Guests in households</h4>
    <p class="muted">Guests are people using the app without an account. They can always browse and add recipes.</p>
    <label class="opt">
      <input type="radio" name="guest-access" value="all" checked={guestAccess === 'all'} disabled={saving}
        on:change={() => setAccess('all')} />
      <span><strong>Every household</strong><br />
        <span class="muted">Guests can pick any household and use its pantry and shopping list.</span></span>
    </label>
    <label class="opt">
      <input type="radio" name="guest-access" value="invited" checked={guestAccess === 'invited'} disabled={saving}
        on:change={() => setAccess('invited')} />
      <span><strong>Only households that welcome guests</strong><br />
        <span class="muted">Each household decides below (its owner can too, in Settings → Households).</span></span>
    </label>
  </section>

  <section>
    <h4>Households</h4>
    {#if !$householdsState.households.length}
      <p class="muted">No households yet.</p>
    {:else}
      <table class="hh-table">
        <thead><tr><th>Household</th><th>Who can join</th><th>Guests welcome</th></tr></thead>
        <tbody>
          {#each $householdsState.households as h (h.id)}
            <tr>
              <td><strong>{h.name}</strong><br /><span class="muted">{h.members.length} member{h.members.length === 1 ? '' : 's'}</span></td>
              <td>
                <select class="input" value={h.join_policy} on:change={e => setPolicy(h, e.target.value)}>
                  <option value="open">Anyone</option>
                  <option value="invite">Invite only</option>
                </select>
              </td>
              <td class="center">
                <input type="checkbox" checked={h.guests} on:change={e => setGuests(h, e.target.checked)}
                  aria-label={`Guests welcome in ${h.name}`} />
                {#if guestAccess === 'all'}<span class="muted small">(all allowed now)</span>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
</div>

<style>
  .perm { display: flex; flex-direction: column; gap: 24px; padding: 4px 0 24px; }
  h4 { margin: 0 0 6px; font-size: 15px; }
  .muted { color: var(--text-3); font-size: 13px; }
  .small { font-size: 11px; display: block; }
  .opt { display: flex; gap: 10px; align-items: flex-start; margin-top: 12px; cursor: pointer; font-size: 14px; }
  .opt input { margin-top: 3px; }
  .hh-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .hh-table th { text-align: left; font-size: 12px; color: var(--text-3); font-weight: 600; padding: 6px 8px; }
  .hh-table td { padding: 8px; border-top: 1px solid var(--border); vertical-align: middle; }
  .hh-table .center { text-align: center; }
  .hh-table select { min-width: 120px; }
</style>

<script lang="ts">
import { browser } from '$app/environment';
import { isLiveMode } from '$lib/amplify';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import type { AccountClosureState, OrganizationAccount, Project } from '$lib/services/graphql';
import * as api from '$lib/services/graphql';

let rows = $state<OrganizationAccount[]>([]);
/** Factory projects (same user) — used to resolve which org accounts can use closeProjectAccount. */
let factoryProjects = $state<Project[]>([]);
let loading = $state(false);
let syncing = $state(false);
/** Set when `listOrganizationAccounts` fails (table is hidden). */
let error = $state('');
/** Set when `listProjects` fails; org table can still load — factory “slug” close is unavailable. */
let projectsLoadError = $state('');
let lastSyncMessage = $state('');

const hasLiveBackend = !!(
  import.meta.env.VITE_USER_POOL_ID &&
  import.meta.env.VITE_USER_POOL_CLIENT_ID &&
  import.meta.env.VITE_GRAPHQL_ENDPOINT
);

const DECOMMISSION_ACTIVE = new Set([
  'DISPATCH_DESTROY',
  'TEARDOWN_BOOTSTRAP',
  'UNASSIGN_IDENTITY_CENTER',
  'CLOSE_ACCOUNT',
]);

function decommissionInProgress(phase: string | null | undefined): boolean {
  return DECOMMISSION_ACTIVE.has(phase ?? '');
}

function slugify(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** `joinedTimestamp` is ISO UTC from the API — show locale date + time instead of raw `…T…Z`. */
function formatJoinedDisplay(iso: string | null | undefined): string {
  if (iso == null || !String(iso).trim()) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

const actionLinkClass =
  'inline-flex size-8 shrink-0 items-center justify-center border border-border text-foreground text-xs font-semibold transition-colors hover:bg-muted/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Same footprint as `actionLinkClass`; non-interactive, muted (account already closed). */
const closedBinClass =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-sm border border-border/50 bg-muted/5 text-muted-foreground/45 mt-0.5 pointer-events-none select-none';

type FactoryAccountLink = {
  projectId: string;
  slug: string;
  githubUrl: string | null;
  closureState: AccountClosureState;
  provisioningPhase: string;
  decommissionPhase: string | null;
  decommissionTargetAccountId: string | null;
};

function factoryLinkByAccountId(projects: Project[]): Map<string, FactoryAccountLink> {
  const m = new Map<string, FactoryAccountLink>();
  for (const p of projects) {
    for (const acc of p.accounts) {
      const aid = acc.accountId?.trim();
      if (!aid || m.has(aid)) continue;
      m.set(aid, {
        projectId: p.id,
        slug: p.slug,
        githubUrl: p.githubUrl ?? null,
        closureState: (acc.closureState ?? 'NONE') as AccountClosureState,
        provisioningPhase: p.provisioningPhase,
        decommissionPhase: p.decommissionPhase ?? null,
        decommissionTargetAccountId: p.decommissionTargetAccountId ?? null,
      });
    }
  }
  return m;
}

function canShowCloseForLink(
  link: FactoryAccountLink | undefined,
  a: OrganizationAccount
): boolean {
  if (!link) return false;
  if (a.isManagementAccount) return false;
  if (stateColumnIsClosed(a, link)) return false;
  if (orgInventoryClosure(a) === 'CLOSING') return false;
  if (decommissionInProgress(a.decommissionPhase)) return false;
  return (
    link.provisioningPhase === 'DONE' &&
    link.closureState === 'NONE' &&
    !decommissionInProgress(link.decommissionPhase)
  );
}

function isClosingForLink(link: FactoryAccountLink | undefined, accountId: string): boolean {
  if (!link || link.closureState === 'CLOSED') return false;
  return (
    link.closureState === 'CLOSING' ||
    (decommissionInProgress(link.decommissionPhase) &&
      link.decommissionTargetAccountId === accountId)
  );
}

function orgInventoryClosure(a: OrganizationAccount): AccountClosureState {
  return (a.closureState ?? 'NONE') as AccountClosureState;
}

/** True if inventory or factory marks this account closed (must hide close actions). */
function isOrgRowClosed(a: OrganizationAccount, link: FactoryAccountLink | undefined): boolean {
  return orgInventoryClosure(a) === 'CLOSED' || link?.closureState === 'CLOSED';
}

/**
 * Matches the State column: CLOSED from app closure or from AWS org lifecycle alone.
 * Close column uses this so the bin is grayed whenever State reads "CLOSED".
 */
function stateColumnIsClosed(
  a: OrganizationAccount,
  link: FactoryAccountLink | undefined
): boolean {
  if (isOrgRowClosed(a, link)) return true;
  if (isClosingForLink(link, a.accountId) || isStandaloneClosing(a, link)) return false;
  return (a.state ?? '').trim().toUpperCase() === 'CLOSED';
}

/** Table cell: prefer app closure (factory + inventory) over raw AWS org `state`, which often stays ACTIVE until sync catches up. */
function closureAwareStateDisplay(
  a: OrganizationAccount,
  link: FactoryAccountLink | undefined
): { primary: string; hint?: string } {
  const closedHere = isOrgRowClosed(a, link);
  const closingHere = isClosingForLink(link, a.accountId) || isStandaloneClosing(a, link);
  const aws = (a.state ?? '').trim();

  if (closedHere) {
    if (aws && aws.toUpperCase() !== 'CLOSED') {
      return { primary: 'CLOSED', hint: `AWS Organizations: ${aws}` };
    }
    return { primary: 'CLOSED' };
  }
  if (closingHere) {
    return { primary: 'CLOSING' };
  }
  return { primary: aws || '—' };
}

/** Close via org inventory + Step Functions (no factory project). */
function canShowStandaloneClose(
  a: OrganizationAccount,
  link: FactoryAccountLink | undefined
): boolean {
  if (link) return false;
  if (a.isManagementAccount) return false;
  if (stateColumnIsClosed(a, link)) return false;
  const cs = orgInventoryClosure(a);
  if (cs === 'CLOSING') return false;
  const dp = a.decommissionPhase ?? null;
  if (decommissionInProgress(dp)) return false;
  if (dp && dp !== 'IDLE' && dp !== 'FAILED') return false;
  return true;
}

function isStandaloneClosing(
  a: OrganizationAccount,
  link: FactoryAccountLink | undefined
): boolean {
  if (link) return false;
  if (orgInventoryClosure(a) === 'CLOSED') return false;
  return orgInventoryClosure(a) === 'CLOSING' || decommissionInProgress(a.decommissionPhase);
}

let factoryLinkMap = $derived(factoryLinkByAccountId(factoryProjects));

type OrgSortKey = 'accountId' | 'name' | 'email' | 'state' | 'joined';

let orgSortKey = $state<OrgSortKey | null>(null);
let orgSortDir = $state<'asc' | 'desc'>('asc');

const sortHeadingBtnClass =
  'inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm text-muted-foreground text-xs font-medium tracking-wide uppercase hover:bg-muted/25 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function toggleOrgSort(key: OrgSortKey) {
  if (orgSortKey === key) {
    orgSortDir = orgSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    orgSortKey = key;
    orgSortDir = 'asc';
  }
}

/** A = not CLOSED; middle = all; C = CLOSED only (matches State column primary). */
type OrgLifecycleFilter = 'all' | 'active' | 'closed';

const ORG_LIFECYCLE_FILTER_STORAGE_KEY = 'admin.org-accounts.lifecycleFilter';

function readOrgLifecycleFilterFromStorage(): OrgLifecycleFilter {
  if (!browser) return 'all';
  try {
    const raw = localStorage.getItem(ORG_LIFECYCLE_FILTER_STORAGE_KEY);
    if (raw === 'all' || raw === 'active' || raw === 'closed') return raw;
  } catch {
    /* private mode, quota, etc. */
  }
  return 'all';
}

let orgLifecycleFilter = $state<OrgLifecycleFilter>(readOrgLifecycleFilterFromStorage());

$effect(() => {
  if (!browser) return;
  try {
    localStorage.setItem(ORG_LIFECYCLE_FILTER_STORAGE_KEY, orgLifecycleFilter);
  } catch {
    /* ignore */
  }
});

function orgRowMatchesLifecycleFilter(
  a: OrganizationAccount,
  link: FactoryAccountLink | undefined
): boolean {
  if (orgLifecycleFilter === 'all') return true;
  const primary = closureAwareStateDisplay(a, link).primary;
  if (orgLifecycleFilter === 'active') return primary !== 'CLOSED';
  return primary === 'CLOSED';
}

const lifecycleSegmentClass =
  'relative min-w-[1.75rem] bg-transparent px-2 py-0.5 font-mono text-[0.65rem] font-semibold uppercase transition-[color,box-shadow] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
/** Selected state: border emphasis only (no fill change). */
const lifecycleSegmentInactive = 'text-muted-foreground hover:text-foreground';
const lifecycleSegmentActive = 'z-[1] text-foreground ring-1 ring-foreground ring-inset';

let displayedOrgRows = $derived.by(() => {
  const linkMap = factoryLinkMap;
  const filtered = rows
    .filter((r) => r.accountId?.trim())
    .filter((a) => orgRowMatchesLifecycleFilter(a, linkMap.get(a.accountId)));
  if (orgSortKey === null) return filtered;
  const list = filtered.slice();
  const m = orgSortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    let c = 0;
    switch (orgSortKey) {
      case 'accountId':
        c = a.accountId.localeCompare(b.accountId, undefined, { numeric: true });
        break;
      case 'name':
        c = (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' });
        break;
      case 'email':
        c = (a.email ?? '').localeCompare(b.email ?? '', undefined, { sensitivity: 'base' });
        break;
      case 'state': {
        const da = closureAwareStateDisplay(a, linkMap.get(a.accountId));
        const db = closureAwareStateDisplay(b, linkMap.get(b.accountId));
        c = da.primary.localeCompare(db.primary) || (da.hint ?? '').localeCompare(db.hint ?? '');
        break;
      }
      case 'joined': {
        const ta = a.joinedTimestamp ? Date.parse(a.joinedTimestamp) : 0;
        const tb = b.joinedTimestamp ? Date.parse(b.joinedTimestamp) : 0;
        c = (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
        break;
      }
      default:
        break;
    }
    return c * m;
  });
  return list;
});

let closeAccountDialog = $state<
  | { mode: 'factory'; projectId: string; accountId: string }
  | { mode: 'standalone'; accountId: string }
  | null
>(null);
let closeAccountConfirmInput = $state('');
let closeAccountError = $state('');
let closeAccountRunMonorepoTeardown = $state(true);

function openFactoryCloseDialog(projectId: string, accountId: string) {
  closeAccountDialog = { mode: 'factory', projectId, accountId };
  closeAccountConfirmInput = '';
  closeAccountError = '';
  closeAccountRunMonorepoTeardown = true;
}

function openStandaloneCloseDialog(accountId: string) {
  closeAccountDialog = { mode: 'standalone', accountId };
  closeAccountConfirmInput = '';
  closeAccountError = '';
}

function dismissCloseAccountDialog() {
  closeAccountDialog = null;
  closeAccountConfirmInput = '';
  closeAccountError = '';
  closeAccountRunMonorepoTeardown = true;
}

async function pollProjectDecommission(projectId: string) {
  const POLL_INTERVAL = 5_000;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    try {
      const remote = await api.getProject(projectId);
      if (!remote) break;
      factoryProjects = factoryProjects.map((p) => (p.id === projectId ? remote : p));
      if (!decommissionInProgress(remote.decommissionPhase)) break;
    } catch (err) {
      console.warn(`Decommission poll error for ${projectId}:`, err);
    }
  }
}

async function pollStandaloneOrgDecommission(accountId: string) {
  const POLL_INTERVAL = 5_000;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    try {
      const remote = await api.getOrganizationAccount(accountId);
      if (!remote) break;
      rows = rows.map((row) => (row.accountId === accountId ? remote : row));
      const done =
        remote.closureState === 'CLOSED' ||
        (!decommissionInProgress(remote.decommissionPhase) &&
          orgInventoryClosure(remote) !== 'CLOSING');
      if (done) break;
    } catch (err) {
      console.warn(`Standalone decommission poll error for ${accountId}:`, err);
    }
  }
}

async function confirmCloseAccount() {
  const ctx = closeAccountDialog;
  if (!ctx) return;
  if (ctx.mode === 'standalone') {
    const expected = ctx.accountId.trim();
    if (closeAccountConfirmInput.trim() !== expected) {
      closeAccountError = `Type the account ID exactly: ${expected}`;
      return;
    }
    try {
      const updated = await api.closeStandaloneOrganizationAccount(ctx.accountId);
      rows = rows.map((row) => (row.accountId === updated.accountId ? updated : row));
      dismissCloseAccountDialog();
      void pollStandaloneOrgDecommission(ctx.accountId);
    } catch (e) {
      closeAccountError = (e as Error).message ?? 'Failed to start account closure';
    }
    return;
  }

  const proj = factoryProjects.find((p) => p.id === ctx.projectId);
  if (!proj) return;
  const expected = slugify(proj.slug) || '';
  if (closeAccountConfirmInput.trim() !== expected) {
    closeAccountError = `Type the project slug exactly: ${expected}`;
    return;
  }
  try {
    const updated = await api.closeProjectAccount(
      ctx.projectId,
      ctx.accountId,
      closeAccountRunMonorepoTeardown
    );
    factoryProjects = factoryProjects.map((p) => (p.id === updated.id ? updated : p));
    dismissCloseAccountDialog();
    void pollProjectDecommission(ctx.projectId);
  } catch (e) {
    closeAccountError = (e as Error).message ?? 'Failed to start account closure';
  }
}

async function load() {
  if (!browser || !isLiveMode()) return;
  loading = true;
  error = '';
  projectsLoadError = '';
  try {
    rows = await api.listOrganizationAccounts();
  } catch (e) {
    error =
      (e as Error).message ??
      'Could not load organization accounts from the API. Deploy the latest AppSync schema if you recently changed it.';
    rows = [];
  }
  try {
    factoryProjects = await api.listProjects();
  } catch (e) {
    projectsLoadError =
      (e as Error).message ??
      'Could not load factory projects (slug-based close will not be available).';
    factoryProjects = [];
  } finally {
    loading = false;
  }
}

async function sync() {
  if (!browser || !isLiveMode()) return;
  syncing = true;
  error = '';
  projectsLoadError = '';
  lastSyncMessage = '';
  try {
    const r = await api.syncOrganizationAccounts();
    lastSyncMessage = `Synced ${r.upserted} accounts (${r.removed} removed from inventory).`;
    await load();
  } catch (e) {
    error = (e as Error).message ?? 'Sync failed';
  } finally {
    syncing = false;
  }
}

$effect(() => {
  if (!browser || !isLiveMode()) return;
  void load();
});
</script>

<svelte:head>
  <title>AWS orgs</title>
</svelte:head>

<main
  class="min-h-dvh min-w-0 max-w-full overflow-x-hidden px-6 pt-6 pb-16 md:px-10 md:pt-10 md:pb-20 lg:px-14 lg:pt-12"
>
  <div class="mx-auto w-full min-w-0 max-w-7xl">
    <div
      class="flex flex-wrap items-center justify-end gap-2 border-border border-b pb-6 md:pb-8"
    >
      <Button
        type="button"
        variant="outline"
        size="icon"
        class="rounded-sm border-foreground/40"
        disabled={!hasLiveBackend || !isLiveMode() || syncing}
        aria-busy={syncing}
        aria-label={syncing
          ? 'Syncing organization accounts from AWS'
          : 'Sync organization accounts from AWS'}
        title={syncing ? 'Syncing…' : 'Sync from AWS'}
        onclick={() => void sync()}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="size-4 shrink-0 {syncing ? 'motion-safe:animate-spin' : ''}"
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      </Button>
    </div>

    {#if !hasLiveBackend || !isLiveMode()}
      <p class="mt-8 border-border border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
        Connect the live AppSync backend to load organization inventory.
      </p>
    {:else if loading}
      <p class="mt-8 border-border border border-dashed px-4 py-8 text-center text-muted-foreground text-sm" role="status">
        Loading…
      </p>
    {:else if error}
      <p class="mt-8 border-destructive/50 border border-dashed px-4 py-8 text-destructive text-sm" role="alert">
        {error}
      </p>
    {/if}

    {#if isLiveMode() && hasLiveBackend && !loading && !error && projectsLoadError}
      <p
        class="mt-6 border-amber-500/40 border border-dashed bg-amber-500/10 px-4 py-3 text-amber-950 text-sm dark:bg-amber-500/15 dark:text-amber-100"
        role="status"
      >
        <span class="font-medium">Projects could not be loaded.</span>
        The org accounts table still works; only factory (slug) close is affected.
        <span class="mt-1 block font-mono text-xs opacity-90">{projectsLoadError}</span>
      </p>
    {/if}

    {#if lastSyncMessage}
      <p class="mt-6 text-foreground text-sm" role="status">{lastSyncMessage}</p>
    {/if}

    {#if isLiveMode() && hasLiveBackend && !loading && !error}
      {#if rows.length > 0}
        <div class="mt-3 mb-2 flex justify-end">
          <div
            class="inline-flex overflow-hidden rounded-full border border-border bg-muted/25"
            role="group"
            aria-label="Filter by account state"
          >
            <button
              type="button"
              class="{lifecycleSegmentClass} rounded-l-full border-r border-border {orgLifecycleFilter === 'active'
                ? lifecycleSegmentActive
                : lifecycleSegmentInactive}"
              title="Show active accounts (not closed)"
              aria-pressed={orgLifecycleFilter === 'active'}
              aria-label="Active accounts only"
              onclick={() => {
                orgLifecycleFilter = 'active';
              }}
            >
              A
            </button>
            <button
              type="button"
              class="{lifecycleSegmentClass} min-w-8 border-r border-border {orgLifecycleFilter === 'all'
                ? lifecycleSegmentActive
                : lifecycleSegmentInactive}"
              title="Show all accounts"
              aria-pressed={orgLifecycleFilter === 'all'}
              aria-label="All accounts"
              onclick={() => {
                orgLifecycleFilter = 'all';
              }}
            >
              <span class="sr-only">All</span>
            </button>
            <button
              type="button"
              class="{lifecycleSegmentClass} rounded-r-full {orgLifecycleFilter === 'closed'
                ? lifecycleSegmentActive
                : lifecycleSegmentInactive}"
              title="Show closed accounts only"
              aria-pressed={orgLifecycleFilter === 'closed'}
              aria-label="Closed accounts only"
              onclick={() => {
                orgLifecycleFilter = 'closed';
              }}
            >
              C
            </button>
          </div>
        </div>
      {/if}
      <div
        class="min-w-0 overflow-x-auto border border-border text-sm {rows.length === 0 ? 'mt-8' : ''}"
      >
        {#if rows.length === 0}
          <p class="px-4 py-10 text-center text-muted-foreground">
            No rows yet — use the sync button above to populate DynamoDB.
          </p>
        {:else}
          <table class="w-full min-w-[44rem] border-collapse text-left">
            <thead>
              <tr class="border-border border-b bg-muted/20">
                <th class="px-3 py-3 text-left align-bottom">
                  <button
                    type="button"
                    class="{sortHeadingBtnClass} font-mono"
                    aria-label="Sort by account ID"
                    onclick={() => toggleOrgSort('accountId')}
                  >
                    Account ID
                    <span
                      class="inline-flex shrink-0 flex-col text-[0.45rem] leading-[0.48rem]"
                      aria-hidden="true"
                    >
                      <span
                        class={orgSortKey === 'accountId' && orgSortDir === 'asc'
                          ? 'text-foreground'
                          : 'text-muted-foreground/40'}
                      >▲</span>
                      <span
                        class={orgSortKey === 'accountId' && orgSortDir === 'desc'
                          ? 'text-foreground'
                          : 'text-muted-foreground/40'}
                      >▼</span>
                    </span>
                  </button>
                </th>
                <th class="px-3 py-3 text-left align-bottom">
                  <button
                    type="button"
                    class={sortHeadingBtnClass}
                    aria-label="Sort by name"
                    onclick={() => toggleOrgSort('name')}
                  >
                    Name
                    <span
                      class="inline-flex shrink-0 flex-col text-[0.45rem] leading-[0.48rem]"
                      aria-hidden="true"
                    >
                      <span
                        class={orgSortKey === 'name' && orgSortDir === 'asc'
                          ? 'text-foreground'
                          : 'text-muted-foreground/40'}
                      >▲</span>
                      <span
                        class={orgSortKey === 'name' && orgSortDir === 'desc'
                          ? 'text-foreground'
                          : 'text-muted-foreground/40'}
                      >▼</span>
                    </span>
                  </button>
                </th>
                <th class="px-3 py-3 text-left align-bottom">
                  <button
                    type="button"
                    class={sortHeadingBtnClass}
                    aria-label="Sort by email"
                    onclick={() => toggleOrgSort('email')}
                  >
                    Email
                    <span
                      class="inline-flex shrink-0 flex-col text-[0.45rem] leading-[0.48rem]"
                      aria-hidden="true"
                    >
                      <span
                        class={orgSortKey === 'email' && orgSortDir === 'asc'
                          ? 'text-foreground'
                          : 'text-muted-foreground/40'}
                      >▲</span>
                      <span
                        class={orgSortKey === 'email' && orgSortDir === 'desc'
                          ? 'text-foreground'
                          : 'text-muted-foreground/40'}
                      >▼</span>
                    </span>
                  </button>
                </th>
                <th class="px-3 py-3 text-left align-bottom" title="App closure status when known; otherwise AWS Organizations account State">
                  <button
                    type="button"
                    class={sortHeadingBtnClass}
                    aria-label="Sort by state"
                    onclick={() => toggleOrgSort('state')}
                  >
                    State
                    <span
                      class="inline-flex shrink-0 flex-col text-[0.45rem] leading-[0.48rem]"
                      aria-hidden="true"
                    >
                      <span
                        class={orgSortKey === 'state' && orgSortDir === 'asc'
                          ? 'text-foreground'
                          : 'text-muted-foreground/40'}
                      >▲</span>
                      <span
                        class={orgSortKey === 'state' && orgSortDir === 'desc'
                          ? 'text-foreground'
                          : 'text-muted-foreground/40'}
                      >▼</span>
                    </span>
                  </button>
                </th>
                <th class="px-3 py-3 text-left align-bottom">
                  <button
                    type="button"
                    class="{sortHeadingBtnClass} tabular-nums"
                    aria-label="Sort by joined date"
                    onclick={() => toggleOrgSort('joined')}
                  >
                    Joined at
                    <span
                      class="inline-flex shrink-0 flex-col text-[0.45rem] leading-[0.48rem]"
                      aria-hidden="true"
                    >
                      <span
                        class={orgSortKey === 'joined' && orgSortDir === 'asc'
                          ? 'text-foreground'
                          : 'text-muted-foreground/40'}
                      >▲</span>
                      <span
                        class={orgSortKey === 'joined' && orgSortDir === 'desc'
                          ? 'text-foreground'
                          : 'text-muted-foreground/40'}
                      >▼</span>
                    </span>
                  </button>
                </th>
                <th
                  class="px-3 py-3 font-medium text-foreground text-xs uppercase tracking-wide text-left align-bottom"
                >
                  Close
                </th>
              </tr>
            </thead>
            <tbody>
              {#each displayedOrgRows as a (a.accountId)}
                {@const link = factoryLinkMap.get(a.accountId)}
                {@const stateDisp = closureAwareStateDisplay(a, link)}
                <tr class="border-border border-b last:border-0">
                  <td class="px-3 py-2.5 font-mono text-xs">
                    <span class="inline-flex max-w-full flex-wrap items-baseline gap-1.5">
                      <span class="min-w-0 break-all">{a.accountId}</span>
                      <!-- Always reserve pill width so filtering mgmt in/out does not shift columns -->
                      <span
                        class="shrink-0 rounded-sm border border-neutral-900/90 bg-neutral-900 px-0.5 py-px font-mono text-[0.55rem] font-medium uppercase leading-none tracking-wide text-white {a.isManagementAccount === true
                          ? ''
                          : 'invisible'}"
                        title={a.isManagementAccount === true
                          ? 'Organization management (root) account'
                          : undefined}
                        aria-hidden={a.isManagementAccount !== true}
                      >
                        mgmt
                      </span>
                    </span>
                  </td>
                  <td class="max-w-[12rem] px-3 py-2.5 break-words">{a.name ?? '—'}</td>
                  <td class="max-w-[14rem] px-3 py-2.5 break-words text-muted-foreground">{a.email ?? '—'}</td>
                  <td class="px-3 py-2.5 align-top">
                    <span class="text-foreground">{stateDisp.primary}</span>
                    {#if stateDisp.hint}
                      <span class="mt-0.5 block text-muted-foreground text-xs">{stateDisp.hint}</span>
                    {/if}
                  </td>
                  <td class="px-3 py-2.5 text-muted-foreground text-xs tabular-nums">
                    {formatJoinedDisplay(a.joinedTimestamp)}
                  </td>
                  <td class="px-3 py-2.5 align-top">
                    {#if stateColumnIsClosed(a, link)}
                      <span
                        class="{closedBinClass}"
                        role="img"
                        aria-label="Account closed"
                        title="Closed"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 6h18" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                          <line x1="10" x2="10" y1="11" y2="17" />
                          <line x1="14" x2="14" y1="11" y2="17" />
                        </svg>
                      </span>
                    {:else if isClosingForLink(link, a.accountId)}
                      <span class="mt-0.5 block max-w-[10rem] text-muted-foreground text-xs leading-snug">
                        Closing… {(link?.decommissionPhase ?? '')
                          .toLowerCase()
                          .replaceAll('_', ' ')}
                      </span>
                    {:else if isStandaloneClosing(a, link)}
                      <span class="mt-0.5 block max-w-[10rem] text-muted-foreground text-xs leading-snug">
                        Closing… {(a.decommissionPhase ?? '').toLowerCase().replaceAll('_', ' ')}
                      </span>
                    {:else if canShowCloseForLink(link, a) && link}
                      <button
                        type="button"
                        class="{actionLinkClass} mt-0.5 text-muted-foreground hover:border-destructive/60 hover:text-destructive"
                        title="Remove this AWS account (opens confirmation)"
                        aria-label="Remove AWS account"
                        onclick={() => openFactoryCloseDialog(link.projectId, a.accountId)}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 6h18" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                          <line x1="10" x2="10" y1="11" y2="17" />
                          <line x1="14" x2="14" y1="11" y2="17" />
                        </svg>
                      </button>
                    {:else if canShowStandaloneClose(a, link)}
                      <button
                        type="button"
                        class="{actionLinkClass} mt-0.5 text-muted-foreground hover:border-destructive/60 hover:text-destructive"
                        title="Close this AWS account via org inventory (no factory project)"
                        aria-label="Close AWS organization account"
                        onclick={() => openStandaloneCloseDialog(a.accountId)}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 6h18" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                          <line x1="10" x2="10" y1="11" y2="17" />
                          <line x1="14" x2="14" y1="11" y2="17" />
                        </svg>
                      </button>
                    {:else if link && link.provisioningPhase !== 'DONE'}
                      <span class="mt-0.5 block text-muted-foreground text-xs">Factory provisioning…</span>
                    {:else}
                      <span class="mt-0.5 block text-muted-foreground text-xs">—</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {/if}
  </div>

  {#if closeAccountDialog != null}
    {@const dlg = closeAccountDialog}
    {@const dlgProject = dlg.mode === 'factory' ? factoryProjects.find((x) => x.id === dlg.projectId) : undefined}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      role="presentation"
      onclick={(e) => {
        if (e.target === e.currentTarget) dismissCloseAccountDialog();
      }}
    >
      <div
        class="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-acct-org-title"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <h2 id="close-acct-org-title" class="text-lg font-semibold text-destructive">
          Remove this account
        </h2>
        <div
          class="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3"
          role="alert"
        >
          <p class="text-sm font-semibold text-foreground">
            Are you sure you want to remove this account?
          </p>
          <p class="mt-1.5 text-sm text-muted-foreground">
            This starts closing the AWS member account after automated cleanup. It is permanent: you cannot
            reopen it from here, and data in that account may be lost.
          </p>
        </div>
        <p class="mt-4 text-sm text-muted-foreground">
          The process runs in the background: optional monorepo workflow on GitHub, removal of factory OIDC/IAM
          in the member account, Identity Center unassignment, then <span class="font-mono">CloseAccount</span>
          in AWS Organizations. Remaining resources can still block closure—see AWS if it fails.
        </p>
        {#if dlg.mode === 'standalone'}
          <p class="mt-3 text-sm text-muted-foreground">
            This account is <span class="font-medium text-foreground">not</span> tied to a factory project in this
            app. The GitHub monorepo teardown step is skipped; IAM bootstrap teardown, Identity Center, and
            organization close still run.
          </p>
          <p class="mt-3 font-mono text-xs text-foreground break-all">Account ID: {dlg.accountId}</p>
          <Label for="confirm-acct-id-org" class="mt-4 block text-sm">
            Type account ID <span class="font-mono font-semibold">{dlg.accountId}</span> to confirm
          </Label>
          <Input
            id="confirm-acct-id-org"
            class="mt-1"
            value={closeAccountConfirmInput}
            oninput={(e) => {
              closeAccountConfirmInput = e.currentTarget.value;
            }}
            autocomplete="off"
          />
        {:else if dlgProject}
          <p class="mt-3 font-mono text-xs text-foreground break-all">Account ID: {dlg.accountId}</p>
          {#if dlgProject.githubUrl?.trim()}
            <div class="mt-4 flex gap-3 rounded-md border border-border bg-muted/20 px-3 py-3">
              <input
                id="close-acct-org-monorepo-teardown"
                type="checkbox"
                class="mt-0.5 size-4 shrink-0 rounded border-border accent-primary"
                checked={closeAccountRunMonorepoTeardown}
                onchange={(e) => {
                  closeAccountRunMonorepoTeardown = e.currentTarget.checked;
                }}
              />
              <div class="min-w-0">
                <Label for="close-acct-org-monorepo-teardown" class="text-sm font-medium text-foreground">
                  Run monorepo GitHub teardown
                </Label>
                <p class="mt-1 text-xs leading-snug text-muted-foreground">
                  Dispatches the destroy workflow in the linked repo. Your GitHub App needs
                  <span class="font-medium text-foreground/90">Actions: Read and write</span> on that repo.
                  Uncheck to skip GitHub and only tear down factory IAM, unassign SSO, and close the AWS
                  account.
                </p>
              </div>
            </div>
          {/if}
          <Label for="confirm-slug-org" class="mt-4 block text-sm">
            Type project slug
            <span class="font-mono font-semibold">{slugify(dlgProject.slug) || '—'}</span> to confirm
          </Label>
          <Input
            id="confirm-slug-org"
            class="mt-1"
            value={closeAccountConfirmInput}
            oninput={(e) => {
              closeAccountConfirmInput = e.currentTarget.value;
            }}
            autocomplete="off"
          />
        {/if}
        {#if closeAccountError}
          <p class="mt-2 text-sm text-destructive">{closeAccountError}</p>
        {/if}
        <div class="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" onclick={() => dismissCloseAccountDialog()}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onclick={() => void confirmCloseAccount()}>
            Yes, remove account
          </Button>
        </div>
      </div>
    </div>
  {/if}
</main>

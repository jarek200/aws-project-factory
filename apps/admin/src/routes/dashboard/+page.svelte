<script lang="ts">
import { buildProjectStageWebsiteUrl } from '@admin/core';
import { Accordion } from 'bits-ui';
import { tick } from 'svelte';
import { browser } from '$app/environment';
import { isLiveMode } from '$lib/amplify';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import type {
  Project as ApiProject,
  GithubRepoOption,
  OrganizationAccount,
} from '$lib/services/graphql';
import * as api from '$lib/services/graphql';

type ProjectRow = {
  id: string;
  name: string;
  /** URL-safe id for plus-address email: local+{slug}-{account}@domain */
  slug: string;
  accountNames: string[];
  createdLabel: string;
  templateLabel: string;
  /** GitHub org for new repo + OIDC trust; optional if template is owner/repo */
  githubOrg?: string;
  detailBlurb: string;
  /** App / marketing site */
  websiteUrl: string;
  githubUrl: string;
  /** AWS console / IAM Identity Center sign-in */
  awsSignInUrl: string;
  /** Placeholder account ids for layout only */
  accountHints?: string[];
  /** Per-account AWS spend (USD strings); same length as accountNames; not edited in UI */
  accountCostsLastMonth?: string[];
  accountCostsCurrent?: string[];
  accountCostsPredicted?: string[];
  /** Newly added row: show Save/Cancel until saved */
  isDraft?: boolean;
  /** After save: provisioning progress (github → accounts → configure) */
  provisioning?: ProjectProvisioning | null;
  /** Factory account closure (Step Functions) */
  decommissionPhase?: string | null;
  decommissionError?: string | null;
  decommissionTargetAccountId?: string | null;
  /** Parallel to accountNames: NONE | CLOSING | CLOSED */
  accountClosureStates?: string[];
  /** From API — used for REPO_ONLY “Add AWS” CTA */
  provisioningPhase?: string;
  /** Draft: create GitHub monorepo only (no AWS accounts yet) */
  repoOnlyDraft?: boolean;
  /** REPO_ONLY project: local suffix list while preparing provisionProjectAws */
  awsProvisionAccountNames?: string[];
  /** Draft: link to existing org accounts (skip CreateAccount) vs vend new */
  awsAccountMode?: 'vend' | 'org';
  selectedOrgAccountIds?: string[];
  /** REPO_ONLY: provision flow — org picks vs suffix vend */
  awsProvisionAccountMode?: 'vend' | 'org';
  awsProvisionOrgAccountIds?: string[];
};

type ProvisioningStepKey = 'github' | 'accounts' | 'configure';

type ProvisioningStepState = 'pending' | 'running' | 'done';

type ProjectProvisioning = Record<ProvisioningStepKey, ProvisioningStepState> & {
  /** Overall bar fill 0–100 (github → accounts → configure) */
  progress: number;
};

// ─── Live mode: API integration ───────────────────────────────────────────────

const liveMode = browser && isLiveMode();

const DECOMMISSION_ACTIVE = new Set([
  'DISPATCH_DESTROY',
  'TEARDOWN_BOOTSTRAP',
  'UNASSIGN_IDENTITY_CENTER',
  'CLOSE_ACCOUNT',
]);

function decommissionInProgress(phase: string | null | undefined): boolean {
  return DECOMMISSION_ACTIVE.has(phase ?? '');
}

/** Same criteria as `isLiveMode()` but evaluable during SSR (no `window`). */
const hasLiveBackend = !!(
  import.meta.env.VITE_USER_POOL_ID &&
  import.meta.env.VITE_USER_POOL_CLIENT_ID &&
  import.meta.env.VITE_GRAPHQL_ENDPOINT
);

/** Map an API Project → the UI's ProjectRow shape */
function apiProjectToRow(p: ApiProject): ProjectRow {
  const phase = p.provisioningPhase;
  const github: ProvisioningStepState =
    phase === 'GITHUB' ? 'running' : phase === 'DRAFT' ? 'pending' : 'done';
  const accounts: ProvisioningStepState =
    phase === 'ACCOUNTS' ? 'running' : ['GITHUB', 'DRAFT'].includes(phase) ? 'pending' : 'done';
  const configure: ProvisioningStepState =
    phase === 'CONFIGURE'
      ? 'running'
      : ['GITHUB', 'ACCOUNTS', 'DRAFT'].includes(phase)
        ? 'pending'
        : 'done';

  const repoOnlyInProgress = phase === 'REPO_ONLY' && (p.provisioningProgress ?? 0) < 100;
  const isProvisioningStandard = ['GITHUB', 'ACCOUNTS', 'CONFIGURE'].includes(phase);

  let provisioning: ProjectProvisioning | null | undefined;
  if (repoOnlyInProgress) {
    provisioning = {
      github: 'done',
      accounts: 'pending',
      configure: 'running',
      progress: p.provisioningProgress ?? 0,
    };
  } else if (isProvisioningStandard) {
    provisioning = {
      github,
      accounts,
      configure,
      progress: p.provisioningProgress ?? 0,
    };
  } else if (phase === 'DONE' || phase === 'FAILED' || phase === 'REPO_ONLY') {
    provisioning = null;
  } else {
    provisioning = undefined;
  }

  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    accountNames: p.accounts.map((a) => a.name),
    createdLabel: shortDate(new Date(p.createdAt)),
    templateLabel: p.templateRepo ?? '',
    githubOrg: p.githubOrg ?? '',
    detailBlurb: p.description ?? '',
    websiteUrl: p.websiteUrl ?? '',
    githubUrl: p.githubUrl ?? '',
    awsSignInUrl: p.awsSignInUrl ?? '',
    accountHints: p.accounts.map((a) => a.accountId ?? ''),
    accountCostsLastMonth: p.accounts.map(() => ''),
    accountCostsCurrent: p.accounts.map(() => ''),
    accountCostsPredicted: p.accounts.map(() => ''),
    accountClosureStates: p.accounts.map((a) => a.closureState ?? 'NONE'),
    decommissionPhase: p.decommissionPhase ?? 'IDLE',
    decommissionError: p.decommissionError ?? null,
    decommissionTargetAccountId: p.decommissionTargetAccountId ?? null,
    provisioning,
    provisioningPhase: p.provisioningPhase,
  };
}

function shouldPollProvisioning(remote: ApiProject): boolean {
  const phase = remote.provisioningPhase;
  if (phase === 'FAILED' || phase === 'DONE') return false;
  if (phase === 'REPO_ONLY') return (remote.provisioningProgress ?? 0) < 100;
  return ['GITHUB', 'ACCOUNTS', 'CONFIGURE'].includes(phase);
}

/** Load all projects from the real API and merge into local state */
async function loadProjectsFromApi() {
  try {
    const apiProjects = await api.listProjects();
    projects = apiProjects.map(apiProjectToRow);
    for (const p of apiProjects) {
      if (decommissionInProgress(p.decommissionPhase)) {
        void pollProjectDecommission(p.id);
      }
      if (shouldPollProvisioning(p)) {
        void pollProjectUntilDone(p.id);
      }
    }
  } catch (err) {
    console.error('Failed to load projects:', err);
  } finally {
    apiProjectsLoading = false;
  }
}

let syncingGithub = $state(false);
let githubSyncMessage = $state('');
let githubSyncError = $state('');

async function syncProjectsWithGithub() {
  if (!browser || !hasLiveBackend || !isLiveMode()) return;
  syncingGithub = true;
  githubSyncError = '';
  githubSyncMessage = '';
  try {
    const { ensureAmplifyConfigured } = await import('$lib/amplify');
    await ensureAmplifyConfigured();
    const r = await api.syncProjectsWithGithub();
    const skipped =
      r.skippedInProgress > 0 ? ` Skipped ${r.skippedInProgress} still provisioning.` : '';
    githubSyncMessage =
      r.removed > 0
        ? `Removed ${r.removed} project${r.removed === 1 ? '' : 's'} whose GitHub repo is gone (${r.checked} checked).${skipped}`
        : `No stale projects (${r.checked} checked against GitHub).${skipped}`;
    apiProjectsLoading = true;
    await loadProjectsFromApi();
  } catch (e) {
    githubSyncError = (e as Error).message ?? 'GitHub sync failed';
  } finally {
    syncingGithub = false;
  }
}

/** Poll a single project from the API until provisioning reaches a terminal state */
async function pollProjectUntilDone(projectId: string) {
  const POLL_INTERVAL = 5_000;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    try {
      const remote = await api.getProject(projectId);
      if (!remote) break;
      patchProject(projectId, apiProjectToRow(remote));
      const phase = remote.provisioningPhase;
      if (phase === 'FAILED') break;
      if (phase === 'DONE') break;
      if (phase === 'REPO_ONLY' && (remote.provisioningProgress ?? 0) >= 100) break;
    } catch (err) {
      console.warn(`Poll error for ${projectId}:`, err);
    }
  }
}

/** Poll while account decommission Step Functions is running */
async function pollProjectDecommission(projectId: string) {
  const POLL_INTERVAL = 5_000;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    try {
      const remote = await api.getProject(projectId);
      if (!remote) break;
      patchProject(projectId, apiProjectToRow(remote));
      if (!decommissionInProgress(remote.decommissionPhase)) break;
    } catch (err) {
      console.warn(`Decommission poll error for ${projectId}:`, err);
    }
  }
}

// Load from API on mount (live mode only)
$effect(() => {
  if (!browser || !liveMode) return;
  loadProjectsFromApi();
});

// ─── GitHub template repo list (live backend: App installation repos) ───────

/** True until the first `listGithubReposForTemplate` finishes (live backend only). */
let githubReposLoading = $state(hasLiveBackend);
let githubRepoOptions = $state<GithubRepoOption[]>([]);
let githubReposError = $state('');

async function loadGithubRepoOptions() {
  if (!browser || !hasLiveBackend) return;
  githubReposLoading = true;
  githubReposError = '';
  try {
    const { ensureAmplifyConfigured } = await import('$lib/amplify');
    await ensureAmplifyConfigured();
    githubRepoOptions = await api.listGithubReposForTemplate();
  } catch (e) {
    githubReposError = (e as Error).message ?? 'Failed to load GitHub repos';
    githubRepoOptions = [];
  } finally {
    githubReposLoading = false;
  }
}

$effect(() => {
  if (!browser || !hasLiveBackend) return;
  void loadGithubRepoOptions();
});

let orgAccountsForPicker = $state<OrganizationAccount[]>([]);
let orgAccountsPickerLoading = $state(false);
let orgAccountsPickerError = $state('');

async function loadOrgAccountsForPicker() {
  if (!browser || !hasLiveBackend) return;
  orgAccountsPickerLoading = true;
  orgAccountsPickerError = '';
  try {
    const { ensureAmplifyConfigured } = await import('$lib/amplify');
    await ensureAmplifyConfigured();
    orgAccountsForPicker = await api.listOrganizationAccounts();
  } catch (e) {
    orgAccountsPickerError = (e as Error).message ?? 'Failed to load organization accounts';
    orgAccountsForPicker = [];
  } finally {
    orgAccountsPickerLoading = false;
  }
}

async function refreshOrgAccountsForPicker() {
  if (!browser || !hasLiveBackend) return;
  try {
    const { ensureAmplifyConfigured } = await import('$lib/amplify');
    await ensureAmplifyConfigured();
    await api.syncOrganizationAccounts();
    await loadOrgAccountsForPicker();
  } catch (e) {
    orgAccountsPickerError = (e as Error).message ?? 'Sync failed';
  }
}

/** Org accounts eligible for project attach (includes management account if you select it). */
function orgAccountsSelectable(rows: OrganizationAccount[]): OrganizationAccount[] {
  return rows.filter(
    (a) => (a.closureState ?? 'NONE') === 'NONE' && (a.decommissionPhase ?? 'IDLE') === 'IDLE'
  );
}

function projectAccountForOrgPick(o: OrganizationAccount): {
  name: string;
  email: string;
  accountId: string;
} {
  const name = (o.name ?? '').trim() || `account-${o.accountId}`;
  const email = (o.email ?? '').trim() || `noreply+${o.accountId}@aws-organization.local`;
  return { name, email, accountId: o.accountId };
}

function toggleDraftOrgAccount(projectId: string, accountId: string, checked: boolean) {
  projects = projects.map((p) => {
    if (p.id !== projectId) return p;
    const cur = [...(p.selectedOrgAccountIds ?? [])];
    const ids = checked
      ? cur.includes(accountId)
        ? cur
        : [...cur, accountId]
      : cur.filter((x) => x !== accountId);
    return { ...p, selectedOrgAccountIds: ids };
  });
}

function toggleProvisionOrgAccount(projectId: string, accountId: string, checked: boolean) {
  projects = projects.map((p) => {
    if (p.id !== projectId) return p;
    const cur = [...(p.awsProvisionOrgAccountIds ?? [])];
    const ids = checked
      ? cur.includes(accountId)
        ? cur
        : [...cur, accountId]
      : cur.filter((x) => x !== accountId);
    return { ...p, awsProvisionOrgAccountIds: ids };
  });
}

$effect(() => {
  if (!browser || !hasLiveBackend) return;
  void loadOrgAccountsForPicker();
});

// ─── Provisioning UI (real pipeline state from API) ───────────────────────────

/** Account IDs stay hidden until the provisioning “accounts” step completes */
function accountIdsPendingProvisioning(
  provisioning: ProjectProvisioning | null | undefined
): boolean {
  return provisioning != null && provisioning.accounts !== 'done';
}

/** Spend columns until accounts exist for CUR-style data */
function costsPendingProvisioning(provisioning: ProjectProvisioning | null | undefined): boolean {
  return provisioning != null && provisioning.accounts !== 'done';
}

/** IAM / org console entry until target accounts are members */
function awsAssignPendingProvisioning(
  provisioning: ProjectProvisioning | null | undefined
): boolean {
  return provisioning != null && provisioning.accounts !== 'done';
}

/** Repo, OIDC, or deploy hooks until the GitHub step completes */
function githubIntegrationPending(provisioning: ProjectProvisioning | null | undefined): boolean {
  return provisioning != null && provisioning.github !== 'done';
}

/** Marketing / app URL often not routable until later in the pipeline */
function websitePendingProvisioning(provisioning: ProjectProvisioning | null | undefined): boolean {
  return provisioning != null && provisioning.github !== 'done';
}

/** Plain USD amounts (grouping); `$` lives in column headers only */
const costAmountFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

function parseAccountCostInput(s: string): number {
  const t = String(s ?? '')
    .replace(/[$,]/g, '')
    .trim();
  if (t === '') return 0;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

type CostKind = 'lastMonth' | 'current' | 'predicted';

function projectCostSumByKind(p: ProjectRow, kind: CostKind): number {
  const arr =
    kind === 'lastMonth'
      ? (p.accountCostsLastMonth ?? [])
      : kind === 'current'
        ? (p.accountCostsCurrent ?? [])
        : (p.accountCostsPredicted ?? []);
  let sum = 0;
  for (let i = 0; i < p.accountNames.length; i++) {
    sum += parseAccountCostInput(arr[i] ?? '');
  }
  return sum;
}

/** Sort / headline total: predicted month spend */
function projectAccountsCostTotal(p: ProjectRow): number {
  return projectCostSumByKind(p, 'predicted');
}

function formatCostAmount(n: number): string {
  return costAmountFormatter.format(n);
}

function awsCostCell(raw: string | undefined): { show: boolean; amount: string } {
  const n = parseAccountCostInput(raw ?? '');
  const show = n !== 0 || String(raw ?? '').trim() !== '';
  return { show, amount: formatCostAmount(n) };
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

/** Plus-address local+tag@domain. Set VITE_ACCOUNT_EMAIL_LOCAL and VITE_ACCOUNT_EMAIL_DOMAIN. */
const ACCOUNT_EMAIL_LOCAL = import.meta.env.VITE_ACCOUNT_EMAIL_LOCAL?.trim() ?? '';
const ACCOUNT_EMAIL_DOMAIN = import.meta.env.VITE_ACCOUNT_EMAIL_DOMAIN?.trim() ?? '';

/** Apex for factory app hostnames (`slug.domain`, `slug-int.domain`, …). Set by SST. */
const PROJECT_APPS_ROOT = import.meta.env.VITE_PROJECT_APPS_ROOT_DOMAIN?.trim() ?? '';

/** Default template repo when the field is empty (`owner/repo`). Empty until configured. */
const DEFAULT_TEMPLATE_REPO = import.meta.env.VITE_DEFAULT_TEMPLATE_REPO?.trim() ?? '';

const DEFAULT_GITHUB_ORG = DEFAULT_TEMPLATE_REPO.split('/')[0]?.trim() ?? '';

/** Template sent to the API: explicit value or your default. */
function effectiveTemplateRepo(row: ProjectRow): string {
  return row.templateLabel.trim() || DEFAULT_TEMPLATE_REPO;
}

function patchDraftSlug(projectId: string, rawSlug: string) {
  const row = projects.find((x) => x.id === projectId);
  const patch: Partial<ProjectRow> = { slug: rawSlug };
  if (row?.isDraft && PROJECT_APPS_ROOT) {
    const suggested = buildProjectStageWebsiteUrl(slugify(rawSlug), 'prod', PROJECT_APPS_ROOT);
    if (suggested && !row.websiteUrl.trim()) {
      patch.websiteUrl = suggested;
    }
  }
  patchProject(projectId, patch);
}

function accountAliasEmail(accountSuffix: string, projectSlug: string) {
  if (!ACCOUNT_EMAIL_LOCAL || !ACCOUNT_EMAIL_DOMAIN) return '';
  const slugPart = slugify(projectSlug) || 'project';
  const accountPart = slugify(accountSuffix) || 'account';
  const tag = `${slugPart}-${accountPart}`;
  return `${ACCOUNT_EMAIL_LOCAL}+${tag}@${ACCOUNT_EMAIL_DOMAIN}`;
}

/** Full AWS account name: `{slug}-{suffix}` (same slugify rules as email tag). */
function fullAwsAccountName(projectSlug: string, accountSuffix: string): string {
  const slugPart = slugify(projectSlug) || 'project';
  const suffixPart = slugify(accountSuffix) || 'account';
  return `${slugPart}-${suffixPart}`;
}

/** Draft row: monospace prefix before the editable suffix (empty slug → no prefix yet). */
function accountNamePrefixForDraft(projectSlug: string): string {
  const s = slugify(projectSlug);
  return s ? `${s}-` : '';
}

/** Org for API: explicit field, else owner of effective template, else {@link DEFAULT_GITHUB_ORG}. */
function githubOrgForApi(row: ProjectRow): string {
  const explicit = row.githubOrg?.trim();
  if (explicit) return explicit;
  const t = effectiveTemplateRepo(row);
  const i = t.indexOf('/');
  if (i > 0) {
    const owner = t.slice(0, i).trim();
    if (owner) return owner;
  }
  return DEFAULT_GITHUB_ORG;
}

/** Draft template field: `<select>` value or `__custom__` for manual `owner/repo`. */
function templateRepoSelectValue(p: ProjectRow): string {
  const t = p.templateLabel.trim();
  if (!t) return '';
  if (githubRepoOptions.some((r) => r.fullName === t)) return t;
  return '__custom__';
}

function onTemplateRepoSelect(projectId: string, value: string) {
  if (value === '__custom__') {
    patchProject(projectId, { templateLabel: '' });
    return;
  }
  patchProject(projectId, { templateLabel: value });
}

function showTemplateRepoCustomInput(p: ProjectRow): boolean {
  if (!hasLiveBackend) return true;
  if (githubReposLoading) return true;
  if (githubRepoOptions.length === 0) return true;
  return templateRepoSelectValue(p) === '__custom__';
}

/** Blocks Save until fields needed for GitHub repo + provisioning are filled. */
function isDraftCreateValid(p: ProjectRow): boolean {
  return draftCreateBlockedReason(p) === null;
}

function draftCreateBlockedReason(p: ProjectRow): string | null {
  if (!p.name.trim()) return 'Project name is required.';
  if (!p.slug.trim()) return 'Slug is required (it becomes the new GitHub repository name).';
  if (!effectiveTemplateRepo(p)) {
    return 'Template repo is required (owner/repo). Set VITE_DEFAULT_TEMPLATE_REPO or enter one.';
  }
  if (!githubOrgForApi(p)) return 'GitHub org is required.';
  if (
    !p.repoOnlyDraft &&
    (p.awsAccountMode ?? 'org') === 'org' &&
    (p.selectedOrgAccountIds?.length ?? 0) === 0
  ) {
    return 'Select at least one AWS organization account, or switch to creating new accounts.';
  }
  if (!p.repoOnlyDraft && (p.awsAccountMode ?? 'org') === 'vend') {
    if (!ACCOUNT_EMAIL_LOCAL || !ACCOUNT_EMAIL_DOMAIN) {
      return 'Set VITE_ACCOUNT_EMAIL_LOCAL and VITE_ACCOUNT_EMAIL_DOMAIN before creating new AWS accounts.';
    }
  }
  return null;
}

/** Short month, zero-padded day, and year for the Created column */
function shortDate(d: Date) {
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

let projects = $state<ProjectRow[]>([]);

/** Block a second "Add" while the creation form (draft row) is open. */
let hasActiveDraftProject = $derived(projects.some((p) => p.isDraft === true));

/** True until the first `listProjects` finishes (live backend only). */
let apiProjectsLoading = $state(hasLiveBackend);

const actionLinkClass =
  'inline-flex size-8 shrink-0 items-center justify-center border border-border text-foreground text-xs font-semibold transition-colors hover:bg-muted/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Which accordion panels are open (bits-ui `type="multiple"`). */
let accordionValue = $state<string[]>([]);

const MIN_ACCOUNTS = 1;
const MAX_ACCOUNTS = 10;

function minDraftAccounts(row: ProjectRow): number {
  return row.isDraft && row.repoOnlyDraft ? 0 : 1;
}

function clampCount(projectId: string, n: number) {
  const row = projects.find((p) => p.id === projectId);
  const minA = row ? minDraftAccounts(row) : 1;
  return Math.min(MAX_ACCOUNTS, Math.max(minA, Math.floor(n) || minA));
}

function addProject() {
  if (projects.some((p) => p.isDraft)) return;
  const id = crypto.randomUUID();
  projects = [
    {
      id,
      name: 'New project',
      slug: '',
      accountNames: ['int', 'stage', 'prod'],
      createdLabel: shortDate(new Date()),
      templateLabel: DEFAULT_TEMPLATE_REPO,
      githubOrg: '',
      detailBlurb: '',
      accountHints: ['', '', ''],
      accountCostsLastMonth: ['', '', ''],
      accountCostsCurrent: ['', '', ''],
      accountCostsPredicted: ['', '', ''],
      websiteUrl: '',
      githubUrl: '',
      awsSignInUrl: '',
      repoOnlyDraft: false,
      awsAccountMode: 'org',
      selectedOrgAccountIds: [],
      isDraft: true,
    },
    ...projects,
  ];
  accordionValue = [id];
}

function setAccountCount(projectId: string, count: number) {
  const target = clampCount(projectId, count);
  projects = projects.map((p) => {
    if (p.id !== projectId) return p;
    let names = p.accountNames.slice(0, target);
    while (names.length < target) names.push('');
    let hints = (p.accountHints ?? []).slice(0, target);
    while (hints.length < target) hints.push('');
    let lastM = (p.accountCostsLastMonth ?? []).slice(0, target);
    while (lastM.length < target) lastM.push('');
    let curC = (p.accountCostsCurrent ?? []).slice(0, target);
    while (curC.length < target) curC.push('');
    let pred = (p.accountCostsPredicted ?? []).slice(0, target);
    while (pred.length < target) pred.push('');
    return {
      ...p,
      accountNames: names,
      accountHints: hints,
      accountCostsLastMonth: lastM,
      accountCostsCurrent: curC,
      accountCostsPredicted: pred,
    };
  });
}

function onProjectAccountCountInput(
  projectId: string,
  e: Event & { currentTarget: HTMLInputElement }
) {
  const row = projects.find((p) => p.id === projectId);
  const minA = row ? minDraftAccounts(row) : MIN_ACCOUNTS;
  const v = Number.parseInt(e.currentTarget.value, 10);
  setAccountCount(projectId, Number.isFinite(v) ? v : minA);
}

function patchProject(id: string, patch: Partial<ProjectRow>) {
  projects = projects.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

function saveDraftProject(id: string) {
  if (!liveMode) {
    console.warn(
      '[dashboard] Save requires Amplify env (VITE_USER_POOL_*, VITE_GRAPHQL_ENDPOINT).'
    );
    return;
  }
  const row = projects.find((p) => p.id === id);
  if (row && !isDraftCreateValid(row)) {
    console.warn('[dashboard] Save blocked:', draftCreateBlockedReason(row));
    return;
  }
  saveDraftProjectApi(id);
}

async function saveDraftProjectApi(id: string) {
  const row = projects.find((p) => p.id === id);
  if (!row) return;

  // Immediately show provisioning bar while the API call goes out
  const initial: ProjectProvisioning = {
    github: 'running',
    accounts: 'pending',
    configure: 'pending',
    progress: 0,
  };
  patchProject(id, { isDraft: false, provisioning: initial });

  try {
    const accountsPayload =
      row.repoOnlyDraft || row.accountNames.length === 0
        ? []
        : (row.awsAccountMode ?? 'org') === 'org' && row.selectedOrgAccountIds?.length
          ? row.selectedOrgAccountIds
              .map((id) => {
                const o = orgAccountsForPicker.find((a) => a.accountId === id);
                return o ? projectAccountForOrgPick(o) : null;
              })
              .filter((x): x is { name: string; email: string; accountId: string } => x !== null)
          : row.accountNames.map((suffix) => ({
              name: fullAwsAccountName(row.slug, suffix),
              email: accountAliasEmail(suffix, row.slug),
            }));

    const created = await api.createProject({
      name: row.name,
      slug: row.slug,
      description: row.detailBlurb || undefined,
      templateRepo: effectiveTemplateRepo(row),
      githubOrg: githubOrgForApi(row),
      accounts: accountsPayload,
      websiteUrl: row.websiteUrl || undefined,
      awsSignInUrl: row.awsSignInUrl || undefined,
    });

    // Replace the temp local row with the API-returned record
    const serverRow = apiProjectToRow(created);
    projects = projects.map((p) => (p.id === id ? { ...serverRow, id: created.id } : p));

    // Remove the old temp id from accordion if it was open, open the real id
    accordionValue = accordionValue.map((v) => (v === id ? created.id : v));

    // Poll for updates
    pollProjectUntilDone(created.id);
  } catch (err) {
    console.error('createProject failed:', err);
    patchProject(id, { isDraft: true, provisioning: undefined });
  }
}

const MIN_AWS_PROVISION_ACCOUNTS = 1;

function clampAwsProvisionCount(count: number) {
  return Math.min(
    MAX_ACCOUNTS,
    Math.max(MIN_AWS_PROVISION_ACCOUNTS, Math.floor(count) || MIN_AWS_PROVISION_ACCOUNTS)
  );
}

function setAwsProvisionAccountCount(projectId: string, count: number) {
  const target = clampAwsProvisionCount(count);
  projects = projects.map((p) => {
    if (p.id !== projectId) return p;
    let names = (p.awsProvisionAccountNames ?? ['int', 'stage', 'prod']).slice(0, target);
    while (names.length < target) names.push('');
    return { ...p, awsProvisionAccountNames: names };
  });
}

async function saveAwsProvision(projectId: string) {
  if (!liveMode) return;
  const row = projects.find((p) => p.id === projectId);
  if (!row || !slugify(row.slug)) return;

  const mode = row.awsProvisionAccountMode ?? 'org';
  let accountsPayload: Array<{ name: string; email: string; accountId?: string | null }>;

  if (mode === 'org') {
    const ids = row.awsProvisionOrgAccountIds ?? [];
    if (ids.length === 0) return;
    accountsPayload = ids
      .map((id) => {
        const o = orgAccountsForPicker.find((a) => a.accountId === id);
        return o ? projectAccountForOrgPick(o) : null;
      })
      .filter((x): x is { name: string; email: string; accountId: string } => x !== null);
    if (accountsPayload.length === 0) return;
  } else {
    const suffixes = row.awsProvisionAccountNames;
    if (!suffixes?.length) return;
    accountsPayload = suffixes.map((suffix) => ({
      name: fullAwsAccountName(row.slug, suffix),
      email: accountAliasEmail(suffix, row.slug),
    }));
  }

  const backupNames = row.awsProvisionAccountNames ? [...row.awsProvisionAccountNames] : undefined;
  const backupOrg = row.awsProvisionOrgAccountIds ? [...row.awsProvisionOrgAccountIds] : undefined;
  const backupMode = row.awsProvisionAccountMode;

  patchProject(projectId, {
    awsProvisionAccountNames: undefined,
    awsProvisionOrgAccountIds: undefined,
    awsProvisionAccountMode: undefined,
    provisioning: {
      github: 'done',
      accounts: 'running',
      configure: 'pending',
      progress: 25,
    },
  });

  try {
    const updated = await api.provisionProjectAws({
      projectId,
      accounts: accountsPayload,
    });
    patchProject(projectId, apiProjectToRow(updated));
    void pollProjectUntilDone(projectId);
  } catch (err) {
    console.error('provisionProjectAws failed:', err);
    patchProject(projectId, {
      awsProvisionAccountNames: backupNames,
      awsProvisionOrgAccountIds: backupOrg,
      awsProvisionAccountMode: backupMode,
      provisioning: undefined,
    });
  }
}

function discardDraftProject(id: string) {
  projects = projects.filter((p) => p.id !== id);
  accordionValue = accordionValue.filter((v) => v !== id);
}

let editingProjectId = $state<string | null>(null);
let editSnapshot = $state<ProjectRow | null>(null);

function cloneProjectRow(row: ProjectRow): ProjectRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    accountNames: [...row.accountNames],
    createdLabel: row.createdLabel,
    templateLabel: row.templateLabel,
    githubOrg: row.githubOrg,
    detailBlurb: row.detailBlurb,
    websiteUrl: row.websiteUrl,
    githubUrl: row.githubUrl,
    awsSignInUrl: row.awsSignInUrl,
    accountHints: row.accountHints ? [...row.accountHints] : undefined,
    accountCostsLastMonth: row.accountCostsLastMonth ? [...row.accountCostsLastMonth] : undefined,
    accountCostsCurrent: row.accountCostsCurrent ? [...row.accountCostsCurrent] : undefined,
    accountCostsPredicted: row.accountCostsPredicted ? [...row.accountCostsPredicted] : undefined,
    accountClosureStates: row.accountClosureStates ? [...row.accountClosureStates] : undefined,
    decommissionPhase: row.decommissionPhase,
    decommissionError: row.decommissionError,
    decommissionTargetAccountId: row.decommissionTargetAccountId,
    provisioningPhase: row.provisioningPhase,
    repoOnlyDraft: row.repoOnlyDraft,
    awsProvisionAccountNames: row.awsProvisionAccountNames
      ? [...row.awsProvisionAccountNames]
      : undefined,
    awsAccountMode: row.awsAccountMode,
    selectedOrgAccountIds: row.selectedOrgAccountIds ? [...row.selectedOrgAccountIds] : undefined,
    awsProvisionAccountMode: row.awsProvisionAccountMode,
    awsProvisionOrgAccountIds: row.awsProvisionOrgAccountIds
      ? [...row.awsProvisionOrgAccountIds]
      : undefined,
    isDraft: row.isDraft,
    provisioning: row.provisioning
      ? { ...row.provisioning }
      : row.provisioning === null
        ? null
        : undefined,
  };
}

let closeAccountDialog = $state<{
  projectId: string;
  accountIndex: number;
  accountId: string;
} | null>(null);
let closeAccountSlugInput = $state('');
let closeAccountError = $state('');
/** When true, Step Functions dispatches monorepo destroy workflow (requires GitHub Actions on the App). */
let closeAccountRunMonorepoTeardown = $state(true);

function openCloseAccountDialog(projectId: string, accountIndex: number, accountId: string) {
  closeAccountDialog = { projectId, accountIndex, accountId };
  closeAccountSlugInput = '';
  closeAccountError = '';
  closeAccountRunMonorepoTeardown = true;
}

function dismissCloseAccountDialog() {
  closeAccountDialog = null;
  closeAccountSlugInput = '';
  closeAccountError = '';
  closeAccountRunMonorepoTeardown = true;
}

async function confirmCloseAccount() {
  const ctx = closeAccountDialog;
  if (!ctx) return;
  const row = projects.find((p) => p.id === ctx.projectId);
  if (!row) return;
  const expected = slugify(row.slug) || '';
  if (closeAccountSlugInput.trim() !== expected) {
    closeAccountError = `Type the project slug exactly: ${expected}`;
    return;
  }
  try {
    const updated = await api.closeProjectAccount(
      ctx.projectId,
      ctx.accountId,
      closeAccountRunMonorepoTeardown
    );
    patchProject(ctx.projectId, apiProjectToRow(updated));
    dismissCloseAccountDialog();
    void pollProjectDecommission(ctx.projectId);
  } catch (e) {
    closeAccountError = (e as Error).message ?? 'Failed to start account closure';
  }
}

function startEditingProject(id: string) {
  const row = projects.find((p) => p.id === id);
  if (!row || row.isDraft) return;
  if (editingProjectId !== null && editingProjectId !== id) {
    cancelEditingProject();
  }
  editSnapshot = cloneProjectRow(row);
  editingProjectId = id;
}

function saveEditingProject() {
  const id = editingProjectId;
  editingProjectId = null;
  editSnapshot = null;

  if (liveMode && id) {
    const row = projects.find((p) => p.id === id);
    if (row) {
      api
        .updateProject(id, {
          name: row.name,
          description: row.detailBlurb || undefined,
          websiteUrl: row.websiteUrl || undefined,
          awsSignInUrl: row.awsSignInUrl || undefined,
          githubUrl: row.githubUrl || undefined,
        })
        .catch((err) => console.warn('updateProject failed:', err));
    }
  }
}

function cancelEditingProject() {
  if (editingProjectId !== null && editSnapshot !== null) {
    const id = editingProjectId;
    const snap = editSnapshot;
    projects = projects.map((p) => (p.id === id ? snap : p));
  }
  editingProjectId = null;
  editSnapshot = null;
}

type SortKey = 'name' | 'cost' | 'template' | 'created' | 'accounts';

let sortKey = $state<SortKey | null>(null);
let sortDir = $state<'asc' | 'desc'>('asc');

let showScrollDownChevron = $state(false);

function updateScrollDownChevron() {
  if (typeof document === 'undefined') return;
  const doc = document.documentElement;
  const roomBelow = doc.scrollHeight - window.innerHeight - window.scrollY;
  showScrollDownChevron = roomBelow > 72;
}

function scrollPageDownStep() {
  const doc = document.documentElement;
  const vh = window.innerHeight;
  const maxTop = doc.scrollHeight - vh;
  const next = Math.min(doc.scrollTop + vh * 0.85, maxTop);
  window.scrollTo({ top: next, behavior: 'smooth' });
}

$effect(() => {
  if (typeof window === 'undefined') return;
  updateScrollDownChevron();
  window.addEventListener('scroll', updateScrollDownChevron, { passive: true });
  window.addEventListener('resize', updateScrollDownChevron);
  return () => {
    window.removeEventListener('scroll', updateScrollDownChevron);
    window.removeEventListener('resize', updateScrollDownChevron);
  };
});

$effect(() => {
  accordionValue;
  if (typeof window === 'undefined') return;
  void tick().then(() => updateScrollDownChevron());
});

function toggleSort(key: SortKey) {
  if (sortKey === key) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey = key;
    sortDir = 'asc';
  }
}

function createdLabelToTime(label: string): number {
  const direct = Date.parse(label);
  if (Number.isFinite(direct)) return direct;
  const inferred = Date.parse(`${label} ${new Date().getFullYear()}`);
  return Number.isFinite(inferred) ? inferred : 0;
}

let displayedProjects = $derived.by(() => {
  if (sortKey === null) return projects;
  const list = projects.slice();
  const m = sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    let c = 0;
    switch (sortKey) {
      case 'name':
        c = a.name.localeCompare(b.name);
        break;
      case 'cost':
        c = projectAccountsCostTotal(a) - projectAccountsCostTotal(b);
        break;
      case 'template':
        c = a.templateLabel.localeCompare(b.templateLabel);
        break;
      case 'created':
        c = createdLabelToTime(a.createdLabel) - createdLabelToTime(b.createdLabel);
        break;
      case 'accounts':
        c = a.accountNames.length - b.accountNames.length;
        break;
      default:
        break;
    }
    return c * m;
  });
  return list;
});

const sortHeadingBtnClass =
  'inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm font-medium tracking-wide uppercase hover:bg-muted/25 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Chevron, then name | accounts | cost | template | created (inside accordion trigger) */
const summaryTriggerGridClass =
  'grid min-h-14 min-w-0 flex-1 grid-cols-1 items-start gap-x-4 gap-y-1 py-3 pr-2 pl-4 text-left md:items-center md:grid-cols-[2rem_minmax(0,1fr)_3.5rem_minmax(9rem,12rem)_minmax(0,12rem)_10.5rem] md:gap-x-8';

/** Header row: same grid columns as trigger + space for actions */
const headerLeftGridClass =
  'grid min-w-0 flex-1 grid-cols-1 px-4 py-3 text-left text-muted-foreground text-xs md:grid md:grid-cols-[2rem_minmax(0,1fr)_3.5rem_minmax(9rem,12rem)_minmax(0,12rem)_10.5rem] md:gap-x-8';

/** Three fields in a row: 1 col, 2 from sm, 3 from lg (name block or URL block) */
const tripleFieldGridClass =
  'grid min-w-0 grid-cols-1 gap-4 sm:col-span-2 sm:grid-cols-2 lg:grid-cols-3';

/** Draft header: name, slug, template, GitHub org */
const draftTopGridClass =
  'grid min-w-0 grid-cols-1 gap-4 sm:col-span-2 sm:grid-cols-2 lg:grid-cols-4';

/** Stacked account row on small screens (AWS accounts table) */
const accountMobileCardClass =
  'flex flex-col gap-3 rounded-md border border-border bg-muted/10 px-3 py-3 shadow-sm';
const accountMobileFieldLabelClass =
  'text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground';
</script>

<svelte:head>
  <title>Projects · AWS Project Factory</title>
</svelte:head>

<main
  class="min-h-dvh min-w-0 max-w-full overflow-x-hidden px-6 pt-6 pb-16 md:px-10 md:pt-10 md:pb-20 lg:px-14 lg:pt-12"
>
  {#snippet accountWebsiteLink(p: ProjectRow, accountName: string)}
    {@const href = p.websiteUrl.trim()}
    <a
      href={href || '#'}
      target="_blank"
      rel="noopener noreferrer"
      title={href || undefined}
      class="{actionLinkClass} {!href ? 'pointer-events-none opacity-40' : ''}"
      aria-label={href ? `Open website for ${accountName}` : 'No website URL set'}
      aria-disabled={!href}
      onclick={(e) => {
        if (!href) e.preventDefault();
      }}
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
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      </svg>
    </a>
  {/snippet}

  {#snippet accountDecommissionControls(row: ProjectRow, idx: number)}
    {@const hint = (row.accountHints?.[idx] ?? '').trim()}
    {@const cstate = row.accountClosureStates?.[idx] ?? 'NONE'}
    {@const canShowClose =
      liveMode &&
      !row.isDraft &&
      !row.provisioning &&
      Boolean(hint) &&
      cstate === 'NONE' &&
      !decommissionInProgress(row.decommissionPhase)}
    {@const isClosingThis =
      cstate !== 'CLOSED' &&
      (cstate === 'CLOSING' ||
        (decommissionInProgress(row.decommissionPhase) && row.decommissionTargetAccountId === hint))}
    {#if canShowClose}
      <button
        type="button"
        class="{actionLinkClass} mt-1 text-muted-foreground hover:border-destructive/60 hover:text-destructive"
        title="Remove this AWS account (opens confirmation)"
        aria-label="Remove AWS account"
        onclick={() => openCloseAccountDialog(row.id, idx, hint)}
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
    {:else if cstate === 'CLOSED'}
      <span class="mt-1 block text-xs text-muted-foreground">It's closed.</span>
    {:else if isClosingThis}
      <span class="mt-1 block text-xs text-muted-foreground">
        Closing… {(row.decommissionPhase ?? '').toLowerCase().replaceAll('_', ' ')}
      </span>
    {/if}
  {/snippet}

  {#snippet accountCostStack(
    cur: ReturnType<typeof awsCostCell>,
    last: ReturnType<typeof awsCostCell>,
    pred: ReturnType<typeof awsCostCell>,
  )}
    <span class="flex w-full min-w-0 max-w-full flex-col items-end">
      <span class="block w-full text-right font-medium tabular-nums text-foreground break-words">
        {#if cur.show}
          {cur.amount}
        {:else}
          <span class="text-muted-foreground">—</span>
        {/if}
      </span>
      <span
        class="mt-0.5 flex w-full max-w-full items-baseline justify-end font-mono text-[0.75rem] font-normal leading-snug text-muted-foreground tabular-nums [overflow-wrap:anywhere]"
      >
        <span class="inline-flex max-w-full items-baseline gap-0">
          {#if last.show}
            {last.amount}
          {:else}
            <span class="text-muted-foreground/80">—</span>
          {/if}
          <span class="mx-px shrink-0 text-muted-foreground/50" aria-hidden="true">·</span>
          {#if pred.show}
            {pred.amount}
          {:else}
            <span class="text-muted-foreground/80">—</span>
          {/if}
        </span>
      </span>
      <span class="sr-only">Current spend, then last month and predicted.</span>
    </span>
  {/snippet}

  {#snippet provisioningFieldDots(className: string, ariaLabel: string)}
    <span class="acct-id-loading-dots {className}" role="status" aria-label={ariaLabel}>
      <span></span><span></span><span></span>
    </span>
  {/snippet}

  {#snippet accountIdDotsPlaceholder()}
    {@render provisioningFieldDots(
      'text-emerald-500/90',
      'AWS account id not created yet',
    )}
  {/snippet}

  {#snippet accountWebsiteLinkOrLoading(p: ProjectRow, accountName: string)}
    {#if websitePendingProvisioning(p.provisioning)}
      <span
        class="{actionLinkClass} pointer-events-none cursor-default opacity-55"
        role="status"
        aria-label="Website not live yet"
      >
        {@render provisioningFieldDots(
          'acct-id-loading-dots--icon text-muted-foreground/90',
          'Website not live yet',
        )}
      </span>
    {:else}
      {@render accountWebsiteLink(p, accountName)}
    {/if}
  {/snippet}

  <div class="mx-auto w-full min-w-0 max-w-7xl">
    <div
      class="flex flex-wrap items-center justify-end gap-2 border-border border-b pb-6 md:pb-8"
    >
      <Button
        type="button"
        variant="outline"
        size="icon"
        class="rounded-sm border-foreground/40"
        disabled={!hasLiveBackend || !isLiveMode() || syncingGithub}
        aria-busy={syncingGithub}
        aria-label={syncingGithub
          ? 'Syncing projects with GitHub'
          : 'Sync projects with GitHub'}
        title={syncingGithub ? 'Syncing…' : 'Sync with GitHub (remove projects whose repo is gone)'}
        onclick={() => void syncProjectsWithGithub()}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="size-4 shrink-0 {syncingGithub ? 'motion-safe:animate-spin' : ''}"
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        class="rounded-sm border-foreground/40 font-mono text-base font-semibold leading-none"
        disabled={hasActiveDraftProject}
        aria-label={hasActiveDraftProject
          ? 'Finish or discard the new project before adding another'
          : 'Add project'}
        title={hasActiveDraftProject
          ? 'Finish or discard the open new-project form first'
          : 'Add project'}
        onclick={addProject}
      >
        +
      </Button>
    </div>

    {#if githubSyncError}
      <p class="mt-4 text-destructive text-sm" role="alert">{githubSyncError}</p>
    {:else if githubSyncMessage}
      <p class="mt-4 text-muted-foreground text-sm" role="status">{githubSyncMessage}</p>
    {/if}

    <div class="mt-8 md:mt-10">
      {#if hasLiveBackend && apiProjectsLoading}
        <p
          class="border-border border border-dashed px-4 py-8 text-center text-muted-foreground text-sm"
          role="status"
          aria-live="polite"
        >
          Loading projects…
        </p>
      {:else if projects.length > 0}
        <div
          class="min-w-0 max-w-full overflow-x-hidden overflow-y-visible border border-border text-sm"
        >
          <div
            class="hidden w-full flex-col border-border border-b md:flex md:flex-row md:items-stretch"
          >
            <div class={headerLeftGridClass}>
              <span class="block md:min-w-[2rem]" aria-hidden="true"></span>
              <div class="hidden min-w-0 md:block">
                <button
                  type="button"
                  class={sortHeadingBtnClass}
                  aria-label="Sort by name"
                  onclick={() => toggleSort('name')}
                >
                  Name
                  <span
                    class="inline-flex shrink-0 flex-col text-[0.45rem] leading-[0.48rem]"
                    aria-hidden="true"
                  >
                    <span
                      class={sortKey === 'name' && sortDir === 'asc'
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'}
                    >▲</span>
                    <span
                      class={sortKey === 'name' && sortDir === 'desc'
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'}
                    >▼</span>
                  </span>
                </button>
              </div>
              <div class="hidden md:flex md:justify-end">
                <button
                  type="button"
                  class="{sortHeadingBtnClass} tabular-nums"
                  aria-label="Sort by account count"
                  onclick={() => toggleSort('accounts')}
                >
                  Accounts
                  <span
                    class="inline-flex shrink-0 flex-col text-[0.45rem] leading-[0.48rem]"
                    aria-hidden="true"
                  >
                    <span
                      class={sortKey === 'accounts' && sortDir === 'asc'
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'}
                    >▲</span>
                    <span
                      class={sortKey === 'accounts' && sortDir === 'desc'
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'}
                    >▼</span>
                  </span>
                </button>
              </div>
              <div class="hidden md:flex md:justify-end">
                <button
                  type="button"
                  class="{sortHeadingBtnClass} tabular-nums"
                  aria-label="Sort by predicted total cost"
                  onclick={() => toggleSort('cost')}
                >
                  Cost
                  <span
                    class="inline-flex shrink-0 flex-col text-[0.45rem] leading-[0.48rem]"
                    aria-hidden="true"
                  >
                    <span
                      class={sortKey === 'cost' && sortDir === 'asc'
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'}
                    >▲</span>
                    <span
                      class={sortKey === 'cost' && sortDir === 'desc'
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'}
                    >▼</span>
                  </span>
                </button>
              </div>
              <div class="hidden min-w-0 md:block">
                <button
                  type="button"
                  class="{sortHeadingBtnClass} max-w-full"
                  aria-label="Sort by template"
                  onclick={() => toggleSort('template')}
                >
                  <span class="min-w-0 truncate">Template</span>
                  <span
                    class="inline-flex shrink-0 flex-col text-[0.45rem] leading-[0.48rem]"
                    aria-hidden="true"
                  >
                    <span
                      class={sortKey === 'template' && sortDir === 'asc'
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'}
                    >▲</span>
                    <span
                      class={sortKey === 'template' && sortDir === 'desc'
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'}
                    >▼</span>
                  </span>
                </button>
              </div>
              <div class="hidden md:flex md:justify-end">
                <button
                  type="button"
                  class="{sortHeadingBtnClass} tabular-nums"
                  aria-label="Sort by created date"
                  onclick={() => toggleSort('created')}
                >
                  Created
                  <span
                    class="inline-flex shrink-0 flex-col text-[0.45rem] leading-[0.48rem]"
                    aria-hidden="true"
                  >
                    <span
                      class={sortKey === 'created' && sortDir === 'asc'
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'}
                    >▲</span>
                    <span
                      class={sortKey === 'created' && sortDir === 'desc'
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'}
                    >▼</span>
                  </span>
                </button>
              </div>
            </div>
            <div
              class="flex items-center justify-end gap-2 px-4 py-3 text-muted-foreground text-xs font-medium tracking-wide uppercase md:min-w-[11rem] md:px-3"
            >
              Actions
            </div>
          </div>

          <Accordion.Root type="multiple" class="min-w-0" bind:value={accordionValue}>
            {#each displayedProjects as p, rowIndex (p.id)}
              <Accordion.Item
                value={p.id}
                class="min-w-0 overflow-x-hidden overflow-y-visible border-x-0 border-b-0 border-border {rowIndex > 0 ? 'border-t' : ''}"
              >
                <Accordion.Header class="m-0 overflow-visible p-0">
                  <div
                    class="flex w-full min-w-0 max-w-full flex-row items-start overflow-x-hidden overflow-y-visible md:items-stretch"
                  >
                    <Accordion.Trigger
                      class="{summaryTriggerGridClass} min-w-0 flex-1 overflow-visible rounded-none border-0 bg-transparent text-left transition-colors hover:bg-muted/15 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&[data-state=open]_svg]:rotate-180"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="size-[18px] shrink-0 justify-self-start text-muted-foreground transition-transform duration-200 md:mx-auto md:justify-self-center"
                        aria-hidden="true"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                      <span class="min-w-0 w-full max-w-full">
                        <span class="block w-full font-medium text-foreground break-words">{p.name}</span>
                        <span
                          class="mt-0.5 block w-full font-mono text-[0.75rem] font-normal leading-snug text-muted-foreground break-all"
                        >
                          {slugify(p.slug) || '—'}
                        </span>
                      </span>
                      <span class="text-muted-foreground tabular-nums md:text-right">
                        <span class="md:hidden text-[0.65rem] uppercase tracking-wide text-muted-foreground/80"
                          >Accounts ·
                        </span>{p.accountNames.length}
                      </span>
                      <span class="min-w-0 md:text-right">
                        {#if costsPendingProvisioning(p.provisioning)}
                          <span class="flex w-full min-w-0 max-w-full flex-col items-end gap-1.5 py-0.5">
                            {@render provisioningFieldDots(
                              'text-muted-foreground/70',
                              'Spend not available while accounts are being set up',
                            )}
                          </span>
                          <span class="sr-only">
                            Cost totals loading; account setup in progress.
                          </span>
                        {:else}
                          <span class="flex w-full min-w-0 max-w-full flex-col md:items-end">
                            <span
                              class="block w-full font-medium tabular-nums text-foreground break-words md:text-right"
                            >
                              {formatCostAmount(projectCostSumByKind(p, 'current'))}
                            </span>
                            <span
                              class="mt-0.5 flex w-full max-w-full items-baseline font-mono text-[0.75rem] font-normal leading-snug text-muted-foreground tabular-nums [overflow-wrap:anywhere] md:justify-end"
                            >
                              <span class="inline-flex max-w-full items-baseline gap-0">
                                {formatCostAmount(projectCostSumByKind(p, 'lastMonth'))}
                                <span
                                  class="mx-px shrink-0 text-muted-foreground/50"
                                  aria-hidden="true"
                                >·</span>
                                {formatCostAmount(projectCostSumByKind(p, 'predicted'))}
                              </span>
                            </span>
                          </span>
                          <span class="sr-only">
                            Current total, then last month and predicted.
                          </span>
                        {/if}
                      </span>
                      <span class="min-w-0 text-muted-foreground md:truncate md:text-left">
                        <span class="md:hidden text-[0.65rem] uppercase tracking-wide text-muted-foreground/80"
                          >Template ·
                        </span>{p.templateLabel}
                      </span>
                      <span
                        class="text-muted-foreground tabular-nums md:block md:w-full md:text-right md:tracking-normal"
                      >
                        <span class="md:hidden text-[0.65rem] uppercase tracking-wide text-muted-foreground/80"
                          >Created ·
                        </span>{p.createdLabel}
                      </span>
                    </Accordion.Trigger>
                    <div
                      class="flex shrink-0 flex-wrap items-center justify-end gap-2 self-start overflow-visible py-3 pr-4 pl-1 md:min-w-[11rem] md:shrink md:self-auto md:px-3"
                    >
                      {#if p.isDraft}
                        {@const saveBlockedReason = draftCreateBlockedReason(p)}
                        <button
                          type="button"
                          disabled={!isDraftCreateValid(p)}
                          title={saveBlockedReason ?? 'Save project and start provisioning'}
                          class="{actionLinkClass} text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
                          aria-label="Save"
                          aria-disabled={!isDraftCreateValid(p)}
                          onclick={(e) => {
                            e.stopPropagation();
                            saveDraftProject(p.id);
                          }}
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
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          class="{actionLinkClass} text-muted-foreground hover:border-destructive/60 hover:text-destructive"
                          aria-label="Cancel"
                          onclick={(e) => {
                            e.stopPropagation();
                            discardDraftProject(p.id);
                          }}
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
                            <path d="M18 6 6 18" />
                            <path d="m6 6 12 12" />
                          </svg>
                        </button>
                      {:else if editingProjectId === p.id}
                        <button
                          type="button"
                          class="{actionLinkClass} text-muted-foreground hover:text-foreground"
                          aria-label="Save"
                          onclick={(e) => {
                            e.stopPropagation();
                            saveEditingProject();
                          }}
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
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          class="{actionLinkClass} text-muted-foreground hover:border-destructive/60 hover:text-destructive"
                          aria-label="Cancel"
                          onclick={(e) => {
                            e.stopPropagation();
                            cancelEditingProject();
                          }}
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
                            <path d="M18 6 6 18" />
                            <path d="m6 6 12 12" />
                          </svg>
                        </button>
                      {:else}
                        {#if websitePendingProvisioning(p.provisioning)}
                          <span
                            class="{actionLinkClass} pointer-events-none cursor-default opacity-55"
                            role="status"
                            aria-label="Website not live yet"
                          >
                            {@render provisioningFieldDots(
                              'acct-id-loading-dots--icon text-muted-foreground/90',
                              'Website not live yet',
                            )}
                          </span>
                        {:else}
                          <a
                            href={p.websiteUrl.trim() || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="{actionLinkClass} {!p.websiteUrl.trim() ? 'pointer-events-none opacity-40' : ''}"
                            aria-label={`Open website for ${p.name}`}
                            aria-disabled={!p.websiteUrl.trim()}
                            onclick={(e) => {
                              e.stopPropagation();
                              if (!p.websiteUrl.trim()) e.preventDefault();
                            }}
                          >
                            W
                          </a>
                        {/if}
                        {#if githubIntegrationPending(p.provisioning)}
                          <span
                            class="{actionLinkClass} pointer-events-none cursor-default opacity-55"
                            role="status"
                            aria-label="GitHub integration not ready"
                          >
                            {@render provisioningFieldDots(
                              'acct-id-loading-dots--icon text-muted-foreground/90',
                              'GitHub integration not ready',
                            )}
                          </span>
                        {:else}
                          <a
                            href={p.githubUrl.trim() || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="{actionLinkClass} {!p.githubUrl.trim() ? 'pointer-events-none opacity-40' : ''}"
                            aria-label={`Open GitHub for ${p.name}`}
                            aria-disabled={!p.githubUrl.trim()}
                            onclick={(e) => {
                              e.stopPropagation();
                              if (!p.githubUrl.trim()) e.preventDefault();
                            }}
                          >
                            G
                          </a>
                        {/if}
                        {#if awsAssignPendingProvisioning(p.provisioning)}
                          <span
                            class="{actionLinkClass} pointer-events-none cursor-default opacity-55"
                            role="status"
                            aria-label="AWS access not ready for these accounts"
                          >
                            {@render provisioningFieldDots(
                              'acct-id-loading-dots--icon text-muted-foreground/90',
                              'AWS access not ready for these accounts',
                            )}
                          </span>
                        {:else}
                          <a
                            href={p.awsSignInUrl.trim() || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="{actionLinkClass} {!p.awsSignInUrl.trim() ? 'pointer-events-none opacity-40' : ''}"
                            aria-label={`Open assign URL for ${p.name}`}
                            aria-disabled={!p.awsSignInUrl.trim()}
                            onclick={(e) => {
                              e.stopPropagation();
                              if (!p.awsSignInUrl.trim()) e.preventDefault();
                            }}
                          >
                            A
                          </a>
                        {/if}
                        <button
                          type="button"
                          class="{actionLinkClass} text-muted-foreground hover:text-foreground"
                          aria-label="Edit project"
                          onclick={(e) => {
                            e.stopPropagation();
                            startEditingProject(p.id);
                          }}
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
                            <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.506l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
                          </svg>
                        </button>
                      {/if}
                    </div>
                  </div>
                  {#if p.provisioning}
                    <div
                      class="relative h-[3px] w-full shrink-0 bg-border/80"
                      role="progressbar"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={Math.round(p.provisioning.progress)}
                      aria-label="Provisioning progress: GitHub repo, AWS accounts, and environment configuration"
                    >
                      <div
                        class="absolute left-0 top-0 h-full origin-left bg-gradient-to-r from-emerald-600/85 via-emerald-400/75 to-emerald-300/90 shadow-[0_0_12px_rgba(52,211,153,0.35)] transition-[width] duration-100 ease-linear"
                        style="width: {p.provisioning.progress}%"
                      ></div>
                    </div>
                    <span class="sr-only" aria-live="polite">
                      Provisioning {Math.round(p.provisioning.progress)} percent complete.
                    </span>
                  {/if}
                </Accordion.Header>
                <Accordion.Content class="min-w-0 max-w-full overflow-x-hidden overflow-y-visible bg-muted/10 px-4 pb-5 pt-2">
                  {#if p.isDraft}
                    <div class="flex flex-col gap-6 pt-2">
                      <div class="grid gap-4 sm:grid-cols-2">
                        <div class={draftTopGridClass}>
                          <div class="flex min-w-0 flex-col gap-2">
                            <Label for={`${p.id}-name`} class="text-muted-foreground text-xs font-normal">
                              Project name <span class="text-destructive" aria-hidden="true">*</span>
                            </Label>
                            <Input
                              id={`${p.id}-name`}
                              type="text"
                              required
                              value={p.name}
                              oninput={(e) => patchProject(p.id, { name: e.currentTarget.value })}
                              class="w-full min-w-0 rounded-sm border-border bg-transparent"
                            />
                          </div>
                          <div class="flex min-w-0 flex-col gap-2">
                            <Label for={`${p.id}-slug`} class="text-muted-foreground text-xs font-normal">
                              Slug <span class="text-destructive" aria-hidden="true">*</span>
                            </Label>
                            <Input
                              id={`${p.id}-slug`}
                              type="text"
                              required
                              placeholder="e.g. new-project"
                              value={p.slug}
                              oninput={(e) => patchDraftSlug(p.id, e.currentTarget.value)}
                              class="w-full min-w-0 rounded-sm border-border bg-transparent font-mono text-[0.85rem]"
                            />
                          </div>
                          <div class="flex min-w-0 flex-col gap-2">
                            <Label for={`${p.id}-template`} class="text-muted-foreground text-xs font-normal">
                              Template repo
                            </Label>
                            <p class="text-[0.65rem] leading-snug text-muted-foreground">
                              {#if DEFAULT_TEMPLATE_REPO}
                                Empty → <span class="font-mono text-foreground">{DEFAULT_TEMPLATE_REPO}</span>
                              {:else}
                                Set <span class="font-mono text-foreground">VITE_DEFAULT_TEMPLATE_REPO</span>
                                or enter owner/repo.
                              {/if}
                            </p>
                            {#if hasLiveBackend && !githubReposLoading && githubRepoOptions.length > 0}
                              <select
                                id={`${p.id}-template-select`}
                                class="w-full min-w-0 rounded-sm border border-border bg-transparent px-3 py-2 font-mono text-[0.85rem] text-foreground"
                                value={templateRepoSelectValue(p)}
                                onchange={(e) => onTemplateRepoSelect(p.id, e.currentTarget.value)}
                                aria-label="Choose template repository from GitHub"
                              >
                                <option value="">Select repository…</option>
                                {#each githubRepoOptions as r (r.fullName)}
                                  <option value={r.fullName}>
                                    {r.fullName}{r.isTemplate ? ' ★' : ''}{r.private ? ' · private' : ''}
                                  </option>
                                {/each}
                                <option value="__custom__">Custom owner/repo…</option>
                              </select>
                            {/if}
                            {#if showTemplateRepoCustomInput(p)}
                              <Input
                                id={`${p.id}-template`}
                                type="text"
                                placeholder="owner/repo (template to generate from)"
                                value={p.templateLabel}
                                oninput={(e) =>
                                  patchProject(p.id, { templateLabel: e.currentTarget.value })}
                                class="w-full min-w-0 rounded-sm border-border bg-transparent font-mono text-[0.85rem]"
                              />
                            {/if}
                            {#if githubReposError && hasLiveBackend}
                              <p class="text-[0.7rem] text-destructive">{githubReposError}</p>
                            {/if}
                          </div>
                          <div class="flex min-w-0 flex-col gap-2">
                            <Label for={`${p.id}-github-org`} class="text-muted-foreground text-xs font-normal">
                              GitHub org
                            </Label>
                            <p class="text-[0.65rem] leading-snug text-muted-foreground">
                              {#if DEFAULT_GITHUB_ORG}
                                Optional. Empty → owner from template, else
                                <span class="font-mono text-foreground">{DEFAULT_GITHUB_ORG}</span>
                              {:else}
                                Optional. Empty → owner from the template repo. Set
                                <span class="font-mono text-foreground">VITE_DEFAULT_TEMPLATE_REPO</span>
                                for a default org.
                              {/if}
                            </p>
                            <Input
                              id={`${p.id}-github-org`}
                              type="text"
                              placeholder="defaults from template owner/repo"
                              value={p.githubOrg ?? ''}
                              oninput={(e) =>
                                patchProject(p.id, { githubOrg: e.currentTarget.value })}
                              class="w-full min-w-0 rounded-sm border-border bg-transparent font-mono text-[0.85rem]"
                            />
                          </div>
                        </div>
                        {#if !isDraftCreateValid(p)}
                          <p class="col-span-2 text-[0.7rem] leading-snug text-destructive">
                            {draftCreateBlockedReason(p)}
                          </p>
                        {/if}
                        <div class="flex w-full min-w-0 flex-col gap-2 sm:col-span-2">
                          <Label for={`${p.id}-blurb`} class="text-muted-foreground text-xs font-normal">
                            Description
                          </Label>
                          <textarea
                            id={`${p.id}-blurb`}
                            rows="3"
                            value={p.detailBlurb}
                            oninput={(e) => patchProject(p.id, { detailBlurb: e.currentTarget.value })}
                            class="min-h-[5rem] w-full min-w-0 resize-y rounded-sm border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            placeholder="Short summary of the stack and accounts…"
                          ></textarea>
                        </div>
                        <div class={tripleFieldGridClass}>
                          <div class="flex min-w-0 flex-col gap-2">
                            <Label for={`${p.id}-website`} class="text-muted-foreground text-xs font-normal">
                              Website URL
                            </Label>
                            {#if PROJECT_APPS_ROOT && p.isDraft}
                              {@const hintSlug = slugify(p.slug) || 'slug'}
                              <p class="text-[0.65rem] leading-snug text-muted-foreground">
                                Prod host:
                                <span class="font-mono text-foreground"
                                  >{buildProjectStageWebsiteUrl(hintSlug, 'prod', PROJECT_APPS_ROOT)}</span
                                >
                                · int example:
                                <span class="font-mono text-foreground"
                                  >{buildProjectStageWebsiteUrl(hintSlug, 'int', PROJECT_APPS_ROOT)}</span
                                >
                              </p>
                            {/if}
                            <Input
                              id={`${p.id}-website`}
                              type="url"
                              placeholder="https://…"
                              value={p.websiteUrl}
                              oninput={(e) => patchProject(p.id, { websiteUrl: e.currentTarget.value })}
                              class="w-full min-w-0 rounded-sm border-border bg-transparent font-mono text-[0.85rem]"
                            />
                          </div>
                          <div class="flex min-w-0 flex-col gap-2">
                            <Label for={`${p.id}-github`} class="text-muted-foreground text-xs font-normal">
                              GitHub URL
                            </Label>
                            <Input
                              id={`${p.id}-github`}
                              type="url"
                              value={p.githubUrl}
                              oninput={(e) => patchProject(p.id, { githubUrl: e.currentTarget.value })}
                              class="w-full min-w-0 rounded-sm border-border bg-transparent font-mono text-[0.85rem]"
                            />
                          </div>
                          <div class="flex min-w-0 flex-col gap-2">
                            <Label for={`${p.id}-aws`} class="text-muted-foreground text-xs font-normal">
                              Assign URL
                            </Label>
                            <Input
                              id={`${p.id}-aws`}
                              type="url"
                              value={p.awsSignInUrl}
                              oninput={(e) => patchProject(p.id, { awsSignInUrl: e.currentTarget.value })}
                              class="w-full min-w-0 rounded-sm border-border bg-transparent font-mono text-[0.85rem]"
                            />
                          </div>
                        </div>
                      </div>

                      <div class="flex max-w-xl items-start gap-2">
                        <input
                          id={`${p.id}-repo-only`}
                          type="checkbox"
                          class="mt-0.5 size-4 shrink-0 rounded border-border"
                          checked={p.repoOnlyDraft ?? false}
                          onchange={(e) => {
                            const on = e.currentTarget.checked;
                            patchProject(p.id, {
                              repoOnlyDraft: on,
                              accountNames: on ? [] : ['int', 'stage', 'prod'],
                              accountHints: on ? [] : ['', '', ''],
                              accountCostsLastMonth: on ? [] : ['', '', ''],
                              accountCostsCurrent: on ? [] : ['', '', ''],
                              accountCostsPredicted: on ? [] : ['', '', ''],
                            });
                          }}
                        />
                        <Label
                          for={`${p.id}-repo-only`}
                          class="cursor-pointer text-muted-foreground text-xs font-normal leading-snug"
                        >
                          Monorepo only — create the GitHub repository first. Add AWS accounts, OIDC, and deploy
                          config from this project after the repo is ready.
                        </Label>
                      </div>

                      {#if p.repoOnlyDraft}
                        <p class="text-sm text-muted-foreground leading-snug">
                          No AWS accounts will be created yet. When provisioning finishes, use “Add AWS accounts” in
                          the project details.
                        </p>
                      {:else}
                      <div class="flex max-w-xl flex-col gap-2 sm:col-span-2">
                        <span class="text-muted-foreground text-xs font-medium tracking-wide uppercase"
                          >AWS accounts</span
                        >
                        <div class="flex flex-wrap gap-4 text-sm">
                          <label class="flex cursor-pointer items-center gap-2">
                            <input
                              type="radio"
                              name={`${p.id}-aws-mode`}
                              class="size-4"
                              checked={(p.awsAccountMode ?? 'org') === 'org'}
                              onchange={() => patchProject(p.id, { awsAccountMode: 'org' })}
                            />
                            <span class="text-muted-foreground">Use existing organization accounts</span>
                          </label>
                          <label class="flex cursor-pointer items-center gap-2">
                            <input
                              type="radio"
                              name={`${p.id}-aws-mode`}
                              class="size-4"
                              checked={(p.awsAccountMode ?? 'org') === 'vend'}
                              onchange={() => patchProject(p.id, { awsAccountMode: 'vend' })}
                            />
                            <span class="text-muted-foreground">Create new accounts (vend)</span>
                          </label>
                        </div>
                      </div>

                      {#if (p.awsAccountMode ?? 'org') === 'org'}
                        <div class="flex w-full min-w-0 flex-col gap-2 sm:col-span-2">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-muted-foreground text-xs font-normal">Organization accounts</span>
                            <Button
                              type="button"
                              variant="outline"
                              class="h-7 text-xs"
                              onclick={() => refreshOrgAccountsForPicker()}
                            >
                              Sync from AWS
                            </Button>
                          </div>
                          {#if orgAccountsPickerLoading}
                            <p class="text-muted-foreground text-xs">Loading accounts…</p>
                          {:else if orgAccountsPickerError}
                            <p class="text-destructive text-xs">{orgAccountsPickerError}</p>
                          {:else}
                            <div
                              class="max-h-48 overflow-y-auto rounded-sm border border-border border-dashed p-2"
                            >
                              {#each orgAccountsSelectable(orgAccountsForPicker) as o (o.accountId)}
                                <label
                                  class="flex cursor-pointer items-start gap-2 border-b border-border/50 py-1.5 last:border-b-0"
                                >
                                  <input
                                    type="checkbox"
                                    class="mt-0.5 size-4 shrink-0"
                                    checked={(p.selectedOrgAccountIds ?? []).includes(o.accountId)}
                                    onchange={(e) =>
                                      toggleDraftOrgAccount(p.id, o.accountId, e.currentTarget.checked)}
                                  />
                                  <span class="min-w-0 font-mono text-[0.75rem] leading-snug text-foreground">
                                    <span class="text-muted-foreground">{o.accountId}</span>
                                    {#if o.isManagementAccount}
                                      <span
                                        class="ml-1.5 inline-block shrink-0 rounded-sm border border-border bg-muted/80 px-1 py-px font-sans text-[0.55rem] font-medium uppercase tracking-wide text-muted-foreground"
                                        title="Organization management (root) account"
                                      >
                                        Management
                                      </span>
                                    {/if}
                                    {#if o.name?.trim()}
                                      {` · ${o.name.trim()}`}
                                    {/if}
                                    {#if o.email?.trim()}
                                      {` · ${o.email.trim()}`}
                                    {/if}
                                  </span>
                                </label>
                              {/each}
                            </div>
                            {#if orgAccountsSelectable(orgAccountsForPicker).length === 0}
                              <p class="text-muted-foreground text-xs">
                                No accounts available. Run “Sync from AWS” or sync on the Org accounts page.
                              </p>
                            {/if}
                          {/if}
                        </div>
                      {:else}
                      <div class="flex max-w-[8rem] flex-col gap-2">
                        <Label for={`${p.id}-acct-count`} class="text-muted-foreground text-xs font-normal">
                          Number of accounts
                        </Label>
                        <Input
                          id={`${p.id}-acct-count`}
                          type="number"
                          min={minDraftAccounts(p)}
                          max={MAX_ACCOUNTS}
                          value={String(p.accountNames.length)}
                          oninput={(e) => onProjectAccountCountInput(p.id, e)}
                          class="rounded-sm border-border bg-transparent tabular-nums"
                        />
                        <p class="text-[0.7rem] text-neutral-600">
                          Between {minDraftAccounts(p)} and {MAX_ACCOUNTS}.
                        </p>
                      </div>

                      <div class="min-w-0">
                        <p class="text-[0.7rem] text-muted-foreground leading-snug">
                          Each account name is <span class="font-mono text-foreground/85"
                            >&lt;slug&gt;-&lt;suffix&gt;</span
                          >. The prefix follows the slug field; edit the suffix only (e.g. int, preview,
                          prod).
                        </p>
                        <div class="flex flex-col gap-3 md:hidden">
                          {#each p.accountNames as name, idx (`${p.id}-acct-m-${idx}`)}
                            {@const lastCell = awsCostCell(p.accountCostsLastMonth?.[idx])}
                            {@const curCell = awsCostCell(p.accountCostsCurrent?.[idx])}
                            {@const predCell = awsCostCell(p.accountCostsPredicted?.[idx])}
                            <div class={accountMobileCardClass}>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Account suffix</span>
                                <div
                                  class="flex h-9 min-w-0 rounded-sm border border-border shadow-xs focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring"
                                >
                                  <span
                                    class="flex max-w-[min(12rem,45%)] shrink-0 items-center border-border border-r bg-muted/30 px-2 font-mono text-[0.75rem] text-muted-foreground"
                                    title="Prefix from slug"
                                  >
                                    {#if accountNamePrefixForDraft(p.slug)}
                                      {accountNamePrefixForDraft(p.slug)}
                                    {:else}
                                      <span class="text-muted-foreground/65">…-</span>
                                    {/if}
                                  </span>
                                  <Input
                                    type="text"
                                    placeholder="e.g. int"
                                    value={name}
                                    oninput={(e) => {
                                      const id = p.id;
                                      const i = idx;
                                      const v = e.currentTarget.value;
                                      projects = projects.map((x) => {
                                        if (x.id !== id) return x;
                                        const accountNames = x.accountNames.slice();
                                        accountNames[i] = v;
                                        return { ...x, accountNames };
                                      });
                                    }}
                                    class="h-9 min-h-9 min-w-0 flex-1 rounded-none border-0 bg-transparent text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                                  />
                                </div>
                                {#if accountNamePrefixForDraft(p.slug)}
                                  <span class="font-mono text-[0.7rem] text-foreground/80 break-all">
                                    {fullAwsAccountName(p.slug, name)}
                                  </span>
                                {/if}
                                {@render accountDecommissionControls(p, idx)}
                              </div>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Email</span>
                                <span class="font-mono text-[0.75rem] text-foreground/90 break-all leading-snug">
                                  {accountAliasEmail(name, p.slug)}
                                </span>
                              </div>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Cost</span>
                                {#if costsPendingProvisioning(p.provisioning)}
                                  <div class="flex min-h-9 items-end justify-end pb-1">
                                    {@render provisioningFieldDots(
                                      'text-muted-foreground/70',
                                      'Per-account cost data not ready yet',
                                    )}
                                  </div>
                                {:else}
                                  {@render accountCostStack(curCell, lastCell, predCell)}
                                {/if}
                              </div>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Account id</span>
                                {#if accountIdsPendingProvisioning(p.provisioning)}
                                  <div class="flex h-9 w-full items-center justify-end">
                                    {@render accountIdDotsPlaceholder()}
                                  </div>
                                {:else}
                                  <Input
                                    type="text"
                                    placeholder="—"
                                    value={p.accountHints?.[idx] ?? ''}
                                    oninput={(e) => {
                                      const id = p.id;
                                      const i = idx;
                                      const v = e.currentTarget.value;
                                      projects = projects.map((x) => {
                                        if (x.id !== id) return x;
                                        const hints = [...(x.accountHints ?? [])];
                                        while (hints.length <= i) hints.push('');
                                        hints[i] = v;
                                        return { ...x, accountHints: hints };
                                      });
                                    }}
                                    class="h-9 w-full min-w-0 rounded-sm border-border bg-transparent font-mono text-[0.8rem] tabular-nums"
                                  />
                                {/if}
                              </div>
                              <div class="flex items-center gap-2">
                                {@render accountWebsiteLinkOrLoading(p, name)}
                              </div>
                            </div>
                          {/each}
                        </div>
                        <div class="hidden min-w-0 md:block">
                          <table
                            class="w-full min-w-0 table-fixed border-collapse border border-border text-sm [overflow-wrap:anywhere]"
                          >
                            <colgroup>
                              <col class="w-[28%]" />
                              <col class="w-[30%]" />
                              <col class="w-[23%]" />
                              <col class="w-[14%]" />
                              <col class="w-[5%]" />
                            </colgroup>
                            <thead>
                              <tr class="border-border border-b bg-muted/20 text-muted-foreground">
                                <th class="border-border border-b px-4 py-2 text-left font-medium tracking-wide uppercase">
                                  Account (suffix)
                                </th>
                                <th
                                  class="min-w-0 border-border border-b px-4 py-2 text-left font-medium tracking-wide uppercase"
                                >
                                  Email
                                </th>
                                <th class="border-border border-b px-3.5 py-2 text-right font-medium tracking-wide uppercase">
                                  Cost
                                </th>
                                <th class="border-border border-b px-3 py-2 pr-1.5 text-right font-medium tracking-wide uppercase">
                                  Account id
                                </th>
                                <th class="border-border border-b py-2 pl-1 pr-2 text-left font-medium tracking-wide uppercase">
                                  Site
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {#each p.accountNames as name, idx (`${p.id}-row-${idx}`)}
                                {@const lastCell = awsCostCell(p.accountCostsLastMonth?.[idx])}
                                {@const curCell = awsCostCell(p.accountCostsCurrent?.[idx])}
                                {@const predCell = awsCostCell(p.accountCostsPredicted?.[idx])}
                                <tr class="[&_td]:border-b [&_td]:border-border last:[&_td]:border-b-0">
                                  <td class="min-w-0 px-4 py-2 align-middle">
                                    <div class="flex flex-col gap-1">
                                      <div
                                        class="flex h-9 min-w-0 rounded-sm border border-border shadow-xs focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring"
                                      >
                                        <span
                                          class="flex max-w-[min(10rem,42%)] shrink-0 items-center border-border border-r bg-muted/30 px-2 font-mono text-[0.72rem] text-muted-foreground"
                                          title="Prefix from slug"
                                        >
                                          {#if accountNamePrefixForDraft(p.slug)}
                                            {accountNamePrefixForDraft(p.slug)}
                                          {:else}
                                            <span class="text-muted-foreground/65">…-</span>
                                          {/if}
                                        </span>
                                        <Input
                                          type="text"
                                          placeholder="e.g. int"
                                          value={name}
                                          oninput={(e) => {
                                            const id = p.id;
                                            const i = idx;
                                            const v = e.currentTarget.value;
                                            projects = projects.map((x) => {
                                              if (x.id !== id) return x;
                                              const accountNames = x.accountNames.slice();
                                              accountNames[i] = v;
                                              return { ...x, accountNames };
                                            });
                                          }}
                                          class="h-9 min-h-9 min-w-0 flex-1 rounded-none border-0 bg-transparent text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                                        />
                                      </div>
                                      {#if accountNamePrefixForDraft(p.slug)}
                                        <span class="font-mono text-[0.68rem] text-foreground/75 break-all">
                                          {fullAwsAccountName(p.slug, name)}
                                        </span>
                                      {/if}
                                      {@render accountDecommissionControls(p, idx)}
                                    </div>
                                  </td>
                                  <td class="min-w-0 px-4 py-2 align-middle">
                                    <span class="block w-full font-mono text-[0.75rem] text-foreground/90 break-all">
                                      {accountAliasEmail(name, p.slug)}
                                    </span>
                                  </td>
                                  <td class="min-w-0 px-3.5 py-2 align-middle text-right tabular-nums">
                                    {#if costsPendingProvisioning(p.provisioning)}
                                      <div class="flex min-h-9 items-center justify-end">
                                        {@render provisioningFieldDots(
                                          'text-muted-foreground/70',
                                          'Per-account cost data not ready yet',
                                        )}
                                      </div>
                                    {:else}
                                      {@render accountCostStack(curCell, lastCell, predCell)}
                                    {/if}
                                  </td>
                                  <td class="min-w-0 px-3 py-2 pr-1.5 align-middle text-right">
                                    {#if accountIdsPendingProvisioning(p.provisioning)}
                                      <div class="flex h-9 items-center justify-end">
                                        {@render accountIdDotsPlaceholder()}
                                      </div>
                                    {:else}
                                      <Input
                                        type="text"
                                        placeholder="—"
                                        value={p.accountHints?.[idx] ?? ''}
                                        oninput={(e) => {
                                          const id = p.id;
                                          const i = idx;
                                          const v = e.currentTarget.value;
                                          projects = projects.map((x) => {
                                            if (x.id !== id) return x;
                                            const hints = [...(x.accountHints ?? [])];
                                            while (hints.length <= i) hints.push('');
                                            hints[i] = v;
                                            return { ...x, accountHints: hints };
                                          });
                                        }}
                                        class="h-9 w-full min-w-0 rounded-sm border-border bg-transparent text-right font-mono text-[0.8rem] tabular-nums"
                                      />
                                    {/if}
                                  </td>
                                  <td class="w-0 whitespace-nowrap py-2 pl-1 pr-2 align-middle text-left">
                                    {@render accountWebsiteLinkOrLoading(p, name)}
                                  </td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      {/if}
                      {/if}
                    </div>
                  {:else if editingProjectId === p.id}
                    <div class="flex flex-col gap-6 pt-2">
                      {#if liveMode && p.decommissionError?.trim() && !p.isDraft && !p.provisioning}
                        <div
                          class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                          role="alert"
                        >
                          Account closure failed: {p.decommissionError}
                        </div>
                      {/if}
                      <div class="grid gap-4 sm:grid-cols-2">
                        <div class={tripleFieldGridClass}>
                          <div class="flex min-w-0 flex-col gap-2">
                            <Label for={`${p.id}-edit-name`} class="text-muted-foreground text-xs font-normal">
                              Project name
                            </Label>
                            <Input
                              id={`${p.id}-edit-name`}
                              type="text"
                              value={p.name}
                              oninput={(e) => patchProject(p.id, { name: e.currentTarget.value })}
                              class="w-full min-w-0 rounded-sm border-border bg-transparent"
                            />
                          </div>
                          <div class="flex min-w-0 flex-col gap-1">
                            <span class="text-muted-foreground text-xs font-normal">Slug</span>
                            <span class="font-mono text-sm text-foreground break-all">{slugify(p.slug) || '—'}</span>
                          </div>
                          <div class="flex min-w-0 flex-col gap-1">
                            <span class="text-muted-foreground text-xs font-normal">Template</span>
                            <span class="text-sm text-foreground break-words">{p.templateLabel || '—'}</span>
                          </div>
                        </div>
                        <p class="text-[0.65rem] text-muted-foreground leading-snug sm:col-span-2">
                          Slug, template, and accounts stay fixed after the project is created.
                        </p>
                        <div class="flex w-full min-w-0 flex-col gap-2 sm:col-span-2">
                          <Label for={`${p.id}-edit-blurb`} class="text-muted-foreground text-xs font-normal">
                            Description
                          </Label>
                          <textarea
                            id={`${p.id}-edit-blurb`}
                            rows="3"
                            value={p.detailBlurb}
                            oninput={(e) => patchProject(p.id, { detailBlurb: e.currentTarget.value })}
                            class="min-h-[5rem] w-full min-w-0 resize-y rounded-sm border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            placeholder="Short summary…"
                          ></textarea>
                        </div>
                        <div class={tripleFieldGridClass}>
                          <div class="flex min-w-0 flex-col gap-2">
                            <span class="text-muted-foreground text-xs font-normal">Website URL</span>
                            {#if websitePendingProvisioning(p.provisioning)}
                              <div class="flex h-9 items-center">
                                {@render provisioningFieldDots(
                                  'text-muted-foreground/75',
                                  'Website not live yet',
                                )}
                              </div>
                            {:else}
                              <Label for={`${p.id}-edit-website`} class="sr-only">Website URL</Label>
                              <Input
                                id={`${p.id}-edit-website`}
                                type="url"
                                placeholder="https://…"
                                value={p.websiteUrl}
                                oninput={(e) => patchProject(p.id, { websiteUrl: e.currentTarget.value })}
                                class="w-full min-w-0 rounded-sm border-border bg-transparent font-mono text-[0.85rem]"
                              />
                            {/if}
                          </div>
                          <div class="flex min-w-0 flex-col gap-2">
                            <span class="text-muted-foreground text-xs font-normal">GitHub URL</span>
                            {#if githubIntegrationPending(p.provisioning)}
                              <div class="flex h-9 items-center">
                                {@render provisioningFieldDots(
                                  'text-muted-foreground/75',
                                  'GitHub integration not ready',
                                )}
                              </div>
                            {:else}
                              <Label for={`${p.id}-edit-github`} class="sr-only">GitHub URL</Label>
                              <Input
                                id={`${p.id}-edit-github`}
                                type="url"
                                value={p.githubUrl}
                                oninput={(e) => patchProject(p.id, { githubUrl: e.currentTarget.value })}
                                class="w-full min-w-0 rounded-sm border-border bg-transparent font-mono text-[0.85rem]"
                              />
                            {/if}
                          </div>
                          <div class="flex min-w-0 flex-col gap-2">
                            <span class="text-muted-foreground text-xs font-normal">Assign URL</span>
                            {#if awsAssignPendingProvisioning(p.provisioning)}
                              <div class="flex h-9 items-center">
                                {@render provisioningFieldDots(
                                  'text-muted-foreground/75',
                                  'AWS account access not ready yet',
                                )}
                              </div>
                            {:else}
                              <Label for={`${p.id}-edit-assign`} class="sr-only">Assign URL</Label>
                              <Input
                                id={`${p.id}-edit-assign`}
                                type="url"
                                value={p.awsSignInUrl}
                                oninput={(e) => patchProject(p.id, { awsSignInUrl: e.currentTarget.value })}
                                class="w-full min-w-0 rounded-sm border-border bg-transparent font-mono text-[0.85rem]"
                              />
                            {/if}
                          </div>
                        </div>
                      </div>

                      <div class="min-w-0">
                        <div class="flex flex-col gap-3 md:hidden">
                          {#each p.accountNames as name, idx (`${p.id}-edit-acct-m-${idx}`)}
                            {@const accountIdHint = p.accountHints?.[idx]}
                            {@const lastCell = awsCostCell(p.accountCostsLastMonth?.[idx])}
                            {@const curCell = awsCostCell(p.accountCostsCurrent?.[idx])}
                            {@const predCell = awsCostCell(p.accountCostsPredicted?.[idx])}
                            <div class={accountMobileCardClass}>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Account name</span>
                                <span class="text-sm font-medium text-foreground break-words">{name}</span>
                                {@render accountDecommissionControls(p, idx)}
                              </div>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Email</span>
                                <span class="font-mono text-[0.75rem] text-foreground/90 break-all leading-snug">
                                  {accountAliasEmail(name, p.slug)}
                                </span>
                              </div>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Cost</span>
                                {#if costsPendingProvisioning(p.provisioning)}
                                  <div class="flex min-h-9 items-end justify-end pb-1">
                                    {@render provisioningFieldDots(
                                      'text-muted-foreground/70',
                                      'Per-account cost data not ready yet',
                                    )}
                                  </div>
                                {:else}
                                  {@render accountCostStack(curCell, lastCell, predCell)}
                                {/if}
                              </div>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Account id</span>
                                {#if accountIdsPendingProvisioning(p.provisioning)}
                                  <div class="flex min-h-9 items-center justify-end">
                                    {@render accountIdDotsPlaceholder()}
                                  </div>
                                {:else}
                                  <span class="font-mono text-[0.8rem] text-muted-foreground tabular-nums break-all">
                                    {#if (accountIdHint ?? '').trim()}
                                      {accountIdHint}
                                    {:else}
                                      —
                                    {/if}
                                  </span>
                                {/if}
                              </div>
                              <div class="flex items-center gap-2">
                                {@render accountWebsiteLinkOrLoading(p, name)}
                              </div>
                            </div>
                          {/each}
                        </div>
                        <div class="hidden min-w-0 md:block">
                          <table
                            class="w-full min-w-0 table-fixed border-collapse border border-border text-sm [overflow-wrap:anywhere]"
                          >
                            <colgroup>
                              <col class="w-[28%]" />
                              <col class="w-[30%]" />
                              <col class="w-[23%]" />
                              <col class="w-[14%]" />
                              <col class="w-[5%]" />
                            </colgroup>
                            <thead>
                              <tr class="border-border border-b bg-muted/20 text-muted-foreground">
                                <th class="border-border border-b px-4 py-2 text-left font-medium tracking-wide uppercase">
                                  Account name
                                </th>
                                <th
                                  class="min-w-0 border-border border-b px-4 py-2 text-left font-medium tracking-wide uppercase"
                                >
                                  Email
                                </th>
                                <th class="border-border border-b px-3.5 py-2 text-right font-medium tracking-wide uppercase">
                                  Cost
                                </th>
                                <th class="border-border border-b px-3 py-2 pr-1.5 text-right font-medium tracking-wide uppercase">
                                  Account id
                                </th>
                                <th class="border-border border-b py-2 pl-1 pr-2 text-left font-medium tracking-wide uppercase">
                                  Site
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {#each p.accountNames as name, idx (`${p.id}-edit-acct-${idx}`)}
                                {@const accountIdHint = p.accountHints?.[idx]}
                                {@const lastCell = awsCostCell(p.accountCostsLastMonth?.[idx])}
                                {@const curCell = awsCostCell(p.accountCostsCurrent?.[idx])}
                                {@const predCell = awsCostCell(p.accountCostsPredicted?.[idx])}
                                <tr class="[&_td]:border-b [&_td]:border-border last:[&_td]:border-b-0">
                                  <td class="min-w-0 break-words px-4 py-2 font-medium text-foreground">
                                    <div class="flex flex-col gap-0.5">
                                      <span>{name}</span>
                                      {@render accountDecommissionControls(p, idx)}
                                    </div>
                                  </td>
                                  <td class="min-w-0 px-4 py-2">
                                    <span class="block w-full font-mono text-[0.75rem] text-foreground/90 break-all">
                                      {accountAliasEmail(name, p.slug)}
                                    </span>
                                  </td>
                                  <td class="min-w-0 px-3.5 py-2 align-middle text-right tabular-nums">
                                    {#if costsPendingProvisioning(p.provisioning)}
                                      <div class="flex min-h-9 items-center justify-end">
                                        {@render provisioningFieldDots(
                                          'text-muted-foreground/70',
                                          'Per-account cost data not ready yet',
                                        )}
                                      </div>
                                    {:else}
                                      {@render accountCostStack(curCell, lastCell, predCell)}
                                    {/if}
                                  </td>
                                  <td class="min-w-0 break-all px-3 py-2 pr-1.5 text-right font-mono text-[0.8rem] text-muted-foreground tabular-nums">
                                    {#if accountIdsPendingProvisioning(p.provisioning)}
                                      <div class="flex min-h-9 items-center justify-end">
                                        {@render accountIdDotsPlaceholder()}
                                      </div>
                                    {:else if (accountIdHint ?? '').trim()}
                                      {accountIdHint}
                                    {:else}
                                      —
                                    {/if}
                                  </td>
                                  <td class="w-0 whitespace-nowrap py-2 pl-1 pr-2 align-middle text-left">
                                    {@render accountWebsiteLinkOrLoading(p, name)}
                                  </td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  {:else}
                    <div class="flex flex-col gap-6 pt-2">
                      {#if liveMode && p.decommissionError?.trim() && !p.isDraft && !p.provisioning}
                        <div
                          class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                          role="alert"
                        >
                          Account closure failed: {p.decommissionError}
                        </div>
                      {/if}
                      {#if liveMode && p.provisioningPhase === 'REPO_ONLY' && !p.provisioning}
                        <div
                          class="rounded-md border border-emerald-600/30 bg-emerald-600/5 px-4 py-3 dark:bg-emerald-950/25"
                          role="region"
                          aria-label="Add AWS accounts to this project"
                        >
                          <p class="text-sm text-foreground leading-snug">
                            The GitHub monorepo is ready. Add one or more AWS accounts to create organization
                            members, GitHub OIDC deploy roles, Identity Center assignment, and repository
                            deploy configuration.
                          </p>
                          {#if p.awsProvisionAccountMode === undefined}
                            <Button
                              type="button"
                              variant="outline"
                              class="mt-3"
                              onclick={() =>
                                patchProject(p.id, {
                                  awsProvisionAccountMode: 'org',
                                  awsProvisionOrgAccountIds: [],
                                  awsProvisionAccountNames: undefined,
                                })}
                            >
                              Add AWS accounts
                            </Button>
                          {:else}
                            <div class="mt-4 flex max-w-xl flex-col gap-3">
                              <div class="flex flex-wrap gap-4 text-sm">
                                <label class="flex cursor-pointer items-center gap-2">
                                  <input
                                    type="radio"
                                    name={`${p.id}-prov-aws-mode`}
                                    class="size-4"
                                    checked={(p.awsProvisionAccountMode ?? 'org') === 'org'}
                                    onchange={() =>
                                      patchProject(p.id, {
                                        awsProvisionAccountMode: 'org',
                                        awsProvisionOrgAccountIds: [],
                                        awsProvisionAccountNames: undefined,
                                      })}
                                  />
                                  <span class="text-muted-foreground">Use existing organization accounts</span>
                                </label>
                                <label class="flex cursor-pointer items-center gap-2">
                                  <input
                                    type="radio"
                                    name={`${p.id}-prov-aws-mode`}
                                    class="size-4"
                                    checked={(p.awsProvisionAccountMode ?? 'org') === 'vend'}
                                    onchange={() =>
                                      patchProject(p.id, {
                                        awsProvisionAccountMode: 'vend',
                                        awsProvisionOrgAccountIds: undefined,
                                        awsProvisionAccountNames: ['int', 'stage', 'prod'],
                                      })}
                                  />
                                  <span class="text-muted-foreground">Create new accounts (vend)</span>
                                </label>
                              </div>

                              {#if (p.awsProvisionAccountMode ?? 'org') === 'org'}
                                <div class="flex flex-wrap items-center gap-2">
                                  <span class="text-muted-foreground text-xs font-normal">Organization accounts</span>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    class="h-7 text-xs"
                                    onclick={() => refreshOrgAccountsForPicker()}
                                  >
                                    Sync from AWS
                                  </Button>
                                </div>
                                {#if orgAccountsPickerLoading}
                                  <p class="text-muted-foreground text-xs">Loading accounts…</p>
                                {:else if orgAccountsPickerError}
                                  <p class="text-destructive text-xs">{orgAccountsPickerError}</p>
                                {:else}
                                  <div
                                    class="max-h-48 overflow-y-auto rounded-sm border border-border border-dashed p-2"
                                  >
                                    {#each orgAccountsSelectable(orgAccountsForPicker) as o (o.accountId)}
                                      <label
                                        class="flex cursor-pointer items-start gap-2 border-b border-border/50 py-1.5 last:border-b-0"
                                      >
                                        <input
                                          type="checkbox"
                                          class="mt-0.5 size-4 shrink-0"
                                          checked={(p.awsProvisionOrgAccountIds ?? []).includes(o.accountId)}
                                          onchange={(e) =>
                                            toggleProvisionOrgAccount(p.id, o.accountId, e.currentTarget.checked)}
                                        />
                                        <span class="min-w-0 font-mono text-[0.75rem] leading-snug text-foreground">
                                          <span class="text-muted-foreground">{o.accountId}</span>
                                          {#if o.isManagementAccount}
                                            <span
                                              class="ml-1.5 inline-block shrink-0 rounded-sm border border-border bg-muted/80 px-1 py-px font-sans text-[0.55rem] font-medium uppercase tracking-wide text-muted-foreground"
                                              title="Organization management (root) account"
                                            >
                                              Management
                                            </span>
                                          {/if}
                                          {#if o.name?.trim()}
                                            {` · ${o.name.trim()}`}
                                          {/if}
                                          {#if o.email?.trim()}
                                            {` · ${o.email.trim()}`}
                                          {/if}
                                        </span>
                                      </label>
                                    {/each}
                                  </div>
                                {/if}
                              {:else}
                                <div class="flex max-w-[8rem] flex-col gap-2">
                                  <Label
                                    for={`${p.id}-aws-acct-count`}
                                    class="text-muted-foreground text-xs font-normal"
                                  >
                                    Number of accounts
                                  </Label>
                                  <Input
                                    id={`${p.id}-aws-acct-count`}
                                    type="number"
                                    min={MIN_AWS_PROVISION_ACCOUNTS}
                                    max={MAX_ACCOUNTS}
                                    value={String((p.awsProvisionAccountNames ?? []).length)}
                                    oninput={(e) => {
                                      const v = Number.parseInt(e.currentTarget.value, 10);
                                      setAwsProvisionAccountCount(
                                        p.id,
                                        Number.isFinite(v) ? v : MIN_AWS_PROVISION_ACCOUNTS
                                      );
                                    }}
                                    class="rounded-sm border-border bg-transparent tabular-nums"
                                  />
                                </div>
                                <div class="flex min-w-0 flex-col gap-2">
                                  {#each p.awsProvisionAccountNames ?? [] as suffix, idx (`${p.id}-aws-sfx-${idx}`)}
                                    <div class="flex min-w-0 flex-col gap-1">
                                      <span class="text-muted-foreground text-[0.65rem] font-normal"
                                        >Account suffix {idx + 1}</span
                                      >
                                      <div
                                        class="flex h-9 min-w-0 rounded-sm border border-border shadow-xs focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring"
                                      >
                                        <span
                                          class="flex max-w-[min(12rem,45%)] shrink-0 items-center border-border border-r bg-muted/30 px-2 font-mono text-[0.75rem] text-muted-foreground"
                                          title="Prefix from slug"
                                        >
                                          {#if accountNamePrefixForDraft(p.slug)}
                                            {accountNamePrefixForDraft(p.slug)}
                                          {:else}
                                            <span class="text-muted-foreground/65">…-</span>
                                          {/if}
                                        </span>
                                        <Input
                                          type="text"
                                          placeholder="e.g. int"
                                          value={suffix}
                                          oninput={(e) => {
                                            const id = p.id;
                                            const i = idx;
                                            const v = e.currentTarget.value;
                                            projects = projects.map((x) => {
                                              if (x.id !== id) return x;
                                              const names = [...(x.awsProvisionAccountNames ?? [])];
                                              names[i] = v;
                                              return { ...x, awsProvisionAccountNames: names };
                                            });
                                          }}
                                          class="h-9 min-h-9 min-w-0 flex-1 rounded-none border-0 bg-transparent text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                                        />
                                      </div>
                                      {#if accountNamePrefixForDraft(p.slug)}
                                        <span class="font-mono text-[0.7rem] text-foreground/80 break-all">
                                          {fullAwsAccountName(p.slug, suffix)}
                                        </span>
                                      {/if}
                                    </div>
                                  {/each}
                                </div>
                              {/if}
                            </div>
                            <div class="mt-4 flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                disabled={!slugify(p.slug) ||
                                  ((p.awsProvisionAccountMode ?? 'org') === 'org' &&
                                    (p.awsProvisionOrgAccountIds?.length ?? 0) === 0) ||
                                  ((p.awsProvisionAccountMode ?? 'org') === 'vend' &&
                                    !(p.awsProvisionAccountNames?.length ?? 0))}
                                onclick={() => saveAwsProvision(p.id)}
                              >
                                Start AWS provisioning
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                onclick={() =>
                                  patchProject(p.id, {
                                    awsProvisionAccountMode: undefined,
                                    awsProvisionOrgAccountIds: undefined,
                                    awsProvisionAccountNames: undefined,
                                  })}
                              >
                                Cancel
                              </Button>
                            </div>
                          {/if}
                        </div>
                      {/if}
                      <div class="grid gap-4 sm:grid-cols-2">
                        <div class={tripleFieldGridClass}>
                          <div class="flex min-w-0 flex-col gap-1">
                            <span class="text-muted-foreground text-xs font-normal">Project name</span>
                            <span class="text-sm text-foreground break-words">{p.name}</span>
                          </div>
                          <div class="flex min-w-0 flex-col gap-1">
                            <span class="text-muted-foreground text-xs font-normal">Slug</span>
                            <span class="font-mono text-sm text-foreground break-all">{slugify(p.slug) || '—'}</span>
                          </div>
                          <div class="flex min-w-0 flex-col gap-1">
                            <span class="text-muted-foreground text-xs font-normal">Template</span>
                            <span class="text-sm text-foreground break-words">{p.templateLabel || '—'}</span>
                          </div>
                        </div>
                        {#if p.detailBlurb.trim()}
                          <div class="flex w-full min-w-0 flex-col gap-1 sm:col-span-2">
                            <span class="text-muted-foreground text-xs font-normal">Description</span>
                            <p class="w-full min-w-0 text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words">
                              {p.detailBlurb}
                            </p>
                          </div>
                        {/if}
                        <div class={tripleFieldGridClass}>
                          <div class="flex min-w-0 flex-col gap-1">
                            <span class="text-muted-foreground text-xs font-normal">Website URL</span>
                            {#if websitePendingProvisioning(p.provisioning)}
                              <div class="flex min-h-[1.35rem] items-center">
                                {@render provisioningFieldDots(
                                  'text-muted-foreground/75',
                                  'Website not live yet',
                                )}
                              </div>
                            {:else if p.websiteUrl.trim()}
                              <a
                                href={p.websiteUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="break-all font-mono text-[0.85rem] text-foreground/90 underline underline-offset-2 hover:text-foreground"
                              >
                                {p.websiteUrl}
                              </a>
                            {:else}
                              <span class="text-sm text-muted-foreground">—</span>
                            {/if}
                          </div>
                          <div class="flex min-w-0 flex-col gap-1">
                            <span class="text-muted-foreground text-xs font-normal">GitHub URL</span>
                            {#if githubIntegrationPending(p.provisioning)}
                              <div class="flex min-h-[1.35rem] items-center">
                                {@render provisioningFieldDots(
                                  'text-muted-foreground/75',
                                  'GitHub integration not ready',
                                )}
                              </div>
                            {:else if p.githubUrl.trim()}
                              <a
                                href={p.githubUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="break-all font-mono text-[0.85rem] text-foreground/90 underline underline-offset-2 hover:text-foreground"
                              >
                                {p.githubUrl}
                              </a>
                            {:else}
                              <span class="text-sm text-muted-foreground">—</span>
                            {/if}
                          </div>
                          <div class="flex min-w-0 flex-col gap-1">
                            <span class="text-muted-foreground text-xs font-normal">Assign URL</span>
                            {#if awsAssignPendingProvisioning(p.provisioning)}
                              <div class="flex min-h-[1.35rem] items-center">
                                {@render provisioningFieldDots(
                                  'text-muted-foreground/75',
                                  'AWS account access not ready yet',
                                )}
                              </div>
                            {:else if p.awsSignInUrl.trim()}
                              <a
                                href={p.awsSignInUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="break-all font-mono text-[0.85rem] text-foreground/90 underline underline-offset-2 hover:text-foreground"
                              >
                                {p.awsSignInUrl}
                              </a>
                            {:else}
                              <span class="text-sm text-muted-foreground">—</span>
                            {/if}
                          </div>
                        </div>
                      </div>

                      <div class="min-w-0">
                        <div class="flex flex-col gap-3 md:hidden">
                          {#each p.accountNames as name, idx (`${p.id}-readonly-acct-m-${idx}`)}
                            {@const accountIdHint = p.accountHints?.[idx]}
                            {@const lastCell = awsCostCell(p.accountCostsLastMonth?.[idx])}
                            {@const curCell = awsCostCell(p.accountCostsCurrent?.[idx])}
                            {@const predCell = awsCostCell(p.accountCostsPredicted?.[idx])}
                            <div class={accountMobileCardClass}>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Account name</span>
                                <span class="text-sm font-medium text-foreground break-words">{name}</span>
                                {@render accountDecommissionControls(p, idx)}
                              </div>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Email</span>
                                <span class="font-mono text-[0.75rem] text-foreground/90 break-all leading-snug">
                                  {accountAliasEmail(name, p.slug)}
                                </span>
                              </div>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Cost</span>
                                {#if costsPendingProvisioning(p.provisioning)}
                                  <div class="flex min-h-9 items-end justify-end pb-1">
                                    {@render provisioningFieldDots(
                                      'text-muted-foreground/70',
                                      'Per-account cost data not ready yet',
                                    )}
                                  </div>
                                {:else}
                                  {@render accountCostStack(curCell, lastCell, predCell)}
                                {/if}
                              </div>
                              <div class="flex flex-col gap-1.5">
                                <span class={accountMobileFieldLabelClass}>Account id</span>
                                {#if accountIdsPendingProvisioning(p.provisioning)}
                                  <div class="flex min-h-9 items-center justify-end">
                                    {@render accountIdDotsPlaceholder()}
                                  </div>
                                {:else}
                                  <span class="font-mono text-[0.8rem] text-muted-foreground tabular-nums break-all">
                                    {#if (accountIdHint ?? '').trim()}
                                      {accountIdHint}
                                    {:else}
                                      —
                                    {/if}
                                  </span>
                                {/if}
                              </div>
                              <div class="flex items-center gap-2">
                                {@render accountWebsiteLinkOrLoading(p, name)}
                              </div>
                            </div>
                          {/each}
                        </div>
                        <div class="hidden min-w-0 md:block">
                          <table
                            class="w-full min-w-0 table-fixed border-collapse border border-border text-sm [overflow-wrap:anywhere]"
                          >
                            <colgroup>
                              <col class="w-[28%]" />
                              <col class="w-[30%]" />
                              <col class="w-[23%]" />
                              <col class="w-[14%]" />
                              <col class="w-[5%]" />
                            </colgroup>
                            <thead>
                              <tr class="border-border border-b bg-muted/20 text-muted-foreground">
                                <th class="border-border border-b px-4 py-2 text-left font-medium tracking-wide uppercase">
                                  Account name
                                </th>
                                <th
                                  class="min-w-0 border-border border-b px-4 py-2 text-left font-medium tracking-wide uppercase"
                                >
                                  Email
                                </th>
                                <th class="border-border border-b px-3.5 py-2 text-right font-medium tracking-wide uppercase">
                                  Cost
                                </th>
                                <th class="border-border border-b px-3 py-2 pr-1.5 text-right font-medium tracking-wide uppercase">
                                  Account id
                                </th>
                                <th class="border-border border-b py-2 pl-1 pr-2 text-left font-medium tracking-wide uppercase">
                                  Site
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {#each p.accountNames as name, idx (`${p.id}-readonly-acct-${idx}`)}
                                {@const accountIdHint = p.accountHints?.[idx]}
                                {@const lastCell = awsCostCell(p.accountCostsLastMonth?.[idx])}
                                {@const curCell = awsCostCell(p.accountCostsCurrent?.[idx])}
                                {@const predCell = awsCostCell(p.accountCostsPredicted?.[idx])}
                                <tr class="[&_td]:border-b [&_td]:border-border last:[&_td]:border-b-0">
                                  <td class="min-w-0 break-words px-4 py-2 font-medium text-foreground">
                                    <div class="flex flex-col gap-0.5">
                                      <span>{name}</span>
                                      {@render accountDecommissionControls(p, idx)}
                                    </div>
                                  </td>
                                  <td class="min-w-0 px-4 py-2">
                                    <span class="block w-full font-mono text-[0.75rem] text-foreground/90 break-all">
                                      {accountAliasEmail(name, p.slug)}
                                    </span>
                                  </td>
                                  <td class="min-w-0 px-3.5 py-2 align-middle text-right tabular-nums">
                                    {#if costsPendingProvisioning(p.provisioning)}
                                      <div class="flex min-h-9 items-center justify-end">
                                        {@render provisioningFieldDots(
                                          'text-muted-foreground/70',
                                          'Per-account cost data not ready yet',
                                        )}
                                      </div>
                                    {:else}
                                      {@render accountCostStack(curCell, lastCell, predCell)}
                                    {/if}
                                  </td>
                                  <td class="min-w-0 break-all px-3 py-2 pr-1.5 text-right font-mono text-[0.8rem] text-muted-foreground tabular-nums">
                                    {#if accountIdsPendingProvisioning(p.provisioning)}
                                      <div class="flex min-h-9 items-center justify-end">
                                        {@render accountIdDotsPlaceholder()}
                                      </div>
                                    {:else if (accountIdHint ?? '').trim()}
                                      {accountIdHint}
                                    {:else}
                                      —
                                    {/if}
                                  </td>
                                  <td class="w-0 whitespace-nowrap py-2 pl-1 pr-2 align-middle text-left">
                                    {@render accountWebsiteLinkOrLoading(p, name)}
                                  </td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  {/if}
                </Accordion.Content>
              </Accordion.Item>
            {/each}
          </Accordion.Root>
        </div>
      {/if}
    </div>
  </div>

  {#if closeAccountDialog != null}
    {@const dlg = closeAccountDialog}
    {@const dlgProject = projects.find((x) => x.id === dlg.projectId)}
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
        aria-labelledby="close-acct-title"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <h2 id="close-acct-title" class="text-lg font-semibold text-destructive">
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
        {#if dlgProject}
          <p class="mt-3 font-mono text-xs text-foreground break-all">
            Account ID: {dlg.accountId}
          </p>
          {#if dlgProject.githubUrl?.trim()}
            <div class="mt-4 flex gap-3 rounded-md border border-border bg-muted/20 px-3 py-3">
              <input
                id="close-acct-monorepo-teardown"
                type="checkbox"
                class="mt-0.5 size-4 shrink-0 rounded border-border accent-primary"
                checked={closeAccountRunMonorepoTeardown}
                onchange={(e) => {
                  closeAccountRunMonorepoTeardown = e.currentTarget.checked;
                }}
              />
              <div class="min-w-0">
                <Label for="close-acct-monorepo-teardown" class="text-sm font-medium text-foreground">
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
          <Label for="confirm-slug" class="mt-4 block text-sm">
            Type project slug
            <span class="font-mono font-semibold">{slugify(dlgProject.slug) || '—'}</span> to confirm
          </Label>
          <Input
            id="confirm-slug"
            class="mt-1"
            value={closeAccountSlugInput}
            oninput={(e) => {
              closeAccountSlugInput = e.currentTarget.value;
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
          <Button type="button" variant="destructive" onclick={() => confirmCloseAccount()}>
            Yes, remove account
          </Button>
        </div>
      </div>
    </div>
  {/if}

  {#if showScrollDownChevron}
    <button
      type="button"
      class="pointer-events-auto fixed bottom-6 left-1/2 z-30 flex size-10 -translate-x-1/2 items-center justify-center border border-border bg-background/95 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label="Scroll down"
      onclick={scrollPageDownStep}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class="translate-y-px"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  {/if}
</main>

<style>
  @keyframes acct-id-dot-flicker {
    0%,
    100% {
      opacity: 0.2;
      transform: scale(0.92);
    }
    50% {
      opacity: 1;
      transform: scale(1);
    }
  }

  .acct-id-loading-dots {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.28rem;
  }

  .acct-id-loading-dots span {
    display: block;
    width: 0.32rem;
    height: 0.32rem;
    border-radius: 9999px;
    background: currentColor;
    animation: acct-id-dot-flicker 1.05s ease-in-out infinite;
  }

  .acct-id-loading-dots span:nth-child(2) {
    animation-delay: 0.18s;
  }

  .acct-id-loading-dots span:nth-child(3) {
    animation-delay: 0.36s;
  }

  /** Fits inside W / G / A action squares */
  .acct-id-loading-dots--icon {
    gap: 0.12rem;
    justify-content: center;
  }

  .acct-id-loading-dots--icon span {
    width: 0.22rem;
    height: 0.22rem;
  }
</style>

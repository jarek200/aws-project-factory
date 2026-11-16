/**
 * Admin GraphQL service
 *
 * Wraps AppSync queries/mutations for project management.
 * Only active when SST env vars are present (live mode).
 * Without live mode, unsaved new-project rows stay in local UI state only.
 */

import type { GraphQLResult } from '@aws-amplify/api-graphql';
import { ensureAmplifyConfigured } from '../amplify';

// biome-ignore lint/suspicious/noExplicitAny: Amplify client type is internal
let _client: any = null;

async function getClient() {
  if (_client) return _client;
  await ensureAmplifyConfigured();
  const { generateClient } = await import('aws-amplify/api');
  _client = generateClient({ authMode: 'userPool' });
  return _client;
}

export function resetClient() {
  _client = null;
}

// ─── Types mirrored from GraphQL schema ──────────────────────────────────────

export type ProvisioningPhase =
  | 'DRAFT'
  | 'GITHUB'
  | 'ACCOUNTS'
  | 'CONFIGURE'
  | 'REPO_ONLY'
  | 'DONE'
  | 'FAILED';

export type AccountClosureState = 'NONE' | 'CLOSING' | 'CLOSED';

export type DecommissionPhase =
  | 'IDLE'
  | 'DISPATCH_DESTROY'
  | 'TEARDOWN_BOOTSTRAP'
  | 'UNASSIGN_IDENTITY_CENTER'
  | 'CLOSE_ACCOUNT'
  | 'DONE'
  | 'FAILED';

export interface ProjectAccount {
  name: string;
  email: string;
  accountId: string | null;
  roleArn: string | null;
  awsSignInUrl: string | null;
  closureState?: AccountClosureState | null;
  closedAt?: string | null;
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  slug: string;
  description: string | null;
  templateRepo: string | null;
  githubOrg: string | null;
  accounts: ProjectAccount[];
  provisioningPhase: ProvisioningPhase;
  provisioningProgress: number;
  executionArn: string | null;
  githubUrl: string | null;
  websiteUrl: string | null;
  awsSignInUrl: string | null;
  error: string | null;
  decommissionPhase?: DecommissionPhase | null;
  decommissionExecutionArn?: string | null;
  decommissionTargetAccountId?: string | null;
  decommissionError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
  description?: string;
  templateRepo?: string;
  githubOrg?: string;
  accounts: Array<{ name: string; email: string; accountId?: string | null }>;
  websiteUrl?: string;
  awsSignInUrl?: string;
}

export interface ProvisionProjectAwsInput {
  projectId: string;
  accounts: Array<{ name: string; email: string; accountId?: string | null }>;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  websiteUrl?: string;
  awsSignInUrl?: string;
  githubUrl?: string;
}

export interface GithubRepoOption {
  fullName: string;
  name: string;
  isTemplate: boolean;
  private: boolean;
}

export interface OrganizationAccount {
  accountId: string;
  name: string | null;
  email: string | null;
  arn: string | null;
  isManagementAccount: boolean;
  /** AWS Organizations account lifecycle State */
  state: string | null;
  joinedMethod: string | null;
  joinedTimestamp: string | null;
  syncedAt: string;
  closureState?: AccountClosureState | null;
  closedAt?: string | null;
  decommissionPhase?: DecommissionPhase | null;
  decommissionError?: string | null;
}

export interface OrganizationAccountSyncResult {
  upserted: number;
  removed: number;
}

export interface ProjectGithubSyncResult {
  checked: number;
  removed: number;
  skippedInProgress: number;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const PROJECT_FIELDS = `
  id userId name slug description templateRepo githubOrg
  provisioningPhase provisioningProgress executionArn
  githubUrl websiteUrl awsSignInUrl error createdAt updatedAt
  decommissionPhase decommissionExecutionArn decommissionTargetAccountId decommissionError
  accounts { name email accountId roleArn awsSignInUrl closureState closedAt }
`;

export async function listProjects(): Promise<Project[]> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `query ListProjects { listProjects { ${PROJECT_FIELDS} } }`,
  })) as GraphQLResult<{ listProjects: Project[] }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  return result.data?.listProjects ?? [];
}

export async function listGithubReposForTemplate(): Promise<GithubRepoOption[]> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `query ListGithubReposForTemplate {
      listGithubReposForTemplate { fullName name isTemplate private }
    }`,
  })) as GraphQLResult<{ listGithubReposForTemplate: GithubRepoOption[] }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  return result.data?.listGithubReposForTemplate ?? [];
}

export async function getProject(id: string): Promise<Project | null> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `query GetProject($id: ID!) { getProject(id: $id) { ${PROJECT_FIELDS} } }`,
    variables: { id },
  })) as GraphQLResult<{ getProject: Project | null }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  return result.data?.getProject ?? null;
}

const ORG_ACCOUNT_FIELDS = `
  accountId name email arn isManagementAccount state joinedMethod joinedTimestamp syncedAt
  closureState closedAt decommissionPhase decommissionError
`;

export async function listOrganizationAccounts(): Promise<OrganizationAccount[]> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `query ListOrganizationAccounts {
      listOrganizationAccounts { ${ORG_ACCOUNT_FIELDS} }
    }`,
  })) as GraphQLResult<{ listOrganizationAccounts: OrganizationAccount[] }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  return result.data?.listOrganizationAccounts ?? [];
}

export async function getOrganizationAccount(
  accountId: string
): Promise<OrganizationAccount | null> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `query GetOrganizationAccount($accountId: ID!) {
      getOrganizationAccount(accountId: $accountId) { ${ORG_ACCOUNT_FIELDS} }
    }`,
    variables: { accountId },
  })) as GraphQLResult<{ getOrganizationAccount: OrganizationAccount | null }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  return result.data?.getOrganizationAccount ?? null;
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `
      mutation CreateProject($input: CreateProjectInput!) {
        createProject(input: $input) { ${PROJECT_FIELDS} }
      }
    `,
    variables: { input },
  })) as GraphQLResult<{ createProject: Project }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  const created = result.data?.createProject;
  if (!created) throw new Error('createProject returned no data');
  return created;
}

export async function provisionProjectAws(input: ProvisionProjectAwsInput): Promise<Project> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `
      mutation ProvisionProjectAws($input: ProvisionProjectAwsInput!) {
        provisionProjectAws(input: $input) { ${PROJECT_FIELDS} }
      }
    `,
    variables: { input },
  })) as GraphQLResult<{ provisionProjectAws: Project }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  const updated = result.data?.provisionProjectAws;
  if (!updated) throw new Error('provisionProjectAws returned no data');
  return updated;
}

export async function updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `
      mutation UpdateProject($id: ID!, $input: UpdateProjectInput!) {
        updateProject(id: $id, input: $input) { ${PROJECT_FIELDS} }
      }
    `,
    variables: { id, input },
  })) as GraphQLResult<{ updateProject: Project }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  const updated = result.data?.updateProject;
  if (!updated) throw new Error('updateProject returned no data');
  return updated;
}

export async function deleteProject(id: string): Promise<boolean> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `mutation DeleteProject($id: ID!) { deleteProject(id: $id) }`,
    variables: { id },
  })) as GraphQLResult<{ deleteProject: boolean }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  return result.data?.deleteProject ?? false;
}

export async function closeProjectAccount(
  projectId: string,
  accountId: string,
  runMonorepoTeardown: boolean = true
): Promise<Project> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `
      mutation CloseProjectAccount($projectId: ID!, $accountId: ID!, $runMonorepoTeardown: Boolean) {
        closeProjectAccount(
          projectId: $projectId
          accountId: $accountId
          runMonorepoTeardown: $runMonorepoTeardown
        ) { ${PROJECT_FIELDS} }
      }
    `,
    variables: { projectId, accountId, runMonorepoTeardown },
  })) as GraphQLResult<{ closeProjectAccount: Project }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  const out = result.data?.closeProjectAccount;
  if (!out) throw new Error('closeProjectAccount returned no data');
  return out;
}

export async function syncOrganizationAccounts(): Promise<OrganizationAccountSyncResult> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `mutation SyncOrganizationAccounts {
      syncOrganizationAccounts { upserted removed }
    }`,
  })) as GraphQLResult<{ syncOrganizationAccounts: OrganizationAccountSyncResult }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  const out = result.data?.syncOrganizationAccounts;
  if (!out) throw new Error('syncOrganizationAccounts returned no data');
  return out;
}

export async function syncProjectsWithGithub(): Promise<ProjectGithubSyncResult> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `mutation SyncProjectsWithGithub {
      syncProjectsWithGithub { checked removed skippedInProgress }
    }`,
  })) as GraphQLResult<{ syncProjectsWithGithub: ProjectGithubSyncResult }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  const out = result.data?.syncProjectsWithGithub;
  if (!out) throw new Error('syncProjectsWithGithub returned no data');
  return out;
}

export async function closeStandaloneOrganizationAccount(
  accountId: string
): Promise<OrganizationAccount> {
  const client = await getClient();
  const result = (await client.graphql({
    query: `mutation CloseStandaloneOrganizationAccount($accountId: ID!) {
      closeStandaloneOrganizationAccount(accountId: $accountId) { ${ORG_ACCOUNT_FIELDS} }
    }`,
    variables: { accountId },
  })) as GraphQLResult<{ closeStandaloneOrganizationAccount: OrganizationAccount }>;

  if (result.errors?.length) throw new Error(result.errors[0]?.message);
  const out = result.data?.closeStandaloneOrganizationAccount;
  if (!out) throw new Error('closeStandaloneOrganizationAccount returned no data');
  return out;
}

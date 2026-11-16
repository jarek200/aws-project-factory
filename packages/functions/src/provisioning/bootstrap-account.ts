/**
 * Lambda Handler: Bootstrap New AWS Account (Step Functions task)
 *
 * Assumes the OrganizationAccountAccessRole in the freshly-created member
 * account, then:
 *   1. Creates the IAM OIDC provider for GitHub Actions
 *   2. Creates the GitHubActions-<envSlug> IAM role with an OIDC trust policy
 *      scoped to the new project repo + environment
 *   3. Attaches AdministratorAccess so a child stack can deploy
 *   4. Sets a permissions boundary that denies account close, organization
 *      changes, and removal of that boundary
 *
 * Returns the role ARN for the GitHub step to store as AWS_ROLE_ARN.
 */

import {
  AttachRolePolicyCommand,
  CreateOpenIDConnectProviderCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  CreateRoleCommand,
  DeletePolicyVersionCommand,
  GetOpenIDConnectProviderCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRoleCommand,
  IAMClient,
  ListPolicyVersionsCommand,
  PutRolePermissionsBoundaryCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

import { envKeyFromAccountName } from './account-env-key';
import {
  buildDeployRolePermissionsBoundary,
  DEPLOY_ROLE_BOUNDARY_POLICY_NAME,
} from './deploy-role-boundary';
import { fetchGitHubRepoMetadata, getGitHubToken } from './github-app-client';
import {
  buildGithubOidcSubClaims,
  buildGithubOidcTrustPolicy,
  GITHUB_OIDC_AUDIENCE,
} from './github-oidc-trust';

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_THUMBPRINT = '6938fd4d98bab03faadb97b34396831e3780aea1';

const stsClient = new STSClient({});

interface BootstrapAccountInput {
  name: string;
  email: string;
  accountId: string;
  /** Determined from the project's github org + slug when the SFN starts */
  projectSlug?: string;
  githubOrg?: string;
  /** Immutable GitHub owner/repo IDs for OIDC `sub` (repos created after 2026-07-15). */
  githubOwnerId?: string | number | null;
  githubRepoId?: string | number | null;
}

interface BootstrapAccountOutput {
  name: string;
  email: string;
  accountId: string;
  roleArn: string;
  envKey: string;
}

async function assumeAccountRole(accountId: string): Promise<IAMClient> {
  const roleArn = `arn:aws:iam::${accountId}:role/OrganizationAccountAccessRole`;

  const assumed = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `BootstrapAccount-${accountId}`,
      DurationSeconds: 3600,
    })
  );

  const creds = assumed.Credentials;
  if (!creds) throw new Error(`Failed to assume role in account ${accountId}`);

  const { AccessKeyId, SecretAccessKey, SessionToken } = creds;
  if (!AccessKeyId || !SecretAccessKey || !SessionToken) {
    throw new Error(`Incomplete assumed role credentials for account ${accountId}`);
  }

  return new IAMClient({
    credentials: {
      accessKeyId: AccessKeyId,
      secretAccessKey: SecretAccessKey,
      sessionToken: SessionToken,
    },
  });
}

/** OIDC provider for GitHub Actions lives in the member account (same account as the deploy role). */
async function ensureOidcProvider(iamClient: IAMClient, memberAccountId: string): Promise<void> {
  const providerArn = `arn:aws:iam::${memberAccountId}:oidc-provider/token.actions.githubusercontent.com`;

  try {
    await iamClient.send(
      new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: providerArn })
    );
    console.log('OIDC provider already exists');
    return;
  } catch (err: unknown) {
    const e = err as { name?: string };
    if (e.name !== 'NoSuchEntityException') throw err;
  }

  await iamClient.send(
    new CreateOpenIDConnectProviderCommand({
      Url: GITHUB_OIDC_URL,
      ClientIDList: [GITHUB_OIDC_AUDIENCE],
      ThumbprintList: [GITHUB_OIDC_THUMBPRINT],
    })
  );
  console.log('OIDC provider created');
}

async function resolveGithubRepoIds(
  githubOrg: string,
  projectSlug: string,
  githubOwnerId?: string | number | null,
  githubRepoId?: string | number | null
): Promise<{ githubOwnerId?: string; githubRepoId?: string }> {
  const ownerId =
    githubOwnerId != null && String(githubOwnerId).trim() !== ''
      ? String(githubOwnerId).trim()
      : '';
  const repoId =
    githubRepoId != null && String(githubRepoId).trim() !== '' ? String(githubRepoId).trim() : '';

  if (ownerId && repoId) {
    return { githubOwnerId: ownerId, githubRepoId: repoId };
  }

  // Best-effort: without IDs the trust policy still gets the name-based sub
  // claim, matching pre-immutable-ID behavior. Do not fail the bootstrap.
  try {
    console.log(`Fetching GitHub repo IDs for ${githubOrg}/${projectSlug}`);
    const token = await getGitHubToken();
    return await fetchGitHubRepoMetadata(token, githubOrg, projectSlug);
  } catch (err) {
    console.warn(
      `Could not fetch GitHub repo IDs for ${githubOrg}/${projectSlug}; ` +
        `trust policy will only include the name-based sub claim. ${String(err)}`
    );
    return {};
  }
}

function canonicalPolicy(document: string): string {
  return canonicalize(JSON.parse(document) as unknown);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    const sorted = items.every((item) => item.startsWith('"')) ? [...items].sort() : items;
    return `[${sorted.join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function decodePolicyDocument(document: string): string {
  try {
    const decoded = decodeURIComponent(document);
    return decoded.trim().startsWith('{') ? decoded : document;
  } catch {
    return document;
  }
}

/** One customer-managed boundary per member account, shared by GitHubActions-* roles. */
async function ensurePermissionsBoundary(iamClient: IAMClient, accountId: string): Promise<string> {
  const policyArn = `arn:aws:iam::${accountId}:policy/${DEPLOY_ROLE_BOUNDARY_POLICY_NAME}`;
  const document = JSON.stringify(buildDeployRolePermissionsBoundary(accountId));

  try {
    const created = await iamClient.send(
      new CreatePolicyCommand({
        PolicyName: DEPLOY_ROLE_BOUNDARY_POLICY_NAME,
        PolicyDocument: document,
        Description:
          'Limits GitHub Actions deploy roles: no account close, no organization changes, no boundary removal',
      })
    );
    const arn = created.Policy?.Arn;
    if (!arn) throw new Error('CreatePolicy returned no ARN for the deploy role boundary');
    return arn;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name !== 'EntityAlreadyExistsException') throw err;
  }

  await syncBoundaryPolicyDocument(iamClient, policyArn, document);
  return policyArn;
}

async function syncBoundaryPolicyDocument(
  iamClient: IAMClient,
  policyArn: string,
  document: string
): Promise<void> {
  const policy = await iamClient.send(new GetPolicyCommand({ PolicyArn: policyArn }));
  const versionId = policy.Policy?.DefaultVersionId;
  if (!versionId) throw new Error('Deploy role boundary has no default version');

  const current = await iamClient.send(
    new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: versionId })
  );
  const currentDocument = current.PolicyVersion?.Document;
  if (
    currentDocument &&
    canonicalPolicy(decodePolicyDocument(currentDocument)) === canonicalPolicy(document)
  ) {
    return;
  }

  const listed = await iamClient.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn }));
  const versions = listed.Versions ?? [];
  if (versions.length >= 5) {
    const oldest = versions
      .filter((version) => !version.IsDefaultVersion && version.VersionId)
      .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0))[0];
    if (!oldest?.VersionId) {
      throw new Error('Deploy role boundary has no old version to replace');
    }
    await iamClient.send(
      new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: oldest.VersionId })
    );
  }

  await iamClient.send(
    new CreatePolicyVersionCommand({
      PolicyArn: policyArn,
      PolicyDocument: document,
      SetAsDefault: true,
    })
  );
}

async function ensureDeployRole(
  iamClient: IAMClient,
  accountId: string,
  roleName: string,
  githubOrg: string,
  projectSlug: string,
  envKey: string,
  githubOwnerId?: string,
  githubRepoId?: string
): Promise<string> {
  const subClaims = buildGithubOidcSubClaims({
    githubOrg,
    projectSlug,
    envKey,
    githubOwnerId,
    githubRepoId,
  });
  const trustPolicy = buildGithubOidcTrustPolicy(accountId, subClaims);
  const trustPolicyDocument = JSON.stringify(trustPolicy);
  const boundaryArn = await ensurePermissionsBoundary(iamClient, accountId);

  let roleArn: string | undefined;
  let roleExists = false;

  try {
    const existing = await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
    roleArn = existing.Role?.Arn;
    roleExists = Boolean(roleArn);
    if (roleArn) {
      console.log(`Role ${roleName} already exists: ${roleArn}`);
    }
  } catch (err: unknown) {
    const e = err as { name?: string };
    if (e.name !== 'NoSuchEntityException') throw err;
  }

  if (roleExists && roleArn) {
    await iamClient.send(
      new UpdateAssumeRolePolicyCommand({
        RoleName: roleName,
        PolicyDocument: trustPolicyDocument,
      })
    );
    console.log(`Updated trust policy on ${roleName} for sub claims: ${subClaims.join(', ')}`);
    await iamClient.send(
      new PutRolePermissionsBoundaryCommand({
        RoleName: roleName,
        PermissionsBoundary: boundaryArn,
      })
    );
    return roleArn;
  }

  const created = await iamClient.send(
    new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: trustPolicyDocument,
      PermissionsBoundary: boundaryArn,
      Description: `GitHub Actions deploy role for ${githubOrg}/${projectSlug} (${envKey})`,
      Tags: [
        { Key: 'ManagedBy', Value: 'AWSProjectFactory' },
        { Key: 'GitHubOrg', Value: githubOrg },
        { Key: 'ProjectSlug', Value: projectSlug },
        { Key: 'Environment', Value: envKey },
      ],
    })
  );

  roleArn = created.Role?.Arn;
  if (!roleArn) throw new Error('CreateRole returned no ARN');

  await iamClient.send(
    new AttachRolePolicyCommand({
      RoleName: roleName,
      PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess',
    })
  );

  console.log(`Role created: ${roleArn}`);
  return roleArn;
}

export const handler = async (event: BootstrapAccountInput): Promise<BootstrapAccountOutput> => {
  const { name, email, accountId } = event;
  const projectSlug = event.projectSlug ?? 'project';
  const githubOrg = event.githubOrg?.trim() || 'org';

  const envKey = envKeyFromAccountName(name);
  const roleName = `GitHubActions-${envKey}`;

  console.log(`Bootstrapping account ${accountId} (${name}), envKey=${envKey}`);

  const repoIds = await resolveGithubRepoIds(
    githubOrg,
    projectSlug,
    event.githubOwnerId,
    event.githubRepoId
  );

  const iamClient = await assumeAccountRole(accountId);
  await ensureOidcProvider(iamClient, accountId);
  const roleArn = await ensureDeployRole(
    iamClient,
    accountId,
    roleName,
    githubOrg,
    projectSlug,
    envKey,
    repoIds.githubOwnerId,
    repoIds.githubRepoId
  );

  return { name, email, accountId, roleArn, envKey };
};

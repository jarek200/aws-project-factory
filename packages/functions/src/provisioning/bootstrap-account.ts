/**
 * Lambda Handler: Bootstrap New AWS Account (Step Functions task)
 *
 * Assumes the OrganizationAccountAccessRole in the freshly-created member
 * account, then:
 *   1. Creates the IAM OIDC provider for GitHub Actions
 *   2. Creates the GitHubActions-<envSlug> IAM role with an OIDC trust policy
 *      scoped to the new project repo + environment
 *   3. Attaches AdministratorAccess (scope down to least-privilege in a later phase)
 *
 * Returns the role ARN for the GitHub step to store as AWS_ROLE_ARN.
 */

import {
  AttachRolePolicyCommand,
  CreateOpenIDConnectProviderCommand,
  CreateRoleCommand,
  GetOpenIDConnectProviderCommand,
  GetRoleCommand,
  IAMClient,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

import { envKeyFromAccountName } from './account-env-key';
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
    return roleArn;
  }

  const created = await iamClient.send(
    new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: trustPolicyDocument,
      Description: `GitHub Actions deploy role for ${githubOrg}/${projectSlug} (${envKey})`,
      Tags: [
        { Key: 'ManagedBy', Value: 'AdminProjectFactory' },
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

/**
 * Lambda Handler: Configure child repo deploy settings (Step Functions task)
 *
 * Aligns child repos from a factory template (starter-monorepo or CMS portfolio starter):
 *   - Renames template placeholders (@scope, SST app name)
 *   - Creates GitHub Environments per provisioned account (int, stage, prod, …)
 *   - Sets Environment secrets/vars expected by `.github/workflows/deploy.yml`
 *   - Sets repo variable DEPLOY_ENV_ORDER for dynamic promotion gates
 *   - Creates deploy:* labels (does NOT overwrite deploy.yml — template is source of truth)
 *
 * Child workflow expects per Environment:
 *   secrets.AWS_ROLE_ARN, optional secrets.DNS_ROLE_ARN
 *   vars.APP_URL, vars.APPS_HOSTED_ZONE_ID
 */

import { createSign } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildProjectStageWebsiteUrl } from '@admin/core';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Sodium } from 'libsodium-wrappers';

import { requiredEnv } from '../runtime-env';
import { buildDeployEnvOrder } from './deploy-env-order';
import { buildProjectRenameOptions, pushProjectRenameCommit } from './rename-project';

/** CJS bundle only — the published ESM build imports a missing `./libsodium.mjs` (libsodium-wrappers 0.7.x). */
const sodium: Sodium = createRequire(import.meta.url)('libsodium-wrappers');

const secretsClient = new SecretsManagerClient({});

const GITHUB_APP_ID = requiredEnv('GITHUB_APP_ID');
const GITHUB_PRIVATE_KEY_SECRET_ARN = requiredEnv('GITHUB_PRIVATE_KEY_SECRET_ARN');
const GITHUB_INSTALLATION_ID = requiredEnv('GITHUB_INSTALLATION_ID');
const APPS_HOSTED_ZONE_ID = process.env.APPS_HOSTED_ZONE_ID?.trim();
const DNS_ROLE_ARN = process.env.DNS_ROLE_ARN?.trim();

interface ProvisionedAccount {
  name: string;
  email: string;
  accountId: string;
  roleArn: string;
  envKey: string;
}

interface ConfigureEnvironmentsInput {
  projectId: string;
  slug: string;
  repoFullName: string;
  githubOrg?: string;
  accounts: ProvisionedAccount[];
}

async function getGitHubToken(): Promise<string> {
  const secret = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: GITHUB_PRIVATE_KEY_SECRET_ARN })
  );
  const privateKey = secret.SecretString;
  if (!privateKey) throw new Error('GitHub private key secret is empty');
  const jwt = createGitHubAppJwt(privateKey);

  const tokenResponse = await fetch(
    `https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'AWSProjectFactory/1.0',
      },
    }
  );

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    throw new Error(`Failed to get installation token: ${tokenResponse.status} ${body}`);
  }

  const { token } = (await tokenResponse.json()) as { token: string };
  return token;
}

function createGitHubAppJwt(privateKeyPem: string): string {
  const normalizedKey = privateKeyPem.replace(/\\n/g, '\n').trim();

  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 600, iss: parseInt(GITHUB_APP_ID, 10) };

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${header}.${body}`;

  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  return `${signingInput}.${sign.sign(normalizedKey, 'base64url')}`;
}

async function githubRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'AWSProjectFactory/1.0',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${path} → ${response.status}: ${text}`);
  }

  if (response.status === 204) return {};
  return response.json();
}

let sodiumReady: Promise<void> | null = null;

async function ensureSodium(): Promise<void> {
  if (!sodiumReady) sodiumReady = sodium.ready;
  await sodiumReady;
}

async function encryptSecret(publicKeyBase64: string, secretValue: string): Promise<string> {
  await ensureSodium();
  const publicKey = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const message = sodium.from_string(secretValue);
  const sealed = sodium.crypto_box_seal(message, publicKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

async function setRepositoryVariable(
  token: string,
  repoFullName: string,
  variableName: string,
  value: string
): Promise<boolean> {
  const path = `https://api.github.com/repos/${repoFullName}/actions/variables`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'AWSProjectFactory/1.0',
  };

  const response = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: variableName, value }),
  });

  if (response.ok) return true;

  const errBody = await response.text();
  if (response.status === 422 || response.status === 409) {
    const patch = await fetch(`${path}/${variableName}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value }),
    });
    if (patch.ok) return true;
    throw new Error(
      `GitHub API PATCH ${path}/${variableName} → ${patch.status}: ${await patch.text()}`
    );
  }

  if (response.status === 403 && errBody.includes('Resource not accessible by integration')) {
    return false;
  }

  throw new Error(`GitHub API POST repository variable → ${response.status}: ${errBody}`);
}

async function setEnvironmentVariable(
  token: string,
  repoFullName: string,
  environmentName: string,
  variableName: string,
  value: string
): Promise<void> {
  const base = `https://api.github.com/repos/${repoFullName}/environments/${environmentName}/variables`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'AWSProjectFactory/1.0',
  };

  const response = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: variableName, value }),
  });

  if (response.ok) return;

  const errBody = await response.text();
  if (response.status === 422 || response.status === 409) {
    const patch = await fetch(`${base}/${variableName}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value }),
    });
    if (patch.ok) return;
    throw new Error(
      `GitHub API PATCH ${base}/${variableName} → ${patch.status}: ${await patch.text()}`
    );
  }

  throw new Error(
    `GitHub API POST environment variable ${environmentName}/${variableName} → ${response.status}: ${errBody}`
  );
}

async function setEnvironmentSecret(
  token: string,
  repoFullName: string,
  environmentName: string,
  secretName: string,
  secretValue: string
): Promise<void> {
  const { key_id: keyId, key: publicKey } = (await githubRequest(
    token,
    'GET',
    `/repos/${repoFullName}/environments/${environmentName}/secrets/public-key`
  )) as { key_id: string; key: string };

  const encryptedValue = await encryptSecret(publicKey, secretValue);

  await githubRequest(
    token,
    'PUT',
    `/repos/${repoFullName}/environments/${environmentName}/secrets/${secretName}`,
    {
      encrypted_value: encryptedValue,
      key_id: keyId,
    }
  );
}

async function ensureGitHubEnvironment(
  token: string,
  repoFullName: string,
  environmentName: string
): Promise<void> {
  await githubRequest(token, 'PUT', `/repos/${repoFullName}/environments/${environmentName}`, {});
}

async function ensureDeployLabel(
  token: string,
  repoFullName: string,
  envKey: string
): Promise<void> {
  const labels: Array<{ name: string; color: string; description: string }> = [
    {
      name: `deploy:${envKey}`,
      color: envKey === 'prod' ? 'd93f0b' : envKey === 'stage' ? 'e4e669' : '0075ca',
      description: `Trigger ${envKey} deployment`,
    },
    {
      name: `deploy-failed:${envKey}`,
      color: 'd73a4a',
      description: `Deploy to ${envKey} failed`,
    },
  ];

  for (const label of labels) {
    try {
      await githubRequest(token, 'POST', `/repos/${repoFullName}/labels`, label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('422') || message.includes('409')) continue;
      throw err;
    }
  }
}

async function configureEnvironmentForAccount(
  token: string,
  repoFullName: string,
  slug: string,
  account: ProvisionedAccount,
  appsRoot: string | undefined
): Promise<void> {
  const envKey = account.envKey;

  await ensureGitHubEnvironment(token, repoFullName, envKey);
  await setEnvironmentSecret(token, repoFullName, envKey, 'AWS_ROLE_ARN', account.roleArn);

  if (DNS_ROLE_ARN) {
    await setEnvironmentSecret(token, repoFullName, envKey, 'DNS_ROLE_ARN', DNS_ROLE_ARN);
  }

  if (APPS_HOSTED_ZONE_ID) {
    await setEnvironmentVariable(
      token,
      repoFullName,
      envKey,
      'APPS_HOSTED_ZONE_ID',
      APPS_HOSTED_ZONE_ID
    );
  }

  if (appsRoot && slug.trim()) {
    const appUrl = buildProjectStageWebsiteUrl(slug, envKey, appsRoot);
    if (appUrl) {
      await setEnvironmentVariable(token, repoFullName, envKey, 'APP_URL', appUrl);
      console.log(`Set ${envKey} APP_URL: ${appUrl}`);
    }
  }

  await ensureDeployLabel(token, repoFullName, envKey);
  console.log(`GitHub Environment '${envKey}' configured for ${repoFullName}`);
}

export const handler = async (event: ConfigureEnvironmentsInput): Promise<void> => {
  const { repoFullName, accounts, slug, githubOrg } = event;
  const appsRoot = process.env.PROJECT_APPS_ROOT_DOMAIN?.trim();

  if (!repoFullName) {
    console.log('No repoFullName provided, skipping environment configuration');
    return;
  }

  console.log(`Configuring GitHub Actions deploy settings for ${repoFullName}`);

  const token = await getGitHubToken();

  if (slug?.trim()) {
    try {
      await pushProjectRenameCommit(
        token,
        repoFullName,
        buildProjectRenameOptions({ slug, githubOrg })
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403') && msg.includes('Resource not accessible by integration')) {
        console.warn(
          `Cannot rename template files — GitHub App lacks Contents permission. ` +
            `Run ./scripts/rename-project.sh manually in the child repo.`
        );
      } else {
        throw err;
      }
    }
  }

  if (accounts.length === 0) {
    console.log('No provisioned accounts — skipping GitHub Environment setup');
    return;
  }

  const envKeys = accounts.map((a) => a.envKey);
  const deployEnvOrder = buildDeployEnvOrder(envKeys);
  const hasVariableAccess = await setRepositoryVariable(
    token,
    repoFullName,
    'DEPLOY_ENV_ORDER',
    deployEnvOrder
  );
  if (!hasVariableAccess) {
    console.warn(
      'Could not set DEPLOY_ENV_ORDER repository variable — promotion gates may need manual setup'
    );
  } else {
    console.log(`Set DEPLOY_ENV_ORDER: ${deployEnvOrder}`);
  }

  for (const account of accounts) {
    await configureEnvironmentForAccount(token, repoFullName, slug, account, appsRoot);
  }

  if (envKeys.includes('prod')) {
    console.log(
      'Reminder: enable Required reviewers on the prod GitHub Environment in repo Settings → Environments'
    );
  }

  console.log(
    `Deploy config complete for ${repoFullName}. Uses template deploy.yml (not overwritten).`
  );
};

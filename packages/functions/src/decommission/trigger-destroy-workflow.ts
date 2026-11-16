/**
 * Optional: dispatch a repository workflow to tear down app stacks (best-effort).
 * Skips when DECOMMISSION_SKIP_GITHUB=true or repo/workflow missing.
 */

import { createSign } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { requiredEnv } from '../runtime-env';

const secretsClient = new SecretsManagerClient({});

const GITHUB_APP_ID = requiredEnv('GITHUB_APP_ID');
const GITHUB_PRIVATE_KEY_SECRET_ARN = requiredEnv('GITHUB_PRIVATE_KEY_SECRET_ARN');
const GITHUB_INSTALLATION_ID = requiredEnv('GITHUB_INSTALLATION_ID');

interface TriggerInput {
  repoFullName: string;
  envKey: string;
  /** Workflow file under .github/workflows (e.g. destroy-environment.yml) */
  workflowFile?: string;
  gitRef?: string;
}

interface TriggerOutput {
  skipped: boolean;
  detail?: string;
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

async function getInstallationToken(): Promise<string> {
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
        'User-Agent': 'AdminProjectFactory/1.0',
      },
    }
  );

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    throw new Error(`GitHub installation token: ${tokenResponse.status} ${body}`);
  }

  const { token } = (await tokenResponse.json()) as { token: string };
  return token;
}

export const handler = async (event: TriggerInput): Promise<TriggerOutput> => {
  if (process.env.DECOMMISSION_SKIP_GITHUB?.trim() === 'true') {
    return { skipped: true, detail: 'DECOMMISSION_SKIP_GITHUB=true' };
  }

  const repo = event.repoFullName?.trim();
  if (!repo || !repo.includes('/')) {
    return { skipped: true, detail: 'No repoFullName' };
  }

  const workflowFile =
    event.workflowFile?.trim() ||
    process.env.DECOMMISSION_GITHUB_WORKFLOW?.trim() ||
    'destroy-environment.yml';
  const ref = event.gitRef?.trim() || process.env.DECOMMISSION_GITHUB_REF?.trim() || 'main';

  const token = await getInstallationToken();
  const path = `/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;

  const withInputs = process.env.DECOMMISSION_GITHUB_WORKFLOW_WITH_INPUTS?.trim() === 'true';
  const dispatchBody = withInputs ? { ref, inputs: { environment: event.envKey } } : { ref };

  const response = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'AdminProjectFactory/1.0',
    },
    body: JSON.stringify(dispatchBody),
  });

  const bodyText = response.ok ? '' : await response.text();

  if (response.status === 404) {
    console.warn(`Workflow ${workflowFile} not found in ${repo}; continuing decommission`);
    return { skipped: true, detail: `Workflow not found: ${workflowFile}` };
  }

  /** Optional GitHub step — never fail decommission: App needs Actions: Read/write + approved install. */
  const integrationBlocked =
    response.status === 403 ||
    bodyText.includes('Resource not accessible by integration') ||
    bodyText.includes('"status":"403"');
  if (!response.ok && integrationBlocked) {
    console.warn(
      `GitHub workflow dispatch blocked for ${repo} (${response.status}). Approve new App permissions on the org/install, ensure Actions: Read and write, or set DECOMMISSION_SKIP_GITHUB=true. Continuing decommission. ${bodyText}`
    );
    return {
      skipped: true,
      detail: `GitHub dispatch skipped (${response.status}): integration cannot run workflow_dispatch; CloseAccount still runs`,
    };
  }

  if (!response.ok) {
    throw new Error(`GitHub workflow dispatch failed ${response.status}: ${bodyText}`);
  }

  console.log(`Dispatched ${workflowFile} on ${repo} ref=${ref} env=${event.envKey}`);
  return { skipped: false, detail: 'dispatched' };
};

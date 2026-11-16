/**
 * Minimal GitHub App client for provisioning Lambdas.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { requiredEnv } from '../runtime-env';

const secretsClient = new SecretsManagerClient({});

const GITHUB_APP_ID = requiredEnv('GITHUB_APP_ID');
const GITHUB_PRIVATE_KEY_SECRET_ARN = requiredEnv('GITHUB_PRIVATE_KEY_SECRET_ARN');
const GITHUB_INSTALLATION_ID = requiredEnv('GITHUB_INSTALLATION_ID');

export type GitHubRepoMetadata = {
  githubOwnerId: string;
  githubRepoId: string;
};

export async function getGitHubToken(): Promise<string> {
  const secret = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: GITHUB_PRIVATE_KEY_SECRET_ARN })
  );
  const privateKey = secret.SecretString;
  if (!privateKey) throw new Error('GitHub private key secret is empty');

  const jwt = await createGitHubAppJwt(privateKey);

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

async function createGitHubAppJwt(privateKeyPem: string): Promise<string> {
  const normalizedKey = privateKeyPem.replace(/\\n/g, '\n').trim();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: parseInt(GITHUB_APP_ID, 10),
  };

  const { createSign } = await import('node:crypto');
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${header}.${body}`;

  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(normalizedKey, 'base64url');

  return `${signingInput}.${signature}`;
}

export async function githubRequest(
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

  return response.json();
}

export async function fetchGitHubRepoMetadata(
  token: string,
  githubOrg: string,
  projectSlug: string
): Promise<GitHubRepoMetadata> {
  const repo = (await githubRequest(
    token,
    'GET',
    `/repos/${encodeURIComponent(githubOrg)}/${encodeURIComponent(projectSlug)}`
  )) as { id: number; owner: { id: number } };

  if (!repo?.id || !repo.owner?.id) {
    throw new Error(`GitHub repo metadata missing ids for ${githubOrg}/${projectSlug}`);
  }

  return {
    githubOwnerId: String(repo.owner.id),
    githubRepoId: String(repo.id),
  };
}

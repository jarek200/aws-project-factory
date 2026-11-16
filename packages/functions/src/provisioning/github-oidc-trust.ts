/** Shared GitHub Actions OIDC trust helpers for project factory deploy roles. */

export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';

/** Build `sub` claim patterns accepted by the deploy role trust policy. */
export function buildGithubOidcSubClaims(input: {
  githubOrg: string;
  projectSlug: string;
  envKey: string;
  githubOwnerId?: string | number | null;
  githubRepoId?: string | number | null;
}): string[] {
  const org = input.githubOrg.trim();
  const slug = input.projectSlug.trim();
  const envKey = input.envKey.trim();
  const claims = [`repo:${org}/${slug}:environment:${envKey}`];

  const ownerId =
    input.githubOwnerId != null && String(input.githubOwnerId).trim() !== ''
      ? String(input.githubOwnerId).trim()
      : '';
  const repoId =
    input.githubRepoId != null && String(input.githubRepoId).trim() !== ''
      ? String(input.githubRepoId).trim()
      : '';

  // Repos created after 2026-07-15 (or opted in) use immutable owner/repo IDs in `sub`.
  if (ownerId && repoId) {
    claims.push(`repo:${org}@${ownerId}/${slug}@${repoId}:environment:${envKey}`);
  }

  return claims;
}

export function buildGithubOidcTrustPolicy(
  accountId: string,
  subClaims: string[]
): Record<string, unknown> {
  if (subClaims.length === 0) {
    throw new Error('At least one OIDC sub claim is required');
  }

  const condition: Record<string, Record<string, string | string[]>> = {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': GITHUB_OIDC_AUDIENCE,
    },
  };

  if (subClaims.length === 1) {
    condition.StringEquals['token.actions.githubusercontent.com:sub'] = subClaims[0];
  } else {
    condition.StringLike = {
      'token.actions.githubusercontent.com:sub': subClaims,
    };
  }

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Federated: `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`,
        },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: condition,
      },
    ],
  };
}

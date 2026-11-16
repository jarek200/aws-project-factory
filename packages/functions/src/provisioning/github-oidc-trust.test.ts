import { describe, expect, it } from 'vitest';
import { buildGithubOidcSubClaims, buildGithubOidcTrustPolicy } from './github-oidc-trust';

describe('buildGithubOidcSubClaims', () => {
  it('includes slug-only claim when IDs are absent', () => {
    expect(
      buildGithubOidcSubClaims({
        githubOrg: 'example-org',
        projectSlug: 'my-app',
        envKey: 'int',
      })
    ).toEqual(['repo:example-org/my-app:environment:int']);
  });

  it('includes immutable-ID claim when owner and repo IDs are known', () => {
    expect(
      buildGithubOidcSubClaims({
        githubOrg: 'example-org',
        projectSlug: 'my-app',
        envKey: 'int',
        githubOwnerId: 100000001,
        githubRepoId: '2000000002',
      })
    ).toEqual([
      'repo:example-org/my-app:environment:int',
      'repo:example-org@100000001/my-app@2000000002:environment:int',
    ]);
  });
});

describe('buildGithubOidcTrustPolicy', () => {
  it('uses StringEquals for a single sub claim', () => {
    const policy = buildGithubOidcTrustPolicy('111111111111', [
      'repo:example-org/my-app:environment:int',
    ]);
    const statement = (policy.Statement as Array<Record<string, unknown>>)[0];
    const condition = statement.Condition as Record<string, Record<string, string | string[]>>;
    expect(condition.StringEquals?.['token.actions.githubusercontent.com:sub']).toBe(
      'repo:example-org/my-app:environment:int'
    );
    expect(condition.StringLike).toBeUndefined();
  });

  it('uses StringLike when both slug and immutable sub claims are present', () => {
    const policy = buildGithubOidcTrustPolicy('111111111111', [
      'repo:example-org/my-app:environment:int',
      'repo:example-org@100000001/my-app@2000000002:environment:int',
    ]);
    const statement = (policy.Statement as Array<Record<string, unknown>>)[0];
    const condition = statement.Condition as Record<string, Record<string, string | string[]>>;
    expect(condition.StringLike?.['token.actions.githubusercontent.com:sub']).toEqual([
      'repo:example-org/my-app:environment:int',
      'repo:example-org@100000001/my-app@2000000002:environment:int',
    ]);
    expect(condition.StringEquals?.['token.actions.githubusercontent.com:sub']).toBeUndefined();
  });
});

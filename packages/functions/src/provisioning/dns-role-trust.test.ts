import { describe, expect, it } from 'vitest';
import { buildProjectAppsDnsTrustPolicy } from './dns-role-trust';

describe('buildProjectAppsDnsTrustPolicy', () => {
  it('allows GitHubActions roles only inside the organization', () => {
    const policy = buildProjectAppsDnsTrustPolicy('o-a1b2c3d4e5');
    const statement = policy.Statement[0];
    expect(statement).toMatchObject({
      Effect: 'Allow',
      Principal: { AWS: '*' },
      Action: 'sts:AssumeRole',
      Condition: {
        StringEquals: { 'aws:PrincipalOrgID': 'o-a1b2c3d4e5' },
        ArnLike: { 'aws:PrincipalArn': 'arn:aws:iam::*:role/GitHubActions-*' },
      },
    });
  });

  it('rejects a missing or malformed organization id', () => {
    expect(() => buildProjectAppsDnsTrustPolicy('')).toThrow(/Organization id/);
    expect(() => buildProjectAppsDnsTrustPolicy('o-SHORT')).toThrow(/Organization id/);
  });
});

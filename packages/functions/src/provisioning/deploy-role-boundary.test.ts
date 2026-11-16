import { describe, expect, it } from 'vitest';
import { buildDeployRolePermissionsBoundary } from './deploy-role-boundary';

describe('buildDeployRolePermissionsBoundary', () => {
  const policy = buildDeployRolePermissionsBoundary('111111111111');
  const statements = policy.Statement;

  it('allows deploy actions and denies organization mutation', () => {
    expect(policy.Version).toBe('2012-10-17');
    expect(statements[0]).toMatchObject({ Effect: 'Allow', Action: '*', Resource: '*' });
    expect(statements[1]).toMatchObject({
      Effect: 'Deny',
      Resource: '*',
      Action: [
        'organizations:CloseAccount',
        'organizations:LeaveOrganization',
        'organizations:CreateAccount',
        'organizations:DeleteOrganization',
        'organizations:RemoveAccountFromOrganization',
      ],
    });
  });

  it('denies removing the boundary from GitHub Actions roles in that account', () => {
    expect(statements[2]).toMatchObject({
      Effect: 'Deny',
      Action: ['iam:DeleteRolePermissionsBoundary', 'iam:PutRolePermissionsBoundary'],
      Resource: 'arn:aws:iam::111111111111:role/GitHubActions-*',
    });
  });

  it('rejects an account id that is not 12 digits', () => {
    expect(() => buildDeployRolePermissionsBoundary('111')).toThrow(/12-digit/);
  });
});

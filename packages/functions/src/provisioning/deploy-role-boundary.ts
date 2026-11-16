/**
 * Permissions boundary for GitHub Actions deploy roles.
 * The role still receives AdministratorAccess. This document is the maximum:
 * deploy actions stay allowed, and the denies below always win.
 */

const ORGANIZATION_DENY_ACTIONS = [
  'organizations:CloseAccount',
  'organizations:LeaveOrganization',
  'organizations:CreateAccount',
  'organizations:DeleteOrganization',
  'organizations:RemoveAccountFromOrganization',
] as const;

export const DEPLOY_ROLE_BOUNDARY_POLICY_NAME = 'GitHubActionsDeployBoundary';

export function buildDeployRolePermissionsBoundary(accountId: string): {
  Version: '2012-10-17';
  Statement: Array<Record<string, unknown>>;
} {
  if (!/^\d{12}$/.test(accountId)) {
    throw new Error('accountId must be a 12-digit AWS account ID');
  }

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowDeploy',
        Effect: 'Allow',
        Action: '*',
        Resource: '*',
      },
      {
        Sid: 'DenyOrganizationMutation',
        Effect: 'Deny',
        Action: [...ORGANIZATION_DENY_ACTIONS],
        Resource: '*',
      },
      {
        Sid: 'DenyBoundaryRemoval',
        Effect: 'Deny',
        Action: ['iam:DeleteRolePermissionsBoundary', 'iam:PutRolePermissionsBoundary'],
        Resource: `arn:aws:iam::${accountId}:role/GitHubActions-*`,
      },
    ],
  };
}

/** Trust policy for the delegated apps DNS role. */

const ORGANIZATION_ID = /^o-[a-z0-9]{10,32}$/;

export function buildProjectAppsDnsTrustPolicy(organizationId: string): {
  Version: '2012-10-17';
  Statement: Array<Record<string, unknown>>;
} {
  const orgId = organizationId.trim();
  if (!ORGANIZATION_ID.test(orgId)) {
    throw new Error(
      'AWS Organization id is required (o- followed by 10 to 32 lowercase letters or digits)'
    );
  }

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: '*' },
        Action: 'sts:AssumeRole',
        Condition: {
          StringEquals: {
            'aws:PrincipalOrgID': orgId,
          },
          ArnLike: {
            'aws:PrincipalArn': 'arn:aws:iam::*:role/GitHubActions-*',
          },
        },
      },
    ],
  };
}

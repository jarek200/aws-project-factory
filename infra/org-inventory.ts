/// <reference path="../.sst/platform/config.d.ts" />

import { stageConfig } from './stage-config';

const LAMBDA_DEFAULTS = {
  runtime: 'nodejs22.x' as const,
  memory: stageConfig.lambda.memory,
  nodejs: {
    loader: { '.node': 'file' as const },
    esbuild: { external: ['fsevents', 'lightningcss'] },
  },
};

/** List/query/sync org inventory + standalone account close (starts decommission Step Functions). */
export function createOrgAccountsLambda(
  table: ReturnType<typeof import('./storage').createStorage>['table'],
  decommissionStateMachineArn: $util.Input<string>
) {
  return new sst.aws.Function('OrgAccounts', {
    ...LAMBDA_DEFAULTS,
    timeout: '300 seconds',
    handler: 'packages/functions/src/organizations/org-accounts.handler',
    link: [table],
    environment: {
      TABLE_NAME: table.name,
      DECOMMISSION_STATE_MACHINE_ARN: decommissionStateMachineArn,
    },
    permissions: [
      {
        actions: [
          'organizations:ListAccounts',
          'organizations:DescribeAccount',
          'organizations:DescribeOrganization',
        ],
        resources: ['*'],
      },
      {
        actions: [
          'dynamodb:BatchWriteItem',
          'dynamodb:BatchGetItem',
          'dynamodb:Query',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
        ],
        resources: [table.arn, $interpolate`${table.arn}/index/*`],
      },
      {
        actions: ['states:StartExecution'],
        resources: [decommissionStateMachineArn],
      },
    ],
  });
}

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

export function createDecommissionLambdas(
  table: ReturnType<typeof import('./storage').createStorage>['table'],
  githubPrivateKeySecretArn: $util.Input<string>,
  githubPrivateKeySecretArnWildcard: $util.Input<string>,
  githubIds: { appId: $util.Input<string>; installationId: $util.Input<string> }
) {
  const icGroupIdParam = aws.ssm.getParameterOutput({
    name: '/admin-factory/identity-center-group-id',
  });

  const identityCenterEnv = {
    IDENTITY_CENTER_PERMISSION_SET_NAME:
      process.env.IDENTITY_CENTER_PERMISSION_SET_NAME ?? 'AdministratorAccess',
    IDENTITY_CENTER_GROUP_ID: icGroupIdParam.value,
    IDENTITY_CENTER_GROUP_DISPLAY_NAME: process.env.IDENTITY_CENTER_GROUP_DISPLAY_NAME ?? '',
    IDENTITY_CENTER_REGION: process.env.IDENTITY_CENTER_REGION ?? '',
    IDENTITY_CENTER_SKIP_ASSIGNMENT: process.env.IDENTITY_CENTER_SKIP_ASSIGNMENT ?? '',
  };

  const updateDecommissionStatusFn = new sst.aws.Function('UpdateDecommissionStatus', {
    ...LAMBDA_DEFAULTS,
    handler: 'packages/functions/src/decommission/update-decommission-status.handler',
    link: [table],
    environment: { TABLE_NAME: table.name },
    permissions: [{ actions: ['dynamodb:UpdateItem'], resources: [table.arn] }],
  });

  const triggerDestroyWorkflowFn = new sst.aws.Function('TriggerDestroyWorkflow', {
    ...LAMBDA_DEFAULTS,
    timeout: '120 seconds',
    handler: 'packages/functions/src/decommission/trigger-destroy-workflow.handler',
    environment: {
      GITHUB_APP_ID: githubIds.appId,
      GITHUB_PRIVATE_KEY_SECRET_ARN: githubPrivateKeySecretArn,
      GITHUB_INSTALLATION_ID: githubIds.installationId,
      DECOMMISSION_SKIP_GITHUB: process.env.DECOMMISSION_SKIP_GITHUB ?? '',
      DECOMMISSION_GITHUB_WORKFLOW: process.env.DECOMMISSION_GITHUB_WORKFLOW ?? '',
      DECOMMISSION_GITHUB_REF: process.env.DECOMMISSION_GITHUB_REF ?? '',
      DECOMMISSION_GITHUB_WORKFLOW_WITH_INPUTS:
        process.env.DECOMMISSION_GITHUB_WORKFLOW_WITH_INPUTS ?? '',
    },
    permissions: [
      {
        actions: ['secretsmanager:GetSecretValue'],
        resources: [githubPrivateKeySecretArnWildcard],
      },
    ],
  });

  const teardownBootstrapFn = new sst.aws.Function('TeardownBootstrapAccount', {
    ...LAMBDA_DEFAULTS,
    timeout: '300 seconds',
    handler: 'packages/functions/src/decommission/teardown-bootstrap-account.handler',
    permissions: [
      {
        actions: ['sts:AssumeRole'],
        resources: ['arn:aws:iam::*:role/OrganizationAccountAccessRole'],
      },
    ],
  });

  const unassignIdentityCenterFn = new sst.aws.Function('UnassignIdentityCenter', {
    ...LAMBDA_DEFAULTS,
    timeout: '900 seconds',
    handler: 'packages/functions/src/decommission/unassign-identity-center.handler',
    environment: identityCenterEnv,
    permissions: [
      {
        actions: [
          'sso:ListInstances',
          'sso:ListPermissionSets',
          'sso:DescribePermissionSet',
          'sso:DeleteAccountAssignment',
          'sso:DescribeAccountAssignmentDeletionStatus',
          'sso:ListAccountAssignments',
          'identitystore:GetGroupId',
        ],
        resources: ['*'],
      },
    ],
  });

  const closeOrganizationAccountFn = new sst.aws.Function('CloseOrganizationAccount', {
    ...LAMBDA_DEFAULTS,
    /** Single CloseAccount call; no DescribeAccount polling (closure finishes async in AWS). */
    timeout: '60 seconds',
    handler: 'packages/functions/src/decommission/close-organization-account.handler',
    permissions: [
      {
        actions: ['organizations:CloseAccount', 'organizations:DescribeAccount'],
        resources: ['*'],
      },
    ],
  });

  const finalizeDecommissionFn = new sst.aws.Function('FinalizeDecommission', {
    ...LAMBDA_DEFAULTS,
    timeout: '60 seconds',
    handler: 'packages/functions/src/decommission/finalize-decommission.handler',
    link: [table],
    environment: { TABLE_NAME: table.name },
    permissions: [{ actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], resources: [table.arn] }],
  });

  return {
    updateDecommissionStatusFn,
    triggerDestroyWorkflowFn,
    teardownBootstrapFn,
    unassignIdentityCenterFn,
    closeOrganizationAccountFn,
    finalizeDecommissionFn,
  };
}

export function createCloseProjectAccountLambda(
  table: ReturnType<typeof import('./storage').createStorage>['table'],
  decommissionStateMachineArn: $util.Input<string>
) {
  return new sst.aws.Function('CloseProjectAccount', {
    ...LAMBDA_DEFAULTS,
    timeout: '60 seconds',
    handler: 'packages/functions/src/projects/close-account.handler',
    link: [table],
    environment: {
      TABLE_NAME: table.name,
      DECOMMISSION_STATE_MACHINE_ARN: decommissionStateMachineArn,
    },
    permissions: [
      {
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [table.arn],
      },
      {
        actions: ['states:StartExecution'],
        resources: [decommissionStateMachineArn],
      },
    ],
  });
}

export function createDecommissionStateMachine(fns: ReturnType<typeof createDecommissionLambdas>) {
  const {
    updateDecommissionStatusFn,
    triggerDestroyWorkflowFn,
    teardownBootstrapFn,
    unassignIdentityCenterFn,
    closeOrganizationAccountFn,
    finalizeDecommissionFn,
  } = fns;

  const sfnRole = new aws.iam.Role('DecommissionSfnExecutionRole', {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'states.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    }),
  });

  new aws.iam.RolePolicy('DecommissionSfnExecutionPolicy', {
    role: sfnRole.id,
    policy: $jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['lambda:InvokeFunction'],
          Resource: [
            updateDecommissionStatusFn.arn,
            triggerDestroyWorkflowFn.arn,
            teardownBootstrapFn.arn,
            unassignIdentityCenterFn.arn,
            closeOrganizationAccountFn.arn,
            finalizeDecommissionFn.arn,
          ],
        },
        {
          Effect: 'Allow',
          Action: [
            'logs:CreateLogGroup',
            'logs:CreateLogDelivery',
            'logs:PutLogEvents',
            'logs:DescribeLogGroups',
            'logs:DescribeResourcePolicies',
          ],
          Resource: '*',
        },
        {
          Effect: 'Allow',
          Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
          Resource: '*',
        },
      ],
    }),
  });

  const definition = $interpolate`{
    "Comment": "Decommission factory member account",
    "StartAt": "UpdateStatusDispatchDestroy",
    "States": {
      "UpdateStatusDispatchDestroy": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateDecommissionStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "targetAccountId.$": "$.accountId",
            "phase": "DISPATCH_DESTROY"
          }
        },
        "ResultPath": null,
        "Next": "MaybeGitHubDestroy",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "HandleDecommissionFailed"}]
      },
      "MaybeGitHubDestroy": {
        "Type": "Choice",
        "Choices": [
          {
            "And": [
              {
                "Variable": "$.hasGithubRepo",
                "BooleanEquals": true
              },
              {
                "Variable": "$.runMonorepoTeardown",
                "BooleanEquals": true
              }
            ],
            "Next": "TriggerDestroyWorkflow"
          }
        ],
        "Default": "UpdateStatusTeardown"
      },
      "TriggerDestroyWorkflow": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${triggerDestroyWorkflowFn.arn}",
          "Payload": {
            "repoFullName.$": "$.repoFullName",
            "envKey.$": "$.envKey"
          }
        },
        "ResultPath": "$.destroyTrigger",
        "Next": "WaitAfterDestroyDispatch",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "HandleDecommissionFailed"}]
      },
      "WaitAfterDestroyDispatch": {
        "Type": "Wait",
        "Seconds": 120,
        "Next": "UpdateStatusTeardown"
      },
      "UpdateStatusTeardown": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateDecommissionStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "targetAccountId.$": "$.accountId",
            "phase": "TEARDOWN_BOOTSTRAP"
          }
        },
        "ResultPath": null,
        "Next": "TeardownBootstrap",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "HandleDecommissionFailed"}]
      },
      "TeardownBootstrap": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${teardownBootstrapFn.arn}",
          "Payload": {
            "accountId.$": "$.accountId",
            "accountName.$": "$.accountName"
          }
        },
        "ResultPath": null,
        "Next": "UpdateStatusUnassign",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "HandleDecommissionFailed"}]
      },
      "UpdateStatusUnassign": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateDecommissionStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "targetAccountId.$": "$.accountId",
            "phase": "UNASSIGN_IDENTITY_CENTER"
          }
        },
        "ResultPath": null,
        "Next": "UnassignIdentityCenter",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "HandleDecommissionFailed"}]
      },
      "UnassignIdentityCenter": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${unassignIdentityCenterFn.arn}",
          "Payload": {
            "accountId.$": "$.accountId",
            "accountName.$": "$.accountName"
          }
        },
        "ResultPath": null,
        "Next": "UpdateStatusCloseAccount",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "HandleDecommissionFailed"}]
      },
      "UpdateStatusCloseAccount": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateDecommissionStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "targetAccountId.$": "$.accountId",
            "phase": "CLOSE_ACCOUNT"
          }
        },
        "ResultPath": null,
        "Next": "CloseOrganizationAccount",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "HandleDecommissionFailed"}]
      },
      "CloseOrganizationAccount": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${closeOrganizationAccountFn.arn}",
          "Payload": {
            "accountId.$": "$.accountId",
            "accountName.$": "$.accountName"
          }
        },
        "ResultPath": null,
        "Next": "FinalizeDecommission",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "HandleDecommissionFailed"}]
      },
      "FinalizeDecommission": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${finalizeDecommissionFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "targetAccountId.$": "$.accountId"
          }
        },
        "ResultPath": null,
        "End": true,
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "HandleDecommissionFailed"}]
      },
      "HandleDecommissionFailed": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateDecommissionStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "targetAccountId.$": "$.accountId",
            "phase": "FAILED",
            "accountsSnapshot.$": "$.accountsSnapshot",
            "sfnError.$": "$.sfnError"
          }
        },
        "ResultPath": null,
        "Next": "FailDecommission"
      },
      "FailDecommission": {
        "Type": "Fail",
        "Error": "DecommissionFailed",
        "Cause": "Account closure failed; see decommissionError on the project."
      }
    }
  }`;

  const stateMachine = new aws.sfn.StateMachine('DecommissionStateMachine', {
    roleArn: sfnRole.arn,
    definition,
    type: 'STANDARD',
  });

  return stateMachine;
}

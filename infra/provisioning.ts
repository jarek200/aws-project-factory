/// <reference path="../.sst/platform/config.d.ts" />

import { PROJECT_APPS_ROOT_DOMAIN } from './admin-site-domain';
import { stageConfig } from './stage-config';

const LAMBDA_DEFAULTS = {
  runtime: 'nodejs22.x' as const,
  memory: stageConfig.lambda.memory,
  nodejs: {
    loader: { '.node': 'file' as const },
    esbuild: { external: ['fsevents', 'lightningcss'] },
  },
};

const LAMBDA_DEFAULTS_WITH_SODIUM = {
  ...LAMBDA_DEFAULTS,
  nodejs: {
    ...LAMBDA_DEFAULTS.nodejs,
    install: ['libsodium-wrappers'],
    esbuild: { external: [...LAMBDA_DEFAULTS.nodejs.esbuild.external, 'libsodium-wrappers'] },
  },
};

// ─── Provisioning task Lambdas ────────────────────────────────────────────────

export function createProvisioningLambdas(
  table: ReturnType<typeof import('./storage').createStorage>['table'],
  githubPrivateKeySecretArn: $util.Input<string>,
  githubPrivateKeySecretArnWildcard: $util.Input<string>,
  githubIds: { appId: $util.Input<string>; installationId: $util.Input<string> },
  projectAppsDns: {
    hostedZoneId: $util.Input<string>;
    dnsRoleArn: $util.Input<string>;
  }
) {
  /** Updates DynamoDB provisioning phase — called at every SFN transition */
  const updateStatusFn = new sst.aws.Function('UpdateStatus', {
    ...LAMBDA_DEFAULTS,
    handler: 'packages/functions/src/provisioning/update-status.handler',
    link: [table],
    environment: { TABLE_NAME: table.name },
    permissions: [{ actions: ['dynamodb:UpdateItem'], resources: [table.arn] }],
  });

  /** AWS Organizations account vending (runs in management account) */
  const vendAccountFn = new sst.aws.Function('VendAccount', {
    ...LAMBDA_DEFAULTS,
    timeout: '900 seconds', // Up to 15 min — account creation can take ~10 min
    handler: 'packages/functions/src/provisioning/vend-accounts.handler',
    link: [table],
    environment: { TABLE_NAME: table.name },
    permissions: [
      {
        actions: [
          'organizations:CreateAccount',
          'organizations:DescribeCreateAccountStatus',
          'organizations:ListAccounts',
        ],
        resources: ['*'],
      },
      // Org-wide CreateAccount lock (UpdateItem) lives in AppTable
      {
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [table.arn],
      },
    ],
  });

  /** Assumes OrganizationAccountAccessRole, creates OIDC provider + IAM role */
  const bootstrapAccountFn = new sst.aws.Function('BootstrapAccount', {
    ...LAMBDA_DEFAULTS,
    timeout: '300 seconds',
    handler: 'packages/functions/src/provisioning/bootstrap-account.handler',
    environment: {
      GITHUB_APP_ID: githubIds.appId,
      GITHUB_PRIVATE_KEY_SECRET_ARN: githubPrivateKeySecretArn,
      GITHUB_INSTALLATION_ID: githubIds.installationId,
    },
    permissions: [
      {
        actions: ['sts:AssumeRole'],
        resources: ['arn:aws:iam::*:role/OrganizationAccountAccessRole'],
      },
      {
        actions: ['secretsmanager:GetSecretValue'],
        resources: [githubPrivateKeySecretArnWildcard],
      },
    ],
  });

  // Read Identity Center config from SSM (fall back to env vars for overrides).
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

  /**
   * Grants the "Admin" Identity Center group AdministratorAccess on each new
   * member account so it appears in your SSO portal immediately.
   * Group ID read from SSM `/admin-factory/identity-center-group-id`.
   */
  const assignIdentityCenterFn = new sst.aws.Function('AssignIdentityCenter', {
    ...LAMBDA_DEFAULTS,
    timeout: '900 seconds',
    handler: 'packages/functions/src/provisioning/assign-identity-center.handler',
    environment: identityCenterEnv,
    permissions: [
      {
        actions: [
          'sso:ListInstances',
          'sso:ListPermissionSets',
          'sso:DescribePermissionSet',
          'sso:CreateAccountAssignment',
          'sso:DescribeAccountAssignmentCreationStatus',
          'sso:ListAccountAssignments',
          'identitystore:GetGroupId',
        ],
        resources: ['*'],
      },
    ],
  });

  /** Creates GitHub repo from template via GitHub App */
  const createRepoFn = new sst.aws.Function('CreateRepo', {
    ...LAMBDA_DEFAULTS,
    /** Template generate + GitHub latency can exceed 2m on large templates. */
    timeout: '300 seconds',
    handler: 'packages/functions/src/provisioning/create-repo.handler',
    environment: {
      GITHUB_APP_ID: githubIds.appId,
      GITHUB_PRIVATE_KEY_SECRET_ARN: githubPrivateKeySecretArn,
      GITHUB_INSTALLATION_ID: githubIds.installationId,
    },
    permissions: [
      {
        actions: ['secretsmanager:GetSecretValue'],
        resources: [githubPrivateKeySecretArnWildcard],
      },
    ],
  });

  /** Configures child repo GitHub Actions secrets, variables, and deploy workflow */
  const configureEnvironmentsFn = new sst.aws.Function('ConfigureEnvironments', {
    ...LAMBDA_DEFAULTS_WITH_SODIUM,
    /** Many sequential GitHub API calls × accounts + encrypt + workflow push; 2m is often too tight. */
    timeout: '900 seconds',
    handler: 'packages/functions/src/provisioning/configure-environments.handler',
    environment: {
      GITHUB_APP_ID: githubIds.appId,
      GITHUB_PRIVATE_KEY_SECRET_ARN: githubPrivateKeySecretArn,
      GITHUB_INSTALLATION_ID: githubIds.installationId,
      PROJECT_APPS_ROOT_DOMAIN,
      APPS_HOSTED_ZONE_ID: projectAppsDns.hostedZoneId,
      DNS_ROLE_ARN: projectAppsDns.dnsRoleArn,
    },
    permissions: [
      {
        actions: ['secretsmanager:GetSecretValue'],
        resources: [githubPrivateKeySecretArnWildcard],
      },
    ],
  });

  return {
    updateStatusFn,
    vendAccountFn,
    bootstrapAccountFn,
    assignIdentityCenterFn,
    createRepoFn,
    configureEnvironmentsFn,
  };
}

// ─── createProject Lambda (AppSync resolver) ─────────────────────────────────

export function createProjectLambda(
  table: ReturnType<typeof import('./storage').createStorage>['table'],
  stateMachineArn: $util.Input<string>,
  githubPrivateKeySecretArn: $util.Input<string>,
  githubPrivateKeySecretArnWildcard: $util.Input<string>,
  githubAppId: $util.Input<string>,
  githubInstallationId: $util.Input<string>
) {
  return new sst.aws.Function('CreateProject', {
    ...LAMBDA_DEFAULTS,
    timeout: '60 seconds',
    handler: 'packages/functions/src/projects/create.handler',
    link: [table],
    environment: {
      TABLE_NAME: table.name,
      STATE_MACHINE_ARN: stateMachineArn,
      GITHUB_APP_ID: githubAppId,
      GITHUB_PRIVATE_KEY_SECRET_ARN: githubPrivateKeySecretArn,
      GITHUB_INSTALLATION_ID: githubInstallationId,
      PROJECT_APPS_ROOT_DOMAIN,
    },
    permissions: [
      {
        actions: [
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:DeleteItem',
          'dynamodb:TransactWriteItems',
        ],
        resources: [table.arn, $interpolate`${table.arn}/index/*`],
      },
      {
        actions: ['states:StartExecution'],
        resources: [stateMachineArn],
      },
      {
        actions: ['secretsmanager:GetSecretValue'],
        resources: [githubPrivateKeySecretArnWildcard],
      },
    ],
  });
}

/** AppSync: provisionProjectAws — starts Step Functions on the AWS_ONLY path */
export function createProvisionProjectAwsLambda(
  table: ReturnType<typeof import('./storage').createStorage>['table'],
  stateMachineArn: $util.Input<string>
) {
  return new sst.aws.Function('ProvisionProjectAws', {
    ...LAMBDA_DEFAULTS,
    timeout: '60 seconds',
    handler: 'packages/functions/src/projects/provision-project-aws.handler',
    link: [table],
    environment: {
      TABLE_NAME: table.name,
      STATE_MACHINE_ARN: stateMachineArn,
    },
    permissions: [
      {
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [table.arn],
      },
      {
        actions: ['states:StartExecution'],
        resources: [stateMachineArn],
      },
    ],
  });
}

// ─── Step Functions state machine ─────────────────────────────────────────────

export function createProvisioningStateMachine(fns: ReturnType<typeof createProvisioningLambdas>) {
  const {
    updateStatusFn,
    vendAccountFn,
    bootstrapAccountFn,
    assignIdentityCenterFn,
    createRepoFn,
    configureEnvironmentsFn,
  } = fns;

  // IAM execution role for Step Functions
  const sfnRole = new aws.iam.Role('SfnExecutionRole', {
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

  new aws.iam.RolePolicy('SfnExecutionPolicy', {
    role: sfnRole.id,
    policy: $jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['lambda:InvokeFunction'],
          Resource: [
            updateStatusFn.arn,
            vendAccountFn.arn,
            bootstrapAccountFn.arn,
            assignIdentityCenterFn.arn,
            createRepoFn.arn,
            configureEnvironmentsFn.arn,
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
          // Allow X-Ray tracing
          Effect: 'Allow',
          Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
          Resource: '*',
        },
      ],
    }),
  });

  // State machine definition
  // Full path: GITHUB → CreateRepo → (accounts?) → ACCOUNTS Map → Configure → DONE
  // Repo-only: CreateRepo → REPO_ONLY configure (no AWS) → terminal REPO_ONLY
  // AWS-only entry (entryPoint AWS_ONLY): ACCOUNTS Map → Configure → DONE (after repo-first project)
  // A 12-digit accountId bootstraps that member. Null vends a new account.
  // StringMatches is guarded: a null accountId makes the comparison fail the state.
  const definition = $interpolate`{
    "Comment": "Admin Project Factory provisioning: github accounts configure",
    "StartAt": "RouteEntry",
    "States": {
      "RouteEntry": {
        "Type": "Choice",
        "Choices": [
          {
            "And": [
              {
                "Variable": "$.entryPoint",
                "IsPresent": true
              },
              {
                "Variable": "$.entryPoint",
                "StringEquals": "AWS_ONLY"
              }
            ],
            "Next": "SetAccountsPhase"
          }
        ],
        "Default": "SetGithubPhase"
      },

      "SetGithubPhase": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "phase": "GITHUB",
            "progress": 5
          }
        },
        "ResultPath": null,
        "Next": "CreateRepo",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "SetFailedPhase"}]
      },

      "CreateRepo": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${createRepoFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "slug.$": "$.slug",
            "name.$": "$.name",
            "templateRepo.$": "$.templateRepo",
            "githubOrg.$": "$.githubOrg"
          }
        },
        "ResultSelector": {
          "githubUrl.$": "$.Payload.githubUrl",
          "repoFullName.$": "$.Payload.repoFullName",
          "githubOwnerId.$": "$.Payload.githubOwnerId",
          "githubRepoId.$": "$.Payload.githubRepoId"
        },
        "ResultPath": "$.repo",
        "Next": "AfterCreateRepo",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "SetFailedPhase"}]
      },

      "AfterCreateRepo": {
        "Type": "Choice",
        "Choices": [
          {
            "Variable": "$.accounts[0]",
            "IsPresent": true,
            "Next": "SetAccountsPhase"
          }
        ],
        "Default": "SetRepoOnlyPhase"
      },

      "SetRepoOnlyPhase": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "phase": "REPO_ONLY",
            "progress": 40,
            "githubUrl.$": "$.repo.githubUrl"
          }
        },
        "ResultPath": null,
        "Next": "InitEmptyProvisionedAccounts",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "SetFailedPhase"}]
      },

      "InitEmptyProvisionedAccounts": {
        "Type": "Pass",
        "Result": [],
        "ResultPath": "$.provisionedAccounts",
        "Next": "ConfigureEnvironmentsRepoOnly"
      },

      "ConfigureEnvironmentsRepoOnly": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${configureEnvironmentsFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "slug.$": "$.slug",
            "repoFullName.$": "$.repo.repoFullName",
            "githubOrg.$": "$.githubOrg",
            "accounts.$": "$.provisionedAccounts"
          }
        },
        "ResultPath": null,
        "Next": "SetRepoOnlyDonePhase",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "SetFailedPhase"}]
      },

      "SetRepoOnlyDonePhase": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "phase": "REPO_ONLY",
            "progress": 100,
            "githubUrl.$": "$.repo.githubUrl"
          }
        },
        "ResultPath": null,
        "End": true
      },

      "SetAccountsPhase": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "phase": "ACCOUNTS",
            "progress": 25,
            "githubUrl.$": "$.repo.githubUrl"
          }
        },
        "ResultPath": null,
        "Next": "VendAndBootstrapAccounts",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "SetFailedPhase"}]
      },

      "VendAndBootstrapAccounts": {
        "Type": "Map",
        "ItemsPath": "$.accounts",
        "ItemSelector": {
          "name.$": "$$.Map.Item.Value.name",
          "email.$": "$$.Map.Item.Value.email",
          "accountId.$": "$$.Map.Item.Value.accountId",
          "projectId.$": "$.projectId",
          "projectSlug.$": "$.slug",
          "githubOrg.$": "$.githubOrg"
        },
        "MaxConcurrency": 1,
        "Iterator": {
          "StartAt": "RouteAccountItem",
          "States": {
            "RouteAccountItem": {
              "Type": "Choice",
              "Choices": [
                {
                  "And": [
                    {
                      "Variable": "$.accountId",
                      "IsPresent": true
                    },
                    {
                      "Variable": "$.accountId",
                      "IsString": true
                    },
                    {
                      "Variable": "$.accountId",
                      "StringMatches": "^[0-9]{12}$"
                    }
                  ],
                  "Next": "BootstrapAccount"
                }
              ],
              "Default": "VendAccount"
            },
            "VendAccount": {
              "Type": "Task",
              "Resource": "arn:aws:states:::lambda:invoke",
              "Parameters": {
                "FunctionName": "${vendAccountFn.arn}",
                "Payload.$": "$"
              },
              "ResultSelector": {
                "name.$": "$.Payload.name",
                "email.$": "$.Payload.email",
                "accountId.$": "$.Payload.accountId",
                "projectSlug.$": "$$.Execution.Input.slug",
                "githubOrg.$": "$$.Execution.Input.githubOrg"
              },
              "Retry": [
                {
                  "ErrorEquals": ["States.TaskFailed"],
                  "IntervalSeconds": 45,
                  "MaxAttempts": 20,
                  "BackoffRate": 1.2
                }
              ],
              "Next": "BootstrapAccount"
            },
            "BootstrapAccount": {
              "Type": "Task",
              "Resource": "arn:aws:states:::lambda:invoke",
              "Parameters": {
                "FunctionName": "${bootstrapAccountFn.arn}",
                "Payload.$": "$"
              },
              "ResultSelector": {
                "name.$": "$.Payload.name",
                "email.$": "$.Payload.email",
                "accountId.$": "$.Payload.accountId",
                "roleArn.$": "$.Payload.roleArn",
                "envKey.$": "$.Payload.envKey"
              },
              "Retry": [
                {
                  "ErrorEquals": ["States.TaskFailed"],
                  "IntervalSeconds": 15,
                  "MaxAttempts": 3,
                  "BackoffRate": 2
                }
              ],
              "Next": "AssignIdentityCenter"
            },
            "AssignIdentityCenter": {
              "Type": "Task",
              "Resource": "arn:aws:states:::lambda:invoke",
              "Parameters": {
                "FunctionName": "${assignIdentityCenterFn.arn}",
                "Payload.$": "$"
              },
              "ResultSelector": {
                "name.$": "$.Payload.name",
                "email.$": "$.Payload.email",
                "accountId.$": "$.Payload.accountId",
                "roleArn.$": "$.Payload.roleArn",
                "envKey.$": "$.Payload.envKey"
              },
              "Retry": [
                {
                  "ErrorEquals": ["States.TaskFailed"],
                  "IntervalSeconds": 30,
                  "MaxAttempts": 3,
                  "BackoffRate": 2
                }
              ],
              "End": true
            }
          }
        },
        "ResultPath": "$.provisionedAccounts",
        "Next": "SetConfiguringPhase",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "SetFailedPhase"}]
      },

      "SetConfiguringPhase": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "phase": "CONFIGURE",
            "progress": 80,
            "accounts.$": "$.provisionedAccounts"
          }
        },
        "ResultPath": null,
        "Next": "ConfigureEnvironments",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "SetFailedPhase"}]
      },

      "ConfigureEnvironments": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${configureEnvironmentsFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "slug.$": "$.slug",
            "repoFullName.$": "$.repo.repoFullName",
            "githubOrg.$": "$.githubOrg",
            "accounts.$": "$.provisionedAccounts"
          }
        },
        "ResultPath": null,
        "Next": "SetDonePhase",
        "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.sfnError", "Next": "SetFailedPhase"}]
      },

      "SetDonePhase": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "phase": "DONE",
            "progress": 100,
            "githubUrl.$": "$.repo.githubUrl"
          }
        },
        "ResultPath": null,
        "End": true
      },

      "SetFailedPhase": {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {
          "FunctionName": "${updateStatusFn.arn}",
          "Payload": {
            "projectId.$": "$.projectId",
            "phase": "FAILED",
            "sfnError.$": "$.sfnError"
          }
        },
        "ResultPath": null,
        "Next": "FailExecution"
      },

      "FailExecution": {
        "Type": "Fail",
        "Error": "ProvisioningFailed",
        "Cause": "Provisioning failed; see the project error field for details."
      }
    }
  }`;

  const stateMachine = new aws.sfn.StateMachine('ProvisioningStateMachine', {
    roleArn: sfnRole.arn,
    definition,
    type: 'STANDARD',
    // Logging requires `destinations` with a CloudWatch log group ARN; omit to use default (no CW logs).
  });

  return stateMachine;
}

/**
 * AppSync Lambda: provisionProjectAws — start Step Functions on the AWS-only path
 * (vend accounts → OIDC → Identity Center → configure GitHub) for a repo-first project.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AppSyncResolverHandler } from 'aws-lambda';
import { requiredEnv } from '../runtime-env';
import { repoFullNameFromGithubUrl } from './github-url';

const TABLE_NAME = requiredEnv('TABLE_NAME');
const STATE_MACHINE_ARN = requiredEnv('STATE_MACHINE_ARN');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sfnClient = new SFNClient({});

interface ProjectAccountInput {
  name: string;
  email: string;
  accountId?: string | null;
}

interface ProvisionProjectAwsInput {
  projectId: string;
  accounts: ProjectAccountInput[];
}

interface ProjectItem {
  id: string;
  userId: string;
  name: string;
  slug: string;
  githubOrg?: string | null;
  githubUrl?: string | null;
  provisioningPhase?: string;
  accounts?: Array<{ accountId?: string | null }>;
  executionArn?: string | null;
}

interface AppSyncIdentityCognito {
  sub: string;
}

export const handler: AppSyncResolverHandler<unknown, unknown> = async (event) => {
  const identity = event.identity as AppSyncIdentityCognito;
  const userId = identity.sub;
  const input = (event.arguments as { input: ProvisionProjectAwsInput }).input;

  if (!input.accounts?.length) {
    throw new Error('At least one AWS account is required.');
  }

  const getResult = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PROJECT#${input.projectId}`, SK: 'METADATA' },
    })
  );

  const project = getResult.Item;
  if (!project) {
    throw new Error('Project not found.');
  }

  const p = project as ProjectItem;
  if (p.userId !== userId) {
    throw new Error('Not authorized to modify this project.');
  }

  if (p.provisioningPhase !== 'REPO_ONLY') {
    throw new Error(
      `AWS provisioning can only start when the project is in REPO_ONLY phase (current: ${p.provisioningPhase ?? 'unknown'}).`
    );
  }

  const existing = p.accounts ?? [];
  if (existing.length > 0 && existing.some((a) => a.accountId)) {
    throw new Error('This project already has vended AWS accounts.');
  }

  const githubUrl = p.githubUrl?.trim();
  if (!githubUrl) {
    throw new Error('Project has no GitHub repository URL; cannot configure AWS.');
  }

  const repoFullName = repoFullNameFromGithubUrl(githubUrl);
  if (!repoFullName) {
    throw new Error(`Could not parse repo from githubUrl: ${githubUrl}`);
  }

  const slug = p.slug?.trim();
  if (!slug) {
    throw new Error('Project slug is missing.');
  }

  const accountsForDb = input.accounts.map((a) => ({
    name: a.name.trim(),
    email: a.email.trim(),
    accountId: a.accountId?.trim() ? a.accountId.trim() : null,
    roleArn: null,
    awsSignInUrl: null,
    closureState: 'NONE',
    closedAt: null,
  }));

  const now = new Date().toISOString();

  // Claim the project before starting SFN (prevents double-submit races).
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `PROJECT#${input.projectId}`, SK: 'METADATA' },
        UpdateExpression:
          'SET #accounts = :accounts, #phase = :phase, #progress = :progress, #error = :err, #updatedAt = :updatedAt',
        ConditionExpression: '#phase = :repoOnly AND #userId = :userId',
        ExpressionAttributeNames: {
          '#accounts': 'accounts',
          '#phase': 'provisioningPhase',
          '#progress': 'provisioningProgress',
          '#error': 'error',
          '#updatedAt': 'updatedAt',
          '#userId': 'userId',
        },
        ExpressionAttributeValues: {
          ':accounts': accountsForDb,
          ':phase': 'ACCOUNTS',
          ':progress': 25,
          ':err': null,
          ':updatedAt': now,
          ':repoOnly': 'REPO_ONLY',
          ':userId': userId,
        },
        ReturnValues: 'ALL_NEW',
      })
    );
  } catch (e: unknown) {
    const name =
      e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
    if (name === 'ConditionalCheckFailedException') {
      throw new Error(
        'AWS provisioning already started or project is no longer in REPO_ONLY phase.'
      );
    }
    throw e;
  }

  const sfnInput = {
    entryPoint: 'AWS_ONLY',
    projectId: p.id,
    userId: p.userId,
    name: p.name,
    slug,
    templateRepo: '',
    githubOrg: (p.githubOrg ?? '').trim(),
    accounts: input.accounts.map((a) => ({
      name: a.name.trim(),
      email: a.email.trim(),
      // Always present so the Map item selector can copy it. Null means vend.
      accountId: a.accountId?.trim() ? a.accountId.trim() : null,
    })),
    repo: {
      githubUrl,
      repoFullName,
    },
  };

  let executionArn: string;
  try {
    const execution = await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: `project-aws-${input.projectId}-${Date.now()}`,
        input: JSON.stringify(sfnInput),
      })
    );
    if (!execution.executionArn) {
      throw new Error('Step Functions did not return an execution ARN.');
    }
    executionArn = execution.executionArn;
  } catch (e) {
    // Roll back claim so the user can retry
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `PROJECT#${input.projectId}`, SK: 'METADATA' },
        UpdateExpression:
          'SET #phase = :phase, #progress = :progress, #accounts = :accounts, #error = :err, #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#phase': 'provisioningPhase',
          '#progress': 'provisioningProgress',
          '#accounts': 'accounts',
          '#error': 'error',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':phase': 'REPO_ONLY',
          ':progress': 100,
          ':accounts': [],
          ':err': 'Failed to start AWS provisioning; you can retry.',
          ':updatedAt': new Date().toISOString(),
        },
      })
    );
    throw e;
  }

  const updated = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PROJECT#${input.projectId}`, SK: 'METADATA' },
      UpdateExpression: 'SET #executionArn = :executionArn, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#executionArn': 'executionArn',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':executionArn': executionArn,
        ':updatedAt': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  if (!updated.Attributes) {
    throw new Error('Project was updated but DynamoDB returned no attributes.');
  }
  const item = updated.Attributes as Record<string, unknown>;
  const rawAccounts = (item.accounts as Array<Record<string, unknown>>) ?? accountsForDb;
  return {
    ...item,
    accounts: rawAccounts.map((a) => ({
      ...a,
      closureState: (a.closureState as string) || 'NONE',
      closedAt: (a.closedAt as string | null) ?? null,
    })),
    provisioningPhase: (item.provisioningPhase as string) ?? 'ACCOUNTS',
    provisioningProgress: (item.provisioningProgress as number) ?? 25,
    executionArn,
    decommissionPhase: item.decommissionPhase ?? 'IDLE',
    decommissionExecutionArn: item.decommissionExecutionArn ?? null,
    decommissionTargetAccountId: item.decommissionTargetAccountId ?? null,
    decommissionError: item.decommissionError ?? null,
  };
};

/**
 * AppSync: closeProjectAccount — validate project ownership, mark account CLOSING,
 * start decommission Step Functions execution.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AppSyncResolverHandler } from 'aws-lambda';

import { envKeyFromAccountName } from '../provisioning/account-env-key';
import { requiredEnv } from '../runtime-env';
import { repoFullNameFromGithubUrl } from './github-url';

export { repoFullNameFromGithubUrl };

const TABLE_NAME = requiredEnv('TABLE_NAME');
const DECOMMISSION_STATE_MACHINE_ARN = requiredEnv('DECOMMISSION_STATE_MACHINE_ARN');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sfnClient = new SFNClient({});

interface AccountRow {
  name: string;
  email: string;
  accountId: string | null;
  roleArn: string | null;
  awsSignInUrl?: string | null;
  closureState?: string | null;
  closedAt?: string | null;
}

interface ProjectItem {
  id: string;
  userId: string;
  slug: string;
  githubOrg?: string | null;
  githubUrl?: string | null;
  provisioningPhase?: string;
  accounts: AccountRow[];
  decommissionPhase?: string | null;
}

interface AppSyncIdentityCognito {
  sub: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function persistProjectExecutionArn(projectId: string, executionArn: string): Promise<void> {
  const max = 6;
  for (let i = 0; i < max; i++) {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: `PROJECT#${projectId}`, SK: 'METADATA' },
          UpdateExpression: 'SET decommissionExecutionArn = :arn, updatedAt = :u',
          ExpressionAttributeValues: {
            ':arn': executionArn,
            ':u': new Date().toISOString(),
          },
        })
      );
      return;
    } catch (e) {
      console.warn(`persistProjectExecutionArn attempt ${i + 1}/${max} failed`, e);
      if (i === max - 1) {
        console.error(
          'Could not persist decommissionExecutionArn; Step Functions execution has already started',
          e
        );
        return;
      }
      await sleep(250 * 2 ** i);
    }
  }
}

async function getProjectAfterCloseStart(
  projectId: string,
  fallbackItem: ProjectItem,
  accountsClosing: AccountRow[],
  executionArn: string,
  accountId: string
): Promise<Record<string, unknown>> {
  const max = 5;
  for (let i = 0; i < max; i++) {
    try {
      const refreshed = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { PK: `PROJECT#${projectId}`, SK: 'METADATA' },
        })
      );
      if (refreshed.Item) return refreshed.Item as Record<string, unknown>;
    } catch (e) {
      console.warn(`getProjectAfterCloseStart attempt ${i + 1}/${max}`, e);
    }
    await sleep(200 * (i + 1));
  }
  console.error(
    'GetItem failed after close start; returning synthetic project (SFN already running)'
  );
  return {
    ...fallbackItem,
    accounts: accountsClosing,
    decommissionPhase: 'DISPATCH_DESTROY',
    decommissionExecutionArn: executionArn,
    decommissionTargetAccountId: accountId,
    decommissionError: null,
    updatedAt: new Date().toISOString(),
  } as unknown as Record<string, unknown>;
}

export const handler: AppSyncResolverHandler<unknown, unknown> = async (event) => {
  const identity = event.identity as AppSyncIdentityCognito;
  const userId = identity.sub;
  const { projectId, accountId, runMonorepoTeardown } = event.arguments as {
    projectId: string;
    accountId: string;
    runMonorepoTeardown?: boolean | null;
  };

  if (!projectId || !accountId) {
    throw new Error('projectId and accountId are required');
  }
  const wantGithubTeardown = runMonorepoTeardown !== false;

  const got = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PROJECT#${projectId}`, SK: 'METADATA' },
    })
  );
  const item = got.Item as ProjectItem | undefined;
  if (!item || item.userId !== userId) {
    throw new Error('Project not found or access denied');
  }

  if (item.provisioningPhase !== 'DONE') {
    throw new Error('Project must finish provisioning before closing an account');
  }

  const phase = item.decommissionPhase;
  if (phase && phase !== 'IDLE' && phase !== 'FAILED') {
    throw new Error('Another account decommission is already in progress for this project');
  }

  const acc = item.accounts.find((a) => a.accountId === accountId);
  if (!acc) {
    throw new Error('Account not found on this project');
  }
  if (!acc.name) {
    throw new Error('Account has no name');
  }
  const cstate = acc.closureState ?? 'NONE';
  if (cstate === 'CLOSED') {
    throw new Error('Account is already closed');
  }
  if (cstate === 'CLOSING') {
    throw new Error('Account closure already in progress');
  }

  const accountsClosing = item.accounts.map((a) =>
    a.accountId === accountId
      ? {
          ...a,
          closureState: 'CLOSING',
          awsSignInUrl: a.awsSignInUrl ?? null,
          closedAt: a.closedAt ?? null,
        }
      : {
          ...a,
          closureState: a.closureState ?? 'NONE',
          awsSignInUrl: a.awsSignInUrl ?? null,
          closedAt: a.closedAt ?? null,
        }
  );

  const now = new Date().toISOString();
  const repoFullName = repoFullNameFromGithubUrl(item.githubUrl ?? undefined);
  const hasGithubRepo = Boolean(repoFullName);
  const envKey = envKeyFromAccountName(acc.name);

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PROJECT#${projectId}`, SK: 'METADATA' },
      ConditionExpression:
        'userId = :uid AND (attribute_not_exists(decommissionPhase) OR decommissionPhase = :idle OR decommissionPhase = :failed)',
      UpdateExpression:
        'SET #accounts = :accounts, #dPhase = :dispatch, #dTarget = :target, #dErr = :null, #updatedAt = :updatedAt REMOVE #dExec',
      ExpressionAttributeNames: {
        '#accounts': 'accounts',
        '#dPhase': 'decommissionPhase',
        '#dTarget': 'decommissionTargetAccountId',
        '#dErr': 'decommissionError',
        '#dExec': 'decommissionExecutionArn',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':uid': userId,
        ':idle': 'IDLE',
        ':failed': 'FAILED',
        ':accounts': accountsClosing.map((a) => ({
          name: a.name,
          email: a.email,
          accountId: a.accountId,
          roleArn: a.roleArn,
          awsSignInUrl: a.awsSignInUrl ?? null,
          closureState: a.closureState ?? 'NONE',
          closedAt: a.closedAt ?? null,
        })),
        ':dispatch': 'DISPATCH_DESTROY',
        ':target': accountId,
        ':null': null,
        ':updatedAt': now,
      },
    })
  );

  const accountsSnapshot = accountsClosing.map((a) => ({
    name: a.name,
    email: a.email,
    accountId: a.accountId,
    roleArn: a.roleArn,
    awsSignInUrl: a.awsSignInUrl ?? null,
    closureState: a.closureState ?? 'NONE',
    closedAt: a.closedAt ?? null,
  }));

  const sfnInput = {
    projectId,
    slug: item.slug,
    githubOrg: item.githubOrg ?? '',
    repoFullName,
    hasGithubRepo,
    runMonorepoTeardown: wantGithubTeardown,
    accountName: acc.name,
    accountEmail: acc.email,
    accountId,
    envKey,
    accountsSnapshot,
  };

  const execName = `decom-${projectId.slice(0, 8)}-${accountId}-${Date.now()}`;

  const accountsNone = item.accounts.map((a) =>
    a.accountId === accountId
      ? {
          ...a,
          closureState: 'NONE',
          awsSignInUrl: a.awsSignInUrl ?? null,
          closedAt: a.closedAt ?? null,
        }
      : {
          ...a,
          closureState: a.closureState ?? 'NONE',
          awsSignInUrl: a.awsSignInUrl ?? null,
          closedAt: a.closedAt ?? null,
        }
  );

  let executionArn: string;
  try {
    const execution = await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn: DECOMMISSION_STATE_MACHINE_ARN,
        name: execName.slice(0, 80),
        input: JSON.stringify(sfnInput),
      })
    );
    executionArn = execution.executionArn ?? '';
    if (!executionArn) throw new Error('StartExecution returned no executionArn');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `PROJECT#${projectId}`, SK: 'METADATA' },
        UpdateExpression:
          'SET #accounts = :accounts, #dPhase = :failed, #dErr = :err, #updatedAt = :u REMOVE #dExec, #dTarget',
        ExpressionAttributeNames: {
          '#accounts': 'accounts',
          '#dPhase': 'decommissionPhase',
          '#dErr': 'decommissionError',
          '#dExec': 'decommissionExecutionArn',
          '#dTarget': 'decommissionTargetAccountId',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':accounts': accountsNone.map((a) => ({
            name: a.name,
            email: a.email,
            accountId: a.accountId,
            roleArn: a.roleArn,
            awsSignInUrl: a.awsSignInUrl ?? null,
            closureState: a.closureState ?? 'NONE',
            closedAt: a.closedAt ?? null,
          })),
          ':failed': 'FAILED',
          ':err': `StartExecution failed: ${msg}`,
          ':u': new Date().toISOString(),
        },
      })
    );
    throw err;
  }

  await persistProjectExecutionArn(projectId, executionArn);

  const raw = await getProjectAfterCloseStart(
    projectId,
    item,
    accountsClosing,
    executionArn,
    accountId
  );
  return mapProjectForGraphQL(raw);
};

function mapProjectForGraphQL(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) throw new Error('Project missing after update');
  return {
    ...raw,
    id: raw.id,
    accounts: (raw.accounts as unknown[]) || [],
    provisioningPhase: raw.provisioningPhase || 'DRAFT',
    provisioningProgress: raw.provisioningProgress ?? 0,
    decommissionPhase: raw.decommissionPhase ?? 'IDLE',
    decommissionExecutionArn: raw.decommissionExecutionArn ?? null,
    decommissionTargetAccountId: raw.decommissionTargetAccountId ?? null,
    decommissionError: raw.decommissionError ?? null,
  };
}

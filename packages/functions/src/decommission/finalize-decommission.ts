/**
 * Mark account CLOSED in DynamoDB and clear decommission tracking fields.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requiredEnv } from '../runtime-env';
import { isStandaloneOrgDecommission } from './standalone-org-constants';

const TABLE_NAME = requiredEnv('TABLE_NAME');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

interface AccountRow {
  name: string;
  email: string;
  accountId: string | null;
  roleArn: string | null;
  awsSignInUrl?: string | null;
  closureState?: string | null;
  closedAt?: string | null;
}

interface FinalizeInput {
  projectId: string;
  targetAccountId: string;
}

interface FinalizeOutput {
  projectId: string;
  targetAccountId: string;
}

export const handler = async (event: FinalizeInput): Promise<FinalizeOutput> => {
  const { projectId, targetAccountId } = event;
  const now = new Date().toISOString();

  if (isStandaloneOrgDecommission(projectId)) {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `ORG_ACCOUNT#${targetAccountId}`, SK: 'METADATA' },
        UpdateExpression:
          'SET #cs = :closed, #cat = :now, #dPhase = :idle, #updatedAt = :updatedAt REMOVE #dExec, #dTarget, #dErr',
        ExpressionAttributeNames: {
          '#cs': 'closureState',
          '#cat': 'closedAt',
          '#dPhase': 'decommissionPhase',
          '#dExec': 'decommissionExecutionArn',
          '#dTarget': 'decommissionTargetAccountId',
          '#dErr': 'decommissionError',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':closed': 'CLOSED',
          ':now': now,
          ':idle': 'IDLE',
          ':updatedAt': now,
        },
      })
    );
    console.log(`Finalized standalone org decommission for account ${targetAccountId}`);
    return { projectId, targetAccountId };
  }

  const got = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PROJECT#${projectId}`, SK: 'METADATA' },
    })
  );
  const item = got.Item;
  if (!item) throw new Error(`Project not found: ${projectId}`);

  const accounts = (item.accounts as AccountRow[] | undefined) ?? [];
  const patched = accounts.map((a) =>
    a.accountId === targetAccountId
      ? {
          ...a,
          closureState: 'CLOSED',
          closedAt: now,
          roleArn: null,
          awsSignInUrl: a.awsSignInUrl ?? null,
        }
      : {
          ...a,
          closureState: a.closureState ?? 'NONE',
          closedAt: a.closedAt ?? null,
          awsSignInUrl: a.awsSignInUrl ?? null,
        }
  );

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PROJECT#${projectId}`, SK: 'METADATA' },
      UpdateExpression:
        'SET #accounts = :accounts, #dPhase = :idle, #dExec = :nul, #dTarget = :nul, #dErr = :nul, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#accounts': 'accounts',
        '#dPhase': 'decommissionPhase',
        '#dExec': 'decommissionExecutionArn',
        '#dTarget': 'decommissionTargetAccountId',
        '#dErr': 'decommissionError',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':accounts': patched.map((a) => ({
          name: a.name,
          email: a.email,
          accountId: a.accountId,
          roleArn: a.roleArn,
          awsSignInUrl: a.awsSignInUrl ?? null,
          closureState: a.closureState ?? 'NONE',
          closedAt: a.closedAt ?? null,
        })),
        ':idle': 'IDLE',
        ':nul': null,
        ':updatedAt': now,
      },
    })
  );

  console.log(`Finalized decommission for project ${projectId} account ${targetAccountId}`);
  return { projectId, targetAccountId };
};

/**
 * Step Functions task: write decommission phase / error to DynamoDB for UI polling.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requiredEnv } from '../runtime-env';
import { isStandaloneOrgDecommission } from './standalone-org-constants';

const TABLE_NAME = requiredEnv('TABLE_NAME');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

export type DecommissionPhase =
  | 'DISPATCH_DESTROY'
  | 'TEARDOWN_BOOTSTRAP'
  | 'UNASSIGN_IDENTITY_CENTER'
  | 'CLOSE_ACCOUNT'
  | 'FAILED';

interface AccountRow {
  name: string;
  email: string;
  accountId: string | null;
  roleArn: string | null;
  awsSignInUrl?: string | null;
  closureState?: string | null;
  closedAt?: string | null;
}

interface UpdateDecommissionStatusInput {
  projectId: string;
  targetAccountId: string;
  phase: DecommissionPhase;
  /** When phase is FAILED, reset matching account row from CLOSING */
  accountsSnapshot?: AccountRow[];
  sfnError?: { Error: string; Cause: string };
}

function withAccountResetOnFailure(
  accounts: AccountRow[] | undefined,
  targetAccountId: string
): AccountRow[] | undefined {
  if (!accounts?.length) return accounts;
  return accounts.map((a) =>
    a.accountId === targetAccountId
      ? {
          ...a,
          closureState: 'NONE',
        }
      : a
  );
}

export const handler = async (event: UpdateDecommissionStatusInput): Promise<void> => {
  const { projectId, phase, targetAccountId, accountsSnapshot, sfnError } = event;
  const now = new Date().toISOString();
  const standalone = isStandaloneOrgDecommission(projectId);

  const expressionNames: Record<string, string> = {
    '#dPhase': 'decommissionPhase',
    '#updatedAt': 'updatedAt',
  };
  const expressionValues: Record<string, unknown> = {
    ':phase': phase,
    ':updatedAt': now,
  };
  const removes: string[] = [];
  const parts = ['#dPhase = :phase', '#updatedAt = :updatedAt'];

  if (phase === 'FAILED') {
    removes.push('#dExec', '#dTarget');
    expressionNames['#dExec'] = 'decommissionExecutionArn';
    expressionNames['#dTarget'] = 'decommissionTargetAccountId';
  }

  if (sfnError) {
    parts.push('#dErr = :dErr');
    expressionNames['#dErr'] = 'decommissionError';
    expressionValues[':dErr'] = `${sfnError.Error}: ${sfnError.Cause}`;
  } else if (phase !== 'FAILED') {
    parts.push('#dErr = :dErr');
    expressionNames['#dErr'] = 'decommissionError';
    expressionValues[':dErr'] = null;
  }

  if (standalone && phase === 'FAILED') {
    expressionNames['#cs'] = 'closureState';
    expressionValues[':none'] = 'NONE';
    parts.push('#cs = :none');
  }

  if (!standalone && phase === 'FAILED' && accountsSnapshot) {
    const patched =
      withAccountResetOnFailure(accountsSnapshot, targetAccountId) ?? accountsSnapshot;
    parts.push('#accounts = :accounts');
    expressionNames['#accounts'] = 'accounts';
    expressionValues[':accounts'] = patched.map((a) => ({
      name: a.name,
      email: a.email,
      accountId: a.accountId,
      roleArn: a.roleArn,
      awsSignInUrl: a.awsSignInUrl ?? null,
      closureState: a.closureState ?? 'NONE',
      closedAt: a.closedAt ?? null,
    }));
  }

  const updateExpr =
    removes.length > 0
      ? `SET ${parts.join(', ')} REMOVE ${removes.join(', ')}`
      : `SET ${parts.join(', ')}`;

  const key = standalone
    ? { PK: `ORG_ACCOUNT#${targetAccountId}`, SK: 'METADATA' }
    : { PK: `PROJECT#${projectId}`, SK: 'METADATA' };

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: key,
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
    })
  );

  console.log(
    standalone
      ? `ORG_ACCOUNT ${targetAccountId} decommission → ${phase}`
      : `Project ${projectId} decommission → ${phase}`
  );
};

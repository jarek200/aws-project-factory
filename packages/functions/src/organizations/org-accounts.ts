/**
 * AppSync: org inventory list/sync, getOrganizationAccount, closeStandaloneOrganizationAccount.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DescribeAccountCommand,
  DescribeOrganizationCommand,
  ListAccountsCommand,
  OrganizationsClient,
} from '@aws-sdk/client-organizations';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AppSyncResolverHandler } from 'aws-lambda';

import { STANDALONE_ORG_DECOMMISSION_PROJECT_ID } from '../decommission/standalone-org-constants';
import { envKeyFromAccountName } from '../provisioning/account-env-key';
import { requiredEnv } from '../runtime-env';
import { orgAccountLifecycleStateOrEmpty } from './org-account-lifecycle';

const TABLE_NAME = requiredEnv('TABLE_NAME');

const ORG_ACCOUNTS_GSI_PK = 'ORG_ACCOUNTS';

const dynamoDb = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoDb);
const orgClient = new OrganizationsClient({ region: 'us-east-1' });
const sfnClient = new SFNClient({});

export type OrganizationAccountRow = {
  accountId: string;
  name: string | null;
  email: string | null;
  arn: string | null;
  /** Matches org `MasterAccountId` from DescribeOrganization (set when returning to AppSync). */
  isManagementAccount: boolean;
  /** AWS Organizations lifecycle State (persisted as Dynamo `state`; legacy `status` read for old rows). */
  state: string | null;
  joinedMethod: string | null;
  joinedTimestamp: string | null;
  syncedAt: string;
  closureState: string;
  closedAt: string | null;
  decommissionPhase: string | null;
  decommissionError: string | null;
};

function normalizeAccountId12(id: string | null | undefined): string {
  return (id ?? '').trim().replace(/\s+/g, '');
}

async function fetchManagementAccountId(): Promise<string | null> {
  try {
    const res = await orgClient.send(new DescribeOrganizationCommand({}));
    const id = normalizeAccountId12(res.Organization?.MasterAccountId);
    return /^\d{12}$/.test(id) ? id : null;
  } catch (e) {
    console.warn('DescribeOrganization failed (isManagementAccount will be false)', e);
    return null;
  }
}

function withManagementFlag(
  row: OrganizationAccountRow,
  managementAccountId: string | null | undefined
): OrganizationAccountRow {
  const master = normalizeAccountId12(managementAccountId);
  const rid = normalizeAccountId12(row.accountId);
  return {
    ...row,
    isManagementAccount: Boolean(/^\d{12}$/.test(master) && /^\d{12}$/.test(rid) && rid === master),
  };
}

/**
 * AWS returns `JoinedTimestamp` as a Date; Dynamo may store string or number (epoch).
 * Normalize to ISO-8601 UTC for GraphQL and consistent UI formatting.
 */
function normalizeJoinedTimestampToIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    const fromIso = new Date(s);
    if (!Number.isNaN(fromIso.getTime())) return fromIso.toISOString();
    if (/^\d{10,13}$/.test(s)) {
      const n = Number(s);
      const ms = s.length >= 13 ? n : n * 1000;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
  }
  return null;
}

function gsiSortKey(accountName: string | undefined | null, accountId: string): string {
  const base = (accountName ?? '').trim().toLowerCase() || '—';
  return `${base}#${accountId}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function persistOrgExecutionArn(orgPk: string, executionArn: string): Promise<void> {
  const max = 6;
  for (let i = 0; i < max; i++) {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: orgPk, SK: 'METADATA' },
          UpdateExpression: 'SET decommissionExecutionArn = :arn, updatedAt = :u',
          ExpressionAttributeValues: {
            ':arn': executionArn,
            ':u': new Date().toISOString(),
          },
        })
      );
      return;
    } catch (e) {
      console.warn(`persistOrgExecutionArn attempt ${i + 1}/${max} failed`, e);
      if (i === max - 1) {
        console.error(
          'Could not persist decommissionExecutionArn on org row; Step Functions execution has already started',
          e
        );
        return;
      }
      await sleep(250 * 2 ** i);
    }
  }
}

function mapOrgItemToRow(item: Record<string, unknown> | undefined): OrganizationAccountRow | null {
  if (!item?.accountId) return null;
  return {
    accountId: String(item.accountId),
    name: (item.accountName as string | undefined) ?? null,
    email: (item.email as string | undefined) ?? null,
    arn: (item.arn as string | undefined) ?? null,
    isManagementAccount: false,
    state: (item.state as string | undefined) ?? (item.status as string | undefined) ?? null,
    joinedMethod: (item.joinedMethod as string | undefined) ?? null,
    joinedTimestamp: normalizeJoinedTimestampToIso(item.joinedTimestamp),
    syncedAt: String(item.syncedAt ?? ''),
    closureState: (item.closureState as string | undefined) ?? 'NONE',
    closedAt: (item.closedAt as string | undefined) ?? null,
    decommissionPhase: (item.decommissionPhase as string | undefined) ?? null,
    decommissionError: (item.decommissionError as string | undefined) ?? null,
  };
}

async function listAllFromDynamo(): Promise<OrganizationAccountRow[]> {
  const out: OrganizationAccountRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': ORG_ACCOUNTS_GSI_PK },
        ExclusiveStartKey: startKey,
      })
    );
    for (const item of res.Items ?? []) {
      const row = mapOrgItemToRow(item as Record<string, unknown>);
      if (row) out.push(row);
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return out;
}

async function getOrgAccountRow(accountId: string): Promise<OrganizationAccountRow | null> {
  const trimmed = accountId.trim();
  if (!trimmed) return null;
  const got = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG_ACCOUNT#${trimmed}`, SK: 'METADATA' },
    })
  );
  return mapOrgItemToRow(got.Item as Record<string, unknown> | undefined);
}

async function listAllOrgAccountIds(): Promise<
  Map<
    string,
    {
      name: string;
      email: string;
      arn: string;
      state: string;
      joinedMethod: string;
      joinedTimestamp: string | null;
    }
  >
> {
  const map = new Map<
    string,
    {
      name: string;
      email: string;
      arn: string;
      state: string;
      joinedMethod: string;
      joinedTimestamp: string | null;
    }
  >();
  let nextToken: string | undefined;
  do {
    const res = await orgClient.send(new ListAccountsCommand({ NextToken: nextToken }));
    for (const a of res.Accounts ?? []) {
      const id = a.Id;
      if (!id) continue;
      const lifecycle = orgAccountLifecycleStateOrEmpty(a);
      const joinedIso = normalizeJoinedTimestampToIso(a.JoinedTimestamp ?? null);
      map.set(id, {
        name: a.Name ?? '',
        email: a.Email ?? '',
        arn: a.Arn ?? '',
        state: lifecycle,
        joinedMethod: a.JoinedMethod ?? '',
        joinedTimestamp: joinedIso,
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return map;
}

async function queryAllInventoryRows(): Promise<
  Array<{ PK: string; SK: string; accountId: string }>
> {
  const keys: Array<{ PK: string; SK: string; accountId: string }> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': ORG_ACCOUNTS_GSI_PK },
        ExclusiveStartKey: startKey,
      })
    );
    for (const item of res.Items ?? []) {
      const pk = item.PK as string | undefined;
      const sk = item.SK as string | undefined;
      const accountId = item.accountId as string | undefined;
      if (pk && sk === 'METADATA' && accountId) {
        keys.push({ PK: pk, SK: sk, accountId });
      }
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return keys;
}

async function batchGetOrgItems(
  accountIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  const chunk = 100;
  for (let i = 0; i < accountIds.length; i += chunk) {
    const idSlice = accountIds.slice(i, i + chunk);
    const res = await docClient.send(
      new BatchGetCommand({
        RequestItems: {
          [TABLE_NAME]: {
            Keys: idSlice.map((id) => ({ PK: `ORG_ACCOUNT#${id}`, SK: 'METADATA' })),
          },
        },
      })
    );
    for (const item of res.Responses?.[TABLE_NAME] ?? []) {
      const id = item.accountId as string | undefined;
      if (id) map.set(id, item as Record<string, unknown>);
    }
  }
  return map;
}

type OrgBatchRequest =
  | { PutRequest: { Item: Record<string, unknown> } }
  | { DeleteRequest: { Key: { PK: string; SK: string } } };

async function batchWriteAll(requests: OrgBatchRequest[]) {
  const chunk = 25;
  for (let i = 0; i < requests.length; i += chunk) {
    const slice = requests.slice(i, i + chunk);
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: slice,
        },
      })
    );
  }
}

function buildInventoryPutItem(
  accountId: string,
  meta: {
    name: string;
    email: string;
    arn: string;
    state: string;
    joinedMethod: string;
    joinedTimestamp: string | null;
  },
  now: string,
  prev?: Record<string, unknown>
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    PK: `ORG_ACCOUNT#${accountId}`,
    SK: 'METADATA',
    GSI1PK: ORG_ACCOUNTS_GSI_PK,
    GSI1SK: gsiSortKey(meta.name, accountId),
    accountId,
    accountName: meta.name,
    email: meta.email,
    arn: meta.arn,
    state: meta.state,
    joinedMethod: meta.joinedMethod,
    joinedTimestamp: meta.joinedTimestamp,
    syncedAt: now,
  };

  const cs = prev?.closureState as string | undefined;
  if (cs === 'CLOSING') {
    item.closureState = 'CLOSING';
    if (prev?.closedAt) item.closedAt = prev.closedAt;
    for (const k of [
      'decommissionPhase',
      'decommissionExecutionArn',
      'decommissionTargetAccountId',
      'decommissionError',
      'updatedAt',
    ] as const) {
      if (prev?.[k] != null) item[k] = prev[k];
    }
  } else if (cs === 'CLOSED') {
    item.closureState = 'CLOSED';
    if (prev?.closedAt) item.closedAt = prev.closedAt;
  }

  return item;
}

async function syncFromAws(): Promise<{ upserted: number; removed: number }> {
  const awsMap = await listAllOrgAccountIds();
  const now = new Date().toISOString();
  const accountIds = [...awsMap.keys()];
  const prevMap = await batchGetOrgItems(accountIds);
  const puts: OrgBatchRequest[] = [];

  for (const [accountId, meta] of awsMap) {
    const prev = prevMap.get(accountId);
    puts.push({
      PutRequest: {
        Item: buildInventoryPutItem(accountId, meta, now, prev),
      },
    });
  }

  await batchWriteAll(puts);

  const existing = await queryAllInventoryRows();
  const awsIds = new Set(awsMap.keys());
  const deletes: OrgBatchRequest[] = [];
  for (const row of existing) {
    // Drop inventory rows (including CLOSED/CLOSING) once AWS Organizations no longer lists them.
    if (awsIds.has(row.accountId)) continue;
    deletes.push({ DeleteRequest: { Key: { PK: row.PK, SK: row.SK } } });
  }

  await batchWriteAll(deletes);

  return { upserted: puts.length, removed: deletes.length };
}

function joinedTimestampFromDescribeAccount(acc: { JoinedTimestamp?: unknown }): string | null {
  return normalizeJoinedTimestampToIso(acc.JoinedTimestamp ?? null);
}

async function closeStandaloneOrganizationAccount(
  accountId: string
): Promise<OrganizationAccountRow> {
  const machineArn = requiredEnv('DECOMMISSION_STATE_MACHINE_ARN');
  const trimmed = accountId.trim();
  if (!/^\d{12}$/.test(trimmed)) {
    throw new Error('accountId must be a 12-digit AWS account ID');
  }

  const desc = await orgClient.send(new DescribeAccountCommand({ AccountId: trimmed }));
  const acc = desc.Account;
  if (!acc?.Id) throw new Error('Account not found in this organization');

  const accountName = acc.Name?.trim() || `account-${trimmed}`;
  const accountEmail = acc.Email?.trim() || 'noreply@amazonaws.com';
  const orgPk = `ORG_ACCOUNT#${trimmed}`;

  const got = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: orgPk, SK: 'METADATA' } })
  );
  const prev = got.Item as Record<string, unknown> | undefined;
  const cstate = (prev?.closureState as string | undefined) ?? 'NONE';
  if (cstate === 'CLOSED') throw new Error('Account is already closed in inventory');
  if (cstate === 'CLOSING') throw new Error('Account closure already in progress');
  const dphase = prev?.decommissionPhase as string | undefined;
  if (dphase && dphase !== 'IDLE' && dphase !== 'FAILED') {
    throw new Error('Another decommission is already in progress for this account');
  }

  const now = new Date().toISOString();
  const envKey = envKeyFromAccountName(accountName);

  async function revertClosingState(message: string) {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: orgPk, SK: 'METADATA' },
        UpdateExpression:
          'SET #cs = :none, #dPhase = :failed, #dErr = :err, #updatedAt = :u REMOVE #dExec, #dTarget',
        ExpressionAttributeNames: {
          '#cs': 'closureState',
          '#dPhase': 'decommissionPhase',
          '#dErr': 'decommissionError',
          '#dExec': 'decommissionExecutionArn',
          '#dTarget': 'decommissionTargetAccountId',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':none': 'NONE',
          ':failed': 'FAILED',
          ':err': message,
          ':u': new Date().toISOString(),
        },
      })
    );
  }

  if (!prev) {
    try {
      await docClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: orgPk,
            SK: 'METADATA',
            GSI1PK: ORG_ACCOUNTS_GSI_PK,
            GSI1SK: gsiSortKey(accountName, trimmed),
            accountId: trimmed,
            accountName,
            email: accountEmail,
            arn: acc.Arn ?? '',
            state: orgAccountLifecycleStateOrEmpty(acc),
            joinedMethod: acc.JoinedMethod ?? '',
            joinedTimestamp: joinedTimestampFromDescribeAccount(acc),
            syncedAt: now,
            closureState: 'CLOSING',
            decommissionPhase: 'DISPATCH_DESTROY',
            decommissionTargetAccountId: trimmed,
            updatedAt: now,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        })
      );
    } catch (e) {
      const err = e as { name?: string };
      if (err.name !== 'ConditionalCheckFailedException') throw e;
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: orgPk, SK: 'METADATA' },
          ConditionExpression:
            '(attribute_not_exists(#cs) OR #cs = :none) AND (attribute_not_exists(#dPhase) OR #dPhase = :idle OR #dPhase = :failed)',
          UpdateExpression:
            'SET #cs = :closing, #dPhase = :dispatch, #dTarget = :tid, #dErr = :nul, #updatedAt = :u REMOVE #dExec',
          ExpressionAttributeNames: {
            '#cs': 'closureState',
            '#dPhase': 'decommissionPhase',
            '#dTarget': 'decommissionTargetAccountId',
            '#dErr': 'decommissionError',
            '#dExec': 'decommissionExecutionArn',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':none': 'NONE',
            ':idle': 'IDLE',
            ':failed': 'FAILED',
            ':closing': 'CLOSING',
            ':dispatch': 'DISPATCH_DESTROY',
            ':tid': trimmed,
            ':nul': null,
            ':u': now,
          },
        })
      );
    }
  } else {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: orgPk, SK: 'METADATA' },
        ConditionExpression:
          '(attribute_not_exists(#cs) OR #cs = :none) AND (attribute_not_exists(#dPhase) OR #dPhase = :idle OR #dPhase = :failed)',
        UpdateExpression:
          'SET #cs = :closing, #dPhase = :dispatch, #dTarget = :tid, #dErr = :nul, #updatedAt = :u REMOVE #dExec',
        ExpressionAttributeNames: {
          '#cs': 'closureState',
          '#dPhase': 'decommissionPhase',
          '#dTarget': 'decommissionTargetAccountId',
          '#dErr': 'decommissionError',
          '#dExec': 'decommissionExecutionArn',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':none': 'NONE',
          ':idle': 'IDLE',
          ':failed': 'FAILED',
          ':closing': 'CLOSING',
          ':dispatch': 'DISPATCH_DESTROY',
          ':tid': trimmed,
          ':nul': null,
          ':u': now,
        },
      })
    );
  }

  const sfnInput = {
    projectId: STANDALONE_ORG_DECOMMISSION_PROJECT_ID,
    slug: '',
    githubOrg: '',
    repoFullName: '',
    hasGithubRepo: false,
    runMonorepoTeardown: false,
    accountName,
    accountEmail,
    accountId: trimmed,
    envKey,
    accountsSnapshot: [],
  };

  const execName = `decom-standalone-${trimmed}-${Date.now()}`;

  let executionArn: string;
  try {
    const execution = await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn: machineArn,
        name: execName.slice(0, 80),
        input: JSON.stringify(sfnInput),
      })
    );
    executionArn = execution.executionArn ?? '';
    if (!executionArn) throw new Error('StartExecution returned no executionArn');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await revertClosingState(`StartExecution failed: ${msg}`);
    throw err;
  }

  await persistOrgExecutionArn(orgPk, executionArn);

  const maxGet = 5;
  let out: OrganizationAccountRow | null = null;
  for (let g = 0; g < maxGet; g++) {
    try {
      out = await getOrgAccountRow(trimmed);
      if (out) break;
    } catch (e) {
      console.warn(`getOrgAccountRow after close start attempt ${g + 1}/${maxGet}`, e);
    }
    await sleep(200 * (g + 1));
  }
  const masterId = await fetchManagementAccountId();
  if (out) return withManagementFlag(out, masterId);

  console.error(
    'Organization account row unreadable after close start; returning synthetic row (SFN already running)'
  );
  return withManagementFlag(
    {
      accountId: trimmed,
      name: accountName,
      email: accountEmail,
      arn: acc.Arn ?? null,
      isManagementAccount: false,
      state: orgAccountLifecycleStateOrEmpty(acc),
      joinedMethod: acc.JoinedMethod ?? null,
      joinedTimestamp: joinedTimestampFromDescribeAccount(acc),
      syncedAt: now,
      closureState: 'CLOSING',
      closedAt: null,
      decommissionPhase: 'DISPATCH_DESTROY',
      decommissionError: null,
    },
    masterId
  );
}

export const handler: AppSyncResolverHandler<unknown, unknown> = async (event) => {
  const field = event.info?.fieldName;
  if (field === 'listOrganizationAccounts') {
    const [rows, masterId] = await Promise.all([listAllFromDynamo(), fetchManagementAccountId()]);
    return rows.map((r) => withManagementFlag(r, masterId));
  }
  if (field === 'syncOrganizationAccounts') {
    return syncFromAws();
  }
  if (field === 'getOrganizationAccount') {
    const id = (event.arguments as { accountId?: string }).accountId?.trim();
    if (!id) return null;
    const row = await getOrgAccountRow(id);
    if (!row) return null;
    return withManagementFlag(row, await fetchManagementAccountId());
  }
  if (field === 'closeStandaloneOrganizationAccount') {
    const id = (event.arguments as { accountId?: string }).accountId;
    if (!id?.trim()) throw new Error('accountId is required');
    return closeStandaloneOrganizationAccount(id);
  }
  throw new Error(`org-accounts: unsupported field ${field}`);
};

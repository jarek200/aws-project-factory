/**
 * Remove IAM Identity Center assignment (mirror of provisioning assign-identity-center).
 */

import { GetGroupIdCommand, IdentitystoreClient } from '@aws-sdk/client-identitystore';
import type { DeleteAccountAssignmentCommandOutput } from '@aws-sdk/client-sso-admin';
import {
  DeleteAccountAssignmentCommand,
  DescribeAccountAssignmentDeletionStatusCommand,
  DescribePermissionSetCommand,
  ListAccountAssignmentsCommand,
  ListInstancesCommand,
  ListPermissionSetsCommand,
  SSOAdminClient,
} from '@aws-sdk/client-sso-admin';

interface UnassignInput {
  accountId: string;
  accountName: string;
}

interface UnassignOutput {
  accountId: string;
  accountName: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function icRegion(): string {
  return (
    process.env.IDENTITY_CENTER_REGION?.trim() || process.env.AWS_REGION?.trim() || 'us-east-1'
  );
}

function shouldSkip(): boolean {
  if (process.env.IDENTITY_CENTER_SKIP_ASSIGNMENT?.trim() === 'true') return true;
  const gid = process.env.IDENTITY_CENTER_GROUP_ID?.trim();
  const gname = process.env.IDENTITY_CENTER_GROUP_DISPLAY_NAME?.trim();
  return !gid && !gname;
}

async function resolvePermissionSetArn(
  client: SSOAdminClient,
  instanceArn: string,
  permissionSetName: string
): Promise<string> {
  let nextToken: string | undefined;
  for (;;) {
    const list = await client.send(
      new ListPermissionSetsCommand({
        InstanceArn: instanceArn,
        NextToken: nextToken,
      })
    );
    for (const psArn of list.PermissionSets ?? []) {
      const desc = await client.send(
        new DescribePermissionSetCommand({
          InstanceArn: instanceArn,
          PermissionSetArn: psArn,
        })
      );
      if (desc.PermissionSet?.Name === permissionSetName) return psArn;
    }
    nextToken = list.NextToken;
    if (!nextToken) break;
  }
  throw new Error(
    `Permission set "${permissionSetName}" not found in IAM Identity Center for this organization`
  );
}

async function resolveGroupId(
  idStore: IdentitystoreClient,
  identityStoreId: string,
  displayName: string
): Promise<string> {
  const out = await idStore.send(
    new GetGroupIdCommand({
      IdentityStoreId: identityStoreId,
      AlternateIdentifier: {
        UniqueAttribute: {
          AttributePath: 'displayName',
          AttributeValue: displayName,
        },
      },
    })
  );
  const id = out.GroupId;
  if (!id) throw new Error(`Identity Center group not found: displayName=${displayName}`);
  return id;
}

async function assignmentExists(
  client: SSOAdminClient,
  instanceArn: string,
  accountId: string,
  permissionSetArn: string,
  groupId: string
): Promise<boolean> {
  let nextToken: string | undefined;
  for (;;) {
    const out = await client.send(
      new ListAccountAssignmentsCommand({
        InstanceArn: instanceArn,
        AccountId: accountId,
        PermissionSetArn: permissionSetArn,
        NextToken: nextToken,
      })
    );
    for (const a of out.AccountAssignments ?? []) {
      if (a.PrincipalType === 'GROUP' && a.PrincipalId === groupId) return true;
    }
    nextToken = out.NextToken;
    if (!nextToken) break;
  }
  return false;
}

function isSsoConflictException(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; message?: string };
  const msg = e.message ?? '';
  return (
    e.name === 'ConflictException' ||
    e.Code === 'ConflictException' ||
    msg.includes('conflicting operation') ||
    msg.includes('ConflictException')
  );
}

async function waitDeletion(
  client: SSOAdminClient,
  instanceArn: string,
  requestId: string
): Promise<void> {
  const maxAttempts = 60;
  const delayMs = 5000;
  for (let i = 0; i < maxAttempts; i++) {
    const out = await client.send(
      new DescribeAccountAssignmentDeletionStatusCommand({
        InstanceArn: instanceArn,
        AccountAssignmentDeletionRequestId: requestId,
      })
    );
    const st = out.AccountAssignmentDeletionStatus;
    const status = st?.Status;
    if (status === 'SUCCEEDED') {
      console.log(`Identity Center unassignment done (${requestId})`);
      return;
    }
    if (status === 'FAILED') {
      throw new Error(`DeleteAccountAssignment failed: ${st?.FailureReason ?? 'unknown'}`);
    }
    await sleep(delayMs);
  }
  throw new Error('Timed out waiting for Identity Center assignment deletion');
}

export const handler = async (event: UnassignInput): Promise<UnassignOutput> => {
  const { accountId, accountName } = event;
  if (shouldSkip()) {
    console.log('Skipping Identity Center unassignment (not configured)');
    return { accountId, accountName };
  }

  const permissionSetName =
    process.env.IDENTITY_CENTER_PERMISSION_SET_NAME?.trim() || 'AdministratorAccess';
  const groupIdConfigured = process.env.IDENTITY_CENTER_GROUP_ID?.trim();
  const groupDisplayName = process.env.IDENTITY_CENTER_GROUP_DISPLAY_NAME?.trim();

  const region = icRegion();
  const ssoAdmin = new SSOAdminClient({ region });

  const instances = await ssoAdmin.send(new ListInstancesCommand({}));
  const instanceArn = instances.Instances?.[0]?.InstanceArn;
  const identityStoreId = instances.Instances?.[0]?.IdentityStoreId;
  if (!instanceArn || !identityStoreId) {
    throw new Error('No IAM Identity Center instance found');
  }

  const idStore = new IdentitystoreClient({ region });
  let groupId: string;
  if (groupIdConfigured) {
    groupId = groupIdConfigured;
  } else if (groupDisplayName) {
    groupId = await resolveGroupId(idStore, identityStoreId, groupDisplayName);
  } else {
    throw new Error('IDENTITY_CENTER_GROUP_ID or IDENTITY_CENTER_GROUP_DISPLAY_NAME required');
  }

  const permissionSetArn = await resolvePermissionSetArn(ssoAdmin, instanceArn, permissionSetName);

  if (!(await assignmentExists(ssoAdmin, instanceArn, accountId, permissionSetArn, groupId))) {
    console.log(`No Identity Center assignment for account ${accountId}; skipping delete`);
    return { accountId, accountName };
  }

  const deleteInput = {
    InstanceArn: instanceArn,
    TargetId: accountId,
    TargetType: 'AWS_ACCOUNT' as const,
    PermissionSetArn: permissionSetArn,
    PrincipalType: 'GROUP' as const,
    PrincipalId: groupId,
  };

  const maxAttempts = 8;
  let del: DeleteAccountAssignmentCommandOutput | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      del = await ssoAdmin.send(new DeleteAccountAssignmentCommand(deleteInput));
      break;
    } catch (err: unknown) {
      if (!isSsoConflictException(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      const base = 8000 * (attempt + 1);
      const jitter = Math.floor(Math.random() * 4000);
      console.warn(
        `DeleteAccountAssignment ConflictException for ${accountId}; retry ${attempt + 1}/${maxAttempts} in ${base + jitter}ms`
      );
      await sleep(base + jitter);
      if (!(await assignmentExists(ssoAdmin, instanceArn, accountId, permissionSetArn, groupId))) {
        console.log(
          `Identity Center assignment already removed for ${accountId} after conflict; continuing`
        );
        return { accountId, accountName };
      }
    }
  }
  if (!del) {
    throw new Error('DeleteAccountAssignment returned no result after retries');
  }

  const requestId = del.AccountAssignmentDeletionStatus?.RequestId;
  const immediate = del.AccountAssignmentDeletionStatus?.Status;
  if (immediate === 'SUCCEEDED') {
    return { accountId, accountName };
  }
  if (immediate === 'FAILED') {
    throw new Error(
      del.AccountAssignmentDeletionStatus?.FailureReason ?? 'DeleteAccountAssignment failed'
    );
  }
  if (!requestId) {
    throw new Error('DeleteAccountAssignment returned no RequestId');
  }

  await waitDeletion(ssoAdmin, instanceArn, requestId);
  return { accountId, accountName };
};

/**
 * Lambda Handler: Assign IAM Identity Center access (Step Functions task)
 *
 * After a member account exists, grants an Identity Center group a permission set
 * on that account so users in the group see it in the SSO access portal.
 *
 * Configure via env (see provisioning infra). If no group is configured or
 * IDENTITY_CENTER_SKIP_ASSIGNMENT=true, succeeds without calling AWS (no-op).
 */

import { GetGroupIdCommand, IdentitystoreClient } from '@aws-sdk/client-identitystore';
import {
  CreateAccountAssignmentCommand,
  DescribeAccountAssignmentCreationStatusCommand,
  DescribePermissionSetCommand,
  ListAccountAssignmentsCommand,
  ListInstancesCommand,
  ListPermissionSetsCommand,
  SSOAdminClient,
} from '@aws-sdk/client-sso-admin';

interface AssignIdentityCenterInput {
  name: string;
  email: string;
  accountId: string;
  roleArn: string;
  envKey: string;
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

async function assignmentAlreadyExists(
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

async function waitForAssignmentCreation(
  client: SSOAdminClient,
  instanceArn: string,
  requestId: string
): Promise<void> {
  const maxAttempts = 120;
  const delayMs = 5000;
  for (let i = 0; i < maxAttempts; i++) {
    const out = await client.send(
      new DescribeAccountAssignmentCreationStatusCommand({
        InstanceArn: instanceArn,
        AccountAssignmentCreationRequestId: requestId,
      })
    );
    const st = out.AccountAssignmentCreationStatus;
    const status = st?.Status;
    if (status === 'SUCCEEDED') {
      console.log(`Identity Center assignment provisioned (request ${requestId})`);
      return;
    }
    if (status === 'FAILED') {
      throw new Error(`CreateAccountAssignment failed: ${st?.FailureReason ?? 'unknown reason'}`);
    }
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for Identity Center assignment (request ${requestId})`);
}

export const handler = async (
  event: AssignIdentityCenterInput
): Promise<AssignIdentityCenterInput> => {
  const { accountId, name } = event;
  if (shouldSkip()) {
    console.log(
      'Skipping IAM Identity Center assignment (IDENTITY_CENTER_SKIP_ASSIGNMENT or no group configured)'
    );
    return event;
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
    throw new Error(
      'No IAM Identity Center instance found — enable Identity Center in this organization first'
    );
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

  if (await assignmentAlreadyExists(ssoAdmin, instanceArn, accountId, permissionSetArn, groupId)) {
    console.log(
      `Identity Center assignment already exists for account ${accountId} (${name}), group ${groupId}`
    );
    return event;
  }

  console.log(
    `Creating Identity Center assignment: account=${accountId} (${name}), group=${groupId}, permissionSet=${permissionSetName}`
  );

  let requestId: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const created = await ssoAdmin.send(
        new CreateAccountAssignmentCommand({
          InstanceArn: instanceArn,
          TargetId: accountId,
          TargetType: 'AWS_ACCOUNT',
          PermissionSetArn: permissionSetArn,
          PrincipalType: 'GROUP',
          PrincipalId: groupId,
        })
      );
      const st = created.AccountAssignmentCreationStatus;
      requestId = st?.RequestId;
      if (st?.Status === 'SUCCEEDED') {
        console.log(`Identity Center assignment completed immediately for ${accountId}`);
        return event;
      }
      if (st?.Status === 'FAILED') {
        throw new Error(st.FailureReason ?? 'CreateAccountAssignment failed');
      }
      break;
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      const conflict =
        e.name === 'ConflictException' ||
        e.message?.includes('Conflict') ||
        e.message?.includes('duplicate');
      if (conflict) {
        if (
          await assignmentAlreadyExists(ssoAdmin, instanceArn, accountId, permissionSetArn, groupId)
        ) {
          console.log(`Assignment already present (after conflict) for ${accountId}`);
          return event;
        }
        if (attempt < 4) {
          console.warn(
            `CreateAccountAssignment conflict for ${accountId}; retrying after backoff (attempt ${attempt + 1})`
          );
          await sleep(15_000);
          continue;
        }
      }
      throw err;
    }
  }

  if (!requestId) {
    throw new Error('CreateAccountAssignment returned no RequestId for status polling');
  }

  await waitForAssignmentCreation(ssoAdmin, instanceArn, requestId);
  return event;
};

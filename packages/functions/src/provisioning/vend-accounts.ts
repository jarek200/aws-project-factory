/**
 * Lambda Handler: Vend AWS Account (Step Functions task)
 *
 * Called once per account in the Map state. Submits an account-creation
 * request to AWS Organizations and polls until the account is ACTIVE.
 * Idempotent: if the account was already created for this project+name,
 * returns the existing account ID without creating a duplicate.
 *
 * Cross-project CreateAccount calls are serialized via a DynamoDB lock
 * (Organizations rejects concurrent mutations).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  CreateAccountCommand,
  type CreateAccountCommandInput,
  type CreateAccountCommandOutput,
  DescribeCreateAccountStatusCommand,
  ListAccountsCommand,
  OrganizationsClient,
} from '@aws-sdk/client-organizations';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { orgAccountLifecycleState } from '../organizations/org-account-lifecycle';
import { requiredEnv } from '../runtime-env';
import {
  acquireOrgCreateAccountLock,
  releaseOrgCreateAccountLock,
} from './org-create-account-lock';

const TABLE_NAME = requiredEnv('TABLE_NAME');

const orgClient = new OrganizationsClient({ region: 'us-east-1' }); // Organizations API is us-east-1 only
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface VendAccountInput {
  name: string;
  email: string;
  projectId: string;
}

interface VendAccountOutput {
  name: string;
  email: string;
  accountId: string;
}

const POLL_INTERVAL_MS = 10_000;
const MAX_POLLS = 60; // Up to 10 minutes

/** Organizations often rejects parallel mutating calls with this; backoff and retry. */
function isConcurrentOrgConflict(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; message?: string };
  const msg = typeof e.message === 'string' ? e.message : '';
  return (
    e.name === 'ConcurrentModificationException' ||
    e.Code === 'ConcurrentModificationException' ||
    msg.includes('ConcurrentModification')
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function createAccountWithRetry(
  input: CreateAccountCommandInput
): Promise<CreateAccountCommandOutput> {
  const max = 6;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await orgClient.send(new CreateAccountCommand(input));
    } catch (err) {
      if (!isConcurrentOrgConflict(err) || attempt === max - 1) throw err;
      const base = 8_000 * (attempt + 1);
      const jitter = Math.floor(Math.random() * 4000);
      console.warn(
        `Organizations ConcurrentModificationException; retry ${attempt + 1}/${max} in ${base + jitter}ms`
      );
      await sleep(base + jitter);
    }
  }
  throw new Error('createAccountWithRetry: unreachable');
}

async function findExistingAccount(email: string): Promise<string | null> {
  let nextToken: string | undefined;

  do {
    const response = await orgClient.send(new ListAccountsCommand({ NextToken: nextToken }));
    const match = response.Accounts?.find(
      (a) => a.Email === email && orgAccountLifecycleState(a) === 'ACTIVE'
    );
    if (match?.Id) return match.Id;
    nextToken = response.NextToken;
  } while (nextToken);

  return null;
}

async function pollUntilActive(requestId: string): Promise<string> {
  for (let i = 0; i < MAX_POLLS; i++) {
    const response = await orgClient.send(
      new DescribeCreateAccountStatusCommand({ CreateAccountRequestId: requestId })
    );

    const status = response.CreateAccountStatus;

    if (status?.State === 'SUCCEEDED' && status.AccountId) {
      return status.AccountId;
    }

    if (status?.State === 'FAILED') {
      throw new Error(`Account creation failed: ${status.FailureReason}`);
    }

    // Still IN_PROGRESS — wait before next poll
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error('Account creation timed out after polling');
}

export const handler = async (event: VendAccountInput): Promise<VendAccountOutput> => {
  const { name, email, projectId } = event;

  console.log(`Vending account: name=${name}, email=${email}, project=${projectId}`);

  // Idempotency: check if account with this email already exists (no lock needed)
  const existingId = await findExistingAccount(email);
  if (existingId) {
    console.log(`Account already exists: ${existingId} (${email})`);
    return { name, email, accountId: existingId };
  }

  const lockHolder = `${projectId}:${email}`;
  await acquireOrgCreateAccountLock(docClient, TABLE_NAME, lockHolder);

  try {
    // Re-check under lock — another project may have finished creating this email
    const existingUnderLock = await findExistingAccount(email);
    if (existingUnderLock) {
      console.log(`Account already exists under lock: ${existingUnderLock} (${email})`);
      return { name, email, accountId: existingUnderLock };
    }

    const createResponse = await createAccountWithRetry({
      AccountName: name,
      Email: email,
      IamUserAccessToBilling: 'ALLOW',
    });

    const requestId = createResponse.CreateAccountStatus?.Id;
    if (!requestId) {
      throw new Error('No request ID returned from CreateAccount');
    }

    // Hold lock through poll — org still treats IN_PROGRESS creates as conflicting
    const accountId = await pollUntilActive(requestId);
    console.log(`Account created: ${accountId} (${name})`);

    return { name, email, accountId };
  } finally {
    await releaseOrgCreateAccountLock(docClient, TABLE_NAME, lockHolder);
  }
};

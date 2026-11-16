/**
 * Cross-execution lock for AWS Organizations CreateAccount.
 *
 * Organizations rejects concurrent mutating calls with ConcurrentModificationException.
 * Account Map states serialize within one project; this lock serializes across projects.
 */

import { type DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const LOCK_PK = 'LOCK#ORG_CREATE_ACCOUNT';
const LOCK_SK = 'LOCK';

/** Hold long enough for CreateAccount + poll (VendAccount timeout is 900s). */
const LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * Fail fast if the lock is busy so Step Functions can retry with backoff
 * (Lambda must not sit in acquire for the full peer create+poll window).
 */
const ACQUIRE_MAX_ATTEMPTS = 4;
const ACQUIRE_POLL_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function acquireOrgCreateAccountLock(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  holder: string
): Promise<void> {
  for (let attempt = 0; attempt < ACQUIRE_MAX_ATTEMPTS; attempt++) {
    const now = Date.now();
    const expiresAt = now + LOCK_TTL_MS;
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: LOCK_PK, SK: LOCK_SK },
          UpdateExpression: 'SET holder = :h, expiresAt = :exp, updatedAt = :u',
          ConditionExpression: 'attribute_not_exists(holder) OR expiresAt < :now',
          ExpressionAttributeValues: {
            ':h': holder,
            ':exp': expiresAt,
            ':now': now,
            ':u': new Date().toISOString(),
          },
        })
      );
      console.log(`Acquired org CreateAccount lock as ${holder}`);
      return;
    } catch (e: unknown) {
      const name =
        e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
      if (name !== 'ConditionalCheckFailedException') throw e;
      console.warn(
        `Org CreateAccount lock held; wait ${ACQUIRE_POLL_MS}ms (${attempt + 1}/${ACQUIRE_MAX_ATTEMPTS})`
      );
      await sleep(ACQUIRE_POLL_MS);
    }
  }
  const err = new Error(
    `OrgCreateAccountLockBusy: another CreateAccount is in progress (holder=${holder})`
  );
  err.name = 'OrgCreateAccountLockBusy';
  throw err;
}

export async function releaseOrgCreateAccountLock(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  holder: string
): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: LOCK_PK, SK: LOCK_SK },
        UpdateExpression: 'SET updatedAt = :u REMOVE holder, expiresAt',
        ConditionExpression: 'holder = :h',
        ExpressionAttributeValues: {
          ':h': holder,
          ':u': new Date().toISOString(),
        },
      })
    );
    console.log(`Released org CreateAccount lock (${holder})`);
  } catch (e: unknown) {
    const name =
      e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
    if (name === 'ConditionalCheckFailedException') {
      console.warn(`releaseOrgCreateAccountLock: lock no longer held by ${holder}`);
      return;
    }
    console.warn('releaseOrgCreateAccountLock failed', e);
  }
}

/**
 * Global project-slug reservation (DynamoDB single-item lock).
 *
 * Prevents two factory projects from sharing the same normalized slug
 * (GitHub repo name + plus-address account emails both key off slug).
 */

import { hostnameSafeSlug } from '@admin/core';
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

export function normalizeProjectSlug(slug: string): string {
  return hostnameSafeSlug(slug);
}

export function slugReservationKey(normalizedSlug: string): { PK: string; SK: string } {
  return { PK: `SLUG#${normalizedSlug}`, SK: 'RESERVED' };
}

export function projectSlugGsi(normalizedSlug: string, projectId: string) {
  return {
    GSI2PK: `SLUG#${normalizedSlug}`,
    GSI2SK: `PROJECT#${projectId}`,
  };
}

/**
 * Atomically create the project and reserve its slug. Throws if the slug is
 * already taken (reservation item, GSI2 project index, or a legacy project).
 */
export async function createProjectWithSlugReservation(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  normalizedSlug: string,
  projectId: string,
  userId: string,
  project: Record<string, unknown>
): Promise<void> {
  if (!normalizedSlug) {
    throw new Error('Slug is required and must contain letters or numbers.');
  }

  const existing = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': `SLUG#${normalizedSlug}` },
      Limit: 1,
    })
  );
  if ((existing.Items?.length ?? 0) > 0) {
    throw new Error(`Project slug "${normalizedSlug}" is already in use.`);
  }

  // Legacy rows may lack GSI2 / reservation — still block same-user duplicates.
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `USER#${userId}` },
        ExclusiveStartKey: startKey,
      })
    );
    for (const item of page.Items ?? []) {
      const other = normalizeProjectSlug(String(item.slug ?? ''));
      if (other && other === normalizedSlug) {
        throw new Error(`Project slug "${normalizedSlug}" is already in use.`);
      }
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);

  const now = new Date().toISOString();
  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                ...slugReservationKey(normalizedSlug),
                projectId,
                slug: normalizedSlug,
                createdAt: now,
                updatedAt: now,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: project,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      })
    );
  } catch (e: unknown) {
    const name =
      e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
    const reasons =
      e && typeof e === 'object' && 'CancellationReasons' in e
        ? (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons
        : undefined;
    if (
      name === 'ConditionalCheckFailedException' ||
      reasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')
    ) {
      throw new Error(`Project slug "${normalizedSlug}" is already in use.`);
    }
    throw e;
  }
}

/** Atomically delete a project and release its reservation once its repo is gone. */
export async function deleteProjectWithSlugReservation(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  normalizedSlug: string,
  projectId: string,
  userId: string
): Promise<void> {
  const slug = normalizeProjectSlug(normalizedSlug);
  if (!slug) {
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { PK: `PROJECT#${projectId}`, SK: 'METADATA' },
        ConditionExpression: '#userId = :userId',
        ExpressionAttributeNames: { '#userId': 'userId' },
        ExpressionAttributeValues: { ':userId': userId },
      })
    );
    return;
  }

  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: tableName,
            Key: { PK: `PROJECT#${projectId}`, SK: 'METADATA' },
            ConditionExpression: '#userId = :userId',
            ExpressionAttributeNames: { '#userId': 'userId' },
            ExpressionAttributeValues: { ':userId': userId },
          },
        },
        {
          Delete: {
            TableName: tableName,
            Key: slugReservationKey(slug),
            ConditionExpression: 'attribute_not_exists(PK) OR projectId = :projectId',
            ExpressionAttributeValues: { ':projectId': projectId },
          },
        },
      ],
    })
  );
}

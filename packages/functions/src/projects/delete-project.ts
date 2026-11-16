/**
 * Delete a factory project only after its GitHub repo is gone, then release
 * the slug reservation atomically with the project row.
 * Does not tear down GitHub repos or AWS accounts.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

import {
  getInstallationToken,
  listInstallationRepositories,
} from '../provisioning/list-github-repos';
import { requiredEnv } from '../runtime-env';
import { deleteProjectWithSlugReservation, normalizeProjectSlug } from './slug-reservation';
import { expectedRepoFullName } from './sync-with-github';

const TABLE_NAME = requiredEnv('TABLE_NAME');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

interface ProjectToDelete {
  id?: string;
  userId?: string;
  slug?: string | null;
  githubUrl?: string | null;
  githubOrg?: string | null;
  templateRepo?: string | null;
}

export async function deleteProject(userId: string, projectId: string): Promise<boolean> {
  if (!userId?.trim() || !projectId?.trim()) {
    throw new Error('deleteProject requires authenticated user and project id');
  }

  const got = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PROJECT#${projectId}`, SK: 'METADATA' },
    })
  );

  const item = got.Item as ProjectToDelete | undefined;
  if (!item) {
    return true;
  }
  if (item.userId !== userId) {
    throw new Error('Not authorized to delete this project.');
  }

  const slug = normalizeProjectSlug(item.slug ?? '');

  // A confirmed URL means the project must remain available for safe GitHub sync.
  if (item.githubUrl?.trim()) {
    throw new Error(
      'Delete the GitHub repository first, then run Sync with GitHub to remove this project safely.'
    );
  }

  // Legacy/failed rows may lack githubUrl even if CreateRepo succeeded. Refuse
  // deletion when the expected repo is still visible to the installation.
  const expectedRepo = expectedRepoFullName(item);
  if (expectedRepo) {
    const token = await getInstallationToken();
    const repos = await listInstallationRepositories(token);
    if (repos.some((repo) => repo.full_name.trim().toLowerCase() === expectedRepo)) {
      throw new Error(
        'Delete the GitHub repository first, then run Sync with GitHub to remove this project safely.'
      );
    }
  }

  await deleteProjectWithSlugReservation(docClient, TABLE_NAME, slug, projectId, userId);

  return true;
}

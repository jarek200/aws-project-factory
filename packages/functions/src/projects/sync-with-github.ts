/**
 * Drop factory projects whose linked GitHub repo is no longer visible to the App installation
 * (deleted, transferred, or otherwise removed from the GitHub account/org).
 *
 * Safety: never deletes in-progress provisioning rows, and only removes projects that already
 * have a confirmed `githubUrl` (slug fallback alone is not enough — that raced with CreateRepo).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import {
  getInstallationToken,
  listInstallationRepositories,
} from '../provisioning/list-github-repos';
import { requiredEnv } from '../runtime-env';
import { repoFullNameFromGithubUrl } from './github-url';
import { deleteProjectWithSlugReservation, normalizeProjectSlug } from './slug-reservation';

const TABLE_NAME = requiredEnv('TABLE_NAME');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/** Phases where the GitHub repo may not be visible yet (or githubUrl not written). */
const IN_PROGRESS_PHASES = new Set(['GITHUB', 'ACCOUNTS', 'CONFIGURE']);

export type ProjectGithubSyncResult = {
  checked: number;
  removed: number;
  skippedInProgress: number;
};

type ProjectRow = {
  id?: string;
  slug?: string | null;
  githubUrl?: string | null;
  githubOrg?: string | null;
  templateRepo?: string | null;
  provisioningPhase?: string | null;
  provisioningProgress?: number | null;
};

async function listUserProjects(userId: string): Promise<ProjectRow[]> {
  const out: ProjectRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `USER#${userId}` },
        ExclusiveStartKey: startKey,
      })
    );
    for (const item of res.Items ?? []) {
      out.push(item as ProjectRow);
    }
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}

/** Lowercased `owner/repo` set currently visible to the GitHub App installation. */
async function installationRepoFullNames(): Promise<Set<string>> {
  const token = await getInstallationToken();
  const repos = await listInstallationRepositories(token);
  return new Set(repos.map((r) => r.full_name.trim().toLowerCase()).filter(Boolean));
}

/**
 * Resolve the GitHub `owner/repo` this factory project is expected to own.
 * Prefer `githubUrl`; otherwise use create-repo naming: `{githubOrg|templateOwner}/{slug}`.
 * (Slug fallback is for display/diagnostics only — sync deletion requires githubUrl.)
 */
export function expectedRepoFullName(project: ProjectRow): string {
  const fromUrl = repoFullNameFromGithubUrl(project.githubUrl).toLowerCase();
  if (fromUrl) return fromUrl;

  const slug = (project.slug ?? '').trim().toLowerCase();
  if (!slug) return '';

  const org = (project.githubOrg ?? '').trim().toLowerCase();
  if (org) return `${org}/${slug}`;

  const template = (project.templateRepo ?? '').trim();
  const templateOwner = template.split('/')[0]?.trim().toLowerCase() ?? '';
  if (templateOwner) return `${templateOwner}/${slug}`;

  return '';
}

/** True when sync may safely delete if the installation no longer sees the repo. */
export function isSafeToSyncDelete(project: ProjectRow): boolean {
  const phase = (project.provisioningPhase ?? '').trim().toUpperCase();
  if (IN_PROGRESS_PHASES.has(phase)) return false;

  // REPO_ONLY before SetRepoOnlyDonePhase still lacks githubUrl while configure runs.
  const githubUrl = (project.githubUrl ?? '').trim();
  if (!githubUrl) return false;

  // Terminal-ish phases with a confirmed URL: DONE, REPO_ONLY (100%), FAILED (if URL was written).
  if (phase === 'DONE' || phase === 'FAILED' || phase === 'REPO_ONLY') return true;

  // DRAFT / unknown: only if we somehow have a githubUrl.
  return Boolean(githubUrl);
}

export async function syncProjectsWithGithub(userId: string): Promise<ProjectGithubSyncResult> {
  if (!userId?.trim()) {
    throw new Error('syncProjectsWithGithub requires authenticated user');
  }

  const githubRepos = await installationRepoFullNames();
  const projects = await listUserProjects(userId);

  let checked = 0;
  let removed = 0;
  let skippedInProgress = 0;

  for (const project of projects) {
    const id = project.id?.trim();
    if (!id) continue;

    if (!isSafeToSyncDelete(project)) {
      skippedInProgress += 1;
      continue;
    }

    const fullName = repoFullNameFromGithubUrl(project.githubUrl).toLowerCase();
    if (!fullName) continue;

    checked += 1;
    if (githubRepos.has(fullName)) continue;

    const slug = normalizeProjectSlug(project.slug ?? '');
    await deleteProjectWithSlugReservation(docClient, TABLE_NAME, slug, id, userId);
    removed += 1;
  }

  return { checked, removed, skippedInProgress };
}

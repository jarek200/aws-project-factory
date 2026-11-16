/**
 * Lambda Handler: Create Project (AppSync Lambda resolver)
 *
 * Creates a project record in DynamoDB and starts the Step Functions
 * provisioning state machine. Called by the AppSync createProject mutation.
 * Also routes listGithubReposForTemplate, syncProjectsWithGithub, deleteProject.
 */

import { buildProjectStageWebsiteUrl } from '@admin/core';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AppSyncResolverHandler } from 'aws-lambda';

import { listGithubReposForTemplate } from '../provisioning/list-github-repos';
import { requiredEnv } from '../runtime-env';
import { deleteProject } from './delete-project';
import {
  createProjectWithSlugReservation,
  normalizeProjectSlug,
  projectSlugGsi,
} from './slug-reservation';
import { syncProjectsWithGithub } from './sync-with-github';

const TABLE_NAME = requiredEnv('TABLE_NAME');
const STATE_MACHINE_ARN = requiredEnv('STATE_MACHINE_ARN');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sfnClient = new SFNClient({});

interface ProjectAccountInput {
  name: string;
  email: string;
  accountId?: string | null;
}

interface CreateProjectInput {
  name: string;
  slug: string;
  description?: string;
  templateRepo?: string;
  githubOrg?: string;
  accounts: ProjectAccountInput[];
  websiteUrl?: string;
  awsSignInUrl?: string;
}

interface AppSyncIdentityCognito {
  sub: string;
  username: string;
  claims: Record<string, unknown>;
}

export const handler: AppSyncResolverHandler<unknown, unknown> = async (event) => {
  if (event.info?.fieldName === 'listGithubReposForTemplate') {
    return listGithubReposForTemplate();
  }

  const identity = event.identity as AppSyncIdentityCognito;
  const userId = identity.sub;

  if (event.info?.fieldName === 'syncProjectsWithGithub') {
    return syncProjectsWithGithub(userId);
  }

  if (event.info?.fieldName === 'deleteProject') {
    const { id } = event.arguments as { id: string };
    return deleteProject(userId, id);
  }

  const input = (event.arguments as { input: CreateProjectInput }).input;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const slug = normalizeProjectSlug(input.slug);
  if (!slug) {
    throw new Error('Slug is required and must contain letters or numbers.');
  }

  const root = process.env.PROJECT_APPS_ROOT_DOMAIN?.trim();
  const websiteUrl =
    input.websiteUrl?.trim() ||
    (root ? buildProjectStageWebsiteUrl(slug, 'prod', root) || null : null);

  const project = {
    PK: `PROJECT#${id}`,
    SK: 'METADATA',
    GSI1PK: `USER#${userId}`,
    GSI1SK: `PROJECT#${now}`,
    ...projectSlugGsi(slug, id),
    id,
    userId,
    name: input.name,
    slug,
    description: input.description ?? null,
    templateRepo: input.templateRepo ?? null,
    githubOrg: input.githubOrg ?? null,
    accounts: input.accounts.map((a) => ({
      name: a.name,
      email: a.email,
      accountId: a.accountId?.trim() ? a.accountId.trim() : null,
      roleArn: null,
      awsSignInUrl: null,
      closureState: 'NONE',
      closedAt: null,
    })),
    provisioningPhase: 'GITHUB',
    provisioningProgress: 0,
    executionArn: null,
    githubUrl: null,
    websiteUrl,
    awsSignInUrl: input.awsSignInUrl ?? null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  await createProjectWithSlugReservation(docClient, TABLE_NAME, slug, id, userId, project);

  // Start Step Functions execution — the state machine drives all provisioning
  const sfnInput = {
    projectId: id,
    userId,
    name: input.name,
    slug,
    templateRepo: input.templateRepo ?? '',
    githubOrg: input.githubOrg ?? '',
    accounts: input.accounts.map((a) => ({
      name: a.name,
      email: a.email,
      accountId: a.accountId?.trim() ?? null,
    })),
  };

  const execution = await sfnClient.send(
    new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: `project-${id}`,
      input: JSON.stringify(sfnInput),
    })
  );
  const executionArn = execution.executionArn;
  if (!executionArn) {
    throw new Error('Step Functions did not return an execution ARN.');
  }

  // Update only execution metadata; SFN may already have advanced the project phase.
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PROJECT#${id}`, SK: 'METADATA' },
      UpdateExpression: 'SET executionArn = :executionArn, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':executionArn': executionArn,
        ':updatedAt': new Date().toISOString(),
      },
    })
  );

  return { ...project, executionArn };
};

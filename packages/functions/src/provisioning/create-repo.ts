/**
 * Lambda Handler: Create GitHub Repository (Step Functions task)
 *
 * Uses the GitHub API to generate a new repository from the project template,
 * then pushes a bootstrap commit that updates child-repo deploy.yml
 * (matrix over the provisioned environment keys for that project).
 *
 * GitHub credentials (App private key) are loaded from AWS Secrets Manager.
 */

import { fetchGitHubRepoMetadata, getGitHubToken, githubRequest } from './github-app-client';

interface CreateRepoInput {
  projectId: string;
  slug: string;
  name: string;
  templateRepo: string; // "org/template-repo"
  githubOrg: string;
}

interface CreateRepoOutput {
  githubUrl: string;
  repoFullName: string;
  githubOwnerId: string;
  githubRepoId: string;
}

function repoMetadataFromResponse(repo: {
  html_url: string;
  full_name: string;
  id: number;
  owner: { id: number };
}): CreateRepoOutput {
  if (!repo.id || !repo.owner?.id) {
    throw new Error(`GitHub repo response missing ids for ${repo.full_name}`);
  }

  return {
    githubUrl: repo.html_url,
    repoFullName: repo.full_name,
    githubOwnerId: String(repo.owner.id),
    githubRepoId: String(repo.id),
  };
}

export const handler = async (event: CreateRepoInput): Promise<CreateRepoOutput | null> => {
  const { templateRepo } = event;
  const slug = event.slug?.trim() ?? '';
  const name = event.name?.trim() ?? '';
  const githubOrg = event.githubOrg?.trim() ?? '';

  if (!templateRepo || templateRepo.trim() === '') {
    console.log('No templateRepo provided, skipping repo creation');
    return { githubUrl: '', repoFullName: '', githubOwnerId: '', githubRepoId: '' };
  }

  if (!slug) {
    throw new Error(
      'CreateRepo requires slug: repository name from GitHub template generate must be non-empty (minimum 1 character).'
    );
  }
  if (!name) {
    throw new Error('CreateRepo requires name: project display name must be non-empty.');
  }
  if (!githubOrg) {
    throw new Error('CreateRepo requires githubOrg when creating a repository from a template.');
  }

  const [templateOwner, templateName] = templateRepo.split('/');

  if (!templateOwner || !templateName) {
    throw new Error(`Invalid templateRepo format: ${templateRepo}. Expected "owner/repo"`);
  }

  const token = await getGitHubToken();

  // Check if repo already exists (idempotency)
  try {
    const existing = (await githubRequest(
      token,
      'GET',
      `/repos/${encodeURIComponent(githubOrg)}/${encodeURIComponent(slug)}`
    )) as {
      html_url: string;
      full_name: string;
      id: number;
      owner: { id: number };
    };
    console.log(`Repo already exists: ${existing.full_name}`);
    return repoMetadataFromResponse(existing);
  } catch {
    // 404 expected — proceed with creation
  }

  // Generate repo from template (404 = missing repo, not a GitHub "template", or app cannot read the template)
  let repo: {
    html_url: string;
    full_name: string;
    default_branch: string;
    id: number;
    owner: { id: number };
  };
  try {
    repo = (await githubRequest(token, 'POST', `/repos/${templateOwner}/${templateName}/generate`, {
      owner: githubOrg,
      name: slug,
      description: `${name} — created by AWS Project Factory`,
      private: true,
      include_all_branches: false,
    })) as {
      html_url: string;
      full_name: string;
      default_branch: string;
      id: number;
      owner: { id: number };
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (raw.includes('404')) {
      throw new Error(
        `GitHub cannot use "${templateOwner}/${templateName}" as a template (404). ` +
          `Create the repo under that name, enable Settings → General → Template repository, ` +
          `install the GitHub App on that repo (or org) with contents read, then retry. Raw: ${raw}`
      );
    }
    throw e;
  }

  console.log(`Repo created: ${repo.full_name}`);

  // Template generate may omit owner metadata — fetch canonical ids if needed.
  if (!repo.id || !repo.owner?.id) {
    const metadata = await fetchGitHubRepoMetadata(token, githubOrg, slug);
    return {
      githubUrl: repo.html_url,
      repoFullName: repo.full_name,
      githubOwnerId: metadata.githubOwnerId,
      githubRepoId: metadata.githubRepoId,
    };
  }

  return repoMetadataFromResponse(repo);
};

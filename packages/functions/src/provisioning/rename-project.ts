/**
 * Rename factory-template placeholders in a child repo via GitHub API.
 *
 * Works for starter-monorepo and the CMS portfolio starter (same placeholders).
 * Keep replacement rules in sync with each template’s scripts/rename-project.sh.
 */

const OLD_SCOPE = '@sst-monorepo';
const OLD_APP = 'sst-monorepo-starter';
const OLD_TREE = 'sst-monorepo/';
const OLD_SSO = 'acme';

/**
 * Text files that may contain template placeholders (relative to repo root).
 * Covers starter-monorepo (AppSync) and portfolio CMS starter (StaticSite + webhook).
 * Missing paths are skipped (404) so one list works for both templates.
 */
export const RENAME_FILE_PATHS = [
  'package.json',
  'sst.config.ts',
  'vitest.config.ts',
  '.lintstagedrc.json',
  'pnpm-lock.yaml',
  'README.md',
  'packages/core/package.json',
  'packages/graphql/package.json',
  'packages/functions/package.json',
  'packages/webhook/package.json',
  'apps/web/package.json',
  'packages/functions/src/auth/create-user-profile.ts',
  'apps/web/src/lib/services/graphql.ts',
  'apps/web/src/routes/(protected)/dashboard/+page.svelte',
] as const;

export interface ProjectRenameOptions {
  scope: string;
  app: string;
  sso: string;
}

export function normalizeScope(value: string): string {
  const scope = value.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(scope)) {
    throw new Error(`Invalid npm scope: ${value}`);
  }
  return scope;
}

export function normalizeAppName(value: string): string {
  const app = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(app)) {
    throw new Error(`Invalid app name: ${value}`);
  }
  return app;
}

export function buildProjectRenameOptions(input: {
  slug: string;
  githubOrg?: string;
}): ProjectRenameOptions {
  const slug = normalizeAppName(input.slug);
  const scope = normalizeScope(input.githubOrg?.trim() || slug);
  return {
    scope,
    app: slug,
    sso: scope,
  };
}

export function applyProjectRename(
  content: string,
  filePath: string,
  options: ProjectRenameOptions
): string {
  const newScope = `@${options.scope}`;
  let result = content
    .replaceAll(OLD_SCOPE, newScope)
    .replaceAll(OLD_APP, options.app)
    .replaceAll(OLD_TREE, `${options.app}/`);

  if (filePath === 'package.json' || filePath === 'README.md') {
    result = result.replaceAll(OLD_SSO, options.sso);
  }

  return result;
}

export function contentNeedsRename(
  content: string,
  filePath: string,
  options: ProjectRenameOptions
): boolean {
  return content !== applyProjectRename(content, filePath, options);
}

type GitHubFileResponse = {
  sha: string;
  content?: string;
  encoding?: string;
};

async function githubRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'AdminProjectFactory/1.0',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${path} → ${response.status}: ${text}`);
  }

  if (response.status === 204) return {};
  return response.json();
}

function decodeGitHubContent(file: GitHubFileResponse): string {
  if (!file.content) return '';
  const normalized = file.content.replace(/\n/g, '');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

/**
 * Commit renamed template files when placeholders are still present.
 * No-op if the repo was already renamed or files are missing.
 */
export async function pushProjectRenameCommit(
  token: string,
  repoFullName: string,
  options: ProjectRenameOptions
): Promise<void> {
  const repoInfo = (await githubRequest(token, 'GET', `/repos/${repoFullName}`)) as {
    default_branch: string;
  };
  const branch = repoInfo.default_branch;

  const ref = (await githubRequest(
    token,
    'GET',
    `/repos/${repoFullName}/git/ref/heads/${branch}`
  )) as { object: { sha: string } };
  const baseCommitSha = ref.object.sha;

  const baseCommit = (await githubRequest(
    token,
    'GET',
    `/repos/${repoFullName}/git/commits/${baseCommitSha}`
  )) as { tree: { sha: string } };

  const treeEntries: Array<{
    path: string;
    mode: '100644';
    type: 'blob';
    sha: string;
  }> = [];

  for (const filePath of RENAME_FILE_PATHS) {
    let file: GitHubFileResponse;
    try {
      file = (await githubRequest(
        token,
        'GET',
        `/repos/${repoFullName}/contents/${filePath}?ref=${branch}`
      )) as GitHubFileResponse;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404')) continue;
      throw err;
    }

    const original = decodeGitHubContent(file);
    if (!contentNeedsRename(original, filePath, options)) continue;

    const updated = applyProjectRename(original, filePath, options);
    const blob = (await githubRequest(token, 'POST', `/repos/${repoFullName}/git/blobs`, {
      content: updated,
      encoding: 'utf-8',
    })) as { sha: string };

    treeEntries.push({
      path: filePath,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    });
  }

  if (treeEntries.length === 0) {
    console.log(`No template placeholders to rename in ${repoFullName}`);
    return;
  }

  const tree = (await githubRequest(token, 'POST', `/repos/${repoFullName}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree: treeEntries,
  })) as { sha: string };

  const commit = (await githubRequest(token, 'POST', `/repos/${repoFullName}/git/commits`, {
    message: `chore: rename template to @${options.scope} (${options.app})`,
    tree: tree.sha,
    parents: [baseCommitSha],
  })) as { sha: string };

  await githubRequest(token, 'PATCH', `/repos/${repoFullName}/git/refs/heads/${branch}`, {
    sha: commit.sha,
  });

  console.log(
    `Renamed ${treeEntries.length} file(s) in ${repoFullName} → @${options.scope}, app=${options.app}`
  );
}

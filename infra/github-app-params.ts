/// <reference path="../.sst/platform/config.d.ts" />

export const GITHUB_APP_ID_PARAM_NAME = '/admin-factory/github-app-id';
export const GITHUB_INSTALLATION_ID_PARAM_NAME = '/admin-factory/github-installation-id';

/**
 * Reads the GitHub App ID and Installation ID from SSM Parameter Store at
 * deploy time using a Pulumi data source (`aws.ssm.getParameterOutput`).
 *
 * The parameters must exist before `sst deploy`:
 *   aws ssm put-parameter --name /admin-factory/github-app-id --value "<ID>" --type String
 *   aws ssm put-parameter --name /admin-factory/github-installation-id --value "<ID>" --type String
 */
export function createGithubAppSsmParameters() {
  const githubAppIdParam = aws.ssm.getParameterOutput({
    name: GITHUB_APP_ID_PARAM_NAME,
  });

  const githubInstallationIdParam = aws.ssm.getParameterOutput({
    name: GITHUB_INSTALLATION_ID_PARAM_NAME,
  });

  return { githubAppIdParam, githubInstallationIdParam };
}

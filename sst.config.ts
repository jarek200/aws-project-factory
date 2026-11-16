/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Admin control plane: one AWS account, one canonical SST stage `admin`.
 *
 * In CI the profile is irrelevant — OIDC credentials from
 * aws-actions/configure-aws-credentials take precedence.
 *
 * Local: set `AWS_PROFILE_ADMIN` or `AWS_PROFILE`, or rely on `default` in
 * ~/.aws/credentials. See https://sst.dev/docs/aws-accounts for SSO examples.
 */
const adminAwsProfile =
  process.env.AWS_PROFILE_ADMIN ?? process.env.AWS_PROFILE ?? 'default';

export default $config({
  app(input) {
    const stage = input?.stage ?? 'admin';

    return {
      name: 'admin',
      /**
       * Retain the real admin stack; any extra sandbox stage name still uses remove.
       */
      removal: stage === 'admin' ? 'retain' : 'remove',
      home: 'aws',
      providers: {
        aws: {
          profile: adminAwsProfile,
        },
      },
    };
  },
  async run() {
    // Dynamic imports (required by SST)
    const { createStorage } = await import('./infra/storage');
    const { createUserProfile } = await import('./infra/functions');
    const { createAuth } = await import('./infra/auth');
    const { createApi, createDataSource, createLambdaDataSource } = await import('./infra/api/api-setup');
    const { addAllResolvers } = await import('./infra/api/resolvers');
    const { stageConfig } = await import('./infra/stage-config');
    const {
      createProvisioningLambdas,
      createProjectLambda,
      createProvisionProjectAwsLambda,
      createProvisioningStateMachine,
    } = await import('./infra/provisioning');
    const {
      createDecommissionLambdas,
      createDecommissionStateMachine,
      createCloseProjectAccountLambda,
    } = await import('./infra/decommission');
    const { createOrgAccountsLambda } = await import('./infra/org-inventory');
    const { createProjectAppsDomain } = await import('./infra/project-apps-domain');
    const { createGithubAppSsmParameters } = await import('./infra/github-app-params');
    const {
      customDomainEnabled,
      ADMIN_SITE_HOSTED_ZONE_ID,
      ADMIN_SITE_HOSTNAME,
      PROJECT_APPS_ROOT_DOMAIN,
    } = await import('./infra/admin-site-domain');

    // Storage: DynamoDB table
    const { table } = createStorage();

    // Functions: Lambda functions
    const createUserProfileFunction = createUserProfile(table);

    // Auth: Cognito User Pool
    const { auth, authClient } = createAuth(createUserProfileFunction);

    // API: AppSync GraphQL API
    const api = createApi(auth);

    // Data source: DynamoDB
    const dynamoDataSource = createDataSource(api, table);

    // Optional delegated zone. Skipped unless FACTORY_ROOT_DOMAIN and
    // FACTORY_ADMIN_HOSTED_ZONE_ID are both set.
    const projectApps = customDomainEnabled
      ? createProjectAppsDomain(ADMIN_SITE_HOSTED_ZONE_ID, $app.stage)
      : undefined;

    // ─── Provisioning infrastructure ────────────────────────────────────────
    // GitHub App private key is stored in Secrets Manager.
    // The ARN is injected via env var at deploy time; create the secret
    // manually in the management account before first deploy:
    //   aws secretsmanager create-secret --name /admin-factory/github-private-key \
    //     --secret-string "$(cat your-app.private-key.pem)"
    const githubPrivateKeySecretArn =
      process.env.GITHUB_PRIVATE_KEY_SECRET_ARN ??
      $interpolate`arn:aws:secretsmanager:${aws.getRegionOutput().name}:${aws.getCallerIdentityOutput({}).accountId}:secret:/admin-factory/github-private-key`;
    const githubPrivateKeySecretArnWildcard = $interpolate`${githubPrivateKeySecretArn}-*`;

    const { githubAppIdParam, githubInstallationIdParam } = createGithubAppSsmParameters();
    const githubIds = {
      appId: githubAppIdParam.value,
      installationId: githubInstallationIdParam.value,
    };

    /**
     * Optional — IAM Identity Center auto-assignment for new member accounts (SSO portal):
     * set IDENTITY_CENTER_GROUP_DISPLAY_NAME (or IDENTITY_CENTER_GROUP_ID) in the environment
     * when running `sst deploy`. See AssignIdentityCenter in infra/provisioning.ts.
     * Use IDENTITY_CENTER_REGION if your Identity Center home region ≠ admin stack region.
     */
    // Provisioning task Lambdas (called by Step Functions)
    const provisioningFns = createProvisioningLambdas(
      table,
      githubPrivateKeySecretArn,
      githubPrivateKeySecretArnWildcard,
      githubIds,
      {
        hostedZoneId: projectApps?.zone.zoneId ?? '',
        dnsRoleArn: projectApps?.dnsRole.arn ?? '',
      }
    );

    // Step Functions state machine
    const stateMachine = createProvisioningStateMachine(provisioningFns);

    const decommissionFns = createDecommissionLambdas(
      table,
      githubPrivateKeySecretArn,
      githubPrivateKeySecretArnWildcard,
      githubIds
    );
    const decommissionStateMachine = createDecommissionStateMachine(decommissionFns);

    // AppSync Lambda: createProject + listGithubReposForTemplate + syncProjectsWithGithub
    const createProjectFn = createProjectLambda(
      table,
      stateMachine.arn,
      githubPrivateKeySecretArn,
      githubPrivateKeySecretArnWildcard,
      githubAppIdParam.value,
      githubInstallationIdParam.value
    );

    const provisionProjectAwsFn = createProvisionProjectAwsLambda(table, stateMachine.arn);

    const closeProjectAccountFn = createCloseProjectAccountLambda(table, decommissionStateMachine.arn);
    const orgAccountsFn = createOrgAccountsLambda(table, decommissionStateMachine.arn);

    const lambdaDataSource = createLambdaDataSource(api, createProjectFn.arn);
    const closeAccountLambdaDataSource = createLambdaDataSource(api, closeProjectAccountFn.arn, {
      name: 'CloseProjectAccountLambda',
    });
    const orgAccountsLambdaDataSource = createLambdaDataSource(api, orgAccountsFn.arn, {
      name: 'OrgAccountsLambda',
    });
    const provisionProjectAwsLambdaDataSource = createLambdaDataSource(api, provisionProjectAwsFn.arn, {
      name: 'ProvisionProjectAwsLambda',
    });

    // Resolvers: Add all resolvers (user + project)
    addAllResolvers(
      api,
      dynamoDataSource,
      lambdaDataSource,
      closeAccountLambdaDataSource,
      orgAccountsLambdaDataSource,
      provisionProjectAwsLambdaDataSource,
      String(table.name)
    );

    // ─── Admin SvelteKit app ─────────────────────────────────────────────────

    const svelteKitTransform = {
      server(server: Record<string, unknown>) {
        server.runtime = 'nodejs22.x';
        server.memory = stageConfig.sveltekit.memory;
        // biome-ignore lint/suspicious/noExplicitAny: SST types incomplete
        if (!server.nodejs) server.nodejs = {} as any;
        // biome-ignore lint/suspicious/noExplicitAny: SST types incomplete
        const nodejs = server.nodejs as any;
        const existingExternal = ((nodejs.esbuild?.external as string[] | undefined) ?? []).slice();
        nodejs.loader = { ...(nodejs.loader ?? {}), '.node': 'file' };
        nodejs.esbuild = {
          ...(nodejs.esbuild ?? {}),
          external: Array.from(new Set([...existingExternal, 'fsevents', 'lightningcss'])),
        };
      },
    };

    const sharedEnv = {
      VITE_AWS_REGION: aws.getRegionOutput().name,
      VITE_USER_POOL_ID: auth.id,
      VITE_USER_POOL_CLIENT_ID: authClient.id,
      VITE_GRAPHQL_ENDPOINT: api.url,
      VITE_STAGE: $app.stage,
      VITE_PROJECT_APPS_ROOT_DOMAIN: PROJECT_APPS_ROOT_DOMAIN,
      /** Plus-address local part for vended AWS account emails (`local+slug-suffix@domain`). */
      VITE_ACCOUNT_EMAIL_LOCAL: process.env.VITE_ACCOUNT_EMAIL_LOCAL?.trim() ?? '',
      VITE_ACCOUNT_EMAIL_DOMAIN: process.env.VITE_ACCOUNT_EMAIL_DOMAIN?.trim() ?? '',
      /** Default GitHub template (`owner/repo`) for the new-project form. */
      VITE_DEFAULT_TEMPLATE_REPO: process.env.VITE_DEFAULT_TEMPLATE_REPO?.trim() ?? '',
      /** Optional IAM Identity Center / IdP portal URL for the admin navbar SSO shortcut. */
      VITE_SSO_URL: process.env.VITE_SSO_URL?.trim() ?? '',
    };

    // Admin UI. Custom hostname only when DNS env is set; otherwise SST assigns a URL.
    const admin = new sst.aws.SvelteKit('Admin', {
      path: 'apps/admin',
      link: [table, auth, authClient, api],
      transform: svelteKitTransform,
      environment: sharedEnv,
      ...(customDomainEnabled
        ? {
            domain: {
              name: ADMIN_SITE_HOSTNAME,
              dns: sst.aws.dns({ zone: ADMIN_SITE_HOSTED_ZONE_ID }),
            },
          }
        : {}),
    });

    return {
      table: table.name,
      userPoolId: auth.id,
      userPoolClientId: authClient.id,
      apiUrl: api.url,
      adminUrl: admin.url,
      projectAppsRootDomain: PROJECT_APPS_ROOT_DOMAIN,
      projectAppsHostedZoneId: projectApps?.zone.zoneId ?? '',
      projectAppsNameServers: projectApps?.zone.nameServers ?? [],
      projectAppsDnsRoleArn: projectApps?.dnsRole.arn ?? '',
      stateMachineArn: stateMachine.arn,
      decommissionStateMachineArn: decommissionStateMachine.arn,
    };
  },
});

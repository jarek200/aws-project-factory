# Adoption checklist

Run this factory in your own AWS management account. Nothing here connects to someone else's organization.

## 1. Admin AWS account

- Use the Organizations **management** account (or an account that can call `organizations:CreateAccount` and assume `OrganizationAccountAccessRole` in members).
- Configure an AWS CLI profile and export it as `AWS_PROFILE_ADMIN`.
- Confirm Organizations is enabled and that new accounts are allowed.

## 2. GitHub App

Create a GitHub App that can create repositories from templates and configure environments.

Suggested permissions:

- Repository: Contents (read and write), Administration (read and write) if you create repos, Environments, Secrets, Variables, Metadata
- Organization: members / administration only if your install needs them to create repos in the org

Install the app on the organization (or user) that will own child repositories, and on the template repositories.

Store the credentials before `pnpm run deploy`:

```bash
aws ssm put-parameter --name /admin-factory/github-app-id \
  --value "<APP_ID>" --type String

aws ssm put-parameter --name /admin-factory/github-installation-id \
  --value "<INSTALLATION_ID>" --type String

aws secretsmanager create-secret --name /admin-factory/github-private-key \
  --secret-string "$(cat your-app.private-key.pem)"
```

The default secret id is `/admin-factory/github-private-key`. Override the full ARN with `GITHUB_PRIVATE_KEY_SECRET_ARN` if you use another name. The private key must not be committed.

## 3. IAM Identity Center

To attach new accounts to your SSO portal, store the group id:

```bash
aws ssm put-parameter --name /admin-factory/identity-center-group-id \
  --value "<IDENTITY_STORE_GROUP_ID>" --type String
```

Optional environment variables at deploy time:

| Variable | Default | Purpose |
|----------|---------|---------|
| `IDENTITY_CENTER_PERMISSION_SET_NAME` | `AdministratorAccess` | Permission set assigned to the group |
| `IDENTITY_CENTER_GROUP_DISPLAY_NAME` | empty | Display name override |
| `IDENTITY_CENTER_REGION` | stack region | Set when Identity Center lives in another region |
| `IDENTITY_CENTER_SKIP_ASSIGNMENT` | empty | Set to skip assignment |
| `VITE_SSO_URL` | empty | Portal link shown in the admin navbar |

Deploy reads `/admin-factory/identity-center-group-id`. Create the parameter before the first deploy even if you plan to skip assignment, or the SSM lookup fails.

## 4. Factory defaults

| Variable | Required when |
|----------|----------------|
| `VITE_DEFAULT_TEMPLATE_REPO` | You want the new-project form to pre-fill `owner/repo` |
| `VITE_ACCOUNT_EMAIL_LOCAL` | You vend new accounts (plus-address local part) |
| `VITE_ACCOUNT_EMAIL_DOMAIN` | You vend new accounts |
| `FACTORY_ROOT_DOMAIN` | You want `admin.<apex>` instead of the SST hostname |
| `FACTORY_ADMIN_HOSTED_ZONE_ID` | Custom domain is set (both or neither) |
| `PROJECT_APPS_HOSTED_ZONE_ID` | Custom domain is set and you deploy a stage other than `admin` |

Account emails look like `local+<slug>-<suffix>@domain`. The address must be unique for every account AWS creates.

## 5. Deploy the admin stack

```bash
export AWS_PROFILE_ADMIN=your-admin-profile
pnpm run deploy
```

Open the `adminUrl` output. Sign in with the Cognito user pool the stack created (create the first user in Cognito if the pool is empty).

## 6. CI deploy (optional)

1. Create a GitHub Environment named `admin`.
2. Add secret `AWS_ROLE_ARN` (OIDC role in the admin account).
3. Create the pull request label `deploy:admin`.

See `.github/workflows/deploy.yml`. The workflow region is `us-east-1`; change it if your admin stack is elsewhere.

## 7. First project

In the admin UI:

- **Use existing organization accounts** bootstraps members you already have. It does not call `CreateAccount`.
- **Create new accounts (vend)** calls Organizations `CreateAccount`, then OIDC bootstrap and Identity Center assignment. The form starts with `int`, `stage`, and `prod`. Use one suffix for a trial.
- **Monorepo only** creates the GitHub repo and stops. You can add AWS accounts later.

Bring your own template repository. It must be marked as a GitHub template, and the rename step expects the placeholders documented in the README (`@sst-monorepo`, `sst-monorepo-starter`, `acme`) if you want automatic renaming.

## 8. Custom DNS (optional)

1. Set `FACTORY_ROOT_DOMAIN` and `FACTORY_ADMIN_HOSTED_ZONE_ID`.
2. Deploy stage `admin`. The stack creates `apps.<apex>` and delegates it from the apex zone.
3. Save output `projectAppsHostedZoneId` as `PROJECT_APPS_HOSTED_ZONE_ID` for later stages.
4. Point child templates at that hosted zone if they publish app DNS through the `DNS_ROLE_ARN` secret the factory writes.

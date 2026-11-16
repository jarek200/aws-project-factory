# Security

This repository is a control plane. A deploy can create AWS accounts, write IAM roles in member accounts, and read a GitHub App private key from AWS Secrets Manager.

## Reporting

Open a private GitHub security advisory on this repository, or contact the maintainer through the GitHub profile that owns the repository. Do not file a public issue for an unpublished vulnerability.

## What not to commit

- AWS account ids, hosted zone ids, or Identity Center ids from a real organization
- GitHub App private keys (`.pem`) or installation tokens
- `.env` files with real `VITE_*` or `FACTORY_*` values
- Long-lived AWS access keys

Use OIDC for GitHub Actions (`AWS_ROLE_ARN` on the `admin` environment). The deploy workflow does not read static AWS keys from the repo.

## Operating notes

- Prefer a dedicated management account and a small set of operators.
- A signed-in Cognito user can close an organization account that is not the management account. Listing and syncing the inventory stays available to any signed-in user.
- GitHub deploy roles stay on `AdministratorAccess` so a child stack can deploy. A permissions boundary blocks closing the account, changing the organization, and removing the boundary. The boundary is applied the next time that account is bootstrapped.
- When custom DNS is on, the apps DNS role can be assumed only by `GitHubActions-*` roles in this AWS Organization. That deploy needs `organizations:DescribeOrganization`.
- Review the IAM permissions in `infra/provisioning.ts` and `infra/decommission.ts` before deploying.
- Vended accounts and the GitHub repos created for them are yours to close if a run fails halfway.

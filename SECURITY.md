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
- Review the IAM permissions in `infra/provisioning.ts` and `infra/decommission.ts` before deploying.
- Vended accounts and the GitHub repos created for them are yours to close if a run fails halfway.

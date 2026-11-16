/**
 * Remove factory bootstrap IAM: deploy role, then GitHub OIDC provider in member account.
 */

import {
  DeleteOpenIDConnectProviderCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
} from '@aws-sdk/client-iam';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

import { envKeyFromAccountName } from '../provisioning/account-env-key';

const stsClient = new STSClient({});

interface TeardownInput {
  accountId: string;
  accountName: string;
}

interface TeardownOutput {
  accountId: string;
  accountName: string;
}

async function assumeAccountRole(accountId: string): Promise<IAMClient> {
  const roleArn = `arn:aws:iam::${accountId}:role/OrganizationAccountAccessRole`;
  const assumed = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `TeardownBootstrap-${accountId}`,
      DurationSeconds: 3600,
    })
  );
  const creds = assumed.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error(`Failed to assume OrganizationAccountAccessRole in ${accountId}`);
  }
  return new IAMClient({
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    },
  });
}

async function deleteRoleAndPolicies(iam: IAMClient, roleName: string): Promise<void> {
  try {
    let marker: string | undefined;
    do {
      const attached = await iam.send(
        new ListAttachedRolePoliciesCommand({ RoleName: roleName, Marker: marker })
      );
      for (const p of attached.AttachedPolicies ?? []) {
        if (p.PolicyArn) {
          await iam.send(
            new DetachRolePolicyCommand({
              RoleName: roleName,
              PolicyArn: p.PolicyArn,
            })
          );
        }
      }
      marker = attached.Marker;
    } while (marker);

    let inlineMarker: string | undefined;
    do {
      const inline = await iam.send(
        new ListRolePoliciesCommand({ RoleName: roleName, Marker: inlineMarker })
      );
      for (const name of inline.PolicyNames ?? []) {
        await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: name }));
      }
      inlineMarker = inline.Marker;
    } while (inlineMarker);

    await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
    console.log(`Deleted role ${roleName}`);
  } catch (err: unknown) {
    const e = err as { name?: string };
    if (e.name === 'NoSuchEntityException') {
      console.log(`Role ${roleName} already absent`);
      return;
    }
    throw err;
  }
}

export const handler = async (event: TeardownInput): Promise<TeardownOutput> => {
  const { accountId, accountName } = event;
  const envKey = envKeyFromAccountName(accountName);
  const roleName = `GitHubActions-${envKey}`;

  const iam = await assumeAccountRole(accountId);
  await deleteRoleAndPolicies(iam, roleName);

  const oidcArn = `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`;
  try {
    await iam.send(new DeleteOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: oidcArn }));
    console.log('Deleted GitHub OIDC provider');
  } catch (err: unknown) {
    const e = err as { name?: string };
    if (e.name === 'NoSuchEntityException') {
      console.log('OIDC provider already absent');
    } else {
      throw err;
    }
  }

  return { accountId, accountName };
};

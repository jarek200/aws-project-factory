/**
 * Close member account via AWS Organizations (management account).
 *
 * CloseAccount is asynchronous: AWS accepts the request immediately; the account moves
 * PENDING_CLOSURE → SUSPENDED in the background (often minutes). We return success as
 * soon as the API accepts the closure so Step Functions does not block on DescribeAccount
 * polling — full teardown in the account can continue for a long time per AWS policy.
 */

import { CloseAccountCommand, OrganizationsClient } from '@aws-sdk/client-organizations';

const orgClient = new OrganizationsClient({ region: 'us-east-1' });

interface CloseInput {
  accountId: string;
  accountName: string;
}

interface CloseOutput {
  accountId: string;
  accountName: string;
}

export const handler = async (event: CloseInput): Promise<CloseOutput> => {
  const { accountId, accountName } = event;

  try {
    await orgClient.send(new CloseAccountCommand({ AccountId: accountId }));
    console.log(
      `CloseAccount accepted for ${accountId} (${accountName}); closure continues asynchronously (see AWS org console / docs)`
    );
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (e.name === 'AccountAlreadyClosedException') {
      console.log(`Account ${accountId} already closed`);
      return { accountId, accountName };
    }
    throw err;
  }

  return { accountId, accountName };
};

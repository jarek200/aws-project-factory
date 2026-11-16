/// <reference path="../.sst/platform/config.d.ts" />

import { ADMIN_SITE_HOSTNAME } from './admin-site-domain';

const ADMIN_ORIGINS = [`https://${ADMIN_SITE_HOSTNAME}`];
/** Matches apps/admin vite server strictPort */
const LOCAL_ADMIN_ORIGINS = ['http://localhost:5174/', 'http://127.0.0.1:5174/'];

export function createAuth(
  createUserProfileFunction: ReturnType<typeof import('./functions').createUserProfile>
) {
  // Cognito User Pool with post-confirmation trigger
  const auth = new sst.aws.CognitoUserPool('Auth', {
    usernames: ['email'],
    transform: {
      userPool: (args) => {
        args.adminCreateUserConfig = {
          allowAdminCreateUserOnly: true,
        };
        args.lambdaConfig = {
          postConfirmation: createUserProfileFunction.arn,
        };
      },
    },
  });

  // Grant Cognito permission to invoke the Lambda
  new aws.lambda.Permission('CreateUserProfilePermission', {
    action: 'lambda:InvokeFunction',
    function: createUserProfileFunction.arn,
    principal: 'cognito-idp.amazonaws.com',
    sourceArn: auth.arn,
  });

  const authClient = auth.addClient('AuthClient', {
    callbackUrls: [...ADMIN_ORIGINS, ...LOCAL_ADMIN_ORIGINS],
    transform: {
      client: {
        logoutUrls: [...ADMIN_ORIGINS, ...LOCAL_ADMIN_ORIGINS],
      },
    },
  });

  return { auth, authClient };
}

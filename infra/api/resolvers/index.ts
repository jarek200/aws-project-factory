/// <reference path="../../../.sst/platform/config.d.ts" />

import { addOrganizationResolvers } from './organizations';
import { addProjectResolvers } from './projects';
import { addUserResolvers } from './users';

export function addAllResolvers(
  api: ReturnType<typeof import('../api-setup').createApi>,
  dynamoDataSource: ReturnType<typeof import('../api-setup').createDataSource>,
  lambdaDataSource: ReturnType<typeof import('../api-setup').createLambdaDataSource>,
  closeAccountLambdaDataSource: ReturnType<typeof import('../api-setup').createLambdaDataSource>,
  orgAccountsLambdaDataSource: ReturnType<typeof import('../api-setup').createLambdaDataSource>,
  provisionProjectAwsLambdaDataSource: ReturnType<
    typeof import('../api-setup').createLambdaDataSource
  >,
  tableName: string
) {
  addUserResolvers(api, dynamoDataSource, tableName);
  addOrganizationResolvers(api, orgAccountsLambdaDataSource);
  addProjectResolvers(
    api,
    dynamoDataSource,
    lambdaDataSource,
    closeAccountLambdaDataSource,
    provisionProjectAwsLambdaDataSource,
    tableName
  );
}

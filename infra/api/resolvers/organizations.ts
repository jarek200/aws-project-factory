/// <reference path="../../../.sst/platform/config.d.ts" />

export function addOrganizationResolvers(
  api: ReturnType<typeof import('../api-setup').createApi>,
  orgAccountsLambdaDataSource: ReturnType<typeof import('../api-setup').createLambdaDataSource>
) {
  api.addResolver('Query listOrganizationAccounts', {
    dataSource: orgAccountsLambdaDataSource.name,
    code: `
      import { util } from '@aws-appsync/utils';

      export function request(ctx) {
        return {
          operation: 'Invoke',
          payload: {
            arguments: ctx.arguments,
            identity: ctx.identity,
            info: ctx.info,
          },
        };
      }

      export function response(ctx) {
        if (ctx.error) return util.error(ctx.error.message, ctx.error.type);
        return ctx.result;
      }
    `,
    transform: {
      resolver: (_args, opts) => {
        opts.deleteBeforeReplace = true;
      },
    },
  });

  api.addResolver('Mutation syncOrganizationAccounts', {
    dataSource: orgAccountsLambdaDataSource.name,
    code: `
      import { util } from '@aws-appsync/utils';

      export function request(ctx) {
        return {
          operation: 'Invoke',
          payload: {
            arguments: ctx.arguments,
            identity: ctx.identity,
            info: ctx.info,
          },
        };
      }

      export function response(ctx) {
        if (ctx.error) return util.error(ctx.error.message, ctx.error.type);
        return ctx.result;
      }
    `,
    transform: {
      resolver: (_args, opts) => {
        opts.deleteBeforeReplace = true;
      },
    },
  });

  api.addResolver('Query getOrganizationAccount', {
    dataSource: orgAccountsLambdaDataSource.name,
    code: `
      import { util } from '@aws-appsync/utils';

      export function request(ctx) {
        return {
          operation: 'Invoke',
          payload: {
            arguments: ctx.arguments,
            identity: ctx.identity,
            info: ctx.info,
          },
        };
      }

      export function response(ctx) {
        if (ctx.error) return util.error(ctx.error.message, ctx.error.type);
        return ctx.result;
      }
    `,
    transform: {
      resolver: (_args, opts) => {
        opts.deleteBeforeReplace = true;
      },
    },
  });

  api.addResolver('Mutation closeStandaloneOrganizationAccount', {
    dataSource: orgAccountsLambdaDataSource.name,
    code: `
      import { util } from '@aws-appsync/utils';

      export function request(ctx) {
        return {
          operation: 'Invoke',
          payload: {
            arguments: ctx.arguments,
            identity: ctx.identity,
            info: ctx.info,
          },
        };
      }

      export function response(ctx) {
        if (ctx.error) return util.error(ctx.error.message, ctx.error.type);
        return ctx.result;
      }
    `,
    transform: {
      resolver: (_args, opts) => {
        opts.deleteBeforeReplace = true;
      },
    },
  });
}

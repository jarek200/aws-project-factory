/// <reference path="../.sst/platform/config.d.ts" />

/**
 * Resource sizing for the admin control-plane stack.
 *
 * This repo targets a single AWS account and canonical SST stage `admin`.
 * Optional sandbox stages (any other name) fall back to the same sizes.
 */

type StageConfig = {
  lambda: {
    memory: `${number} MB`;
    timeout: `${number} seconds`;
  };
  sveltekit: {
    memory: `${number} MB`;
  };
};

const adminConfig: StageConfig = {
  lambda: { memory: '1024 MB', timeout: '30 seconds' },
  sveltekit: { memory: '1024 MB' },
};

export const stageConfig: StageConfig = adminConfig;

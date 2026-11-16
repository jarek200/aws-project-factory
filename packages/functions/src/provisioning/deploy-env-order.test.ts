import { describe, expect, it } from 'vitest';

import { buildDeployEnvOrder, priorDeployEnvKeys } from './deploy-env-order';

describe('deploy-env-order', () => {
  it('orders provisioned env keys canonically', () => {
    expect(buildDeployEnvOrder(['prod', 'int'])).toBe('int,prod');
    expect(buildDeployEnvOrder(['int', 'stage', 'prod'])).toBe('int,stage,prod');
  });

  it('returns prior env keys for promotion gates', () => {
    expect(priorDeployEnvKeys('int,prod', 'prod')).toEqual(['int']);
    expect(priorDeployEnvKeys('int,stage,prod', 'stage')).toEqual(['int']);
    expect(priorDeployEnvKeys('int,stage,prod', 'prod')).toEqual(['int', 'stage']);
    expect(priorDeployEnvKeys('int,prod', 'int')).toEqual([]);
  });
});

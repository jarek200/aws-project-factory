import { describe, expect, it } from 'vitest';
import { requireCognitoSub } from './require-cognito-sub';

describe('requireCognitoSub', () => {
  it('returns the trimmed Cognito sub', () => {
    expect(requireCognitoSub({ sub: '  user-123  ' })).toBe('user-123');
  });

  it('rejects a missing caller', () => {
    expect(() => requireCognitoSub(null)).toThrow(/signed-in Cognito user/);
    expect(() => requireCognitoSub({})).toThrow(/signed-in Cognito user/);
    expect(() => requireCognitoSub({ sub: '   ' })).toThrow(/signed-in Cognito user/);
  });
});

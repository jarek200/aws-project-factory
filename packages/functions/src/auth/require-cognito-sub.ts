/** Cognito user id from an AppSync identity. Empty when the caller is not a user pool user. */

export function requireCognitoSub(identity: unknown): string {
  const sub =
    identity && typeof identity === 'object' ? (identity as { sub?: unknown }).sub : undefined;
  if (typeof sub !== 'string' || sub.trim() === '') {
    throw new Error('A signed-in Cognito user is required');
  }
  return sub.trim();
}

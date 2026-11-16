/**
 * AWS Organizations account lifecycle: prefer {@link Account.State}, fall back to
 * {@link Account.Status} until AWS retires Status (announced 2026-09-09).
 */

export type OrgAccountLifecycleFields = {
  State?: string | null;
  Status?: string | null;
};

export function orgAccountLifecycleState(account: OrgAccountLifecycleFields): string | undefined {
  const s = account.State ?? account.Status;
  return s == null || s === '' ? undefined : s;
}

export function orgAccountLifecycleStateOrEmpty(account: OrgAccountLifecycleFields): string {
  return orgAccountLifecycleState(account) ?? '';
}

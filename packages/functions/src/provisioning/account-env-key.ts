/** Derive GitHub Actions environment key from factory account name (same rules as bootstrap). */
export function envKeyFromAccountName(name: string): string {
  const parts = name.toLowerCase().split('-');
  return parts[parts.length - 1] ?? name.toLowerCase();
}

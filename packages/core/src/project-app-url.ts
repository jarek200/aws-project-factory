/**
 * Hostnames for apps provisioned by the factory, under PROJECT_APPS_ROOT_DOMAIN.
 *
 * - prod: `https://{slug}.{root}`
 * - int / stage / other: `https://{slug}-{envKey}.{root}`
 */

export function hostnameSafeSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function buildProjectStageWebsiteUrl(
  slug: string,
  envKey: string,
  rootDomain: string
): string {
  const s = hostnameSafeSlug(slug);
  const root = rootDomain.trim().replace(/^\.+|\.+$/g, '');
  const e = envKey.trim().toLowerCase();
  if (!s || !root || !e) return '';
  const host = e === 'prod' ? `${s}.${root}` : `${s}-${e}.${root}`;
  return `https://${host}`;
}

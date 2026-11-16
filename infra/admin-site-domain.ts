/// <reference path="../.sst/platform/config.d.ts" />

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? '';
}

/**
 * Optional apex domain for the admin UI and delegated app zone.
 * Example: `example.com` → admin UI at `admin.example.com`, apps at `apps.example.com`.
 * Leave unset to deploy the admin UI on the default SST hostname (no Route 53).
 */
export const FACTORY_ROOT_DOMAIN = readEnv('FACTORY_ROOT_DOMAIN');

/** Route 53 hosted zone ID for {@link FACTORY_ROOT_DOMAIN}. Required with the root domain. */
export const ADMIN_SITE_HOSTED_ZONE_ID = readEnv('FACTORY_ADMIN_HOSTED_ZONE_ID');

if (FACTORY_ROOT_DOMAIN && !ADMIN_SITE_HOSTED_ZONE_ID) {
  throw new Error('FACTORY_ADMIN_HOSTED_ZONE_ID is required when FACTORY_ROOT_DOMAIN is set.');
}

if (!FACTORY_ROOT_DOMAIN && ADMIN_SITE_HOSTED_ZONE_ID) {
  throw new Error('FACTORY_ROOT_DOMAIN is required when FACTORY_ADMIN_HOSTED_ZONE_ID is set.');
}

/** True when both the apex domain and its hosted zone ID are configured. */
export const customDomainEnabled = Boolean(FACTORY_ROOT_DOMAIN && ADMIN_SITE_HOSTED_ZONE_ID);

/** Admin UI hostname. Empty when custom DNS is not configured. */
export const ADMIN_SITE_HOSTNAME = customDomainEnabled ? `admin.${FACTORY_ROOT_DOMAIN}` : '';

/**
 * Delegated subdomain for factory-created apps.
 * The admin stack manages NS delegation from the root zone once; created projects
 * automate their own app DNS and certificates underneath this subdomain.
 */
export const PROJECT_APPS_ROOT_DOMAIN = customDomainEnabled ? `apps.${FACTORY_ROOT_DOMAIN}` : '';

/**
 * Route 53 hosted zone ID for {@link PROJECT_APPS_ROOT_DOMAIN}.
 * Required for SST stages other than `admin` when custom DNS is enabled
 * (those stages look up the zone created by the `admin` stage).
 * Set it from the `projectAppsHostedZoneId` output after the first admin deploy.
 */
export const PROJECT_APPS_HOSTED_ZONE_ID = readEnv('PROJECT_APPS_HOSTED_ZONE_ID');

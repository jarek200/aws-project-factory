/// <reference path="../.sst/platform/config.d.ts" />

import { buildProjectAppsDnsTrustPolicy } from '../packages/functions/src/provisioning/dns-role-trust';
import { PROJECT_APPS_HOSTED_ZONE_ID, PROJECT_APPS_ROOT_DOMAIN } from './admin-site-domain';

function createProjectAppsDnsRole(zoneArn: $util.Input<string>) {
  // Management account (or another principal that can DescribeOrganization).
  const organization = aws.organizations.getOrganizationOutput({});
  const dnsRole = new aws.iam.Role('ProjectAppsDnsRole', {
    assumeRolePolicy: organization.id.apply((organizationId) =>
      JSON.stringify(buildProjectAppsDnsTrustPolicy(organizationId))
    ),
    description: 'Cross-account DNS updater for delegated project app domains',
  });

  new aws.iam.RolePolicy('ProjectAppsDnsRolePolicy', {
    role: dnsRole.id,
    policy: $jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: [
            'route53:ChangeResourceRecordSets',
            'route53:ListResourceRecordSets',
            'route53:GetHostedZone',
          ],
          Resource: zoneArn,
        },
        {
          Effect: 'Allow',
          Action: ['route53:GetChange'],
          Resource: 'arn:aws:route53:::change/*',
        },
      ],
    }),
  });

  return dnsRole;
}

/**
 * Admin stage: creates the delegated zone + NS delegation + DNS role.
 * Any other stage: looks up the existing zone (see `PROJECT_APPS_HOSTED_ZONE_ID`)
 * so `sst dev` without `--stage admin` does not create a second `apps.*` zone.
 */
export function createProjectAppsDomain(parentHostedZoneId: $util.Input<string>, stage: string) {
  if (stage === 'admin') {
    const zone = new aws.route53.Zone('ProjectAppsZone', {
      name: PROJECT_APPS_ROOT_DOMAIN,
      comment: 'Delegated public hosted zone for factory-created apps',
    });

    const delegation = new aws.route53.Record('ProjectAppsZoneDelegation', {
      zoneId: parentHostedZoneId,
      name: PROJECT_APPS_ROOT_DOMAIN,
      type: 'NS',
      ttl: 172800,
      records: zone.nameServers,
      allowOverwrite: true,
    });

    const dnsRole = createProjectAppsDnsRole(zone.arn);
    return { zone, delegation, dnsRole };
  }

  if (!PROJECT_APPS_HOSTED_ZONE_ID) {
    throw new Error(
      'PROJECT_APPS_HOSTED_ZONE_ID is required for non-admin stages when custom DNS is enabled. ' +
        'Use the projectAppsHostedZoneId output from the admin stage.'
    );
  }

  // Look up by zone ID only (do not pass `name` / `privateZone`; those are for name-based lookup).
  const zone = aws.route53.getZoneOutput({
    zoneId: PROJECT_APPS_HOSTED_ZONE_ID,
  });

  const dnsRole = createProjectAppsDnsRole(zone.arn);
  return { zone, delegation: undefined, dnsRole };
}

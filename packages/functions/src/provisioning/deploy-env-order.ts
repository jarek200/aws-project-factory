/** Canonical promotion order for starter-monorepo label-driven deploys. */
export const DEFAULT_DEPLOY_ENV_ORDER = ['int', 'stage', 'prod'] as const;

/** Build comma-separated env list from provisioned account keys (e.g. `int,prod`). */
export function buildDeployEnvOrder(envKeys: string[]): string {
  const normalized = new Set(envKeys.map((k) => k.trim().toLowerCase()).filter(Boolean));
  const ordered = DEFAULT_DEPLOY_ENV_ORDER.filter((k) => normalized.has(k));
  const extras = [...normalized]
    .filter((k) => !(DEFAULT_DEPLOY_ENV_ORDER as readonly string[]).includes(k))
    .sort();
  return [...ordered, ...extras].join(',');
}

/** Env keys that must have deploy:* labels before promoting to `envName`. */
export function priorDeployEnvKeys(deployEnvOrder: string, envName: string): string[] {
  const envs = deployEnvOrder
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const idx = envs.indexOf(envName.trim().toLowerCase());
  if (idx <= 0) return [];
  return envs.slice(0, idx);
}

let isConfigured = false;
let initPromise: Promise<boolean> | null = null;

/**
 * AppSync hostname is `*.appsync-api.<region>.amazonaws.com`.
 * The GraphQL client's `region` must match that segment or Amplify can build
 * invalid signed requests (AppSync: `MalformedHttpRequestException` / `Invalid URI format`).
 *
 * `sst dev` often resolves env consistently; `sst deploy` bakes `import.meta.env`
 * at build time — if `VITE_AWS_REGION` were ever missing or wrong in the
 * bundle, production breaks while local dev still works.
 */
function regionFromAppsyncEndpoint(endpoint: string): string | null {
  try {
    const u = new URL(endpoint);
    const m = u.hostname.match(/\.appsync-api\.([a-z0-9-]+)\.amazonaws\.com$/i);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns true when Amplify is configured (env vars present + running in browser).
 * Returns false in local-only / mock mode (no env vars).
 */
export async function ensureAmplifyConfigured(): Promise<boolean> {
  if (isConfigured) return true;
  if (initPromise) return initPromise;
  initPromise = initializeAmplify();
  return initPromise;
}

async function initializeAmplify(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  const { Amplify } = await import('aws-amplify');

  interface WindowWithEnv extends Window {
    ENV?: Record<string, string>;
    __ADMIN_AMPLIFY_CONFIGURED__?: boolean;
  }
  const win = window as WindowWithEnv;

  if (win.__ADMIN_AMPLIFY_CONFIGURED__) {
    isConfigured = true;
    return true;
  }

  const env = win.ENV || import.meta.env;
  const userPoolId = String(env.VITE_USER_POOL_ID ?? '').trim();
  const userPoolClientId = String(env.VITE_USER_POOL_CLIENT_ID ?? '').trim();
  let graphqlEndpoint = String(env.VITE_GRAPHQL_ENDPOINT ?? '').trim();
  const regionEnv = String(env.VITE_AWS_REGION ?? '').trim();

  if (!userPoolId || !userPoolClientId || !graphqlEndpoint) {
    console.info('[Admin Amplify] No env vars — running in local mock mode');
    return false;
  }

  try {
    const url = new URL(graphqlEndpoint);
    if (url.protocol !== 'https:') {
      console.error('[Admin Amplify] VITE_GRAPHQL_ENDPOINT must be https:', graphqlEndpoint);
      return false;
    }
    graphqlEndpoint = url.toString().replace(/\/$/, '');
  } catch {
    console.error(
      '[Admin Amplify] VITE_GRAPHQL_ENDPOINT is not a valid URL (AppSync returns Invalid URI format):',
      graphqlEndpoint
    );
    return false;
  }

  const region = regionEnv || regionFromAppsyncEndpoint(graphqlEndpoint) || 'us-east-1';

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        loginWith: { email: true },
      },
    },
    API: {
      GraphQL: {
        endpoint: graphqlEndpoint,
        region,
        defaultAuthMode: 'userPool',
      },
    },
  });

  win.__ADMIN_AMPLIFY_CONFIGURED__ = true;
  isConfigured = true;
  console.log('[Admin Amplify] Configured ✅', {
    region,
    endpointHost: new URL(graphqlEndpoint).hostname,
  });
  return true;
}

/** True when SST env vars are present — used to switch between real/mock mode */
export function isLiveMode(): boolean {
  if (typeof window === 'undefined') return false;
  interface WindowWithEnv extends Window {
    ENV?: Record<string, string>;
  }
  const env = (window as WindowWithEnv).ENV || import.meta.env;
  const ep = String(env.VITE_GRAPHQL_ENDPOINT ?? '').trim();
  return !!(
    String(env.VITE_USER_POOL_ID ?? '').trim() &&
    String(env.VITE_USER_POOL_CLIENT_ID ?? '').trim() &&
    ep
  );
}

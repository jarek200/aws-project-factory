<script lang="ts">
import { browser } from '$app/environment';
import { page } from '$app/state';
import { isLiveMode } from '$lib/amplify';
import { auth } from '$lib/stores/auth';

const onProjects = $derived(page.route.id === '/dashboard');
const onAwsOrgs = $derived(page.route.id === '/org-accounts');

const linkBase =
  'font-mono font-medium text-xs uppercase tracking-wide underline-offset-4 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm';

/** Same scale as text-xs nav links (~one line / cap height), not a large control. */
const compactControl =
  'inline-flex size-4 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/**
 * IAM Identity Center access portal (not Cognito admin login).
 * Precedence: `VITE_SSO_URL` → localStorage `admin.ssoPortalUrl` → org default below.
 */
const SSO_PORTAL_FALLBACK = 'https://d-9367998abd.awsapps.com/start/';
const SSO_PORTAL_STORAGE_KEY = 'admin.ssoPortalUrl';

const ssoUrlFromEnv = String(import.meta.env.VITE_SSO_URL ?? '').trim();

function readSsoPortalFromStorage(): string {
  if (!browser) return '';
  try {
    const v = localStorage.getItem(SSO_PORTAL_STORAGE_KEY)?.trim() ?? '';
    if (v && /^https?:\/\//i.test(v)) return v;
  } catch {
    /* private mode */
  }
  return '';
}

let ssoUrlOverride = $state(readSsoPortalFromStorage());

const ssoPortalUrl = $derived(ssoUrlFromEnv || ssoUrlOverride || SSO_PORTAL_FALLBACK);
</script>

<header
  class="sticky top-0 z-30 w-full min-w-0 border-border border-b bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/80"
>
  <!-- Match `<main>`: horizontal padding on the outer shell, then `max-w-7xl` so width aligns with tables. -->
  <div class="px-6 md:px-10 lg:px-14">
    <div
      class="mx-auto flex w-full min-w-0 max-w-7xl items-center justify-between gap-4 py-3 md:py-3.5"
    >
      <nav class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" aria-label="Main">
        <a
          href="/dashboard"
          class="{linkBase} {onProjects
            ? 'text-foreground'
            : 'text-muted-foreground hover:text-foreground hover:underline'}"
          aria-current={onProjects ? 'page' : undefined}
        >
          Projects
        </a>
        <span class="font-mono text-muted-foreground/50 text-xs" aria-hidden="true">/</span>
        <a
          href="/org-accounts"
          class="{linkBase} {onAwsOrgs
            ? 'text-foreground'
            : 'text-muted-foreground hover:text-foreground hover:underline'}"
          aria-current={onAwsOrgs ? 'page' : undefined}
        >
          AWS orgs
        </a>
      </nav>
      <div class="flex shrink-0 items-center gap-1">
        <a
          href={ssoPortalUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="{compactControl}"
          aria-label="Open IAM Identity Center portal (new tab)"
          title="IAM Identity Center / AWS SSO portal"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            class="block shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
          </svg>
        </a>
        <button
          type="button"
          class="{compactControl}"
          aria-label={isLiveMode() ? 'Log out' : 'Leave'}
          title={isLiveMode() ? 'Log out' : 'Leave'}
          onclick={() => void auth.logout()}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            class="block shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" x2="9" y1="12" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</header>

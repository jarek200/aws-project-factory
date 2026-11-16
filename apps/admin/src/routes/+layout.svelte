<script lang="ts">
import { fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';
import type { Snippet } from 'svelte';
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { ensureAmplifyConfigured, isLiveMode } from '$lib/amplify';
import AppNavbar from '$lib/components/app-navbar.svelte';
import BrandMark from '$lib/components/brand-mark.svelte';
import { auth } from '$lib/stores/auth';
import '../app.css';

interface Props {
  children?: Snippet;
}

let { children }: Props = $props();

/** Wordmark hidden where the app navbar replaces it (dashboard, org accounts). */
let layoutHeaderClass = $derived(
  page.route.id === '/dashboard' || page.route.id === '/org-accounts' ? 'hidden' : ''
);

let showAppNavbar = $derived(page.route.id === '/dashboard' || page.route.id === '/org-accounts');

let isSignInPage = $derived(page.url.pathname === '/');

// Auth guard: on protected routes (dashboard), check session
$effect(() => {
  if (!browser) return;
  const isProtected = page.route.id === '/dashboard' || page.route.id === '/org-accounts';
  if (!isProtected) return;
  if (!isLiveMode()) return; // Local mock: no guard needed

  (async () => {
    try {
      await ensureAmplifyConfigured();
      const [u, session] = await Promise.all([getCurrentUser(), fetchAuthSession()]);
      if (u && session.tokens) {
        auth.setUser({ id: u.userId, email: u.signInDetails?.loginId ?? '' });
      } else {
        goto('/?redirect=/dashboard', { replaceState: true });
      }
    } catch {
      goto('/?redirect=/dashboard', { replaceState: true });
    } finally {
      auth.setLoading(false);
    }
  })();
});
</script>

<div class="relative min-h-dvh min-w-0 overflow-x-hidden text-foreground">
  {#if showAppNavbar}
    <AppNavbar />
  {/if}
  <header
    class="pointer-events-none absolute top-8 left-6 z-10 md:top-10 md:left-10 lg:top-12 lg:left-14 {layoutHeaderClass}"
  >
    {#if isSignInPage}
      <span class="sr-only">AWS Project Factory</span>
      <div class="flex border-white/75 border-l-2 pl-5 md:items-center">
        <p
          class="m-0 max-w-[20rem] font-display text-[11px] font-medium leading-snug tracking-[0.22em] text-white/90 md:max-w-none md:text-sm"
        >
          AWS Project Factory
        </p>
      </div>
    {:else}
      <span class="sr-only md:hidden">AWS Project Factory</span>
      <div class="flex md:hidden">
        <BrandMark class="size-[2.25rem] shrink-0 text-foreground" />
      </div>
      <div
        class="hidden items-center gap-3 border-foreground pl-5 [border-left-width:2px] md:flex"
      >
        <BrandMark class="size-[1.35rem] shrink-0 text-foreground" />
        <p
          class="m-0 max-w-[20rem] font-display text-[11px] font-medium leading-snug tracking-[0.22em] text-muted-foreground md:max-w-none md:text-sm"
        >
          AWS Project Factory
        </p>
      </div>
    {/if}
  </header>

  {@render children?.()}
</div>

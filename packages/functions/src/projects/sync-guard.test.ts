import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.TABLE_NAME = process.env.TABLE_NAME || 'test-table';
});

describe('normalizeProjectSlug', () => {
  it('normalizes like the dashboard slugify', async () => {
    const { normalizeProjectSlug } = await import('./slug-reservation');
    expect(normalizeProjectSlug(' My App ')).toBe('my-app');
    expect(normalizeProjectSlug('Foo_Bar!')).toBe('foobar');
  });

  it('rejects empty after normalize', async () => {
    const { normalizeProjectSlug } = await import('./slug-reservation');
    expect(normalizeProjectSlug('!!!')).toBe('');
  });
});

describe('isSafeToSyncDelete', () => {
  it('blocks in-progress phases even with a githubUrl', async () => {
    const { isSafeToSyncDelete } = await import('./sync-with-github');
    expect(
      isSafeToSyncDelete({
        provisioningPhase: 'GITHUB',
        githubUrl: 'https://github.com/org/repo',
      })
    ).toBe(false);
    expect(
      isSafeToSyncDelete({
        provisioningPhase: 'ACCOUNTS',
        githubUrl: 'https://github.com/org/repo',
      })
    ).toBe(false);
    expect(
      isSafeToSyncDelete({
        provisioningPhase: 'CONFIGURE',
        githubUrl: 'https://github.com/org/repo',
      })
    ).toBe(false);
  });

  it('blocks REPO_ONLY without githubUrl (configure still running)', async () => {
    const { isSafeToSyncDelete } = await import('./sync-with-github');
    expect(
      isSafeToSyncDelete({
        provisioningPhase: 'REPO_ONLY',
        githubUrl: null,
      })
    ).toBe(false);
  });

  it('allows terminal phases with githubUrl', async () => {
    const { isSafeToSyncDelete } = await import('./sync-with-github');
    expect(
      isSafeToSyncDelete({
        provisioningPhase: 'DONE',
        githubUrl: 'https://github.com/org/repo',
      })
    ).toBe(true);
    expect(
      isSafeToSyncDelete({
        provisioningPhase: 'REPO_ONLY',
        githubUrl: 'https://github.com/org/repo',
      })
    ).toBe(true);
    expect(
      isSafeToSyncDelete({
        provisioningPhase: 'FAILED',
        githubUrl: 'https://github.com/org/repo',
      })
    ).toBe(true);
  });

  it('never deletes on slug fallback alone', async () => {
    const { isSafeToSyncDelete } = await import('./sync-with-github');
    expect(
      isSafeToSyncDelete({
        provisioningPhase: 'FAILED',
        slug: 'my-app',
        githubOrg: 'org',
        githubUrl: null,
      })
    ).toBe(false);
  });
});

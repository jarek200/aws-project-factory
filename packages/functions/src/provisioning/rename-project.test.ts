import { describe, expect, it } from 'vitest';

import { applyProjectRename, buildProjectRenameOptions } from './rename-project';

describe('rename-project', () => {
  it('builds rename options from slug and github org', () => {
    expect(buildProjectRenameOptions({ slug: 'My-App', githubOrg: 'MyCompany' })).toEqual({
      scope: 'mycompany',
      app: 'my-app',
      sso: 'mycompany',
    });
  });

  it('replaces package scope and app name', () => {
    const input = '{"name":"@sst-monorepo/web","root":"sst-monorepo-starter"}';
    expect(
      applyProjectRename(input, 'package.json', { scope: 'acme', app: 'billing', sso: 'acme' })
    ).toBe('{"name":"@acme/web","root":"billing"}');
  });

  it('replaces SSO placeholder only in package.json and README', () => {
    const readme = 'aws sso login --sso-session=acme';
    const other = 'aws sso login --sso-session=acme';

    expect(
      applyProjectRename(readme, 'README.md', { scope: 'acme', app: 'billing', sso: 'corp' })
    ).toContain('corp');
    expect(
      applyProjectRename(other, 'sst.config.ts', { scope: 'acme', app: 'billing', sso: 'corp' })
    ).toContain('acme');
  });
});

/** Parse `owner/repo` from a github.com URL (html or .git). */
export function repoFullNameFromGithubUrl(url: string | null | undefined): string {
  if (!url?.trim()) return '';
  const m = url.trim().match(/github\.com\/([^/]+\/[^/#?]+)/i);
  if (!m) return '';
  return m[1].replace(/\.git$/i, '');
}

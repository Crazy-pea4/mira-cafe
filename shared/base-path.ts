export function normalizeBasePath(value = ''): string {
  if (value === '' || value === '/') return '';
  const path = value.replace(/\/$/, '');
  if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) throw new Error('Invalid MIRA_BASE_PATH');
  return path;
}
export function withBasePath(base: string, path: string): string {
  return normalizeBasePath(base) + '/' + path.replace(/^\/+/, '');
}

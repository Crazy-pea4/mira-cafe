import { normalizeBasePath } from '../shared/base-path';
export type Deployment = { basePath: string; publicOrigin?: string; auth?: { passwordHash: string; sessionMs?: number } };
export function isLoopback(hostname: string) { return ['127.0.0.1','localhost','[::1]'].includes(hostname); }
export function resolveDeployment(env: Record<string,string|undefined>): Deployment {
  const basePath = normalizeBasePath(env.MIRA_BASE_PATH);
  let publicOrigin: string | undefined;
  if (env.MIRA_PUBLIC_ORIGIN) {
    const url = new URL(env.MIRA_PUBLIC_ORIGIN);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))) throw new Error('Invalid MIRA_PUBLIC_ORIGIN');
    publicOrigin = url.origin;
  }
  const required = env.MIRA_AUTH_REQUIRED === 'true';
  if (publicOrigin && !isLoopback(new URL(publicOrigin).hostname) && !required) throw new Error('Public deployment requires authentication');
  if (!required) return { basePath, publicOrigin };
  if (!publicOrigin || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(env.MIRA_PASSWORD_HASH ?? '')) throw new Error('Authentication requires an origin and a valid password hash');
  return { basePath, publicOrigin, auth: { passwordHash: env.MIRA_PASSWORD_HASH! } };
}
export function originAllowed(origin: string|undefined, host: string|undefined, publicOrigin?: string) {
  try {
    const url = new URL(origin ?? '');
    if (url.origin !== origin || url.host !== host) return false;
    return publicOrigin ? origin === publicOrigin : isLoopback(url.hostname) && ['http:','https:'].includes(url.protocol);
  } catch { return false; }
}

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deployment } from './deployment';
import { originAllowed } from './deployment';
import { withBasePath } from '../shared/base-path';
declare module 'fastify' {
  interface FastifyRequest {
    miraSession: string | null;
  }
}
const SESSION_MS = 8 * 60 * 60_000;
const COOKIE = 'mira_session';
type Session = {
  expires: number;
  timer: ReturnType<typeof setTimeout>;
  listeners: Set<() => void>;
};
function digest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
function keyFor(request: FastifyRequest) {
  const matches = (request.headers.cookie ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(COOKIE + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token) : null;
}
function verify(password: string, encoded: string): Promise<boolean> {
  const [, salt, hash] = encoded.split('$');
  return new Promise((resolve, reject) =>
    scrypt(password, Buffer.from(salt, 'hex'), 64, (error, key) => {
      if (error) reject(error);
      else resolve(timingSafeEqual(key, Buffer.from(hash, 'hex')));
    }),
  );
}
function loginPage(base: string, error = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>进入咖啡馆 · Mira</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#191c26;color:#eee1ce;font:16px system-ui}
  main{width:min(100%,360px)}small{letter-spacing:3px;color:#c2a787}h1{font:36px Georgia,serif;font-weight:400}p{line-height:1.8;color:#c7bdb2}label{display:block;margin:24px 0 8px}input,button{width:100%;min-height:48px;border-radius:9px;font:inherit}input{background:#252936;color:inherit;border:1px solid #a58b6e;padding:12px}button{margin-top:14px;border:0;background:#d8b789;color:#27232a;cursor:pointer}:focus-visible{outline:3px solid #f1cb93;outline-offset:4px}.access-note{margin-top:24px;padding:14px 16px;border:1px solid #51483e;border-radius:9px;background:#22232b;font-size:14px}.access-note strong{color:#d8b789;font-weight:500}.access-note p{margin:6px 0 0}.error{color:#f1b6a5}</style></head><body><main><small>MIRA CAFÉ</small><h1>雨停之前</h1><p>输入邀请密码，进来坐一会儿。</p><aside class="access-note" aria-label="演示访问保护"><strong>演示访问保护</strong><p>本演示调用付费 AI API，共享邀请密码仅用于防止接口被滥用，不涉及账号注册或个人账号登录。</p></aside>${error ? '<p class="error" role="alert">' + error + '</p>' : ''}<form method="post" action="${withBasePath(base, 'auth/login')}"><label for="password">邀请密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button type="submit">进入咖啡馆</button></form></main></body></html>`;
}
export function registerAccess(app: FastifyInstance, deployment: Deployment) {
  const { basePath, publicOrigin, auth } = deployment;
  const path = (suffix: string) => withBasePath(basePath, suffix);
  const sessions = new Map<string, Session>();
  const failures = new Map<string, { attempts: number; until: number }>();
  let verifying = 0;
  function revoke(key: string) {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    clearTimeout(session.timer);
    for (const listener of session.listeners) listener();
  }
  function active(key: string | null) {
    if (!auth) return true;
    const session = key ? sessions.get(key) : undefined;
    if (session && session.expires > Date.now()) return true;
    if (key) revoke(key);
    return false;
  }
  const watch = (key: string | null, listener: () => void) => {
    if (!auth) return () => {};
    if (!key || !active(key)) {
      listener();
      return () => {};
    }
    const session = sessions.get(key)!;
    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
    };
  };
  app.decorateRequest('miraSession', null);
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    if (publicOrigin && request.headers.host !== new URL(publicOrigin).host)
      return reply.code(404).send();
    if (basePath && pathname !== basePath && !pathname.startsWith(basePath + '/'))
      return reply.code(404).send();
    if (!auth) return;
    reply
      .header('Cache-Control', 'no-store, private')
      .header('Vary', 'Cookie')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'same-origin');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      !originAllowed(request.headers.origin, request.headers.host, publicOrigin)
    )
      return reply.code(403).send({ error: { code: 'ORIGIN', message: '请从当前页面操作。' } });
    request.miraSession = keyFor(request);
    if (
      (request.method === 'GET' && (pathname === path('login') || pathname === basePath)) ||
      (request.method === 'POST' && pathname === path('auth/login'))
    )
      return;
    if (active(request.miraSession)) return;
    if (request.method === 'GET' && pathname === path(''))
      return reply.redirect(path('login'), 303);
    return reply.code(401).send({
      error: { code: 'AUTH_REQUIRED', message: '会话已结束，请刷新页面重新输入邀请密码。' },
    });
  });
  if (basePath) app.get(basePath, async (_request, reply) => reply.redirect(path(''), 308));
  if (auth) {
    const secure = publicOrigin!.startsWith('https:');
    const cookie = (value: string, age: number) =>
      `${COOKIE}=${value}; Path=${path('')}; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        const params = new URLSearchParams(String(body));
        done(
          null,
          params.size === 1 && params.has('password') ? { password: params.get('password') } : {},
        );
      },
    );
    app.get(path('login'), async (request, reply) =>
      active(keyFor(request))
        ? reply.redirect(path(''), 303)
        : reply.type('text/html').send(loginPage(basePath)),
    );
    app.post(path('auth/login'), { bodyLimit: 2048 }, async (request, reply) => {
      const now = Date.now();
      for (const [ip, value] of failures) if (value.until <= now) failures.delete(ip);
      const failure = failures.get(request.ip);
      if ((failure && failure.attempts >= 5) || verifying >= 2 || failures.size >= 2048)
        return reply
          .code(429)
          .header('Retry-After', '60')
          .type('text/html')
          .send(loginPage(basePath, '尝试太频繁，请一分钟后再试。'));
      const password = (request.body as { password?: unknown } | undefined)?.password;
      let correct = false;
      verifying++;
      try {
        correct =
          typeof password === 'string' &&
          password.length > 0 &&
          password.length <= 256 &&
          (await verify(password, auth.passwordHash));
      } catch {
        return reply
          .code(503)
          .type('text/html')
          .send(loginPage(basePath, '暂时无法验证，请稍后再试。'));
      } finally {
        verifying--;
      }
      if (!correct) {
        const latest = failures.get(request.ip);
        failures.set(request.ip, {
          attempts: (latest?.attempts ?? 0) + 1,
          until: latest?.until ?? now + 60_000,
        });
        return reply
          .code(401)
          .type('text/html')
          .send(loginPage(basePath, '密码不正确，请再试一次。'));
      }
      failures.delete(request.ip);
      const old = keyFor(request);
      if (old) revoke(old);
      while (sessions.size >= 256) revoke(sessions.keys().next().value!);
      const token = randomBytes(32).toString('base64url'),
        key = digest(token),
        ttl = auth.sessionMs ?? SESSION_MS;
      const timer = setTimeout(() => revoke(key), ttl).unref();
      sessions.set(key, { expires: Date.now() + ttl, timer, listeners: new Set() });
      return reply
        .header('Set-Cookie', cookie(token, Math.floor(ttl / 1000)))
        .redirect(path(''), 303);
    });
    app.post(path('auth/logout'), async (request, reply) => {
      if (request.miraSession) revoke(request.miraSession);
      return reply.header('Set-Cookie', cookie('', 0)).redirect(path('login'), 303);
    });
  }
  app.addHook('onClose', async () => {
    for (const key of sessions.keys()) revoke(key);
    failures.clear();
  });
  return { enabled: !!auth, active, watch };
}

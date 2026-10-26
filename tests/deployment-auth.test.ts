import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildApp } from '../server/app';
import { registerWeb } from '../server/web';
import { originAllowed, resolveDeployment, type Deployment } from '../server/deployment';
import { normalizeBasePath, withBasePath } from '../shared/base-path';
import type { DialogueProvider } from '../server/providers';
import type { SpeechProvider } from '../server/speech';
const password = 'temporary-test-invitation';
const salt = randomBytes(16);
const passwordHash =
  'scrypt$' + salt.toString('hex') + '$' + scryptSync(password, salt, 64).toString('hex');
const deployment: Deployment = {
  basePath: '/mira',
  publicOrigin: 'https://iamm.xyz',
  auth: { passwordHash },
};
const headers = { host: 'iamm.xyz', origin: 'https://iamm.xyz' };
const turn = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  turnId: 1,
  text: '你好',
  history: [],
  fault: 'none',
};
const result = {
  segments: [{ text: '你好。', emotion: 'curious' as const, action: 'idle' as const }],
};
function setup(
  settings: Deployment = deployment,
  speech?: SpeechProvider,
  override?: DialogueProvider,
) {
  const reply = vi.fn(async () => result);
  const app = buildApp(override ?? { kind: 'deepseek', reply }, 18000, speech, undefined, settings);
  const login = async (cookie?: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/mira/auth/login',
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
      payload: { password },
    });
    expect(response.statusCode).toBe(303);
    return String(response.headers['set-cookie']).split(';')[0];
  };
  return { app, reply, login };
}
afterEach(() => vi.useRealTimers());
describe('protected /mira deployment with ephemeral test passwords and fake providers', () => {
  it('fails closed for incomplete public configuration and never broadens the origin to www', () => {
    expect(resolveDeployment({})).toEqual({ basePath: '', publicOrigin: undefined });
    expect(() => resolveDeployment({ MIRA_PUBLIC_ORIGIN: 'https://iamm.xyz' })).toThrow(
      'authentication',
    );
    expect(() =>
      resolveDeployment({ MIRA_AUTH_REQUIRED: 'true', MIRA_PUBLIC_ORIGIN: 'https://iamm.xyz' }),
    ).toThrow('password hash');
    for (const value of [
      'http://iamm.xyz',
      'https://name:password@iamm.xyz',
      'https://iamm.xyz/mira',
      'https://iamm.xyz?x=1',
    ])
      expect(() => resolveDeployment({ MIRA_PUBLIC_ORIGIN: value })).toThrow();
    expect(originAllowed('https://www.iamm.xyz', 'www.iamm.xyz', deployment.publicOrigin)).toBe(
      false,
    );
    expect(
      originAllowed('https://iamm.xyz.evil.test', 'iamm.xyz.evil.test', deployment.publicOrigin),
    ).toBe(false);
    expect(originAllowed('https://iamm.xyz', 'iamm.xyz', deployment.publicOrigin)).toBe(true);
    expect(() => normalizeBasePath('/mira/../')).toThrow();
    expect(withBasePath('/mira/', '/api/speech')).toBe('/mira/api/speech');
  });
  it('protects HTML, every API, assets, microphone worklet and WS before any provider is reached', async () => {
    const s = setup(),
      dir = mkdtempSync(join(tmpdir(), 'mira-auth-'));
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'index.html'), '<html>private scene</html>');
      writeFileSync(join(dir, 'assets', 'app.js'), 'private script');
      writeFileSync(join(dir, 'mic-worklet.js'), 'private worklet');
      writeFileSync(join(dir, 'mira-build.json'), JSON.stringify({ basePath: '/mira' }));
      await registerWeb(s.app, dir, '/mira');
      const canonical = await s.app.inject({ url: '/mira', headers });
      expect(canonical.headers.location).toBe('/mira/');
      const page = await s.app.inject({ url: '/mira/', headers });
      expect(page.statusCode).toBe(303);
      expect(page.headers.location).toBe('/mira/login');
      expect(page.body).not.toContain('private scene');
      for (const url of ['/mira/assets/app.js', '/mira/mic-worklet.js', '/mira/api/health'])
        expect((await s.app.inject({ url, headers })).statusCode).toBe(401);
      for (const route of ['turn', 'cancel', 'presented'])
        expect(
          (
            await s.app.inject({
              method: 'POST',
              url: '/mira/api/' + route,
              headers,
              payload: turn,
            })
          ).statusCode,
        ).toBe(401);
      await s.app.ready();
      await expect(s.app.injectWS('/mira/api/speech', { headers })).rejects.toThrow('401');
      for (const url of ['/', '/api/health', '/mira-other/', '/fetiao/'])
        expect((await s.app.inject({ url, headers })).statusCode).toBe(404);
      expect(
        (await s.app.inject({ url: '/mira/login', headers: { host: 'www.iamm.xyz' } })).statusCode,
      ).toBe(404);
      expect(s.reply).not.toHaveBeenCalled();
      const cookie = await s.login();
      for (const url of ['/mira/', '/mira/assets/app.js', '/mira/mic-worklet.js'])
        expect((await s.app.inject({ url, headers: { ...headers, cookie } })).statusCode).toBe(200);
      expect(
        (await s.app.inject({ url: '/mira/', headers: { ...headers, cookie } })).body,
      ).toContain('private scene');
      expect(
        (await s.app.inject({ url: '/mira/api/health', headers: { ...headers, cookie } })).body,
      ).not.toContain(passwordHash);
    } finally {
      await s.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('uses HttpOnly, Secure, same-site, path-scoped cookies; rejects wrong password, forged cookies and cross-origin login', async () => {
    const s = setup();
    try {
      const page = await s.app.inject({ url: '/mira/login', headers });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('type="password"');
      expect(page.body).not.toContain(passwordHash);
      expect(page.headers['referrer-policy']).toBe('same-origin');
      const wrong = await s.app.inject({
        method: 'POST',
        url: '/mira/auth/login',
        headers,
        payload: { password: 'incorrect' },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.headers['set-cookie']).toBeUndefined();
      const foreign = await s.app.inject({
        method: 'POST',
        url: '/mira/auth/login',
        headers: { ...headers, origin: 'https://www.iamm.xyz' },
        payload: { password },
      });
      expect(foreign.statusCode).toBe(403);
      const response = await s.app.inject({
        method: 'POST',
        url: '/mira/auth/login',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'password=' + encodeURIComponent(password),
      });
      const cookie = String(response.headers['set-cookie']);
      expect(cookie).toMatch(/Path=\/mira\//);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('Max-Age=28800');
      expect(cookie).not.toContain(password);
      expect(
        (
          await s.app.inject({
            url: '/mira/api/health',
            headers: {
              ...headers,
              cookie: 'mira_session=' + randomBytes(32).toString('base64url'),
            },
          })
        ).statusCode,
      ).toBe(401);
      const valid = cookie.split(';')[0];
      expect(
        (
          await s.app.inject({
            url: '/mira/api/health',
            headers: { ...headers, cookie: valid + '; ' + valid },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/mira/api/turn',
            headers: { ...headers, cookie: valid, origin: 'https://foreign.test' },
            payload: turn,
          })
        ).statusCode,
      ).toBe(403);
      expect(s.reply).not.toHaveBeenCalled();
    } finally {
      await s.app.close();
    }
  });
  it('keeps the same conversation UUID isolated between authenticated reviewer sessions', async () => {
    const s = setup();
    try {
      const a = await s.login(),
        b = await s.login();
      for (const cookie of [a, b])
        expect(
          (
            await s.app.inject({
              method: 'POST',
              url: '/mira/api/turn',
              headers: { ...headers, cookie },
              payload: turn,
            })
          ).statusCode,
        ).toBe(200);
      await s.app.inject({
        method: 'POST',
        url: '/mira/api/cancel',
        headers: { ...headers, cookie: b },
        payload: { sessionId: turn.sessionId, throughTurnId: 99 },
      });
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/mira/api/turn',
            headers: { ...headers, cookie: a },
            payload: { ...turn, turnId: 2 },
          })
        ).statusCode,
      ).toBe(200);
      const newer = await s.login(a);
      expect(
        (await s.app.inject({ url: '/mira/api/health', headers: { ...headers, cookie: a } }))
          .statusCode,
      ).toBe(401);
      expect(
        (await s.app.inject({ url: '/mira/api/health', headers: { ...headers, cookie: newer } }))
          .statusCode,
      ).toBe(200);
    } finally {
      await s.app.close();
    }
  });
  it('revokes logout immediately, cancels an in-flight reply and closes active ASR sockets', async () => {
    let signal: AbortSignal | undefined, ttsSignal: AbortSignal | undefined;
    const reply = vi.fn((_r, abort: AbortSignal) => {
      signal = abort;
      return new Promise<typeof result>(() => {});
    });
    const cancel = vi.fn();
    const speech: SpeechProvider = {
      openAsr: () => ({ ready: Promise.resolve(), append: vi.fn(), commit: vi.fn(), cancel }),
      synthesize: vi.fn((_text, abort, chunk) => {
        ttsSignal = abort;
        chunk(new Uint8Array([0, 0]));
        return new Promise<void>(() => {});
      }),
    };
    const s = setup(deployment, speech, { kind: 'deepseek', reply });
    try {
      const cookie = await s.login();
      const work = s.app.inject({
        method: 'POST',
        url: '/mira/api/turn',
        headers: { ...headers, cookie },
        payload: turn,
      });
      await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
      const socket = await s.app.injectWS('/mira/api/speech', { headers: { ...headers, cookie } });
      const ready = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'asr.start', turnId: 1, requestId: turn.sessionId }));
      await ready;
      const tts = await s.app.injectWS('/mira/api/speech', { headers: { ...headers, cookie } });
      const audio = once(tts, 'message');
      tts.send(
        JSON.stringify({ type: 'tts.start', turnId: 1, requestId: turn.sessionId, text: '测试' }),
      );
      await audio;
      const closed = Promise.all([once(socket, 'close'), once(tts, 'close')]);
      const logout = await s.app.inject({
        method: 'POST',
        url: '/mira/auth/logout',
        headers: { ...headers, cookie },
      });
      await closed;
      expect(cancel).toHaveBeenCalled();
      expect(signal?.aborted).toBe(true);
      expect(ttsSignal?.aborted).toBe(true);
      expect((await work).statusCode).toBe(409);
      expect(logout.headers.location).toBe('/mira/login');
      expect(logout.headers['set-cookie']).toContain('Max-Age=0');
      expect(
        (await s.app.inject({ url: '/mira/api/health', headers: { ...headers, cookie } }))
          .statusCode,
      ).toBe(401);
      await expect(
        s.app.injectWS('/mira/api/speech', { headers: { ...headers, cookie } }),
      ).rejects.toThrow('401');
    } finally {
      await s.app.close();
    }
  });
  it('expires sessions and does not accept their cookies after a restart', async () => {
    const s = setup({ ...deployment, auth: { passwordHash, sessionMs: 60 } });
    let cookie = '';
    try {
      cookie = await s.login();
      await vi.waitFor(
        async () =>
          expect(
            (await s.app.inject({ url: '/mira/api/health', headers: { ...headers, cookie } }))
              .statusCode,
          ).toBe(401),
        { timeout: 1000 },
      );
    } finally {
      await s.app.close();
    }
    const fresh = setup();
    try {
      expect(
        (await fresh.app.inject({ url: '/mira/api/health', headers: { ...headers, cookie } }))
          .statusCode,
      ).toBe(401);
    } finally {
      await fresh.app.close();
    }
  });
  it('limits failed password guesses only, then permits another attempt after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = setup();
    try {
      for (let i = 0; i < 5; i++)
        expect(
          (
            await s.app.inject({
              method: 'POST',
              url: '/mira/auth/login',
              headers,
              payload: { password: 'incorrect' },
            })
          ).statusCode,
        ).toBe(401);
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/mira/auth/login',
            headers,
            payload: { password },
          })
        ).statusCode,
      ).toBe(429);
      vi.setSystemTime(Date.now() + 61_000);
      const cookie = await s.login();
      expect(
        (await s.app.inject({ url: '/mira/api/health', headers: { ...headers, cookie } })).json()
          .usagePolicy.localLimits,
      ).toBe(false);
    } finally {
      await s.app.close();
    }
  });
  it('keeps local root Mock mode available without passwords or public origins', async () => {
    const s = setup({ basePath: '' });
    try {
      expect((await s.app.inject('/api/health')).json()).toMatchObject({
        authentication: { required: false },
      });
    } finally {
      await s.app.close();
    }
  });
});

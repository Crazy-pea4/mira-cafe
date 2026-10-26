// Local production-bundle check: temporary password, isolated state, no keys/network providers.
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
const root = process.cwd(),
  work = await mkdtemp(join(tmpdir(), 'mira-bundle-check-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const origin = 'http://127.0.0.1:' + port,
  base = origin + '/mira';
const password = randomBytes(24).toString('base64url'),
  salt = randomBytes(16);
const passwordHash =
  'scrypt$' + salt.toString('hex') + '$' + scryptSync(password, salt, 64).toString('hex');
const child = spawn(process.execPath, [resolve(root, 'build/server/index.js')], {
  cwd: work,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'production',
    PORT: String(port),
    MIRA_ENABLE_LIVE_APIS: 'false',
    MIRA_BASE_PATH: '/mira',
    MIRA_PUBLIC_ORIGIN: origin,
    MIRA_AUTH_REQUIRED: 'true',
    MIRA_PASSWORD_HASH: passwordHash,
    MIRA_STATIC_DIR: resolve(root, 'build/client'),
    MIRA_STATE_DIR: join(work, 'state'),
  },
});
child.stdout.resume();
child.stderr.resume();
const stopped = once(child, 'exit');
let count = 0;
const request = (url, options = {}) => fetch(origin + url, { redirect: 'manual', ...options });
const status = async (url, expected, options) => {
  const res = await request(url, options);
  assert.equal(res.status, expected, url);
  count++;
  return res;
};
const wsResult = (headers) =>
  new Promise((resolveResult, reject) => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/mira/api/speech', { headers });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('WS timed out'));
    }, 3000);
    socket.on('error', () => {});
    socket.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      socket.terminate();
      resolveResult(res.statusCode);
    });
    socket.once('open', () => {
      clearTimeout(timer);
      socket.close();
      resolveResult(101);
    });
  });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Bundle exited before readiness');
    try {
      if ((await request('/mira/api/health')).status === 401) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(ready, true, 'Bundle ready');
  assert.equal((await status('/mira', 308)).headers.get('location'), '/mira/');
  assert.equal((await status('/mira/', 303)).headers.get('location'), '/mira/login');
  await status('/mira/login', 200);
  await status('/', 404);
  await status('/api/health', 404);
  await status('/mira/auth/login', 401, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=wrong',
  });
  const login = await status('/mira/auth/login', 303, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0],
    headers = { cookie, origin };
  const page = await status('/mira/', 200, { headers }),
    html = await page.text();
  await status('/mira/', 200, { headers }); // Refresh uses the same protected canonical URL.
  assert.match(page.headers.get('cache-control'), /no-store/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const assets = [...html.matchAll(/(?:src|href)="(\/mira\/assets\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(assets.length >= 2);
  assets.push(
    '/mira/mic-worklet.js',
    '/mira/characters/mira/mira-amber-neutral-v3.png',
    '/mira/backgrounds/mira-cafe-galgame-background.png',
  );
  for (const path of assets) {
    await status(path, 401);
    await status(path, 200, { headers });
  }
  const health = await (await status('/mira/api/health', 200, { headers })).json();
  assert.equal(health.provider, 'mock');
  assert.equal(health.speechAvailable, false);
  const turn = await status('/mira/api/turn', 200, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: '22222222-2222-4222-8222-222222222222',
      turnId: 1,
      text: '谢谢，外面雨太大了。',
      history: [],
      fault: 'none',
    }),
  });
  assert.ok((await turn.json()).segments.length > 0);
  assert.equal(await wsResult({ origin }), 401);
  count++;
  assert.equal(await wsResult({ cookie, origin: 'http://foreign.test' }), 403);
  count++;
  assert.equal(await wsResult(headers), 101);
  count++;
  await status('/mira/auth/logout', 303, { method: 'POST', headers });
  await status('/mira/api/health', 401, { headers });
  assert.equal(await wsResult(headers), 401);
  count++;
  for (const [overrides, expected] of [
    [{ MIRA_PUBLIC_ORIGIN: 'https://iamm.xyz' }, 'Public deployment requires both live providers'],
    [{ MIRA_BASE_PATH: '/different' }, 'Client and server base paths do not match'],
    [{ MIRA_STATIC_DIR: join(work, 'missing-client') }, 'Deployment client build is missing'],
  ]) {
    const rejected = spawn(process.execPath, [resolve(root, 'build/server/index.js')], {
      cwd: work,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        PORT: String(port),
        MIRA_ENABLE_LIVE_APIS: 'false',
        MIRA_BASE_PATH: '/mira',
        MIRA_PUBLIC_ORIGIN: origin,
        MIRA_AUTH_REQUIRED: 'true',
        MIRA_PASSWORD_HASH: passwordHash,
        MIRA_STATIC_DIR: resolve(root, 'build/client'),
        MIRA_STATE_DIR: join(work, 'state'),
        ...overrides,
      },
    });
    let diagnostic = '';
    rejected.stderr.on('data', (chunk) => {
      diagnostic += chunk.toString();
    });
    const timer = setTimeout(() => rejected.kill('SIGKILL'), 3000);
    const [code] = await once(rejected, 'exit');
    clearTimeout(timer);
    assert.equal(code, 1);
    assert.ok(diagnostic.includes(expected), 'Fail-closed startup reason');
    count++;
  }
  console.log(
    JSON.stringify({
      checks: count,
      result: 'passed',
      bundle: 'production',
      providers: 'local mock only',
      credentials: 'ephemeral in memory',
      audio: 'none',
    }),
  );
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(work, { recursive: true, force: true });
}

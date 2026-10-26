import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../server/app';
import { DeepSeekProvider, MockProvider, type DialogueProvider } from '../server/providers';
import type { Reply, TurnRequest } from '../shared/protocol';
const sessionId = '22222222-2222-4222-8222-222222222222';
const input = (turnId: number) => ({ sessionId, turnId, text: '你好', history: [], fault: 'none' });
const good: Reply = { segments: [{ text: '你好。', emotion: 'curious', action: 'idle' }] };
function controlled() {
  const calls: { request: TurnRequest; signal: AbortSignal; resolve: (reply: Reply) => void }[] =
    [];
  const provider: DialogueProvider = {
    kind: 'mock',
    reply: (request, signal) => new Promise((resolve) => calls.push({ request, signal, resolve })),
  };
  return { provider, calls };
}
describe('API contract, isolation and recovery', () => {
  it('validates request boundaries and unknown fields', async () => {
    const app = buildApp();
    try {
      for (const body of [
        { ...input(1), text: '' },
        { ...input(1), turnId: -1 },
        { ...input(1), execute: 'unknown' },
      ]) {
        expect(
          (await app.inject({ method: 'POST', url: '/api/turn', payload: body })).statusCode,
        ).toBe(400);
      }
      expect((await app.inject('/api/health')).json()).toMatchObject({
        ok: true,
        provider: 'mock',
      });
    } finally {
      await app.close();
    }
  });
  it('prevents a delayed pre-cancel request from starting at all', async () => {
    const { provider, calls } = controlled();
    const app = buildApp(provider);
    try {
      await app.inject({
        method: 'POST',
        url: '/api/cancel',
        payload: { sessionId, throughTurnId: 4 },
      });
      expect(
        (await app.inject({ method: 'POST', url: '/api/turn', payload: input(3) })).statusCode,
      ).toBe(409);
      expect(calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
  it('cancels the older provider and rejects its late result while preserving the new turn', async () => {
    const { provider, calls } = controlled();
    const app = buildApp(provider);
    try {
      const old = app.inject({ method: 'POST', url: '/api/turn', payload: input(1) });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      const fresh = app.inject({ method: 'POST', url: '/api/turn', payload: input(2) });
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[0].signal.aborted).toBe(true);
      calls[1].resolve(good);
      expect((await fresh).json()).toMatchObject({ turnId: 2, provider: 'mock' });
      expect((await old).statusCode).toBe(409);
      calls[0].resolve(good);
      expect(
        (await app.inject({ method: 'POST', url: '/api/turn', payload: input(2) })).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it('times out even if an adapter ignores its abort signal, then permits recovery', async () => {
    let attempts = 0;
    const provider: DialogueProvider = {
      kind: 'mock',
      reply: () => (++attempts === 1 ? new Promise(() => {}) : Promise.resolve(good)),
    };
    const app = buildApp(provider, 20);
    try {
      const failed = await app.inject({ method: 'POST', url: '/api/turn', payload: input(1) });
      expect(failed.statusCode).toBe(504);
      expect(failed.json().error.code).toBe('TIMEOUT');
      expect(
        (await app.inject({ method: 'POST', url: '/api/turn', payload: input(2) })).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
  it('validates provider output rather than forwarding unknown scene commands', async () => {
    const provider: DialogueProvider = {
      kind: 'mock',
      reply: async () =>
        ({
          segments: [{ text: 'unsafe', emotion: 'curious', action: 'run-code' }],
        }) as unknown as Reply,
    };
    const app = buildApp(provider);
    try {
      const result = await app.inject({ method: 'POST', url: '/api/turn', payload: input(1) });
      expect(result.statusCode).toBe(503);
      expect(result.json().error.code).toBe('INVALID_REPLY');
    } finally {
      await app.close();
    }
  });
  it('keeps different sessions independent', async () => {
    const provider: DialogueProvider = { kind: 'mock', reply: async () => good };
    const app = buildApp(provider);
    try {
      const a = await app.inject({ method: 'POST', url: '/api/turn', payload: input(1) });
      const b = await app.inject({
        method: 'POST',
        url: '/api/turn',
        payload: { ...input(1), sessionId: '33333333-3333-4333-8333-333333333333' },
      });
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
describe('provider adapters, without external calls', () => {
  it('triggers the photo on dialogue content and cancels mock delays', async () => {
    const provider = new MockProvider();
    const controller = new AbortController();
    const work = provider.reply({ ...input(1), fault: 'slow', text: '照片' }, controller.signal);
    controller.abort();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    const reply = await provider.reply(
      { ...input(2), fault: 'none', text: '给我看照片' },
      new AbortController().signal,
    );
    expect(reply.segments.some((s) => s.event === 'reveal-photo')).toBe(true);
  });
  it('keeps a cancelled turn from disturbing a newer request', async () => {
    const { provider, calls } = controlled();
    const app = buildApp(provider);
    try {
      const current = app.inject({ method: 'POST', url: '/api/turn', payload: input(3) });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await app.inject({
        method: 'POST',
        url: '/api/cancel',
        payload: { sessionId, throughTurnId: 2 },
      });
      expect(calls[0].signal.aborted).toBe(false);
      calls[0].resolve(good);
      expect((await current).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it('uses a configurable DeepSeek model, JSON response and only validated dialogue output', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) } }] })),
    );
    const provider = new DeepSeekProvider('test-fixture-not-a-real-key', 'test-model', fetcher);
    expect(
      await provider.reply({ ...input(1), fault: 'none' }, new AbortController().signal),
    ).toEqual(good);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'test-model',
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
    });
  });
  it('returns a configuration error without calling external services when no key is supplied', async () => {
    const fetcher = vi.fn();
    const provider = new DeepSeekProvider('', 'test', fetcher);
    await expect(
      provider.reply({ ...input(1), fault: 'none' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

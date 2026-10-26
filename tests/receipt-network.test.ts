import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../src/core/transport';
const receipt = { sessionId: '55555555-5555-4555-8555-555555555555', turnId: 1, through: 1 };
const story = {
  act: 'invitation',
  facts: ['arrival'],
  ending: null,
  planQuote: '',
  declined: false,
};
const accepted = () => new Response(JSON.stringify({ ...receipt, sessionId: undefined, story }));
const next = {
  sessionId: receipt.sessionId,
  turnId: 2,
  text: '继续',
  history: [],
  fault: 'none' as const,
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('live receipt recovery without another model request', () => {
  it('accepts a valid 4.5-second response instead of permanently breaking the next turn', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(accepted()), 4500);
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      ),
    );
    const task = new HttpTransport().presented(receipt);
    await vi.advanceTimersByTimeAsync(4500);
    await expect(task).resolves.toMatchObject({ story });
  });
  it('repeats exactly the lost receipt and keeps cancel/new dialogue behind it', async () => {
    vi.useFakeTimers();
    const paths: string[] = [],
      bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url, init) => {
        paths.push(url);
        bodies.push(init.body);
        if (paths.length === 1)
          return new Promise((_resolve, reject) =>
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            ),
          );
        if (url === '/api/presented') return Promise.resolve(accepted());
        if (url === '/api/cancel') return Promise.resolve(new Response('{}'));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              turnId: 2,
              provider: 'mock',
              segments: [{ text: '继续。', emotion: 'curious', action: 'idle' }],
            }),
          ),
        );
      }),
    );
    const transport = new HttpTransport(),
      ack = transport.presented(receipt);
    const cancel = transport.cancel(receipt.sessionId, 1),
      turn = transport.turn(next, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(9999);
    expect(paths).toEqual(['/api/presented']);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([ack, cancel, turn]);
    expect(paths).toEqual(['/api/presented', '/api/presented', '/api/cancel', '/api/turn']);
    expect(bodies[0]).toBe(bodies[1]);
  });
  it.each([401, 409])(
    'does not retry terminal HTTP %i or issue another paid turn',
    async (status) => {
      const fetcher = vi.fn(async () => new Response('{}', { status }));
      vi.stubGlobal('fetch', fetcher);
      const transport = new HttpTransport();
      await expect(transport.presented(receipt)).rejects.toThrow('同步');
      await expect(transport.turn(next, new AbortController().signal)).rejects.toThrow('同步');
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it('stops after two network timeouts and blocks subsequent model requests', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const transport = new HttpTransport(),
      task = transport.presented(receipt);
    const rejected = expect(task).rejects.toThrow('同步');
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    await expect(transport.turn(next, new AbortController().signal)).rejects.toThrow('同步');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

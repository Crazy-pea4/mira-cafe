import { afterEach, describe, it, expect, vi } from 'vitest';
import { appPath } from '../src/core/app-path';
import { HttpTransport } from '../src/core/transport';
import { LocalSpeechTransport } from '../src/core/speech-transport';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('one base path for client assets, HTTP and WebSocket', () => {
  it.each(['/', '/mira/'])('routes transport requests under %s', async (base) => {
    vi.stubEnv('BASE_URL', base);
    expect(appPath('characters/mira/image.png')).toBe(base + 'characters/mira/image.png');
    expect(appPath('/mic-worklet.js')).toBe(base + 'mic-worklet.js');
    const fetcher = vi.fn(async (_url: unknown) => new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    await new HttpTransport().cancel('22222222-2222-4222-8222-222222222222', 1);
    expect(fetcher.mock.calls[0][0]).toBe(base + 'api/cancel');
    vi.stubGlobal('location', { protocol: 'https:', host: 'iamm.xyz' });
    const factory = vi.fn((_url: string) => ({
      readyState: 0,
      bufferedAmount: 0,
      addEventListener: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    }));
    const abort = new AbortController();
    new LocalSpeechTransport(factory).openAsr(1, abort.signal);
    abort.abort();
    expect(factory.mock.calls[0][0]).toBe('wss://iamm.xyz' + base + 'api/speech');
  });
});

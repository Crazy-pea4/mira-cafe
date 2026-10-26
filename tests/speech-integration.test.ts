import { describe, it, expect } from 'vitest';
import { once } from 'node:events';
import { buildApp } from '../server/app';
import type { SpeechProvider } from '../server/speech';
const id = { requestId: '11111111-1111-4111-8111-111111111111', turnId: 1 };
describe('in-memory WebSocket route integration (no network)', () => {
  it('accepts only local same-origin upgrades and exposes no credentials', async () => {
    const app = buildApp();
    try {
      await app.ready();
      await expect(
        app.injectWS('/api/speech', {
          headers: { origin: 'https://example.com', host: '127.0.0.1:3001' },
        }),
      ).rejects.toThrow('403');
      const socket = await app.injectWS('/api/speech', {
        headers: { origin: 'http://127.0.0.1:3001', host: '127.0.0.1:3001' },
      });
      const event = once(socket, 'message');
      socket.send(JSON.stringify({ ...id, type: 'asr.start' }));
      expect(JSON.parse(String((await event)[0]))).toMatchObject({
        type: 'error',
        code: 'NOT_CONFIGURED',
      });
      socket.close();
    } finally {
      await app.close();
    }
  });
  it('routes fake ASR audio and transcript through the registered websocket plugin', async () => {
    let size = 0;
    const provider: SpeechProvider = {
      openAsr: () => ({
        ready: Promise.resolve(),
        append: (pcm) => {
          size += pcm.length;
        },
        commit: async () => '注入测试',
        cancel: () => {},
      }),
      synthesize: async () => {},
    };
    const app = buildApp(undefined, 18000, provider);
    try {
      await app.ready();
      const socket = await app.injectWS('/api/speech', {
        headers: { origin: 'http://127.0.0.1:3001', host: '127.0.0.1:3001' },
      });
      const ready = once(socket, 'message');
      socket.send(JSON.stringify({ ...id, type: 'asr.start' }));
      expect(JSON.parse(String((await ready)[0])).type).toBe('ready');
      const result = once(socket, 'message');
      socket.send(
        JSON.stringify({
          ...id,
          type: 'asr.audio',
          sampleRate: 16000,
          audio: Buffer.alloc(8000).toString('base64'),
        }),
      );
      socket.send(JSON.stringify({ ...id, type: 'asr.commit' }));
      expect(JSON.parse(String((await result)[0]))).toMatchObject({
        type: 'transcript',
        text: '注入测试',
      });
      expect(size).toBe(8000);
      socket.close();
    } finally {
      await app.close();
    }
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BrowserSpeech } from '../src/core/audio';
import { HttpTransport } from '../src/core/transport';
const input = { sessionId: '44444444-4444-4444-8444-444444444444', turnId: 1, text: 'hello', history: [], fault: 'none' as const };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('silent by default and network recovery', () => {
  it('starts muted and never reaches speech APIs without explicit consent', async () => {
    const speak = vi.fn(); const start = vi.fn();
    vi.stubGlobal('window', { speechSynthesis: { speak } });
    const audio = new BrowserSpeech();
    expect(audio.muted).toBe(true);
    await expect(audio.play('不应实际出声。', new AbortController().signal, start)).rejects.toThrow();
    expect(speak).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it('new audio instances do not remember an earlier sound choice', () => {
    const previous = new BrowserSpeech(); previous.muted = false;
    expect(new BrowserSpeech().muted).toBe(true);
  });
  it('turns connection failures into a recoverable message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(new HttpTransport().turn(input, new AbortController().signal)).rejects.toThrow('无法连接本地服务');
  });
  it('bounds a network wait and forwards cancellation', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
    })));
    const work = new HttpTransport().turn(input, new AbortController().signal);
    const assertion = expect(work).rejects.toThrow('连接超时');
    await vi.advanceTimersByTimeAsync(21000); await assertion;
  });
});

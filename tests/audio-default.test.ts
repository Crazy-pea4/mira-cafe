import { describe, it, expect, vi, afterEach } from 'vitest';
import { BrowserSpeech, AudioPlaybackBlocked } from '../src/core/audio';
import { HttpTransport } from '../src/core/transport';
const input = { sessionId: '44444444-4444-4444-8444-444444444444', turnId: 1, text: 'hello', history: [], fault: 'none' as const };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('default reply audio with a user-activation gate and network recovery', () => {
  function speech() {
    const utterances: SpeechSynthesisUtterance[] = [];
    const synthesis = { speak: vi.fn((value: SpeechSynthesisUtterance) => utterances.push(value)), cancel: vi.fn(), getVoices: () => [] };
    vi.stubGlobal('window', { speechSynthesis: synthesis });
    vi.stubGlobal('SpeechSynthesisUtterance', class { onstart = null; onend = null; onerror = null; constructor(public text: string) {} });
    return { synthesis, utterances };
  }
  it('never speaks on construction or before a user gesture', async () => {
    const { synthesis } = speech(); const start = vi.fn();
    const audio = new BrowserSpeech();
    expect(synthesis.speak).not.toHaveBeenCalled();
    await expect(audio.play('不应实际出声。', new AbortController().signal, start)).rejects.toBeInstanceOf(AudioPlaybackBlocked);
    expect(synthesis.speak).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it('plays the next reply after activation without an additional sound toggle or welcome speech', async () => {
    const { synthesis, utterances } = speech(); const audio = new BrowserSpeech();
    audio.unlock(); expect(synthesis.speak).not.toHaveBeenCalled();
    const start = vi.fn(), run = audio.play('仅假音频。', new AbortController().signal, start);
    expect(synthesis.speak).toHaveBeenCalledOnce();
    utterances[0].onstart?.({} as SpeechSynthesisEvent); expect(start).toHaveBeenCalledOnce();
    utterances[0].onend?.({} as SpeechSynthesisEvent); await run;
    await expect(new BrowserSpeech().play('新页面。', new AbortController().signal, vi.fn())).rejects.toBeInstanceOf(AudioPlaybackBlocked);
  });
  it('reports browser blocking and allows a later user gesture without an automatic retry', async () => {
    const { synthesis, utterances } = speech(); const audio = new BrowserSpeech(); audio.unlock();
    const run = audio.play('仅假音频。', new AbortController().signal, vi.fn());
    const assertion = expect(run).rejects.toBeInstanceOf(AudioPlaybackBlocked);
    utterances[0].onerror?.({ error: 'not-allowed' } as SpeechSynthesisErrorEvent); await assertion;
    expect(synthesis.speak).toHaveBeenCalledOnce();
  });
  it('stops immediately and ignores a late start callback after interruption', async () => {
    const { synthesis, utterances } = speech(); const audio = new BrowserSpeech(); audio.unlock(); const start = vi.fn();
    const run = audio.play('仅假音频。', new AbortController().signal, start), late = utterances[0].onstart;
    const assertion = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    audio.stop(); await assertion; late?.call(utterances[0], {} as SpeechSynthesisEvent);
    expect(synthesis.cancel).toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/App';
import { ModeBadge } from '../src/ModeBadge';
import { bindAudioLifecycle } from '../src/core/audio-lifecycle';
import { SceneAudio } from '../src/core/scene-audio';
import { PcmSpeechPlayer } from '../src/core/pcm-playback';
import { AudioPlaybackBlocked } from '../src/core/audio';
import type { SpeechTransport } from '../src/core/speech-transport';
class Events {
  hidden = false;
  listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, fn: EventListener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: EventListener) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string, fields: object = {}) {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ type, isTrusted: true, ...fields } as Event);
  }
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function setup() {
  const page = new Events(),
    document = new Events();
  const audio = { unlockFromGesture: vi.fn(async () => {}), dispose: vi.fn() },
    cancel = vi.fn(),
    notice = vi.fn();
  const close = bindAudioLifecycle(page, document, audio, cancel, notice);
  return { page, document, audio, cancel, notice, close };
}
function pcm() {
  const context = {
    state: 'suspended',
    currentTime: 0,
    resume: vi.fn(async () => {
      context.state = 'running';
    }),
    close: vi.fn(async () => {
      context.state = 'closed';
    }),
    createBuffer: vi.fn(),
  };
  const transport = {
    synthesize: vi.fn(async () => {}),
    openAsr: vi.fn(),
  } as unknown as SpeechTransport;
  const create = vi.fn(() => context as unknown as AudioContext);
  return { context, transport, create, player: new PcmSpeechPlayer(transport, create) };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('trusted interaction and page lifecycle, fake audio only', () => {
  it('renders the product without sound/debug controls and performs no initial model, audio or microphone action', () => {
    const fetch = vi.fn(),
      device = vi.fn(),
      speak = vi.fn(),
      socket = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('AudioContext', device);
    vi.stubGlobal('WebSocket', socket);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: device } });
    vi.stubGlobal('window', { speechSynthesis: { speak } });
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('aria-label="故事进度"');
    expect(html).not.toMatch(/hud-toggle|hud-collapsed|收起对话|展开对话|aria-expanded/);
    expect(html).toContain('雨停之前');
    expect(html).toContain('发送文字');
    expect(html).toContain('正在连接');
    expect(html).not.toMatch(
      /声音关闭|声音开启|体验工具|下一轮演示|演示朗读失败|输入模式|已确认立绘|嘴型|静音模拟|本地开发|PHASE|DeepSeek|MOCK|默认有声|真实语音转文字|本地预留/,
    );
    for (const stub of [fetch, device, speak, socket]) expect(stub).not.toHaveBeenCalled();
  });
  it('labels the no-key dialogue experience as demo mode without technical jargon', () => {
    const html = renderToStaticMarkup(createElement(ModeBadge, { provider: 'mock' }));
    expect(html).toContain('演示模式');
    expect(html).not.toMatch(/MOCK|API|provider/);
  });
  it.each([null, 'deepseek'])('omits model/development labels when provider is %s', (provider) => {
    expect(renderToStaticMarkup(createElement(ModeBadge, { provider }))).toBe('');
  });
  it.each(['pointerdown', 'click', 'keydown'])(
    'unlocks on trusted %s, without a dedicated sound button',
    async (type) => {
      const s = setup();
      expect(s.audio.unlockFromGesture).not.toHaveBeenCalled();
      s.page.emit(type, { key: 'Enter', isTrusted: false });
      expect(s.audio.unlockFromGesture).not.toHaveBeenCalled();
      s.page.emit(type, { key: 'Enter' });
      expect(s.audio.unlockFromGesture).toHaveBeenCalledOnce();
      await flush();
      expect(s.notice).toHaveBeenLastCalledWith('');
      expect(s.cancel).not.toHaveBeenCalled();
      s.close();
    },
  );
  it('does not unlock, resume or cancel sound for HUD fold/restore gestures', async () => {
    const s = setup(),
      target = {
        closest: (selector: string) => (selector === '[data-audio-gesture="ignore"]' ? {} : null),
      };
    for (const type of ['pointerdown', 'click', 'keydown'])
      s.page.emit(type, { target, key: 'Enter' });
    await flush();
    expect(s.audio.unlockFromGesture).not.toHaveBeenCalled();
    expect(s.audio.dispose).not.toHaveBeenCalled();
    expect(s.cancel).not.toHaveBeenCalled();
    s.close();
  });
  it('shows a bounded playback hint then clears it on a later gesture, without replaying a reply', async () => {
    const s = setup();
    s.audio.unlockFromGesture.mockRejectedValueOnce(new AudioPlaybackBlocked());
    s.page.emit('click');
    await flush();
    expect(s.notice).toHaveBeenLastCalledWith(expect.stringContaining('浏览器限制'));
    s.page.emit('click');
    await flush();
    expect(s.notice).toHaveBeenLastCalledWith('');
    s.close();
  });
  it('cleans up on navigation, keeps playback on tab switches, and discards late unlock results', async () => {
    const s = setup();
    let finish!: () => void;
    s.audio.unlockFromGesture.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    s.page.emit('click');
    s.page.emit('pagehide');
    expect(s.cancel).toHaveBeenCalledOnce();
    expect(s.audio.dispose).toHaveBeenCalledOnce();
    finish();
    await flush();
    expect(s.notice).not.toHaveBeenCalled();
    s.document.hidden = true;
    s.document.emit('visibilitychange');
    expect(s.cancel).toHaveBeenCalledTimes(1);
    expect(s.audio.dispose).toHaveBeenCalledTimes(1);
    s.page.emit('click');
    expect(s.audio.unlockFromGesture).toHaveBeenCalledOnce();
    s.close();
    s.document.hidden = false;
    s.page.emit('click');
    expect(s.audio.unlockFromGesture).toHaveBeenCalledOnce();
  });
  it('prepares PCM before live health resolves without synthesis, then reuses the unlocked context', async () => {
    const s = pcm();
    const scene = new SceneAudio(undefined, s.player);
    expect(s.create).not.toHaveBeenCalled();
    const first = scene.unlockFromGesture();
    const same = scene.unlockFromGesture();
    expect(s.context.resume).toHaveBeenCalledOnce();
    expect(same).toBe(first);
    await first;
    scene.live = true;
    await scene.unlockFromGesture();
    expect(s.create).toHaveBeenCalledOnce();
    expect(s.transport.synthesize).not.toHaveBeenCalled();
    expect(s.context.createBuffer).not.toHaveBeenCalled();
    scene.dispose();
    expect(s.context.close).toHaveBeenCalledOnce();
    expect(s.player.ready).toBe(false);
  });
  it('bounds a suspended resume and does not request TTS while browser playback is blocked', async () => {
    vi.useFakeTimers();
    const s = pcm();
    s.context.resume.mockImplementation(() => new Promise<void>(() => {}));
    const unlock = s.player.unlock(),
      blocked = expect(unlock).rejects.toBeInstanceOf(AudioPlaybackBlocked);
    await vi.advanceTimersByTimeAsync(1500);
    await blocked;
    await expect(
      s.player.play('假文字', 1, new AbortController().signal, vi.fn()),
    ).rejects.toBeInstanceOf(AudioPlaybackBlocked);
    expect(s.transport.synthesize).not.toHaveBeenCalled();
    s.player.dispose();
  });
  it('does not resurrect PCM after the page leaves during unlock', async () => {
    const s = pcm();
    let resume!: () => void;
    s.context.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    const run = s.player.unlock(),
      aborted = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    s.player.dispose();
    resume();
    await aborted;
    expect(s.player.ready).toBe(false);
    expect(s.transport.synthesize).not.toHaveBeenCalled();
  });
  it('cancels a reply waiting for activation without synthesizing late audio', async () => {
    const s = pcm();
    let resume!: () => void;
    s.context.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resume = () => {
            s.context.state = 'running';
            resolve();
          };
        }),
    );
    const scene = new SceneAudio(undefined, s.player);
    scene.live = true;
    const unlock = scene.unlockFromGesture(),
      signal = new AbortController();
    const run = scene.play('假文字', signal.signal, vi.fn(), { turnId: 2 }),
      aborted = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    signal.abort();
    scene.stop();
    resume();
    await unlock;
    await aborted;
    expect(s.transport.synthesize).not.toHaveBeenCalled();
    scene.dispose();
  });
});

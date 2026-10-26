import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConversationEngine } from '../src/core/engine';
import { bindAudioLifecycle } from '../src/core/audio-lifecycle';
import { VoiceEntry } from '../src/core/voice-entry';
import type { TurnRequest, TurnResponse } from '../shared/protocol';
import { abortError } from '../shared/async';
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
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, isTrusted: true } as Event);
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function setup() {
  const pending = deferred<TurnResponse>(),
    playing = deferred<void>();
  let signal!: AbortSignal;
  const transport = {
    turn: vi.fn((_request: TurnRequest, s: AbortSignal) => {
      signal = s;
      return pending.promise;
    }),
    cancel: vi.fn(async () => {}),
  };
  const audio = {
    stop: vi.fn(),
    dispose: vi.fn(),
    unlockFromGesture: vi.fn(async () => {}),
    play: vi.fn((_text: string, s: AbortSignal, start: () => void) => {
      start();
      return new Promise<void>((resolve, reject) => {
        s.addEventListener('abort', () => reject(abortError()), { once: true });
        void playing.promise.then(resolve);
      });
    }),
  };
  const voice = { start: vi.fn(async () => {}), finish: vi.fn(async () => {}), cancel: vi.fn() },
    permission = vi.fn(async () => {});
  const entry = new VoiceEntry(voice, permission);
  entry.configure(true, true);
  const engine = new ConversationEngine(transport, audio, '11111111-1111-4111-8111-111111111111');
  const page = new Events(),
    document = new Events();
  const close = bindAudioLifecycle(
    page,
    document,
    audio,
    () => {
      entry.suspend();
      engine.suspend();
    },
    vi.fn(),
  );
  const hide = () => {
    document.hidden = true;
    document.emit('visibilitychange');
  };
  const show = () => {
    document.hidden = false;
    document.emit('visibilitychange');
    page.emit('focus');
  };
  const answer = () =>
    pending.resolve({
      turnId: engine.getSnapshot().turnId,
      provider: 'mock',
      segments: [{ text: '已经呈现的这句话。', emotion: 'curious', action: 'idle' }],
      suggestions: ['说说照片吧。', '我们慢慢聊。', '先喝杯咖啡。'],
    });
  return {
    engine,
    entry,
    voice,
    permission,
    audio,
    transport,
    pending,
    playing,
    answer,
    hide,
    show,
    close,
    signal: () => signal,
    page,
  };
}
afterEach(() => vi.useRealTimers());
describe('tab visibility is cleanup, not character dialogue', () => {
  it('leaves the entire untouched opening and idle input unchanged after repeated tab switches', () => {
    const s = setup(),
      opening = s.engine.getSnapshot(),
      input = s.entry.getSnapshot();
    for (let i = 0; i < 5; i++) {
      s.hide();
      s.show();
    }
    expect(s.engine.getSnapshot()).toBe(opening);
    expect(s.entry.getSnapshot()).toBe(input);
    expect(s.transport.turn).not.toHaveBeenCalled();
    expect(s.transport.cancel).not.toHaveBeenCalled();
    expect(s.voice.start).not.toHaveBeenCalled();
    expect(s.voice.cancel).not.toHaveBeenCalled();
    expect(s.permission).not.toHaveBeenCalled();
    expect(s.audio.play).not.toHaveBeenCalled();
    expect(s.audio.unlockFromGesture).not.toHaveBeenCalled();
    s.close();
  });
  it('cancels a thinking turn once, ignores its late reply and never auto-resumes on focus', async () => {
    const s = setup(),
      work = s.engine.submit('问候');
    s.hide();
    const cancelled = s.engine.getSnapshot();
    s.show();
    s.hide();
    s.show();
    expect(s.engine.getSnapshot()).toBe(cancelled);
    expect(s.signal().aborted).toBe(true);
    s.answer();
    await work;
    expect(s.audio.play).not.toHaveBeenCalled();
    expect(s.transport.turn).toHaveBeenCalledTimes(1);
    expect(s.transport.cancel).toHaveBeenCalledTimes(1);
    expect(s.engine.getSnapshot()).toMatchObject({
      status: 'idle',
      subtitle: '',
      suggestions: [],
      completed: 0,
    });
    s.close();
  });
  it('stops speaking, retains only the visible subtitle and never replays or commits the unfinished sentence', async () => {
    const s = setup(),
      work = s.engine.submit('问候');
    s.answer();
    await flush();
    expect(s.engine.getSnapshot().status).toBe('speaking');
    const visible = s.engine.getSnapshot().subtitle;
    s.hide();
    await work;
    const stopped = s.engine.getSnapshot();
    s.show();
    s.hide();
    s.show();
    expect(s.engine.getSnapshot()).toBe(stopped);
    expect(stopped).toMatchObject({
      status: 'idle',
      subtitle: visible,
      presentation: 'none',
      suggestions: [],
      completed: 0,
    });
    expect(s.audio.play).toHaveBeenCalledTimes(1);
    expect(s.signal().aborted).toBe(true);
    expect(s.transport.cancel).toHaveBeenCalledTimes(1);
    const next = s.engine.submit('继续');
    expect(s.transport.turn.mock.calls[1][0].history).toEqual([]);
    s.hide();
    await next;
    s.close();
  });
  it('preserves completed dialogue, suggestions, turn identity and input without a cancellation request', async () => {
    const s = setup(),
      work = s.engine.submit('问候');
    s.answer();
    await flush();
    s.playing.resolve();
    await work;
    const completed = s.engine.getSnapshot(),
      input = s.entry.getSnapshot(),
      cancels = s.transport.cancel.mock.calls.length;
    for (let i = 0; i < 4; i++) {
      s.hide();
      s.show();
    }
    expect(completed.completed).toBe(1);
    expect(s.engine.getSnapshot()).toBe(completed);
    expect(s.entry.getSnapshot()).toBe(input);
    expect(s.transport.cancel).toHaveBeenCalledTimes(cancels);
    expect(s.transport.turn).toHaveBeenCalledTimes(1);
    expect(s.audio.play).toHaveBeenCalledTimes(1);
    s.close();
  });
  it('rolls back an unfinished narrative cue without advancing its receipt or reviving it on return', async () => {
    vi.useFakeTimers();
    const s = setup(),
      presented = vi.fn();
    Object.assign(s.transport, { presented });
    const work = s.engine.submit('照片');
    s.pending.resolve({
      turnId: 1,
      provider: 'mock',
      segments: [
        {
          text: '之后才应说的话。',
          emotion: 'curious',
          action: 'idle',
          cue: { kind: 'photo-drift', text: '风把照片吹到你面前。', placement: 'before' },
        },
      ],
    } as TurnResponse);
    await flush();
    expect(s.engine.getSnapshot().status).toBe('narrating');
    s.hide();
    await work;
    s.show();
    await vi.advanceTimersByTimeAsync(6000);
    expect(s.engine.getSnapshot()).toMatchObject({
      status: 'idle',
      narration: '',
      stageProps: { photoPose: 'aside' },
      suggestions: [],
      completed: 0,
    });
    expect(s.audio.play).not.toHaveBeenCalled();
    expect(presented).not.toHaveBeenCalled();
    s.close();
  });
  it('keeps a failed reply available for an explicit retry instead of replacing it on return', async () => {
    const s = setup(),
      work = s.engine.submit('问候');
    s.pending.resolve({ turnId: 1, provider: 'mock', segments: [] } as TurnResponse);
    await work;
    const failed = s.engine.getSnapshot();
    s.hide();
    s.show();
    expect(failed.status).toBe('error');
    expect(s.engine.getSnapshot()).toBe(failed);
    expect(s.transport.turn).toHaveBeenCalledTimes(1);
    s.close();
  });
  it('invalidates pending permission when hidden without restoring it on return', async () => {
    const permission = deferred<void>(),
      voice = { start: vi.fn(async () => {}), finish: vi.fn(async () => {}), cancel: vi.fn() };
    const entry = new VoiceEntry(voice, () => permission.promise),
      notice = vi.fn();
    entry.configure(true, true);
    const work = entry.prepare(notice);
    entry.suspend();
    permission.resolve();
    await work;
    expect(entry.getSnapshot()).toMatchObject({ phase: 'idle', permission: 'needed', held: false });
    expect(notice).not.toHaveBeenCalled();
    expect(voice.start).not.toHaveBeenCalled();
  });
  it('stops active capture on hide, with no automatic recording, recognition or reply on return', async () => {
    const s = setup();
    await s.entry.prepare(vi.fn());
    s.entry.press({
      begin: () => {
        s.engine.interrupt(true);
        return s.engine.getSnapshot().turnId;
      },
      text: vi.fn(),
      mock: vi.fn(),
      notice: vi.fn(),
      end: () => s.engine.endListening(),
    });
    const before = s.voice.cancel.mock.calls.length;
    s.hide();
    s.show();
    s.hide();
    s.show();
    expect(s.voice.start).toHaveBeenCalledTimes(1);
    expect(s.voice.cancel).toHaveBeenCalledTimes(before + 1);
    expect(s.voice.finish).not.toHaveBeenCalled();
    expect(s.transport.turn).not.toHaveBeenCalled();
    expect(s.entry.getSnapshot()).toMatchObject({ phase: 'idle', held: false });
    expect(s.engine.getSnapshot().status).toBe('idle');
    s.close();
  });
});

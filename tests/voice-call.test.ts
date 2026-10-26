import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceActivityDetector, isBriefAcknowledgement } from '../src/core/voice-activity';
import { VoiceCall } from '../src/core/voice-call';
import { MicrophoneCapture } from '../src/core/microphone';
import type { SpeechTransport } from '../src/core/speech-transport';
import { SpeechTransportError } from '../src/core/speech-transport';
import { ConversationEngine } from '../src/core/engine';
import { abortError } from '../shared/async';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function frame(amplitude: number) {
  const pcm = new Uint8Array(640), view = new DataView(pcm.buffer);
  for (let i = 0; i < 320; i++) view.setInt16(i * 2, Math.round(amplitude * 32767 * Math.sin(i * 0.3)), true);
  return pcm;
}
function setup() {
  let responding = false, turnId = 0;
  const captures: { frame: (pcm: Uint8Array) => void; signal: AbortSignal; failed?: () => void; cancel: ReturnType<typeof vi.fn> }[] = [];
  const capture = new MicrophoneCapture(async (frame, signal, failed) => {
    const session = { frame, signal, failed, cancel: vi.fn() };
    captures.push(session);
    return { cancel: session.cancel, finish: vi.fn(async () => {}) };
  });
  const sessions: {
    signal: AbortSignal;
    ready: ReturnType<typeof deferred<void>>;
    result: ReturnType<typeof deferred<string>>;
    append: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
  }[] = [];
  const transport: SpeechTransport = {
    synthesize: vi.fn(),
    openAsr: vi.fn((_turnId, signal) => {
      const ready = deferred<void>(), result = deferred<string>();
      const append = vi.fn(), commit = vi.fn(() => result.promise);
      sessions.push({ signal, ready, result, append, commit });
      return { ready: ready.promise, append, commit };
    }),
  };
  const callbacks = {
    turnId: () => turnId,
    responding: () => responding,
    begin: vi.fn(() => { responding = false; turnId++; }),
    text: vi.fn(), end: vi.fn(), stop: vi.fn(),
  };
  const call = new VoiceCall(transport, capture);
  const feed = (ms: number, amplitude = 0.08) => {
    for (let n = 0; n < ms / 20; n++) captures.at(-1)!.frame(frame(amplitude));
  };
  const say = (ms = 600) => { feed(ms); feed(800, 0); };
  return { call, callbacks, captures, sessions, transport, feed, say, responding: () => { responding = true; } };
}
afterEach(() => vi.useRealTimers());

describe('continuous voice call, synthetic PCM and fake ASR only', () => {
  it('starts only explicitly, keeps silence local, and completes two turns on one microphone capture', async () => {
    const s = setup();
    expect(s.captures).toHaveLength(0);
    expect(s.transport.openAsr).not.toHaveBeenCalled();
    await s.call.start(s.callbacks);
    expect(s.call.getSnapshot()).toMatchObject({ active: true, phase: 'listening' });
    s.feed(10000, 0);
    expect(s.transport.openAsr).not.toHaveBeenCalled();
    for (const text of ['你好，Mira。', '这张照片拍的是哪里？']) {
      s.say();
      const op = s.sessions.at(-1)!;
      expect(s.call.getSnapshot().phase).toBe('recognizing');
      expect(op.commit).not.toHaveBeenCalled();
      op.ready.resolve();
      await flush();
      expect(op.commit).toHaveBeenCalledOnce();
      expect(op.append).toHaveBeenCalled();
      op.result.resolve(text);
      await flush();
      expect(s.callbacks.text).toHaveBeenLastCalledWith(text);
      expect(s.call.getSnapshot().phase).toBe('listening');
    }
    expect(s.captures).toHaveLength(1);
    expect(s.callbacks.text).toHaveBeenCalledTimes(2);
    s.call.stop();
    expect(s.captures[0].cancel).toHaveBeenCalledOnce();
    expect(s.callbacks.stop).toHaveBeenCalledOnce();
  });
  it('automatically interrupts sustained speech during a reply before recognition finishes', async () => {
    const s = setup();
    await s.call.start(s.callbacks);
    s.responding();
    s.feed(420);
    expect(s.callbacks.begin).not.toHaveBeenCalled();
    s.feed(20);
    expect(s.callbacks.begin).toHaveBeenCalledOnce();
    expect(s.sessions[0].commit).not.toHaveBeenCalled();
    s.feed(400);
    expect(s.callbacks.begin).toHaveBeenCalledOnce();
    s.feed(800, 0);
    s.sessions[0].ready.resolve();
    await flush();
    s.sessions[0].result.resolve('等一下，我想问另一件事。');
    await flush();
    expect(s.callbacks.text).toHaveBeenCalledExactlyOnceWith('等一下，我想问另一件事。');
    s.call.stop();
  });
  it.each(['嗯。', '对。', '好的。'])('keeps the reply playing for a short %s', async (text) => {
    const s = setup();
    await s.call.start(s.callbacks);
    s.responding();
    s.say(240);
    s.sessions[0].ready.resolve();
    await flush();
    s.sessions[0].result.resolve(text);
    await flush();
    expect(s.callbacks.begin).not.toHaveBeenCalled();
    expect(s.callbacks.text).not.toHaveBeenCalled();
    expect(s.call.getSnapshot().active).toBe(true);
    s.call.stop();
  });
  it('treats a brief stop/question as an interruption after recognition', async () => {
    const s = setup();
    await s.call.start(s.callbacks);
    s.responding();
    s.say(240);
    s.sessions[0].ready.resolve();
    await flush();
    s.sessions[0].result.resolve('等等。');
    await flush();
    expect(s.callbacks.begin).toHaveBeenCalledOnce();
    expect(s.callbacks.text).toHaveBeenCalledExactlyOnceWith('等等。');
    s.call.stop();
  });
  it('hangs up during recognition and discards a late result and late PCM', async () => {
    const s = setup();
    await s.call.start(s.callbacks);
    s.say();
    s.sessions[0].ready.resolve();
    await flush();
    s.call.stop();
    expect(s.sessions[0].signal.aborted).toBe(true);
    expect(s.captures[0].signal.aborted).toBe(true);
    s.sessions[0].result.resolve('迟到的识别');
    s.say();
    await flush();
    expect(s.sessions).toHaveLength(1);
    expect(s.callbacks.text).not.toHaveBeenCalled();
  });
  it('lets a new utterance replace pending recognition instead of submitting stale text', async () => {
    const s = setup();
    await s.call.start(s.callbacks);
    s.say();
    s.sessions[0].ready.resolve();
    await flush();
    s.say();
    expect(s.sessions[0].signal.aborted).toBe(true);
    s.sessions[0].result.resolve('旧问题');
    s.sessions[1].ready.resolve();
    await flush();
    s.sessions[1].result.resolve('我改主意了，先聊咖啡吧。');
    await flush();
    expect(s.callbacks.text).toHaveBeenCalledExactlyOnceWith('我改主意了，先聊咖啡吧。');
    s.call.stop();
  });
  it('manual text clears pending recognition while leaving the call connected', async () => {
    const s = setup();
    await s.call.start(s.callbacks);
    s.say();
    s.sessions[0].ready.resolve();
    await flush();
    s.call.clearInput();
    s.sessions[0].result.resolve('被打字取代的旧识别');
    await flush();
    expect(s.call.getSnapshot()).toMatchObject({ active: true, phase: 'listening' });
    expect(s.callbacks.text).not.toHaveBeenCalled();
    expect(s.captures[0].cancel).not.toHaveBeenCalled();
    s.call.stop();
  });
  it('keeps the recognition deadline after a late handshake and never retries automatically', async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.call.start(s.callbacks);
    s.say();
    await vi.advanceTimersByTimeAsync(1000);
    s.sessions[0].ready.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(11000);
    expect(s.call.getSnapshot()).toMatchObject({ active: false, phase: 'error' });
    expect(s.sessions[0].signal.aborted).toBe(true);
    expect(s.captures[0].cancel).toHaveBeenCalled();
    expect(s.sessions).toHaveLength(1);
    s.sessions[0].result.resolve('超时后的识别');
    await flush();
    expect(s.callbacks.text).not.toHaveBeenCalled();
  });
  it('survives permission-popup blur but stops late permission capture after hangup', async () => {
    const permission = deferred<void>(), cancel = vi.fn();
    const call = new VoiceCall({ openAsr: vi.fn(), synthesize: vi.fn() }, new MicrophoneCapture(async () => {
      await permission.promise;
      return { cancel, finish: vi.fn() };
    }));
    const s = setup();
    const start = call.start(s.callbacks);
    call.blur();
    expect(call.getSnapshot()).toMatchObject({ active: true, phase: 'connecting' });
    call.stop();
    permission.resolve();
    await start;
    expect(cancel).toHaveBeenCalledOnce();
    expect(call.getSnapshot().active).toBe(false);
  });
  it('stops on microphone disconnect or focus loss, and requires an explicit restart', async () => {
    const s = setup();
    await s.call.start(s.callbacks);
    s.captures[0].failed?.();
    expect(s.call.getSnapshot()).toMatchObject({ active: false, phase: 'error' });
    expect(s.captures[0].cancel).toHaveBeenCalled();
    expect(s.transport.openAsr).not.toHaveBeenCalled();
    await s.call.start(s.callbacks);
    const stops = s.callbacks.stop.mock.calls.length;
    s.call.blur();
    expect(s.call.getSnapshot().active).toBe(false);
    expect(s.call.getSnapshot().message).toContain('失去焦点');
    expect(s.callbacks.stop.mock.calls.length).toBe(stops);
    expect(s.captures).toHaveLength(2);
  });
  it('releases capture and recognition on backgrounding while preserving a reply already in progress', async () => {
    const s = setup();
    await s.call.start(s.callbacks);
    s.responding();
    s.feed(200);
    s.call.stop('页面已进入后台，已暂停收音。', false);
    expect(s.call.getSnapshot().active).toBe(false);
    expect(s.captures[0].signal.aborted).toBe(true);
    expect(s.sessions[0].signal.aborted).toBe(true);
    expect(s.callbacks.end).toHaveBeenCalledOnce();
    expect(s.callbacks.stop).not.toHaveBeenCalled();
    s.sessions[0].ready.resolve();
    await flush();
    expect(s.callbacks.text).not.toHaveBeenCalled();
  });
  it('reports denied permission and never silently substitutes demo dialogue', async () => {
    const transport = { openAsr: vi.fn(), synthesize: vi.fn() };
    const call = new VoiceCall(transport, new MicrophoneCapture(async () => { throw new Error('麦克风权限未开启'); }));
    const s = setup();
    await call.start(s.callbacks);
    expect(call.getSnapshot()).toMatchObject({ active: false, phase: 'error', message: '麦克风权限未开启' });
    expect(transport.openAsr).not.toHaveBeenCalled();
    expect(s.callbacks.text).not.toHaveBeenCalled();
  });
  it('closes the microphone and session on ASR failure without starting a retry loop', async () => {
    const s = setup();
    await s.call.start(s.callbacks);
    s.say();
    s.sessions[0].ready.resolve();
    await flush();
    s.sessions[0].result.reject(new Error('disconnected'));
    await flush();
    expect(s.call.getSnapshot()).toMatchObject({ active: false, phase: 'error' });
    expect(s.sessions).toHaveLength(1);
    expect(s.captures[0].signal.aborted).toBe(true);
    expect(s.callbacks.text).not.toHaveBeenCalled();
  });
  it('keeps listening after an empty recognition without calling the dialogue model or retrying ASR', async () => {
    const s = setup();
    await s.call.start(s.callbacks);
    s.say();
    s.sessions[0].ready.resolve();
    await flush();
    s.sessions[0].result.reject(new SpeechTransportError('EMPTY_TRANSCRIPT', '没有识别到内容'));
    await flush();
    expect(s.call.getSnapshot()).toMatchObject({ active: true, phase: 'listening' });
    expect(s.call.getSnapshot().message).toContain('没听清');
    expect(s.callbacks.text).not.toHaveBeenCalled();
    expect(s.sessions).toHaveLength(1);
    s.call.stop();
  });
  it('cancels actual engine playback and late visuals when automatically interrupted, then submits the new utterance', async () => {
    const s = setup(), cancelled = vi.fn(async () => {}), stop = vi.fn();
    let lateStart: (() => void) | undefined, playbackSignal: AbortSignal | undefined;
    const engine = new ConversationEngine({
      turn: async (r) => ({ turnId: r.turnId, provider: 'mock', segments: [{ text: '这是尚未讲完的旧回复。', emotion: 'curious', action: 'laughing' }] }),
      cancel: cancelled,
    }, {
      stop,
      play: (_text, signal, start) => new Promise<void>((_resolve, reject) => {
        playbackSignal = signal;
        lateStart = start;
        start();
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      }),
    });
    try {
      const old = engine.submit('原问题');
      await flush();
      expect(engine.getSnapshot().status).toBe('speaking');
      const text = vi.fn((value: string) => { void engine.submit(value); });
      await s.call.start({
        turnId: () => engine.getSnapshot().turnId,
        responding: () => engine.getSnapshot().status === 'speaking',
        begin: () => engine.interrupt(true),
        text, end: () => engine.endListening(), stop: () => engine.interrupt(),
      });
      const stops = stop.mock.calls.length;
      s.feed(440);
      expect(stop.mock.calls.length).toBe(stops + 1);
      expect(playbackSignal?.aborted).toBe(true);
      expect(engine.getSnapshot()).toMatchObject({ status: 'listening', subtitle: '', suggestions: [], action: 'idle' });
      lateStart?.();
      expect(engine.getSnapshot().subtitle).toBe('');
      await old;
      s.feed(800, 0);
      s.sessions[0].ready.resolve();
      await flush();
      s.sessions[0].result.resolve('换个话题吧。');
      await flush();
      expect(text).toHaveBeenCalledExactlyOnceWith('换个话题吧。');
      expect(engine.getSnapshot().lastInput).toBe('换个话题吧。');
      expect(cancelled).toHaveBeenCalled();
    } finally { s.call.stop(); engine.dispose(); }
  });
});

describe('local speech endpointing boundaries', () => {
  it('ignores silence and brief clicks, retaining a bounded prefix without losing the first syllable', () => {
    const detector = new VoiceActivityDetector();
    const events = [];
    for (let i = 0; i < 3000; i++) events.push(...detector.push(frame(0.002), false));
    events.push(...detector.push(frame(0.5), false));
    events.push(...detector.push(frame(0), false));
    expect(events).toHaveLength(0);
    for (let i = 0; i < 6; i++) events.push(...detector.push(frame(0.08), false));
    const start = events.find((event) => event.type === 'start');
    expect(start?.type).toBe('start');
    if (start?.type === 'start') {
      expect(start.frames.length).toBeLessThanOrEqual(16);
      expect(start.frames.at(-1)).toEqual(frame(0.08));
      expect(start.frames.at(-6)).toEqual(frame(0.08));
    }
  });
  it('ends very long speech below the existing 30 second ASR limit', () => {
    const detector = new VoiceActivityDetector();
    let bytes = 0, ended = false;
    for (let i = 0; i < 1500 && !ended; i++) for (const event of detector.push(frame(0.08), false)) {
      if (event.type === 'start') bytes += event.frames.reduce((sum, pcm) => sum + pcm.length, 0);
      if (event.type === 'audio') bytes += event.pcm.length;
      if (event.type === 'end') ended = true;
    }
    expect(ended).toBe(true);
    expect(bytes).toBeLessThan(960000);
    expect(bytes).toBeGreaterThan(900000);
  });
  it('does not mistake meaningful agreement or a long utterance for a brief acknowledgement', () => {
    expect(isBriefAcknowledgement('嗯。', 200)).toBe(true);
    expect(isBriefAcknowledgement('嗯，我觉得可以拒绝。', 300)).toBe(false);
    expect(isBriefAcknowledgement('对。', 900)).toBe(false);
    expect(isBriefAcknowledgement('等等。', 200)).toBe(false);
  });
});

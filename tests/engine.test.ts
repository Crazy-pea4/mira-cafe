import { characterPose } from '../src/core/character-pose';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConversationEngine } from '../src/core/engine';
import { AudioPlaybackBlocked, type AudioPlayer } from '../src/core/audio';
import type { Transport } from '../src/core/transport';
import type { TurnRequest, TurnResponse } from '../shared/protocol';
import { abortError } from '../shared/async';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
class FakeTransport implements Transport {
  calls: {
    request: TurnRequest;
    signal: AbortSignal;
    task: ReturnType<typeof deferred<TurnResponse>>;
  }[] = [];
  cancellations: number[] = [];
  turn(request: TurnRequest, signal: AbortSignal) {
    const task = deferred<TurnResponse>();
    this.calls.push({ request, signal, task });
    return task.promise;
  }
  async cancel(_sessionId: string, turn: number) {
    this.cancellations.push(turn);
  }
}
class FakeAudio implements AudioPlayer {
  calls: {
    text: string;
    signal: AbortSignal;
    start: () => void;
    task: ReturnType<typeof deferred<void>>;
  }[] = [];
  stopped = 0;
  fail = false;
  play(text: string, signal: AbortSignal, start: () => void) {
    if (this.fail) return Promise.reject(new Error('audio failed'));
    const task = deferred<void>();
    signal.addEventListener('abort', () => task.reject(abortError()), { once: true });
    this.calls.push({ text, signal, start, task });
    return task.promise;
  }
  stop() {
    this.stopped++;
  }
}
function setup() {
  const transport = new FakeTransport();
  const audio = new FakeAudio();
  const engine = new ConversationEngine(
    transport,
    audio,
    '11111111-1111-4111-8111-111111111111',
    () => 100,
  );
  return { transport, audio, engine };
}
function response(id: number, text = '这是本轮回复。'): TurnResponse {
  return { turnId: id, provider: 'mock', segments: [{ text, emotion: 'curious', action: 'idle' }] };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
describe('conversation cancellation and presentation', () => {
  it('owns semantic poses only from playback start until completion or interruption, including late callbacks', async () => {
    const { transport, audio, engine } = setup();
    const run = engine.submit('逗你笑');
    expect(characterPose(engine.getSnapshot())).toBe('thinking');
    transport.calls[0].task.resolve({
      turnId: 1,
      provider: 'mock',
      segments: [{ text: '真的被你逗笑了。', emotion: 'relieved', action: 'laughing' }],
    });
    await flush();
    expect(characterPose(engine.getSnapshot())).toBe('thinking');
    audio.calls[0].start();
    expect(characterPose(engine.getSnapshot())).toBe('laughing');
    engine.interrupt(true);
    await run;
    expect(characterPose(engine.getSnapshot())).toBe('listening');
    audio.calls[0].start();
    expect(characterPose(engine.getSnapshot())).toBe('listening');
    engine.endListening();
    expect(characterPose(engine.getSnapshot())).toBe('idle');
    const next = engine.submit('先慢慢来');
    transport.calls[1].task.resolve({
      turnId: engine.getSnapshot().turnId,
      provider: 'mock',
      segments: [{ text: '我有一点犹豫。', emotion: 'guarded', action: 'hesitant' }],
    });
    await flush();
    audio.calls[1].start();
    expect(characterPose(engine.getSnapshot())).toBe('hesitant');
    audio.calls[1].task.resolve();
    await next;
    expect(characterPose(engine.getSnapshot())).toBe('idle');
    engine.reset();
    expect(characterPose(engine.getSnapshot())).toBe('idle');
  });
  it('drops an old response that ignores cancellation and arrives after the new one', async () => {
    const { transport, audio, engine } = setup();
    const old = engine.submit('old');
    const fresh = engine.submit('new');
    transport.calls[1].task.resolve(response(transport.calls[1].request.turnId, '新的回答。'));
    await flush();
    audio.calls[0].start();
    transport.calls[0].task.resolve({
      ...response(1, '过期回答。'),
      segments: [
        {
          text: '旧照片。',
          emotion: 'relieved',
          action: 'offer-photo',
          event: 'reveal-photo',
          scene: 'warm',
        },
      ],
    });
    await old;
    expect(engine.getSnapshot().subtitle).toBe('新的回答。');
    expect(engine.getSnapshot().photo).toBe(false);
    expect(audio.calls).toHaveLength(1);
    audio.calls[0].task.resolve();
    await fresh;
    expect(engine.getSnapshot().status).toBe('idle');
  });
  it('starts subtitles and visual events only when audio playback actually starts', async () => {
    const { transport, audio, engine } = setup();
    const run = engine.submit('照片');
    transport.calls[0].task.resolve({
      turnId: 1,
      provider: 'mock',
      segments: [
        { text: '给你看照片。', emotion: 'relieved', action: 'offer-photo', event: 'reveal-photo' },
      ],
    });
    await flush();
    expect(engine.getSnapshot().subtitle).toBe('');
    expect(engine.getSnapshot().photo).toBe(false);
    audio.calls[0].start();
    expect(engine.getSnapshot().subtitle).toBe('给你看照片。');
    expect(engine.getSnapshot().photo).toBe(true);
    audio.calls[0].task.resolve();
    await run;
  });
  it('cancels pending audio, subtitles, actions and media together and enters listening', async () => {
    const { transport, audio, engine } = setup();
    const run = engine.submit('hello');
    transport.calls[0].task.resolve({
      turnId: 1,
      provider: 'mock',
      segments: [
        { text: '先听这一句。', emotion: 'curious', action: 'look-window' },
        {
          text: '不应播放。',
          emotion: 'relieved',
          action: 'offer-photo',
          event: 'reveal-photo',
          scene: 'warm',
        },
      ],
    });
    await flush();
    audio.calls[0].start();
    engine.interrupt(true);
    await run;
    expect(engine.getSnapshot()).toMatchObject({
      status: 'listening',
      subtitle: '',
      action: 'idle',
      photo: false,
      scene: 'rain',
    });
    expect(audio.calls).toHaveLength(1);
    expect(audio.calls[0].signal.aborted).toBe(true);
    expect(transport.cancellations).toContain(1);
    audio.calls[0].start();
    expect(engine.getSnapshot().subtitle).toBe('');
  });
  it('survives ten rapid inputs and plays only the current response', async () => {
    const { transport, audio, engine } = setup();
    const runs = Array.from({ length: 10 }, (_, i) => engine.submit('input ' + i));
    for (const call of transport.calls) call.task.resolve(response(call.request.turnId));
    await flush();
    expect(transport.calls.every((c) => c.request.history.length === 0)).toBe(true);
    expect(audio.calls).toHaveLength(1);
    expect(transport.calls.slice(0, -1).every((c) => c.signal.aborted)).toBe(true);
    audio.calls[0].start();
    audio.calls[0].task.resolve();
    await Promise.all(runs);
    expect(engine.getSnapshot().completed).toBe(1);
  });
  it('does not retain unheard assistant sentences in history', async () => {
    const { transport, audio, engine } = setup();
    const first = engine.submit('问候');
    transport.calls[0].task.resolve(response(1, '听到的第一句。没听完的第二句。'));
    await flush();
    audio.calls[0].start();
    audio.calls[0].task.resolve();
    await flush();
    audio.calls[1].start();
    const second = engine.submit('打断后的问题');
    await first;
    const history = transport.calls[1].request.history;
    expect(history.some((h) => h.content.includes('听到的第一句。'))).toBe(true);
    expect(history.some((h) => h.content.includes('没听完的第二句。'))).toBe(false);
    transport.calls[1].task.reject(new Error('stop'));
    await second;
  });
  it('offers a working retry after a recoverable provider error', async () => {
    const { transport, audio, engine } = setup();
    const run = engine.submit('重试的问题', 'timeout');
    transport.calls[0].task.reject(new Error('模拟超时'));
    await run;
    expect(engine.getSnapshot().status).toBe('error');
    const retry = engine.retry();
    expect(transport.calls[1].request.history).toEqual([]);
    expect(transport.calls[1].request).toMatchObject({ text: '重试的问题', fault: 'none' });
    transport.calls[1].task.resolve(response(transport.calls[1].request.turnId));
    await flush();
    audio.calls[0].start();
    audio.calls[0].task.resolve();
    await retry;
    expect(engine.getSnapshot().error).toBe('');
    expect(engine.getSnapshot().status).toBe('idle');
  });
  it('recovers from failed audio with timed subtitles', async () => {
    vi.useFakeTimers();
    const { transport, audio, engine } = setup();
    audio.fail = true;
    const run = engine.submit('hello');
    transport.calls[0].task.resolve(response(1));
    await flush();
    expect(engine.getSnapshot().status).toBe('speaking');
    expect(engine.getSnapshot().notice).toContain('字幕');
    await vi.advanceTimersByTimeAsync(100);
    await run;
    expect(engine.getSnapshot().status).toBe('idle');
  });
  it('shows actual reply text if second-turn audio finishes without a start event, without another model request', async () => {
    vi.useFakeTimers();
    const { transport, audio, engine } = setup();
    const first = engine.submit('第一轮');
    transport.calls[0].task.resolve(response(1, '第一轮的回答。'));
    await flush();
    audio.calls[0].start();
    audio.calls[0].task.resolve();
    await first;
    const second = engine.submit('第二轮');
    transport.calls[1].task.resolve(response(engine.getSnapshot().turnId, '第二轮的真实回答。'));
    await flush();
    expect(engine.getSnapshot().pendingAudio).toBe(true);
    audio.calls[1].task.resolve();
    await flush();
    expect(engine.getSnapshot()).toMatchObject({
      subtitle: '第二轮的真实回答。',
      pendingAudio: false,
      presentation: 'simulated',
      status: 'speaking',
    });
    expect(engine.getSnapshot().notice).toContain('字幕');
    await vi.advanceTimersByTimeAsync(100);
    await second;
    expect(engine.getSnapshot()).toMatchObject({
      subtitle: '第二轮的真实回答。',
      status: 'idle',
      completed: 2,
    });
    audio.calls[1].start();
    expect(engine.getSnapshot().status).toBe('idle');
    expect(transport.calls).toHaveLength(2);
  });
  it('keeps subtitles and a clear hint when autoplay is blocked, without retrying the model', async () => {
    vi.useFakeTimers();
    const { transport, audio, engine } = setup();
    audio.play = vi.fn(async () => {
      throw new AudioPlaybackBlocked();
    });
    const run = engine.submit('hello');
    transport.calls[0].task.resolve(response(1));
    await flush();
    expect(engine.getSnapshot().notice).toContain('浏览器限制了声音');
    expect(engine.getSnapshot()).toMatchObject({
      presentation: 'simulated',
      subtitle: '这是本轮回复。',
    });
    await vi.advanceTimersByTimeAsync(100);
    await run;
    expect(transport.calls).toHaveLength(1);
  });
  it('keeps a text-only degradation notice through silent fallback without inventing visual events', async () => {
    vi.useFakeTimers();
    const { transport, audio, engine } = setup();
    audio.fail = true;
    const run = engine.submit('hello');
    transport.calls[0].task.resolve({ ...response(1), notice: 'REPLY_TEXT_ONLY' });
    await flush();
    expect(engine.getSnapshot().notice).toContain('仅保留对白');
    expect(engine.getSnapshot().notice).toContain('字幕');
    expect(engine.getSnapshot().photo).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await run;
  });
  it('also cancels the timed fallback and never runs its next visual event', async () => {
    vi.useFakeTimers();
    const { transport, audio, engine } = setup();
    audio.fail = true;
    const run = engine.submit('hello');
    transport.calls[0].task.resolve({
      turnId: 1,
      provider: 'mock',
      segments: [
        { text: '第一句。', emotion: 'guarded', action: 'idle' },
        { text: '第二句。', emotion: 'relieved', action: 'offer-photo', event: 'reveal-photo' },
      ],
    });
    await flush();
    engine.interrupt(true);
    await vi.advanceTimersByTimeAsync(1000);
    await run;
    expect(engine.getSnapshot()).toMatchObject({ status: 'listening', subtitle: '', photo: false });
  });
  it('reset invalidates an in-flight response', async () => {
    const { transport, audio, engine } = setup();
    const run = engine.submit('hello');
    engine.reset();
    transport.calls[0].task.resolve(response(1));
    await run;
    expect(engine.getSnapshot().completed).toBe(0);
    expect(engine.getSnapshot().lastInput).toBe('');
    expect(audio.calls).toHaveLength(0);
  });
  it('rejects a mismatched response turnId instead of leaving a stuck thinking state', async () => {
    const { transport, engine } = setup();
    const run = engine.submit('hello');
    transport.calls[0].task.resolve(response(999));
    await run;
    expect(engine.getSnapshot().status).toBe('error');
  });
  it('does not submit whitespace or overlong text', async () => {
    const { transport, engine } = setup();
    await engine.submit('  ');
    await engine.submit('x'.repeat(801));
    expect(transport.calls).toHaveLength(0);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InteractionTiming, firstReplyAudioMs } from '../src/core/interaction-timing';
import { TimingDebugPanel } from '../src/TimingDebugPanel';
import { HttpTransport } from '../src/core/transport';
import { LocalSpeechTransport, type BrowserWire } from '../src/core/speech-transport';
import { SceneAudio } from '../src/core/scene-audio';
import type { PcmSpeechPlayer } from '../src/core/pcm-playback';

const input = { sessionId: '66666666-6666-4666-8666-666666666666', turnId: 7, text: '私人测试内容', history: [], fault: 'none' as const };
const reply = { turnId: 7, provider: 'mock', segments: [{ text: '雨还没停。', emotion: 'curious', action: 'idle' }] };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

class Wire implements BrowserWire {
  readyState = 0;
  bufferedAmount = 0;
  sent: any[] = [];
  listeners: Record<string, ((event: any) => void)[]> = {};
  addEventListener(type: string, listener: (event: any) => void) { (this.listeners[type] ??= []).push(listener); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.listeners.close?.forEach(listener => listener({})); }
  open() { this.readyState = 1; this.listeners.open?.forEach(listener => listener({})); }
  event(fields: object) {
    this.listeners.message?.forEach(listener => listener({ data: JSON.stringify({
      requestId: this.sent[0].requestId, turnId: this.sent[0].turnId, ...fields,
    }) }));
  }
}

describe('page-local interaction measurements', () => {
  it('retains only the first milestone and rejects late updates after completion, clearing or eviction', () => {
    let now = 10;
    const timing = new InteractionTiming(() => now), listener = vi.fn();
    timing.subscribe(listener);
    const span = timing.begin('model', 1);
    now = 30; span.mark('firstText');
    const calls = listener.mock.calls.length;
    now = 50; span.mark('firstText');
    expect(listener).toHaveBeenCalledTimes(calls);
    span.finish('cancelled');
    now = 70; span.mark('firstAudio'); span.finish('complete');
    expect(timing.getSnapshot()[0]).toMatchObject({ status: 'cancelled', points: { firstText: 20 }, elapsedMs: 40 });
    timing.clear(); span.mark('ready');
    expect(timing.getSnapshot()).toEqual([]);
    const evicted = timing.begin('tts', 2);
    for (let i = 0; i < 20; i++) timing.begin('model', i + 3).finish('complete');
    const snapshot = timing.getSnapshot();
    evicted.finish('complete');
    expect(timing.getSnapshot()).toBe(snapshot);
    expect(snapshot).toHaveLength(20);
  });

  it('measures streamed first text separately from the full validated reply without keeping content', async () => {
    let now = 0, stream!: ReadableStreamDefaultController<Uint8Array>;
    const timing = new InteractionTiming(() => now);
    timing.configure(true, true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } })));
    const work = new HttpTransport(timing).turn(input, new AbortController().signal);
    await flush();
    const send = (data: unknown) => stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(data) + '\n\n'));
    now = 90; send({ type: 'text', turnId: 7, text: '尚未校验的私人预览' });
    await vi.waitFor(() => expect(timing.getSnapshot()[0].points.firstText).toBe(90));
    now = 240; send({ type: 'reply', reply }); stream.close();
    await expect(work).resolves.toEqual(reply);
    expect(timing.getSnapshot()[0]).toMatchObject({ mode: 'live', status: 'complete', elapsedMs: 240 });
    expect(JSON.stringify(timing.getSnapshot())).not.toMatch(/私人|雨还没停/);
  });

  it('records model transport failure and an already aborted turn never starts a measurement', async () => {
    const timing = new InteractionTiming(() => 0), fetcher = vi.fn(async () => { throw new TypeError('network'); });
    vi.stubGlobal('fetch', fetcher);
    await expect(new HttpTransport(timing).turn(input, new AbortController().signal)).rejects.toThrow();
    expect(timing.getSnapshot()[0].status).toBe('error');
    const controller = new AbortController(); controller.abort();
    await expect(new HttpTransport(timing).turn(input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(timing.getSnapshot()).toHaveLength(1);
  });

  it('counts ASR recognition only after commit, excluding recording time and cleanup cancellation', async () => {
    let now = 0;
    const timing = new InteractionTiming(() => now), wire = new Wire(), controller = new AbortController();
    const speech = new LocalSpeechTransport(() => wire, () => 'ws://test/api/speech', timing);
    const asr = speech.openAsr(4, controller.signal);
    now = 60; wire.open(); wire.event({ type: 'ready' }); await asr.ready;
    now = 5000; const work = asr.commit();
    now = 5260; wire.event({ type: 'transcript', text: '私人录音内容' }); wire.event({ type: 'done' });
    await expect(work).resolves.toBe('私人录音内容');
    controller.abort();
    const record = timing.getSnapshot()[0];
    expect(record).toMatchObject({ status: 'complete', elapsedMs: 5260, points: { ready: 60, commit: 5000 } });
    expect(record.elapsedMs! - record.points.commit!).toBe(260);
    expect(JSON.stringify(record)).not.toContain('私人');
  });

  it('keeps first TTS packet distinct and ignores mismatched and late audio after cancellation', async () => {
    let now = 0;
    const timing = new InteractionTiming(() => now), wires: Wire[] = [];
    const speech = new LocalSpeechTransport(() => { const wire = new Wire(); wires.push(wire); return wire; }, () => 'ws://test/api/speech', timing);
    const controller = new AbortController(), chunk = vi.fn();
    const work = speech.synthesize('私人对白', 7, controller.signal, chunk);
    wires[0].open();
    now = 10; wires[0].event({ type: 'audio', turnId: 9, audio: 'AAAA', sampleRate: 24000 });
    expect(timing.getSnapshot()[0].points.firstAudio).toBeUndefined();
    now = 80; wires[0].event({ type: 'audio', audio: 'AAAAAA==', sampleRate: 24000 });
    now = 110; wires[0].event({ type: 'audio', audio: 'AAAAAA==', sampleRate: 24000 });
    controller.abort(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    now = 190; wires[0].event({ type: 'audio', audio: 'AAAA', sampleRate: 24000 }); wires[0].event({ type: 'done' });
    expect(timing.getSnapshot()[0]).toMatchObject({ status: 'cancelled', points: { firstAudio: 80 } });
    expect(chunk).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(timing.getSnapshot())).not.toContain('私人');
  });

  it('waits for the player callback for first sound and does not revive a finished playback', async () => {
    let now = 10, start!: () => void, resolve!: () => void;
    const timing = new InteractionTiming(() => now);
    timing.begin('model', 7).finish('complete');
    const pcm = { play: vi.fn((_text, _turn, _signal, onStart) => { start = onStart; return new Promise<void>(done => { resolve = done; }); }), stop: vi.fn() } as unknown as PcmSpeechPlayer;
    const audio = new SceneAudio(undefined, pcm, timing); audio.live = true;
    now = 40; const callback = vi.fn(), work = audio.play('内容', new AbortController().signal, callback, { turnId: 7 });
    now = 70; expect(firstReplyAudioMs(timing.getSnapshot(), 7)).toBeUndefined();
    now = 130; start();
    expect(firstReplyAudioMs(timing.getSnapshot(), 7)).toBe(120);
    expect(timing.getSnapshot()[1].points.firstPlayback).toBe(90);
    now = 200; resolve(); await work;
    now = 300; start();
    expect(callback).toHaveBeenCalledOnce();
    expect(timing.getSnapshot()[1]).toMatchObject({ status: 'complete', elapsedMs: 160 });
  });

  it('does not report successful sound when playback fails or resolves without a start callback', async () => {
    const timing = new InteractionTiming(() => 0);
    const pcm = { play: vi.fn(async () => {}), stop: vi.fn() } as unknown as PcmSpeechPlayer;
    const audio = new SceneAudio(undefined, pcm, timing); audio.live = true;
    await audio.play('字幕', new AbortController().signal, vi.fn(), { turnId: 8 });
    expect(timing.getSnapshot()[0]).toMatchObject({ status: 'error', points: {} });
    pcm.play = vi.fn(async () => { throw new Error('failure'); });
    await expect(audio.play('字幕', new AbortController().signal, vi.fn(), { turnId: 9 })).rejects.toThrow('failure');
    expect(timing.getSnapshot()[1].status).toBe('error');
  });

  it('renders a closed panel with explicit metric boundaries and mode labels', () => {
    let now = 0;
    const timing = new InteractionTiming(() => now);
    timing.configure(false, false);
    const asr = timing.begin('asr'); now = 4000; asr.mark('commit'); now = 4125; asr.finish('complete');
    const html = renderToStaticMarkup(<TimingDebugPanel timing={timing} />);
    expect(html).toContain('语音耗时调试面板');
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    expect(html).toContain('125 ms');
    expect(html).toContain('演示模式');
    expect(html).toContain('不含整段讲话时间');
  });
});

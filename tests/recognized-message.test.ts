import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { VoiceInput } from '../src/core/voice-input';
import { MicrophoneCapture } from '../src/core/microphone';
import { ConversationEngine } from '../src/core/engine';
import type { SpeechTransport } from '../src/core/speech-transport';
import type { TurnRequest } from '../shared/protocol';
import { UserMessage } from '../src/UserMessage';

function setup(results: unknown[]) {
  let frame!: (pcm: Uint8Array) => void;
  const stop = vi.fn(), finish = vi.fn(async () => {});
  const capture = new MicrophoneCapture(async callback => {
    frame = callback; return { finish, cancel: stop };
  });
  const commit = vi.fn(async () => { const value = results.shift(); if (value instanceof Error) throw value; return value as string; });
  const speech: SpeechTransport = { openAsr: () => ({ ready: Promise.resolve(), append: () => {}, commit }), synthesize: vi.fn() };
  const turn = vi.fn(async (request: TurnRequest) => ({ turnId: request.turnId, provider: 'mock' as const, segments: [{ text: '听到了。', emotion: 'curious' as const, action: 'idle' as const }] }));
  const engine = new ConversationEngine({ turn, cancel: async () => {} }, { play: async (_text, _signal, start) => { start(); }, stop: () => {} });
  const voice = new VoiceInput(speech, capture);
  const text = vi.fn((value: string) => { void engine.submit(value); });
  const error = vi.fn((value: string) => engine.inputNotice(value));
  const callbacks = { text, error, state: vi.fn() };
  const record = async () => { engine.interrupt(true); await voice.start(engine.getSnapshot().turnId, callbacks); frame(new Uint8Array(8000)); await voice.finish(); };
  return { voice, engine, turn, text, error, callbacks, record, commit, stop, finish };
}
describe('recognized speech becomes visible user text using fake capture and providers only', () => {
  it('shows normalized final words as a user message and submits the same text once', async () => {
    const s = setup([' \t雨停了，\n一起喝咖啡吗？ ']); await s.record();
    expect(s.turn).toHaveBeenCalledOnce();
    expect(s.turn.mock.calls[0][0].text).toBe('雨停了， 一起喝咖啡吗？');
    expect(s.engine.getSnapshot().lastInput).toBe('雨停了， 一起喝咖啡吗？');
    const html = renderToStaticMarkup(createElement(UserMessage, { text: s.engine.getSnapshot().lastInput, source: 'asr' }));
    expect(html).toContain('你最近发送的消息'); expect(html).toContain('语音识别'); expect(html).toContain('雨停了， 一起喝咖啡吗？');
    expect(s.callbacks.state).toHaveBeenLastCalledWith('录音已停止，正在识别……');
    expect(s.finish).toHaveBeenCalledOnce(); s.engine.dispose();
  });
  it.each(['', ' \n\t ', '……？！', '\u0000\u0007', { text: 'not a string' }, null, '字'.repeat(801)])('does not submit malformed or empty recognition (%j)', async value => {
    const s = setup([value]); await s.record();
    expect(s.turn).not.toHaveBeenCalled(); expect(s.text).not.toHaveBeenCalled(); expect(s.error).toHaveBeenCalledOnce();
    expect(s.engine.getSnapshot().lastInput).toBe(''); expect(s.engine.getSnapshot().status).toBe('idle');
    expect(s.engine.getSnapshot().notice).toMatch(/重新录制|再说一次|分段/); s.engine.dispose();
  });
  it('reports a failed recognition without submitting, then accepts a fresh recording', async () => {
    const s = setup([new Error('语音连接中断，请重新录制。'), '再来一杯']); await s.record();
    expect(s.turn).not.toHaveBeenCalled(); expect(s.engine.getSnapshot().notice).toContain('连接中断');
    await s.record(); expect(s.turn).toHaveBeenCalledOnce(); expect(s.turn.mock.calls[0][0].text).toBe('再来一杯'); expect(s.engine.getSnapshot().notice).toBe(''); s.engine.dispose();
  });
  it('keeps simulated voice explicitly labeled and renders recognized markup only as text', () => {
    expect(renderToStaticMarkup(createElement(UserMessage, { text: '预设台词', source: 'mock-voice' }))).toContain('模拟语音 · 预设台词');
    const html = renderToStaticMarkup(createElement(UserMessage, { text: '<script>test</script>', source: 'asr' }));
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
    expect(renderToStaticMarkup(createElement(UserMessage, { text: '', source: 'asr' }))).toBe('');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sseData } from '../shared/sse';
import { streamedText } from '../server/streamed-text';
import { DeepSeekProvider, ProviderError, type DialogueProvider } from '../server/providers';
import { retryDialogue } from '../server/retry-dialogue';
import { buildApp } from '../server/app';
import { HttpTransport } from '../src/core/transport';
import { ConversationEngine } from '../src/core/engine';
import type { TurnRequest, TurnResponse } from '../shared/protocol';

const input = {
  sessionId: '66666666-6666-4666-8666-666666666666',
  turnId: 1,
  text: '聊聊雨吧',
  history: [],
  fault: 'none' as const,
};
const good = { segments: [{ text: '雨还没停，坐一会儿吧。', emotion: 'curious', action: 'idle' }] };
const final: TurnResponse = { turnId: 1, provider: 'mock', ...good } as TurnResponse;
const encoder = new TextEncoder();
const event = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
const delta = (content: string) => event({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finish = (reason = 'stop') => event({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 21, completion_tokens: 14 } }) + 'data: [DONE]\n\n';
function controlled() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return {
    body,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}
const response = (text: string) => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('incremental structured dialogue', () => {
  it('extracts only dialogue paths and decodes partial escapes without exposing JSON, suggestions or instructions', () => {
    expect(streamedText('{"suggestions":["别显示"],"segments":[{"action":"idle","text":"雨')).toBe('雨');
    expect(streamedText('{"segments":[{"text":"雨\\n\\"停\\"\\u4e86')).toBe('雨\n"停"了');
    expect(streamedText('{"segments":[{"text":"星\\uD83D')).toBe('星');
    expect(streamedText('{"segments":[{"text":"星\\uD83D\\uDE00"}]}')).toBe('星😀');
    expect(streamedText('{"text":"不要显示","nested":{"segments":[{"text":"也不显示"}]}}')).toBe('');
    expect(streamedText('{"segments":[{"text":"第一句。"},{"text":"第二')).toBe('第一句。\n第二');
    expect(streamedText('{"segments":[{"emotion":"text: 偷换","text":"真正的对白"}]}')).toBe('真正的对白');
  });
  it('decodes Chinese bytes split anywhere, CRLF, comments and multiline data', async () => {
    const bytes = encoder.encode(': heartbeat\r\ndata: {"text":\r\ndata: "雨后😀"}\r\n\r\n');
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const received = [];
    for await (const data of sseData(body, new AbortController().signal)) received.push(JSON.parse(data));
    expect(received).toEqual([{ text: '雨后😀' }]);
  });
  it('emits model text before the final JSON or finish event exists and retains usage', async () => {
    const stream = controlled();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(stream.body, { headers: { 'Content-Type': 'text/event-stream' } }));
    const diagnostics: any[] = [], texts: string[] = [];
    const provider = new DeepSeekProvider('fixture', undefined, fetcher, (facts) => diagnostics.push(facts));
    let settled = false;
    const work = provider.reply(input, new AbortController().signal, undefined, (text) => texts.push(text));
    void work.then(() => { settled = true; });
    stream.push(delta('{"segments":[{"text":"雨还没停'));
    await vi.waitFor(() => expect(texts).toEqual(['雨还没停']));
    expect(settled).toBe(false);
    stream.push(delta('，坐一会儿吧。","emotion":"curious","action":"idle"}]}') + finish());
    stream.close();
    expect(await work).toEqual(good);
    expect(texts.at(-1)).toBe(good.segments[0].text);
    expect(diagnostics[0]).toMatchObject({ promptTokens: 21, completionTokens: 14 });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).stream).toBe(true);
  });
  it('rejects a broken stream without silently retrying a paid model request', async () => {
    const fetcher = vi.fn(async () => response(delta(JSON.stringify(good))));
    const provider = retryDialogue(new DeepSeekProvider('fixture', undefined, fetcher));
    await expect(provider.reply(input, new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('resets the previous preview before a bounded schema repair and streams the corrected attempt', async () => {
    const bad = { segments: [{ ...good.segments[0], text: '待修正的对白', action: 'unknown' }] };
    const fetcher = vi.fn().mockResolvedValueOnce(response(delta(JSON.stringify(bad)) + finish()))
      .mockResolvedValueOnce(response(delta(JSON.stringify(good)) + finish()));
    const texts: string[] = [];
    expect(await retryDialogue(new DeepSeekProvider('fixture', undefined, fetcher))
      .reply(input, new AbortController().signal, undefined, (text) => texts.push(text))).toEqual(good);
    expect(texts).toEqual(['', '待修正的对白', '', good.segments[0].text]);
  });
  it('cancels a stalled model reader immediately', async () => {
    const stream = controlled();
    const provider = new DeepSeekProvider('fixture', undefined, async () => new Response(stream.body, { headers: { 'Content-Type': 'text/event-stream' } }));
    const controller = new AbortController();
    const work = provider.reply(input, controller.signal);
    const assertion = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await assertion;
  });
  it('ignores callbacks from an earlier repair attempt even while the same turn is still receiving', async () => {
    let firstText!: (text: string) => void;
    let count = 0;
    const texts: string[] = [];
    const provider: DialogueProvider = { kind: 'mock', async reply(_request, _signal, _repair, onText) {
      if (++count === 1) {
        firstText = onText!;
        onText?.('第一版');
        throw new ProviderError('INVALID_REPLY', '需要修正');
      }
      onText?.('已修正');
      firstText('迟到的第一版');
      return good as any;
    } };
    await retryDialogue(provider).reply(input, new AbortController().signal, undefined, (text) => texts.push(text));
    expect(texts).toEqual(['', '第一版', '', '已修正']);
  });
});

describe('turn stream and authoritative presentation', () => {
  it('delivers an HTTP chunk while the provider is still running, then accepts only the validated reply', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const app = buildApp({ kind: 'mock', async reply(_request, _signal, _repair, onText) {
      onText?.('雨还没');
      await gate;
      return good as any;
    } });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const result = await fetch(address + '/api/turn', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(input) });
      expect(result.headers.get('x-accel-buffering')).toBe('no');
      const iterator = sseData(result.body!, new AbortController().signal);
      expect(JSON.parse((await iterator.next()).value!)).toMatchObject({ type: 'start', turnId: 1 });
      expect(JSON.parse((await iterator.next()).value!)).toMatchObject({ type: 'text', text: '雨还没' });
      const before = await app.inject({ method: 'POST', url: '/api/presented', payload: { sessionId: input.sessionId, turnId: 1, through: 1 } });
      expect(before.statusCode).toBe(409);
      release();
      expect(JSON.parse((await iterator.next()).value!)).toMatchObject({ type: 'reply', reply: final });
      expect((await iterator.next()).done).toBe(true);
      const after = await app.inject({ method: 'POST', url: '/api/presented', payload: { sessionId: input.sessionId, turnId: 1, through: 1 } });
      expect(after.statusCode).toBe(200);
    } finally { release(); await app.close(); }
  });
  it('returns a terminal SSE error for a mid-stream failure and a timeout', async () => {
    for (const mode of ['failure', 'timeout']) {
      const provider: DialogueProvider = { kind: 'mock', async reply(_request, _signal, _repair, onText) {
        onText?.('不完整');
        if (mode === 'timeout') return new Promise(() => {});
        throw new ProviderError('UNAVAILABLE', '回复传输中断，请重试这一句。');
      } };
      const app = buildApp(provider, 20);
      try {
        const result = await app.inject({ method: 'POST', url: '/api/turn', headers: { accept: 'text/event-stream' }, payload: input });
        const events = result.body.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.slice(6)));
        expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: mode === 'timeout' ? 'TIMEOUT' : 'UNAVAILABLE' } });
        expect(events.some((item) => item.type === 'reply')).toBe(false);
      } finally { await app.close(); }
    }
  });
  it('streams through HttpTransport, rejects missing finals, errors and mismatched turns', async () => {
    const texts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => response(event({ type: 'text', turnId: 1, text: '雨还' }) + event({ type: 'reply', reply: final }))));
    expect(await new HttpTransport().turn(input, new AbortController().signal, (text) => texts.push(text))).toEqual(final);
    expect(texts).toEqual(['雨还']);
    for (const data of [event({ type: 'text', turnId: 1, text: '一半' }), event({ type: 'text', turnId: 9, text: '迟到' }), event({ type: 'error', turnId: 1, error: { code: 'TIMEOUT', message: '等待回复超时' } })]) {
      const fetcher = vi.fn(async () => response(data));
      vi.stubGlobal('fetch', fetcher);
      await expect(new HttpTransport().turn(input, new AbortController().signal)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it('shows incremental text without audio or actions, and drops late previews on interruption and after completion', async () => {
    const calls: { text: (text: string) => void; resolve: (reply: TurnResponse) => void; request: TurnRequest }[] = [];
    const transport = { turn(request: TurnRequest, _signal: AbortSignal, onText?: (text: string) => void) {
      return new Promise<TurnResponse>((resolve) => calls.push({ text: onText!, resolve, request }));
    }, async cancel() {} };
    const audio = { play: vi.fn(async (_text: string, _signal: AbortSignal, start: () => void) => start()), stop() {} };
    const engine = new ConversationEngine(transport, audio);
    const first = engine.submit('第一轮');
    calls[0].text('这张照片');
    expect(engine.getSnapshot()).toMatchObject({ streamingText: '这张照片', status: 'thinking', photo: false, story: undefined });
    expect(audio.play).not.toHaveBeenCalled();
    engine.interrupt(true);
    calls[0].text('迟到的预览');
    expect(engine.getSnapshot()).toMatchObject({ streamingText: '', status: 'listening' });
    const second = engine.submit('继续');
    expect(calls[1].request.history).toEqual([]);
    calls[1].text('雨还');
    calls[0].resolve({ ...final, turnId: 1 });
    await first;
    expect(engine.getSnapshot().streamingText).toBe('雨还');
    calls[1].resolve({ ...final, turnId: engine.getSnapshot().turnId });
    await second;
    calls[1].text('完成后迟到的预览');
    expect(engine.getSnapshot()).toMatchObject({ streamingText: '', subtitle: good.segments[0].text, completed: 1 });
    expect(audio.play).toHaveBeenCalledOnce();
  });
});

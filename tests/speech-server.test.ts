import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { QwenSpeechProvider } from '../server/qwen';
import { resolveConfig, type QwenConfig } from '../server/config';
import { createSpeechHandler, sameLocalOrigin } from '../server/speech-routes';
import type { SpeechProvider, WireSocket } from '../server/speech';
import type { SpeechServerEvent } from '../shared/speech-protocol';
const config: QwenConfig = {
  apiKey: 'not-a-real-key',
  region: 'cn-beijing',
  asrEndpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  ttsEndpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  asrModel: 'test-asr',
  ttsModel: 'test-tts',
  voice: 'Chelsie',
};
class FakeWire extends EventEmitter implements WireSocket {
  sent: Record<string, any>[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
  event(data: object) {
    this.emit('message', JSON.stringify(data));
  }
  ready() {
    this.emit('open');
    this.event({ type: 'session.updated' });
  }
}
function setup() {
  const wires: FakeWire[] = [];
  const factory = vi.fn(() => {
    const wire = new FakeWire();
    wires.push(wire);
    return wire;
  });
  return { wires, factory, provider: new QwenSpeechProvider(config, factory) };
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
describe('explicit configuration gates', () => {
  it('does not read any secret when the live switch is off', () => {
    const env = new Proxy(
      { MIRA_ENABLE_LIVE_APIS: 'false' },
      {
        get(target, key) {
          if (String(key).includes('KEY')) throw new Error('secret accessed');
          return target[key as keyof typeof target];
        },
      },
    );
    expect(resolveConfig(env)).toEqual({ liveEnabled: false, configuration: 'mock' });
  });
  it('falls back to Mock when live configuration is incomplete', () => {
    const result = resolveConfig({
      MIRA_ENABLE_LIVE_APIS: 'true',
      MIRA_PROVIDER: 'deepseek',
      MIRA_SPEECH_PROVIDER: 'qwen',
    });
    expect(result.deepseek).toBeUndefined();
    expect(result.qwen).toBeUndefined();
  });
  it('requires same-region official endpoints and keeps keys out of public status', () => {
    const env = {
      MIRA_ENABLE_LIVE_APIS: 'true',
      MIRA_SPEECH_PROVIDER: 'qwen',
      DASHSCOPE_API_KEY: 'fake',
      DASHSCOPE_REGION: 'cn-beijing',
      QWEN_ASR_ENDPOINT: config.asrEndpoint,
      QWEN_TTS_ENDPOINT: config.ttsEndpoint,
    };
    expect(resolveConfig(env).qwen?.asrModel).toBe('qwen3-asr-flash-realtime');
    expect(resolveConfig(env).qwen?.voice).toBe('Chelsie');
    expect(resolveConfig({ ...env, QWEN_TTS_VOICE: 'configured-preset' }).qwen?.voice).toBe(
      'configured-preset',
    );
    expect(resolveConfig({ ...env, DASHSCOPE_REGION: 'ap-southeast-1' }).qwen).toBeUndefined();
    expect(
      resolveConfig({ ...env, QWEN_ASR_ENDPOINT: 'wss://attacker.example/api-ws/v1/realtime' })
        .qwen,
    ).toBeUndefined();
  });
  it('restricts the local paid proxy to its same-origin browser', () => {
    expect(sameLocalOrigin('http://127.0.0.1:3001', '127.0.0.1:3001')).toBe(true);
    expect(sameLocalOrigin('https://attacker.example', '127.0.0.1:3001')).toBe(false);
    expect(sameLocalOrigin(undefined, '127.0.0.1:3001')).toBe(false);
  });
});
describe('Qwen protocol with fake WebSockets only', () => {
  it('configures 16k manual ASR, commits and finishes before returning a transcript', async () => {
    const { provider, wires, factory } = setup();
    const session = provider.openAsr(new AbortController().signal);
    wires[0].ready();
    await session.ready;
    expect(wires[0].sent[0]).toMatchObject({
      type: 'session.update',
      session: {
        input_audio_format: 'pcm',
        sample_rate: 16000,
        turn_detection: null,
        input_audio_transcription: { language: 'zh' },
      },
    });
    session.append(new Uint8Array(8000));
    const work = session.commit();
    expect(wires[0].sent.map((e) => e.type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
      'session.finish',
    ]);
    wires[0].event({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '你好 Mira',
    });
    wires[0].event({ type: 'session.finished' });
    await expect(work).resolves.toBe('你好 Mira');
    expect(wires[0].closed).toBe(true);
    expect(factory.mock.calls[0]).toHaveLength(2);
  });
  it('rejects short audio without submitting it upstream', async () => {
    const { provider, wires } = setup();
    const session = provider.openAsr(new AbortController().signal);
    wires[0].ready();
    await session.ready;
    session.append(new Uint8Array(100));
    await expect(session.commit()).rejects.toMatchObject({ code: 'TOO_SHORT' });
    expect(wires[0].sent.some((e) => e.type === 'input_audio_buffer.commit')).toBe(false);
  });
  it('reports empty recognition and allows a fresh retry', async () => {
    const { provider, wires } = setup();
    for (let i = 0; i < 2; i++) {
      const session = provider.openAsr(new AbortController().signal);
      wires[i].ready();
      await session.ready;
      session.append(new Uint8Array(8000));
      const work = session.commit();
      wires[i].event({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: i ? '重试成功' : '',
      });
      wires[i].event({ type: 'session.finished' });
      if (!i) await expect(work).rejects.toMatchObject({ code: 'EMPTY_TRANSCRIPT' });
      else await expect(work).resolves.toBe('重试成功');
    }
  });
  it.each([
    { transcript: '……？！', code: 'EMPTY_TRANSCRIPT' },
    { transcript: { text: 'invalid object' }, code: 'BAD_TRANSCRIPT' },
    { transcript: '字'.repeat(801), code: 'TOO_LONG' },
  ])(
    'rejects unusable upstream transcripts without coercing them ($code)',
    async ({ transcript, code }) => {
      const { provider, wires } = setup();
      const session = provider.openAsr(new AbortController().signal);
      wires[0].ready();
      await session.ready;
      session.append(new Uint8Array(8000));
      const work = session.commit();
      wires[0].event({ type: 'conversation.item.input_audio_transcription.completed', transcript });
      wires[0].event({ type: 'session.finished' });
      await expect(work).rejects.toMatchObject({ code });
      expect(wires[0].closed).toBe(true);
    },
  );
  it('cancels ASR during connection and does not use late transcripts', async () => {
    const { provider, wires } = setup();
    const abort = new AbortController();
    const session = provider.openAsr(abort.signal);
    abort.abort();
    await expect(session.ready).rejects.toMatchObject({ name: 'AbortError' });
    wires[0].event({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'late',
    });
    expect(wires[0].closed).toBe(true);
  });
  it('configures 24k PCM TTS and emits only decoded audio bytes', async () => {
    const { provider, wires } = setup();
    const chunks: Uint8Array[] = [];
    const work = provider.synthesize('只有对白。', new AbortController().signal, (pcm) =>
      chunks.push(pcm),
    );
    wires[0].ready();
    await flush();
    expect(wires[0].sent[0]).toMatchObject({
      session: { mode: 'commit', response_format: 'pcm', sample_rate: 24000, voice: 'Chelsie' },
    });
    expect(wires[0].sent[1]).toMatchObject({
      type: 'input_text_buffer.append',
      text: '只有对白。',
    });
    wires[0].event({
      type: 'response.audio.delta',
      delta: Buffer.from([1, 0, 2, 0]).toString('base64'),
    });
    wires[0].event({ type: 'response.done' });
    wires[0].event({ type: 'session.finished' });
    await work;
    expect([...chunks[0]]).toEqual([1, 0, 2, 0]);
    expect(wires[0].sent.at(-1)?.type).toBe('session.finish');
  });
  it('drops all audio after cancellation and does not leak upstream errors', async () => {
    const { provider, wires } = setup();
    const abort = new AbortController();
    const audio = vi.fn();
    const work = provider.synthesize('你好。', abort.signal, audio);
    wires[0].ready();
    await flush();
    abort.abort();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    wires[0].event({ type: 'response.audio.delta', delta: 'AAAA' });
    expect(audio).not.toHaveBeenCalled();
    const other = provider.synthesize('重试。', new AbortController().signal, audio);
    wires[1].ready();
    await flush();
    wires[1].event({ type: 'error', error: { message: 'sensitive fake key' } });
    await expect(other).rejects.toThrow('语音服务返回错误');
  });
  it('bounds handshake wait and never connects if already aborted', async () => {
    vi.useFakeTimers();
    const { provider, wires, factory } = setup();
    const session = provider.openAsr(new AbortController().signal);
    const failed = expect(session.ready).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(8000);
    await failed;
    expect(wires[0].closed).toBe(true);
    const abort = new AbortController();
    abort.abort();
    expect(() => provider.openAsr(abort.signal)).toThrow();
    expect(factory).toHaveBeenCalledTimes(1);
  });
  it('reports unexpected connection closure as retryable failure', async () => {
    const { provider, wires } = setup();
    const session = provider.openAsr(new AbortController().signal);
    wires[0].ready();
    await session.ready;
    session.append(new Uint8Array(8000));
    const work = session.commit();
    wires[0].emit('close');
    await expect(work).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });
});
describe('local proxy cancellation and disabled mode', () => {
  const first = { requestId: '11111111-1111-4111-8111-111111111111', turnId: 1 };
  const second = { requestId: '22222222-2222-4222-8222-222222222222', turnId: 2 };
  it('does not create a provider connection in unconfigured mode', () => {
    const events: SpeechServerEvent[] = [];
    const handler = createSpeechHandler(undefined, (event) => events.push(event));
    handler.receive(JSON.stringify({ type: 'asr.start', ...first }));
    expect(events[0]).toMatchObject({ type: 'error', code: 'NOT_CONFIGURED' });
  });
  it('isolates replacement TTS operations from late audio and cancels on disconnect', async () => {
    const operations: { signal: AbortSignal; audio: (pcm: Uint8Array) => void }[] = [];
    const provider: SpeechProvider = {
      openAsr: () => {
        throw new Error('unused');
      },
      synthesize: (_text, signal, audio) => {
        operations.push({ signal, audio });
        return new Promise(() => {});
      },
    };
    const events: SpeechServerEvent[] = [];
    const handler = createSpeechHandler(provider, (event) => events.push(event));
    handler.receive(JSON.stringify({ type: 'tts.start', ...first, text: 'old' }));
    handler.receive(JSON.stringify({ type: 'tts.start', ...second, text: 'new' }));
    expect(operations[0].signal.aborted).toBe(true);
    operations[0].audio(new Uint8Array(2));
    operations[1].audio(new Uint8Array(2));
    expect(events).toHaveLength(1);
    expect(events[0].requestId).toBe(second.requestId);
    handler.receive(JSON.stringify({ type: 'cancel', ...first }));
    expect(operations[1].signal.aborted).toBe(false);
    handler.close();
    expect(operations[1].signal.aborted).toBe(true);
  });
});

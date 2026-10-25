import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { speechClientSchema, type SpeechServerEvent } from '../shared/speech-protocol';
import { SpeechError, type AsrSession, type SpeechProvider } from './speech';
import { isAbort } from '../shared/async';

export function sameLocalOrigin(origin: string | undefined, host: string | undefined): boolean {
  try { const url = new URL(origin ?? ''); return url.host === host && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol); }
  catch { return false; }
}
export function createSpeechHandler(provider: SpeechProvider | undefined, send: (event: SpeechServerEvent) => void) {
  let active: { requestId: string; turnId: number; controller: AbortController; asr?: AsrSession } | undefined;
  const close = () => { const previous = active; active = undefined; previous?.controller.abort(); previous?.asr?.cancel(); };
  const receive = (raw: unknown) => {
    let parsed;
    try { parsed = speechClientSchema.safeParse(JSON.parse(String(raw))); } catch { return close(); }
    if (!parsed.success) return close();
    const event = parsed.data;
    if (event.type === 'asr.start' || event.type === 'tts.start') {
      close();
      const op = { requestId: event.requestId, turnId: event.turnId, controller: new AbortController(), asr: undefined as AsrSession | undefined };
      active = op;
      const identity = { requestId: op.requestId, turnId: op.turnId };
      const current = () => active === op && !op.controller.signal.aborted;
      const fail = (error: unknown) => {
        if (!current() || isAbort(error)) return;
        send({ type: 'error', ...identity, code: error instanceof SpeechError ? error.code : 'SPEECH_ERROR', message: error instanceof SpeechError ? error.message : '语音暂时不可用，请重新录制或重试。' });
        close();
      };
      if (!provider) { fail(new SpeechError('NOT_CONFIGURED', '真实语音未启用，请使用模拟模式或先完成本机配置。')); return; }
      try {
        if (event.type === 'asr.start') {
          op.asr = provider.openAsr(op.controller.signal);
          void op.asr.ready.then(() => { if (current()) send({ type: 'ready', ...identity }); }, fail);
        } else {
          void provider.synthesize(event.text, op.controller.signal, pcm => {
            if (!current()) return;
            // Bound each browser event even when the upstream sends a large audio block.
            for (let offset = 0; offset < pcm.length; offset += 24000) send({ type: 'audio', ...identity, audio: Buffer.from(pcm.subarray(offset, offset + 24000)).toString('base64'), sampleRate: 24000 });
          }).then(() => { if (current()) { send({ type: 'done', ...identity }); close(); } }, fail);
        }
      } catch (error) { fail(error); }
      return;
    }
    const op = active;
    if (!op || op.requestId !== event.requestId || op.turnId !== event.turnId) return;
    if (event.type === 'cancel') { close(); return; }
    try {
      if (!op.asr) throw new SpeechError('NOT_READY', '请先开始录音。');
      if (event.type === 'asr.audio') op.asr.append(Buffer.from(event.audio, 'base64'));
      if (event.type === 'asr.commit') void op.asr.commit().then(text => {
        if (active !== op || op.controller.signal.aborted) return;
        send({ type: 'transcript', requestId: op.requestId, turnId: op.turnId, text });
        send({ type: 'done', requestId: op.requestId, turnId: op.turnId }); close();
      }, error => {
        if (active !== op || isAbort(error)) return;
        send({ type: 'error', requestId: op.requestId, turnId: op.turnId, code: error instanceof SpeechError ? error.code : 'SPEECH_ERROR', message: error instanceof SpeechError ? error.message : '识别失败，请重新录制。' }); close();
      });
    } catch (error) {
      send({ type: 'error', requestId: op.requestId, turnId: op.turnId, code: error instanceof SpeechError ? error.code : 'BAD_AUDIO', message: error instanceof SpeechError ? error.message : '录音数据异常，请重新录制。' }); close();
    }
  };
  return { receive, close };
}
export function registerSpeech(app: FastifyInstance, provider?: SpeechProvider) {
  app.register(websocket, { options: { maxPayload: 66000 } });
  app.register(async scope => {
    scope.get('/api/speech', { websocket: true, onRequest: async (request, reply) => {
      if (!sameLocalOrigin(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Origin not allowed' });
    } }, socket => {
      const handler = createSpeechHandler(provider, event => {
        if (socket.readyState !== 1) return;
        if (socket.bufferedAmount > 1_000_000) { handler.close(); socket.close(1013); return; }
        socket.send(JSON.stringify(event));
      });
      // Attach immediately: async setup must not lose early browser messages.
      socket.on('message', handler.receive); socket.on('close', handler.close); socket.on('error', handler.close);
    });
  });
}

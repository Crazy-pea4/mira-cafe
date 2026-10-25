import { appPath } from './app-path';
import { speechServerSchema, bytesToBase64, base64ToBytes, type SpeechClientEvent, type SpeechServerEvent } from '../../shared/speech-protocol';
import { abortError } from '../../shared/async';
import { normalizeTranscript } from '../../shared/transcript';
export interface BrowserWire {
  readyState: number; bufferedAmount: number;
  send(value: string): void; close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}
export type BrowserWireFactory = (url: string) => BrowserWire;
const nativeFactory: BrowserWireFactory = url => new WebSocket(url);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); void promise.catch(() => {});
  return { promise, resolve, reject };
}
export interface BrowserAsr { ready: Promise<void>; append(pcm: Uint8Array): void; commit(): Promise<string>; }
export interface SpeechTransport {
  openAsr(turnId: number, signal: AbortSignal): BrowserAsr;
  synthesize(text: string, turnId: number, signal: AbortSignal, chunk: (pcm: Uint8Array) => void): Promise<void>;
}
export class LocalSpeechTransport implements SpeechTransport {
  constructor(private factory: BrowserWireFactory = nativeFactory, private endpoint = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + appPath('api/speech')) {}
  private connect(turnId: number, signal: AbortSignal, start: 'asr.start' | 'tts.start', text?: string, audio?: (pcm: Uint8Array) => void) {
    const requestId = crypto.randomUUID(), ready = deferred<void>(), done = deferred<string>();
    if (signal.aborted) { ready.reject(abortError()); done.reject(abortError()); return { ready: ready.promise, done: done.promise, send: (_event: object) => {} }; }
    const socket = this.factory(this.endpoint()); let closed = false, transcript = '';
    const finish = (error?: Error) => {
      if (closed) return; closed = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      error ? (ready.reject(error), done.reject(error)) : (ready.resolve(), done.resolve(transcript));
      try { socket.close(); } catch { /* Already disconnected. */ }
    };
    const send = (fields: object) => {
      if (closed || signal.aborted || socket.readyState !== 1) throw abortError();
      if (socket.bufferedAmount > 1_000_000) { finish(new Error('网络发送过慢，请重试。')); return; }
      try { socket.send(JSON.stringify({ requestId, turnId, ...fields })); }
      catch { const error = new Error('语音发送失败，请重试。'); finish(error); throw error; }
    };
    const cancel = () => { try { if (!closed && socket.readyState === 1) socket.send(JSON.stringify({ type: 'cancel', requestId, turnId } satisfies SpeechClientEvent)); } catch { /* Cancellation still closes locally. */ } finally { finish(abortError()); } };
    const timer = setTimeout(() => finish(new Error('语音等待超时，请重新录制或重试。')), 45000);
    signal.addEventListener('abort', cancel, { once: true });
    socket.addEventListener('open', () => { try { if (!closed) send(start === 'tts.start' ? { type: start, text } : { type: start }); } catch { finish(new Error('语音发送失败，请重试。')); } });
    socket.addEventListener('message', (raw: MessageEvent) => {
      if (closed || signal.aborted) return;
      let event: SpeechServerEvent;
      try { event = speechServerSchema.parse(JSON.parse(String(raw.data))); } catch { finish(new Error('语音响应格式异常，请重试。')); return; }
      if (event.requestId !== requestId || event.turnId !== turnId) return;
      if (event.type === 'ready') ready.resolve();
      if (event.type === 'transcript') transcript = event.text;
      if (event.type === 'audio') { try { audio?.(base64ToBytes(event.audio)); } catch { finish(new Error('语音播放数据异常，已保留文字。')); } }
      if (event.type === 'error') finish(new Error(event.message));
      if (event.type === 'done') {
        try { if (start === 'asr.start') transcript = normalizeTranscript(transcript); finish(); }
        catch (error) { finish(error instanceof Error ? error : new Error('识别失败，请重试。')); }
      }
    });
    socket.addEventListener('error', () => finish(new Error('无法连接语音服务，请重试。')));
    socket.addEventListener('close', () => { if (!closed) finish(new Error('语音连接中断，请重新录制或重试。')); });
    return { ready: ready.promise, done: done.promise, send };
  }
  openAsr(turnId: number, signal: AbortSignal): BrowserAsr {
    const connection = this.connect(turnId, signal, 'asr.start');
    return { ready: connection.ready, append: pcm => connection.send({ type: 'asr.audio', audio: bytesToBase64(pcm), sampleRate: 16000 }),
      commit: () => { connection.send({ type: 'asr.commit' }); return connection.done; } };
  }
  synthesize(text: string, turnId: number, signal: AbortSignal, chunk: (pcm: Uint8Array) => void) {
    return this.connect(turnId, signal, 'tts.start', text, chunk).done.then(() => {});
  }
}

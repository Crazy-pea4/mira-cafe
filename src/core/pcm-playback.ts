import { decodePcm16 } from '../../shared/pcm';
import { abortError } from '../../shared/async';
import type { SpeechTransport } from './speech-transport';
export interface ScheduledPcm { stop(): void; }
export interface PlaybackClock {
  now(): number; running(): boolean;
  schedule(samples: Float32Array, at: number, ended: () => void): ScheduledPcm;
}
export class PcmPlaybackQueue {
  readonly done: Promise<void>;
  private resolve!: () => void; private reject!: (error: Error) => void;
  private nodes = new Set<ScheduledPcm>(); private nextTime = 0; private firstTime?: number;
  private started = false; private ended = false; private closed = false;
  private poll: ReturnType<typeof setInterval>; private watchdog: ReturnType<typeof setTimeout>;
  private cancel: () => void;
  constructor(private clock: PlaybackClock, private signal: AbortSignal, private onStart: () => void) {
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); void this.done.catch(() => {});
    this.cancel = () => this.fail(abortError());
    signal.addEventListener('abort', this.cancel, { once: true });
    this.poll = setInterval(() => this.tick(), 10);
    this.watchdog = setTimeout(() => this.fail(new Error('语音播放超时，已保留文字。')), 65000);
    if (signal.aborted) this.cancel();
  }
  enqueue(bytes: Uint8Array) {
    if (this.closed || this.ended || this.signal.aborted) return;
    const samples = decodePcm16(bytes); if (!samples.length) return;
    const start = Math.max(this.clock.now() + 0.04, this.nextTime);
    if (start - this.clock.now() > 60) { this.fail(new Error('语音缓存过长，已取消。')); return; }
    this.firstTime ??= start; this.nextTime = start + samples.length / 24000;
    const node = this.clock.schedule(samples, start, () => {
      if (this.closed) return;
      this.tick(); this.nodes.delete(node); this.completeIfReady();
    });
    this.nodes.add(node);
  }
  end() { if (this.closed) return; this.ended = true; if (this.firstTime === undefined) this.fail(new Error('未收到语音，已保留文字。')); else this.completeIfReady(); }
  private tick() {
    if (this.closed || this.signal.aborted) return;
    // Wall-clock timers may fire while AudioContext is suspended: only its clock can start visuals.
    if (!this.started && this.firstTime !== undefined && this.clock.running() && this.clock.now() >= this.firstTime) { this.started = true; this.onStart(); }
  }
  private completeIfReady() { if (this.ended && !this.nodes.size && !this.closed) { this.closed = true; this.cleanup(); this.resolve(); } }
  fail(error: Error) {
    if (this.closed) return; this.closed = true; this.cleanup();
    for (const node of this.nodes) node.stop(); this.nodes.clear(); this.reject(error);
  }
  private cleanup() { clearInterval(this.poll); clearTimeout(this.watchdog); this.signal.removeEventListener('abort', this.cancel); }
}
function browserClock(context: AudioContext): PlaybackClock {
  return { now: () => context.currentTime, running: () => context.state === 'running',
    schedule: (samples, at, ended) => {
      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.getChannelData(0).set(samples);
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
      source.onended = () => { source.disconnect(); ended(); }; source.start(at);
      return { stop: () => { source.onended = null; try { source.stop(); } catch { /* already ended */ } source.disconnect(); } };
    } };
}
export class PcmSpeechPlayer {
  private context?: AudioContext; private clock?: PlaybackClock; private controller?: AbortController;
  constructor(private transport: SpeechTransport, private createContext = () => new AudioContext()) {}
  async unlock() {
    this.context ??= this.createContext();
    await this.context.resume();
    if (this.context.state !== 'running') throw new Error('浏览器未允许声音，仍保持静音。');
    this.clock = browserClock(this.context);
  }
  async suspend() { this.stop(); await this.context?.suspend(); }
  async play(text: string, turnId: number, signal: AbortSignal, onStart: () => void) {
    if (!this.clock || !this.context || this.context.state !== 'running') throw new Error('请先明确开启声音。');
    this.stop();
    const controller = new AbortController(); this.controller = controller;
    const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const queue = new PcmPlaybackQueue(this.clock, controller.signal, onStart);
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) throw abortError();
      return this.transport.synthesize(text, turnId, controller.signal, pcm => {
      if (this.controller === controller && !controller.signal.aborted) {
        try { queue.enqueue(pcm); } catch { queue.fail(new Error('语音数据异常，已保留文字。')); }
      }
      });
    }).then(() => queue.end(), error => queue.fail(error instanceof Error ? error : new Error('语音连接中断。')));
    try { await queue.done; }
    finally { controller.abort(); signal.removeEventListener('abort', cancel); if (this.controller === controller) this.controller = undefined; }
  }
  stop() { this.controller?.abort(); this.controller = undefined; }
}
